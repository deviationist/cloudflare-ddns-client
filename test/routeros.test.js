import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import RouterOS from '../src/routers/RouterOS.js';
import { createRouterDriver } from '../src/routers/index.js';

// Shapes as RouterOS 7 returns them. :serialize (ssh) gives typed JSON; REST
// gives every value as a string. A primary uplink at distance 1 checked through
// a recursive gateway, and an LTE backup at distance 2.
const PRIMARY_ROUTES = [
  { 'dst-address': '0.0.0.0/0', 'routing-table': 'main', gateway: '192.0.2.53', distance: 1, active: true, disabled: false, comment: 'WAN primary' },
  { 'dst-address': '0.0.0.0/0', 'routing-table': 'main', gateway: 'lte1', distance: 2, disabled: false, comment: 'WAN backup' },
];
const FAILOVER_ROUTES = [
  { 'dst-address': '0.0.0.0/0', 'routing-table': 'main', gateway: '192.0.2.53', distance: 1, disabled: false, comment: 'WAN primary' },
  { 'dst-address': '0.0.0.0/0', 'routing-table': 'main', gateway: 'lte1', distance: 2, active: true, disabled: false, comment: 'WAN backup' },
];
const ADDRESSES = [
  { address: '192.168.88.1/24', interface: 'bridge', disabled: false, invalid: false },
  { address: '203.0.113.42/24', interface: 'ether1', disabled: false, invalid: false },
  { address: '10.164.0.9/32', interface: 'lte1', disabled: false, invalid: false },
];
const PUBLIC_IP = '203.0.113.42';
const CARRIER_IP = '198.51.100.7';

const sshOutput = (routes, addresses) => `${JSON.stringify(routes)}\r\n${JSON.stringify(addresses)}\r\n`;
const stringify = rows => rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])));

const viaSsh = (routes, addresses = ADDRESSES, options = {}) => {
  const d = new RouterOS({ transport: 'ssh', ssh: { host: 'router' }, ...options });
  d.runSsh = async () => sshOutput(routes, addresses);
  return d;
};

// A stand-in for the REST API. In-process is fine here: nothing in this file
// blocks the event loop the way the end-to-end client runs do.
async function withRest({ routes = PRIMARY_ROUTES, addresses = ADDRESSES, status = 200 } = {}, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    req.resume();
    if (status !== 200) {
      res.statusCode = status;
      res.end('{"error":401,"message":"Unauthorized"}');
      return;
    }
    if (req.url.startsWith('/rest/ip/route')) return res.end(JSON.stringify(stringify(routes)));
    if (req.url.startsWith('/rest/ip/address')) return res.end(JSON.stringify(stringify(addresses)));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(url, seen);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('RouterOS verdicts', () => {
  test('publishable on the primary route when the router holds the detected IP', async () => {
    const verdict = await viaSsh(PRIMARY_ROUTES).evaluate(PUBLIC_IP);

    assert.equal(verdict.ok, true);
    assert.equal(verdict.publishable, true);
    assert.match(verdict.reason, /primary default route "WAN primary"/);
    assert.match(verdict.reason, /on ether1/);
  });

  test('pauses when a backup route is the active one', async () => {
    const verdict = await viaSsh(FAILOVER_ROUTES).evaluate(CARRIER_IP);

    assert.equal(verdict.ok, true);
    assert.equal(verdict.publishable, false);
    assert.match(verdict.reason, /backup default route "WAN backup".*distance 2 > 1/);
  });

  // The failover signal comes first: a backup uplink with a routable address
  // that the router really holds is still not where DNS should point.
  test('pauses on failover even when the backup uplink holds a public IP', async () => {
    const addresses = [...ADDRESSES, { address: `${CARRIER_IP}/32`, interface: 'lte1' }];

    const verdict = await viaSsh(FAILOVER_ROUTES, addresses).evaluate(CARRIER_IP);

    assert.equal(verdict.publishable, false);
    assert.match(verdict.reason, /failover active/);
  });

  test('pauses when the detected IP is on no router interface (upstream NAT)', async () => {
    const verdict = await viaSsh(PRIMARY_ROUTES).evaluate(CARRIER_IP);

    assert.equal(verdict.ok, true);
    assert.equal(verdict.publishable, false);
    assert.match(verdict.reason, /not assigned to any router interface/);
  });

  test('checkAddress:false trusts the route alone, for a router behind 1:1 NAT', async () => {
    const verdict = await viaSsh(PRIMARY_ROUTES, ADDRESSES, { checkAddress: false }).evaluate(CARRIER_IP);

    assert.equal(verdict.publishable, true);
  });

  test('a disabled route with a better distance does not count as the primary', async () => {
    const routes = [
      { 'dst-address': '0.0.0.0/0', gateway: '192.0.2.99', distance: 1, disabled: true },
      { 'dst-address': '0.0.0.0/0', gateway: '192.0.2.53', distance: 5, active: true, disabled: false },
    ];

    const verdict = await viaSsh(routes).evaluate(PUBLIC_IP);

    assert.equal(verdict.publishable, true);
  });

  test('default routes in other routing tables are ignored', async () => {
    const routes = [
      ...PRIMARY_ROUTES,
      { 'dst-address': '0.0.0.0/0', 'routing-table': 'vpn', gateway: 'wg0', distance: 0, active: true },
    ];

    const verdict = await viaSsh(routes).evaluate(PUBLIC_IP);

    assert.equal(verdict.publishable, true);
  });

  test('cannot determine (fails open) with no active default route', async () => {
    const routes = PRIMARY_ROUTES.map(({ active, ...r }) => r);

    const verdict = await viaSsh(routes).evaluate(PUBLIC_IP);

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /no active default route/);
  });

  test('cannot determine (fails open) with no default route at all', async () => {
    const verdict = await viaSsh([]).evaluate(PUBLIC_IP);

    assert.equal(verdict.ok, false);
  });
});

