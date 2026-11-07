import { readFileSync } from 'fs';
import RouterDriver from './RouterDriver.js';
import { isPublicV4 } from './addresses.js';
import { httpRequest, sshArgs, execSsh } from './transport.js';

// MikroTik RouterOS 7. Reads two tables and decides from them alone:
//
//   default routes (main table) — is the active one the best one configured?
//     Failover on RouterOS is route distance: the backup uplink's default route
//     carries a higher distance and only becomes active when every better route
//     has gone (link down, check-gateway, netwatch). So "the active default
//     route has a higher distance than the best enabled one" *is* failover, with
//     no need to know which interface is which, or how the primary is checked.
//   interface addresses — does the router itself hold the detected public IP?
//     If it does, inbound traffic to that IP arrives here. If it does not, the
//     address belongs to someone upstream (CGNAT, a carrier NAT, an ISP modem
//     doing NAT), and publishing it would point DNS at their box.
//
// Two transports, both read-only and both returning JSON:
//
//   ssh  — `:serialize to=json` (RouterOS 7.13+) over SSH. Key auth, no stored
//          password. Both tables in a single round trip.
//   rest — the REST API at /rest on the router's www-ssl service (RouterOS 7.1+),
//          with HTTP Basic auth. Not the binary API service (8728/8729): those
//          can stay disabled.
//
// A dedicated user in the built-in `read` group is enough for either.

const SSH_COMMAND = [
  ':put [:serialize to=json [/ip/route/print as-value where dst-address=0.0.0.0/0]]',
  ':put [:serialize to=json [/ip/address/print as-value]]',
].join('; ');

// REST returns every value as a string ("true", "1"); :serialize returns typed
// JSON. Normalise both so the decision logic sees one shape.
const asBool = (v) => v === true || v === 'true' || v === 'yes';
const asInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

export function normaliseRoutes(rows, routingTable = 'main') {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r['dst-address'] === '0.0.0.0/0')
    .filter((r) => (r['routing-table'] || 'main') === routingTable)
    .filter((r) => !asBool(r.disabled))
    .map((r) => ({
      gateway: r.gateway,
      distance: asInt(r.distance),
      active: asBool(r.active),
      comment: r.comment,
    }));
}

export function normaliseAddresses(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((a) => a && a.address && !asBool(a.disabled) && !asBool(a.invalid))
    .map((a) => ({ ip: String(a.address).split('/')[0], interface: a.interface }));
}

export default class RouterOS extends RouterDriver {
  static driverName = 'routeros';

  constructor(options = {}, logger = () => {}) {
    super(options, logger);
    this.baseUrl = (options.url || '').replace(/\/+$/, '');
    this.username = options.usernameEnv ? process.env[options.usernameEnv] : options.username;
    this.password = options.passwordEnv ? process.env[options.passwordEnv] : options.password;
    // Verify TLS by default. For a router signing its own certificate, pin its
    // CA with caFile rather than turning verification off.
    this.rejectUnauthorized = options.verifySsl !== false;
    this.caFile = options.caFile || null;
    this.timeout = options.timeoutMs || 10000;
    this.ssh = options.ssh || null;
    this.transport = options.transport || 'auto';
    // How to conclude "not publishable". Every default works with no config;
    // each exists for a setup the defaults can't see.
    //
    // routingTable    — the table holding the default routes.
    // failover        — "distance" (default): a default route with a higher
    //                   distance than the primary is active. "off": skip.
    // primaryDistance — the primary route's distance. Default: the best distance
    //                   among enabled default routes. Pin it when failover works
    //                   by *disabling* the primary, which hides it from that min.
    // backupRoute     — { gateway, comment } regexes; an active route matching
    //                   either is a backup, whatever its distance.
    // checkAddress    — the router must hold the detected IP itself. Off only for
    //                   a router behind 1:1 NAT, where it would pause forever.
    this.routingTable = options.routingTable || 'main';
    this.failoverMode = options.failover || 'distance';
    this.primaryDistance = options.primaryDistance ?? null;
    // A bad option is reported through the verdict (fail open), never thrown:
    // a typo in config must not crash the run.
    this.configError = null;
    if (!['distance', 'off'].includes(this.failoverMode)) {
      this.configError = `failover must be "distance" or "off", not "${this.failoverMode}"`;
    }
    const br = options.backupRoute || {};
    this.backupRoute = { gateway: null, comment: null };
    for (const key of ['gateway', 'comment']) {
      if (!br[key]) continue;
      try {
        this.backupRoute[key] = new RegExp(br[key]);
      } catch (e) {
        this.configError = `backupRoute.${key} is not a valid regex (${e.message})`;
      }
    }
    this.checkAddress = options.checkAddress !== false;
  }

  // Why the active route counts as a backup, or null when it doesn't.
  backupReason(route, bestDistance) {
    const { gateway, comment } = this.backupRoute;
    if (gateway && route.gateway && gateway.test(route.gateway)) return `gateway ${route.gateway} matches backupRoute.gateway`;
    if (comment && route.comment && comment.test(route.comment)) return `comment matches backupRoute.comment`;
    if (this.failoverMode === 'distance' && route.distance !== null) {
      const primary = this.primaryDistance ?? bestDistance;
      if (route.distance > primary) return `distance ${route.distance} > ${primary}`;
    }
    return null;
  }

  get restConfigured() {
    return !!(this.baseUrl && this.username && this.password);
  }

  get sshConfigured() {
    return !!(this.ssh && this.ssh.host);
  }

