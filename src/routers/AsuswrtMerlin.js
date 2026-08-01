import https from 'https';
import http from 'http';
import { URL } from 'url';
import RouterDriver from './RouterDriver.js';

// Asuswrt(-Merlin) exposes nvram over its web UI: authenticate at /login.cgi to
// obtain an `asus_token` cookie, then read any nvram key via
// /appGet.cgi?hook=nvram_get(<key>). This driver reuses that flow purely to
// decide whether the active WAN is a real, publishable public connection.
const USER_AGENT = 'asusrouter-Android-DUTUtil-1.0.0.201';

// Ranges that must never be published as a "public" IP. 100.64.0.0/10 is
// RFC 6598 carrier-grade NAT — the tell-tale sign of a CGNAT'd uplink.
const NON_PUBLIC_V4 = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10], // RFC 6598 — carrier-grade NAT
  ['169.254.0.0', 16], // link-local
  ['127.0.0.0', 8],
];

function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4 || p.some((o) => o === '' || Number.isNaN(+o) || +o < 0 || +o > 255)) return null;
  return (((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + +p[3]) >>> 0;
}

function inCidr(ip, base, bits) {
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function isNonPublicV4(ip) {
  return NON_PUBLIC_V4.some(([base, bits]) => inCidr(ip, base, bits));
}

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
    this.username = options.username;
    this.password = options.passwordEnv ? process.env[options.passwordEnv] : options.password;
    // Default to verifying TLS; set verifySsl:false for a router's self-signed cert.
    this.rejectUnauthorized = options.verifySsl !== false;
    this.timeout = options.timeoutMs || 10000;
    this.cookie = null;
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

  async evaluate() {
    if (!this.baseUrl || !this.username) {
      return { ok: false, publishable: false, reason: 'router driver missing url/username' };
    }
    if (!this.password) {
      return {
        ok: false,
        publishable: false,
        reason: `router password not set${this.options.passwordEnv ? ` (env "${this.options.passwordEnv}")` : ''}`,
      };
    }

    try {
      if (!(await this.login())) {
        return { ok: false, publishable: false, reason: 'router login failed' };
      }

      const dualwan = await this.nvram('wans_dualwan'); // e.g. "wan none" / "wan usb"
      const wan1Primary = await this.nvram('wan1_primary'); // "1" when the secondary unit is active
      const active = wan1Primary === '1' ? 1 : 0;
      const onSecondary = !!dualwan && dualwan !== 'wan none' && active === 1;

      const ipaddr = await this.nvram(`wan${active}_ipaddr`);
      const realipState = await this.nvram(`wan${active}_realip_state`);
      const realip = await this.nvram(`wan${active}_realip_ip`);

      const detail = { dualwan, active, ipaddr, realip, onSecondary };

      // Signal 1 — intent: the router has failed over to its secondary uplink.
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

      return { ok: true, publishable: true, reason: `WAN on primary, public IP ${ipaddr || '(unknown)'}`, detail };
    } catch (e) {
      return { ok: false, publishable: false, reason: `router query error: ${e.message}` };
    }
  }
}