describe('RouterOS detection options', () => {
  // Failover by netwatch disabling the primary: only the backup is enabled, so
  // it is the "best" one left and distance alone can't see the failover.
  const PRIMARY_DISABLED = [
    { 'dst-address': '0.0.0.0/0', gateway: '192.0.2.53', distance: 1, disabled: true },
    { 'dst-address': '0.0.0.0/0', gateway: 'lte1', distance: 2, active: true, disabled: false, comment: 'WAN backup' },
  ];
  const holdsCarrierIp = [...ADDRESSES, { address: `${CARRIER_IP}/32`, interface: 'lte1' }];

  test('without primaryDistance, a disabled primary hides the failover', async () => {
    const verdict = await viaSsh(PRIMARY_DISABLED, holdsCarrierIp).evaluate(CARRIER_IP);

    assert.equal(verdict.publishable, true);
  });

  test('primaryDistance pins the primary, so a disabled primary still reads as failover', async () => {
    const verdict = await viaSsh(PRIMARY_DISABLED, holdsCarrierIp, { primaryDistance: 1 }).evaluate(CARRIER_IP);

    assert.equal(verdict.publishable, false);
    assert.match(verdict.reason, /distance 2 > 1/);
  });

  test('backupRoute.gateway marks the active route as a backup regardless of distance', async () => {
    const verdict = await viaSsh(PRIMARY_DISABLED, holdsCarrierIp, { backupRoute: { gateway: '^lte\\d+$' } }).evaluate(CARRIER_IP);

    assert.equal(verdict.publishable, false);
    assert.match(verdict.reason, /matches backupRoute.gateway/);
  });

  test('backupRoute.comment matches on the route comment', async () => {
    const verdict = await viaSsh(PRIMARY_DISABLED, holdsCarrierIp, { backupRoute: { comment: 'backup' } }).evaluate(CARRIER_IP);

    assert.equal(verdict.publishable, false);
    assert.match(verdict.reason, /matches backupRoute.comment/);
  });

  test('backupRoute does not fire on a primary that does not match', async () => {
    const verdict = await viaSsh(PRIMARY_ROUTES, ADDRESSES, { backupRoute: { gateway: '^lte' } }).evaluate(PUBLIC_IP);

    assert.equal(verdict.publishable, true);
  });

  test('failover:"off" leaves only the address check', async () => {
    const verdict = await viaSsh(FAILOVER_ROUTES, holdsCarrierIp, { failover: 'off' }).evaluate(CARRIER_IP);

    assert.equal(verdict.publishable, true);
  });

  test('routingTable selects which table the default routes are read from', async () => {
    const routes = PRIMARY_ROUTES.map(r => ({ ...r, 'routing-table': 'wan' }));

    assert.equal((await viaSsh(routes).evaluate(PUBLIC_IP)).ok, false, 'none in main');
    assert.equal((await viaSsh(routes, ADDRESSES, { routingTable: 'wan' }).evaluate(PUBLIC_IP)).publishable, true);
  });

  test('a bad option fails open with a reason instead of throwing', async () => {
    for (const options of [{ failover: 'sometimes' }, { backupRoute: { gateway: '(' } }]) {
      const verdict = await viaSsh(PRIMARY_ROUTES, ADDRESSES, options).evaluate(PUBLIC_IP);

      assert.equal(verdict.ok, false);
      assert.match(verdict.reason, /misconfigured/);
    }
  });
});

describe('RouterOS ssh transport', () => {
  test('reads both tables in one non-interactive ssh call', async () => {
    const calls = [];
    const d = new RouterOS({ transport: 'ssh', ssh: { host: 'r.example', user: 'guard', port: 2222 } });
    d.runSsh = async args => { calls.push(args); return sshOutput(PRIMARY_ROUTES, ADDRESSES); };

    const verdict = await d.evaluate(PUBLIC_IP);

    assert.equal(verdict.detail.transport, 'ssh');
    assert.equal(calls.length, 1);
    const args = calls[0];
    assert.ok(args.includes('BatchMode=yes'));
    assert.ok(args.includes('guard@r.example'));
    assert.match(args.at(-1), /:serialize to=json \[\/ip\/route\/print as-value/);
    assert.match(args.at(-1), /:serialize to=json \[\/ip\/address\/print as-value/);
  });

  test('an ssh failure means could-not-determine, so the core fails open', async () => {
    const d = new RouterOS({ transport: 'ssh', ssh: { host: 'router' } });
    d.runSsh = async () => { throw new Error('Host key verification failed.'); };

    const verdict = await d.evaluate(PUBLIC_IP);

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /Host key verification failed/);
  });

  // RouterOS before 7.13 has no :serialize and prints an error instead.
  test('output that is not JSON means could-not-determine', async () => {
    const d = new RouterOS({ transport: 'ssh', ssh: { host: 'router' } });
    d.runSsh = async () => 'bad command name serialize (line 1 column 8)\r\nsyntax error\r\n';

    const verdict = await d.evaluate(PUBLIC_IP);

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /could not parse/);
  });
});