  // Same policy as the other drivers: "auto" prefers ssh (no stored password)
  // and falls back, so one broken credential degrades instead of blinding.
  get transportOrder() {
    if (this.transport === 'ssh') return this.sshConfigured ? ['ssh'] : [];
    if (this.transport === 'rest') return this.restConfigured ? ['rest'] : [];
    return [this.sshConfigured && 'ssh', this.restConfigured && 'rest'].filter(Boolean);
  }

  // Overridable so tests can drive the transport without a real ssh binary.
  runSsh(args, timeoutMs) {
    return execSsh(this.ssh.sshBinary, args, timeoutMs);
  }

  async readViaSsh() {
    const stdout = await this.runSsh(sshArgs(this.ssh, this.timeout, SSH_COMMAND), this.timeout);
    const lines = String(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) throw new Error(`unexpected output (${lines.length} line(s); RouterOS 7.13+ needed for :serialize)`);
    let routes;
    let addresses;
    try {
      routes = JSON.parse(lines[0]);
      addresses = JSON.parse(lines[1]);
    } catch (e) {
      throw new Error(`could not parse router output as JSON: ${lines[0].slice(0, 80)}`);
    }
    return { routes, addresses };
  }

  async restGet(path) {
    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    if (this.caFile && this.ca === undefined) this.ca = readFileSync(this.caFile, 'utf8');
    const res = await httpRequest(`${this.baseUrl}/rest${path}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      rejectUnauthorized: this.rejectUnauthorized,
      ca: this.ca,
      timeout: this.timeout,
    });
    if (res.status !== 200) throw new Error(`GET /rest${path} returned HTTP ${res.status}`);
    try {
      return JSON.parse(res.body);
    } catch (e) {
      throw new Error(`GET /rest${path} did not return JSON`);
    }
  }

  async readViaRest() {
    const routes = await this.restGet('/ip/route?dst-address=0.0.0.0/0');
    const addresses = await this.restGet('/ip/address');
    return { routes, addresses };
  }

  async readAll() {
    const order = this.transportOrder;
    if (!order.length) return { data: null, transport: null, error: 'no usable transport configured' };

    const failures = [];
    for (const transport of order) {
      try {
        const data = transport === 'ssh' ? await this.readViaSsh() : await this.readViaRest();
        if (failures.length) this.logger(`Router guard fell back to the ${transport} transport.`, 'warn');
        return { data, transport, error: null };
      } catch (e) {
        failures.push(`${transport}: ${e.message}`);
      }
    }
    return { data: null, transport: null, error: failures.join('; ') };
  }

  async evaluate(detectedIp) {
    if (this.configError) {
      return { ok: false, publishable: false, reason: `router driver misconfigured: ${this.configError}` };
    }
    if (!this.transportOrder.length) {
      const why = this.transport === 'ssh' || (this.transport === 'auto' && this.ssh)
        ? 'ssh transport needs router.options.ssh.host'
        : `rest transport needs url, username and password${this.options.passwordEnv ? ` (env "${this.options.passwordEnv}")` : ''}`;
      return { ok: false, publishable: false, reason: `router driver not usable: ${why}` };
    }

    const { data, transport, error } = await this.readAll();
    if (!data) return { ok: false, publishable: false, reason: `router query error (${error})` };

    const routes = normaliseRoutes(data.routes, this.routingTable);
    const addresses = normaliseAddresses(data.addresses);

    // No default route in the table, or none active: the router is using
    // something this driver does not model (VRFs, policy routing). Don't guess.
    if (!routes.length) {
      return { ok: false, publishable: false, reason: `router has no default route in table "${this.routingTable}" (via ${transport})` };
    }
    const active = routes.filter((r) => r.active);
    if (!active.length) {
      return { ok: false, publishable: false, reason: `router has no active default route (via ${transport})` };
    }

    const known = (xs) => xs.filter((d) => d !== null);
    const bestDistance = Math.min(...known(routes.map((r) => r.distance)));
    const activeRoute = active.reduce((a, b) => ((b.distance ?? Infinity) < (a.distance ?? Infinity) ? b : a));
    const held = detectedIp ? addresses.find((a) => a.ip === detectedIp) : null;

    const detail = {
      transport,
      activeGateway: activeRoute.gateway,
      activeDistance: activeRoute.distance,
      activeComment: activeRoute.comment,
      bestDistance,
      publicAddresses: addresses.filter((a) => isPublicV4(a.ip)),
    };
    const label = activeRoute.comment ? ` "${activeRoute.comment}"` : '';

    // Signal 1 — intent: a backup route is carrying traffic. Checked before any
    // address, so a failover uplink with a routable address still pauses.
    const backup = this.backupReason(activeRoute, bestDistance);
    if (backup) {
      return {
        ok: true,
        publishable: false,
        reason: `router is on a backup default route${label} (gateway ${activeRoute.gateway}, ${backup}): failover active`,
        detail,
      };
    }

    // Signal 2 — the router does not hold the address the internet sees, so
    // something upstream is translating it.
    if (this.checkAddress && detectedIp) {
      if (!held) {
        return {
          ok: true,
          publishable: false,
          reason: `detected IP ${detectedIp} is not assigned to any router interface (upstream NAT/CGNAT)`,
          detail,
        };
      }
      if (!isPublicV4(held.ip)) {
        return { ok: true, publishable: false, reason: `detected IP ${detectedIp} is in a private/CGNAT range`, detail };
      }
    }

    const where = held ? ` on ${held.interface}` : '';
    return {
      ok: true,
      publishable: true,
      reason: `router on its primary default route${label}, public IP ${detectedIp || '(not checked)'}${where} (via ${transport})`,
      detail,
    };
  }
}
