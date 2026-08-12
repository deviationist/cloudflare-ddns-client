import https from 'https';
import http from 'http';
import { execFile } from 'child_process';
import { URL } from 'url';
import RouterDriver from './RouterDriver.js';
import { isNonPublicV4 } from './addresses.js';

// Asuswrt(-Merlin) keeps its WAN state in nvram. This driver reads a handful of
// those keys purely to decide whether the active WAN is a real, publishable
// public connection, over either of two transports:
//
//   web — authenticate at /login.cgi for an asus_token cookie, then read keys
//         via /appGet.cgi?hook=nvram_get(<key>). Needs an admin password, and
//         needs the calling host to be allowed to reach the *web UI*.
//   ssh — run `nvram get` over SSH. Needs no password when key auth is set up,
//         and on firmware with an admin source-allowlist a host is often
//         permitted SSH but not the web UI, which makes this the easier path.
//
// `transport: "auto"` (the default) tries whichever is configured, preferring
// ssh, and falls back to the other if the first cannot answer — so a router
// password rotation or a revoked SSH key degrades instead of blinding the guard.
const USER_AGENT = 'asusrouter-Android-DUTUtil-1.0.0.201';

// Read in one go so the ssh transport needs a single round trip, and so the
// active-WAN index can be decided from the values rather than by re-querying.
const NVRAM_KEYS = [
  'wans_dualwan',
  'wan0_primary',
  'wan1_primary',
  'wan0_ipaddr',
  'wan1_ipaddr',
  'wan0_realip_state',
  'wan1_realip_state',
  'wan0_realip_ip',
  'wan1_realip_ip',
];

const SAFE_KEY = /^[a-z0-9_]+$/;