describe('RouterOS rest transport', () => {
  test('reads string-typed REST values and reaches the same verdicts', async () =>
    withRest({ routes: FAILOVER_ROUTES }, async url => {
      const d = new RouterOS({ transport: 'rest', url, username: 'guard', password: 'pw' });

      const verdict = await d.evaluate(CARRIER_IP);

      assert.equal(verdict.ok, true);
      assert.equal(verdict.publishable, false);
      assert.equal(verdict.detail.transport, 'rest');
      assert.equal(verdict.detail.activeDistance, 2);
    }));

  test('sends HTTP Basic auth to /rest', async () =>
    withRest({}, async (url, seen) => {
      const d = new RouterOS({ transport: 'rest', url: `${url}/`, username: 'guard', password: 'pw' });

      const verdict = await d.evaluate(PUBLIC_IP);

      assert.equal(verdict.publishable, true);
      assert.deepEqual(seen.map(s => s.url), ['/rest/ip/route?dst-address=0.0.0.0/0', '/rest/ip/address']);
      assert.ok(seen.every(s => s.auth === `Basic ${Buffer.from('guard:pw').toString('base64')}`));
    }));

  test('a rejected login means could-not-determine', async () =>
    withRest({ status: 401 }, async url => {
      const d = new RouterOS({ transport: 'rest', url, username: 'guard', password: 'wrong' });

      const verdict = await d.evaluate(PUBLIC_IP);

      assert.equal(verdict.ok, false);
      assert.match(verdict.reason, /HTTP 401/);
    }));

  test('auto prefers ssh and falls back to rest when ssh fails', async () =>
    withRest({}, async url => {
      const logs = [];
      const d = new RouterOS({ ssh: { host: 'router' }, url, username: 'guard', password: 'pw' }, msg => logs.push(msg));
      d.runSsh = async () => { throw new Error('connection refused'); };

      const verdict = await d.evaluate(PUBLIC_IP);

      assert.equal(verdict.publishable, true);
      assert.equal(verdict.detail.transport, 'rest');
      assert.ok(logs.some(l => /fell back to the rest transport/.test(l)));
    }));

  test('an explicit ssh transport does not fall back to rest', async () =>
    withRest({}, async (url, seen) => {
      const d = new RouterOS({ transport: 'ssh', ssh: { host: 'router' }, url, username: 'guard', password: 'pw' });
      d.runSsh = async () => { throw new Error('connection refused'); };

      const verdict = await d.evaluate(PUBLIC_IP);

      assert.equal(verdict.ok, false);
      assert.equal(seen.length, 0);
    }));

  test('reads username and password from the environment when asked to', () => {
    process.env.TEST_ROS_USER = 'guard-from-env';
    process.env.TEST_ROS_PW = 'from-env';
    const d = new RouterOS({ url: 'https://192.0.2.1', usernameEnv: 'TEST_ROS_USER', passwordEnv: 'TEST_ROS_PW' });

    assert.equal(d.username, 'guard-from-env');
    assert.equal(d.password, 'from-env');
    assert.deepEqual(d.transportOrder, ['rest']);
    delete process.env.TEST_ROS_USER;
    delete process.env.TEST_ROS_PW;
  });

  test('the ssh transport takes its user from ssh.user, not usernameEnv', async () => {
    process.env.TEST_ROS_USER = 'rest-only-user';
    let seen = null;
    const d = new RouterOS({ transport: 'ssh', ssh: { host: 'r.example', user: 'guard' }, usernameEnv: 'TEST_ROS_USER' });
    d.runSsh = async args => { seen = args; return sshOutput(PRIMARY_ROUTES, ADDRESSES); };

    await d.evaluate(PUBLIC_IP);

    assert.ok(seen.includes('guard@r.example'));
    delete process.env.TEST_ROS_USER;
  });

  test('is unusable, and says why, when nothing is configured', async () => {
    const verdict = await new RouterOS({}).evaluate(PUBLIC_IP);

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /not usable/);
  });
});

describe('RouterOS registration', () => {
  test('is selected by driver "routeros"', () => {
    const Config = { get: key => (key === 'router' ? { driver: 'routeros', options: { ssh: { host: 'router' } } } : undefined) };

    const driver = createRouterDriver(Config);

    assert.ok(driver instanceof RouterOS);
  });
});
