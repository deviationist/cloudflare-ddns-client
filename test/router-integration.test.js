import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import AsuswrtMerlin, { NVRAM_KEYS } from '../src/routers/AsuswrtMerlin.js';

// Opt-in tests that talk to a REAL router. Everything else in the suite runs
// against mocks and a fake router, and stays the primary coverage: it is
// deterministic, needs no credentials, and passes on a fresh clone.
//
// These exist to check the one thing mocks cannot — that our assumptions about
// the firmware still hold. They deliberately do NOT re-assert verdict logic:
// the correct verdict depends on what your WAN is doing right now, so such a
// test would need editing whenever your IP or uplink changed. They assert the
// *contract* instead: auth works, the keys we depend on exist, and the two
// transports agree with each other.
//
// Enable with DDNS_TEST_ROUTER=1, then:
//   DDNS_TEST_ROUTER_URL=https://192.168.1.1:8443
//   DDNS_TEST_ROUTER_USER=admin
//   ROUTER_PASSWORD=...              (web transport)
//   DDNS_TEST_ROUTER_SSH_HOST=192.168.1.1
//   DDNS_TEST_ROUTER_SSH_USER=admin  (ssh transport, optional)
//
// Credentials alone are NOT the trigger: anyone running this client has
// ROUTER_PASSWORD in their environment already, and `npm test` must never start
// talking to their router because of that. The opt-in flag is the trigger, and
// a missing prerequisite skips *visibly* rather than passing quietly.
const enabled = process.env.DDNS_TEST_ROUTER === '1';

const web = {
  url: process.env.DDNS_TEST_ROUTER_URL,
  username: process.env.DDNS_TEST_ROUTER_USER,
  password: process.env.ROUTER_PASSWORD,
};
const sshHost = process.env.DDNS_TEST_ROUTER_SSH_HOST;

const why = (what, ready) => {
  if (!enabled) return 'DDNS_TEST_ROUTER is not 1 (opt-in)';
  if (!ready) return `${what} not configured (see the header of this file)`;
  return false;
};

const webReady = !!(web.url && web.username && web.password);
const sshReady = !!sshHost;

const webDriver = () => new AsuswrtMerlin({ transport: 'web', ...web, verifySsl: process.env.DDNS_TEST_ROUTER_VERIFY_SSL === '1' });
const sshDriver = () => new AsuswrtMerlin({
  transport: 'ssh',
  ssh: { host: sshHost, user: process.env.DDNS_TEST_ROUTER_SSH_USER },
});

describe('real router (opt-in)', () => {
  test('web: authentication still yields a token cookie', { skip: why('web transport', webReady) }, async () => {
    const d = webDriver();

    assert.equal(await d.login(), true, 'login.cgi did not return an asus_token cookie');
    assert.match(d.cookie, /^asus_s?_token=/);
  });

  // An unset nvram key and a *nonexistent* one are indistinguishable: both come
  // back as an empty string over web and as undefined over ssh. So this cannot
  // assert on all of NVRAM_KEYS — several are legitimately empty (an idle
  // secondary WAN has no realip). It asserts on the keys that must always carry
  // a value on a working router; a firmware update renaming one of those would
  // otherwise degrade the guard to fail-open forever, unnoticed.
  const ALWAYS_POPULATED = ['wans_dualwan', 'wan0_primary', 'wan1_primary', 'wan0_ipaddr'];
  const blank = (values, keys) => keys.filter(key => values[key] === undefined || values[key] === '');

  test('web: the load-bearing nvram keys still carry values', { skip: why('web transport', webReady) }, async () => {
    const values = await webDriver().readViaWeb(NVRAM_KEYS);

    const missing = blank(values, ALWAYS_POPULATED);
    assert.deepEqual(missing, [], `firmware no longer returns: ${missing.join(', ')}`);
  });

  test('ssh: the load-bearing nvram keys still carry values', { skip: why('ssh transport', sshReady) }, async () => {
    const values = await sshDriver().readViaSsh(NVRAM_KEYS);

    const missing = blank(values, ALWAYS_POPULATED);
    assert.deepEqual(missing, [], `router no longer returns: ${missing.join(', ')}`);
  });

  // The most valuable of these, and the most stable: it holds regardless of
  // what the WAN is doing, so it never needs updating — and a divergence in how
  // the two transports parse values is exactly the bug that unit tests with
  // separate stubs cannot catch.
  test('both transports report identical values', { skip: why('both transports', webReady && sshReady) }, async () => {
    const [viaWeb, viaSsh] = await Promise.all([
      webDriver().readViaWeb(NVRAM_KEYS),
      sshDriver().readViaSsh(NVRAM_KEYS),
    ]);

    for (const key of NVRAM_KEYS) {
      // The web transport yields '' where ssh yields undefined for an unset
      // key; normalise so the comparison is about values, not that quirk.
      const w = viaWeb[key] === '' ? undefined : viaWeb[key];
      assert.equal(w, viaSsh[key], `transports disagree on ${key}`);
    }
  });

  test('the guard reaches a verdict against the real router', { skip: why('any transport', webReady || sshReady) }, async () => {
    const verdict = await (sshReady ? sshDriver() : webDriver()).evaluate();

    // Not asserting publishable: that depends on the live WAN. Asserting only
    // that the driver could decide at all.
    assert.equal(verdict.ok, true, `guard could not determine WAN state: ${verdict.reason}`);
    assert.equal(typeof verdict.publishable, 'boolean');
  });
});