function httpRequest(urlStr, { method = 'GET', headers = {}, body = null, rejectUnauthorized = true, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers,
      timeout,
    };
    if (u.protocol === 'https:') opts.rejectUnauthorized = rejectUnauthorized;
    const req = mod.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

export default class AsuswrtMerlin extends RouterDriver {
  static driverName = 'asuswrt-merlin';

  constructor(options = {}, logger = () => {}) {
    super(options, logger);
    this.baseUrl = (options.url || '').replace(/\/+$/, '');
    this.username = options.usernameEnv ? process.env[options.usernameEnv] : options.username;
    this.password = options.passwordEnv ? process.env[options.passwordEnv] : options.password;
    // Default to verifying TLS; set verifySsl:false for a router's self-signed cert.
    this.rejectUnauthorized = options.verifySsl !== false;
    this.timeout = options.timeoutMs || 10000;
    this.ssh = options.ssh || null;
    this.transport = options.transport || 'auto';
    this.cookie = null;
  }

  get webConfigured() {
    return !!(this.baseUrl && this.username && this.password);
  }

  get sshConfigured() {
    return !!(this.ssh && this.ssh.host);
  }

  // Which transports to try, in order. "auto" prefers ssh: it needs no stored
  // password, so it is both the cheaper credential and the one less likely to
  // be blocked by an admin source-allowlist.
  get transportOrder() {
    if (this.transport === 'ssh') return this.sshConfigured ? ['ssh'] : [];
    if (this.transport === 'web') return this.webConfigured ? ['web'] : [];
    return [this.sshConfigured && 'ssh', this.webConfigured && 'web'].filter(Boolean);
  }

  async login() {
    const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    const body = `login_authorization=${encodeURIComponent(token)}`;
    const res = await httpRequest(`${this.baseUrl}/login.cgi`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      rejectUnauthorized: this.rejectUnauthorized,
      timeout: this.timeout,
    });
    // Cookie name varies by firmware: asus_token (older) / asus_s_token (388.x+).
    const setCookie = res.headers['set-cookie'] || [];
    const tokenCookie = setCookie.map((c) => c.split(';')[0]).find((c) => /^asus_s?_token=/.test(c));
    if (!tokenCookie) return false;
    this.cookie = tokenCookie;
    return true;
  }

  async nvram(key) {
    const res = await httpRequest(`${this.baseUrl}/appGet.cgi?hook=nvram_get(${key})`, {
      headers: { 'User-Agent': USER_AGENT, Cookie: this.cookie },
      rejectUnauthorized: this.rejectUnauthorized,
      timeout: this.timeout,
    });
    try {
      return JSON.parse(res.body)[key];
    } catch (e) {
      return undefined;
    }
  }

  async readViaWeb(keys) {
    if (!(await this.login())) throw new Error('router login failed');
    const values = {};
    for (const key of keys) values[key] = await this.nvram(key);
    return values;
  }

  // Overridable so tests can drive the transport without a real ssh binary.
  runSsh(args, timeoutMs) {
    const binary = this.ssh.sshBinary || 'ssh';
    return new Promise((resolve, reject) => {
      execFile(binary, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || '').trim() || error.message));
          return;
        }
        resolve(stdout);
      });
    });
  }

  async readViaSsh(keys) {
    const unsafe = keys.filter((key) => !SAFE_KEY.test(key));
    if (unsafe.length) throw new Error(`refusing to query unsafe nvram key(s): ${unsafe.join(', ')}`);

    // One invocation for all keys: `key=value` per line. BatchMode makes a
    // missing key or an unknown host fail immediately rather than prompting and
    // hanging a cron run forever.
    const remote = `for k in ${keys.join(' ')}; do printf '%s=%s\\n' "$k" "$(nvram get "$k")"; done`;
    const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.max(1, Math.round(this.timeout / 1000))}`];
    if (this.ssh.strictHostKeyChecking) args.push('-o', `StrictHostKeyChecking=${this.ssh.strictHostKeyChecking}`);
    if (this.ssh.identityFile) args.push('-i', this.ssh.identityFile);
    if (this.ssh.port) args.push('-p', String(this.ssh.port));
    args.push(this.ssh.user ? `${this.ssh.user}@${this.ssh.host}` : this.ssh.host, remote);

    const stdout = await this.runSsh(args, this.timeout);
    const values = {};
    for (const line of String(stdout).split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      const value = line.slice(at + 1).trim();
      values[line.slice(0, at)] = value === '' ? undefined : value;
    }
    return values;
  }

  // Tries each configured transport in turn. A transport that throws is logged
  // and the next one is tried; only when all of them fail does the guard report
  // "could not determine", which the core treats as fail-open.
  async readAll(keys) {
    const order = this.transportOrder;
    if (!order.length) return { values: null, transport: null, error: 'no usable transport configured' };

    const failures = [];
    for (const transport of order) {
      try {
        const values = transport === 'ssh' ? await this.readViaSsh(keys) : await this.readViaWeb(keys);
        if (!values || values.wans_dualwan === undefined) throw new Error('router returned no WAN state');
        if (failures.length) this.logger(`Router guard fell back to the ${transport} transport.`, 'warn');
        return { values, transport, error: null };
      } catch (e) {
        failures.push(`${transport}: ${e.message}`);
      }
    }
    return { values: null, transport: null, error: failures.join('; ') };
  }

  async evaluate() {
    if (!this.transportOrder.length) {
      // Report the *reason* it is unusable, since "no transport" is nearly
      // always a half-finished config rather than a deliberate choice.
      const why = this.transport === 'ssh' || (this.transport === 'auto' && this.ssh)
        ? 'ssh transport needs router.options.ssh.host'
        : `web transport needs url, username and password${this.options.passwordEnv ? ` (env "${this.options.passwordEnv}")` : ''}`;
      return { ok: false, publishable: false, reason: `router driver not usable: ${why}` };
    }

    const { values, transport, error } = await this.readAll(NVRAM_KEYS);
    if (!values) return { ok: false, publishable: false, reason: `router query error (${error})` };

    const dualwan = values.wans_dualwan; // e.g. "wan none" / "wan usb"
    const active = values.wan1_primary === '1' ? 1 : 0;
    const onSecondary = !!dualwan && dualwan !== 'wan none' && active === 1;

    const ipaddr = values[`wan${active}_ipaddr`];
    const realipState = values[`wan${active}_realip_state`];
    const realip = values[`wan${active}_realip_ip`];

    const detail = { dualwan, active, ipaddr, realip, onSecondary, transport };

    // Signal 1 — intent: the router has failed over to its secondary uplink.
    // Deliberately checked before the address, so a failover path that happens
    // to hand out a routable address is still treated as not-publishable.
    if (onSecondary) {
      return { ok: true, publishable: false, reason: 'router is on its secondary WAN (failover active)', detail };
    }
    // Signal 2 — the active WAN address is itself private/CGNAT.
    if (ipaddr && isNonPublicV4(ipaddr)) {
      return { ok: true, publishable: false, reason: `WAN IP ${ipaddr} is in a private/CGNAT range`, detail };
    }
    // Signal 3 — the router's own external-IP probe disagrees with the WAN IP
    // (realip_state === '2' means the probe succeeded), i.e. an upstream NAT.
    if (realipState === '2' && realip && ipaddr && realip !== ipaddr) {
      return { ok: true, publishable: false, reason: `upstream NAT detected (WAN ${ipaddr} != external ${realip})`, detail };
    }

    return { ok: true, publishable: true, reason: `WAN on primary, public IP ${ipaddr || '(unknown)'} (via ${transport})`, detail };
  }
}
