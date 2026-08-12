import { execFile } from 'child_process';
import RouterDriver from './RouterDriver.js';
import { isNonPublicV4, ipToInt } from './addresses.js';

// A router-agnostic driver: you supply a command, its stdout decides the
// verdict. This exists so the guard is usable without a bundled driver for
// your specific router — anything you can query from a shell (a vendor CLI,
// SSH into the router, curl + grep of a modem status page, SNMP) can drive it
// with config alone, no JavaScript.
//
// Two output shapes are accepted:
//
//   1. A bare IPv4 address — the WAN address as the router sees it. The driver
//      classifies it: a private/CGNAT address means "don't publish". This is
//      the easy path, and covers most routers.
//   2. JSON — `{"publishable": true|false, "reason": "...", "detail": {...}}`
//      for anything the address alone can't express, e.g. "I am on my failover
//      uplink" even when that uplink has a routable address.
//
// The exit status is *not* the verdict. A non-zero exit, a timeout, or an
// unparseable output all mean "could not determine", which the core treats as
// fail-open — the same as an unreachable router. Encoding the verdict in the
// exit status would make a broken script indistinguishable from a real pause,
// and a broken script must never silently freeze DNS updates.
export default class CommandDriver extends RouterDriver {
  static driverName = 'command';

  constructor(options = {}, logger = () => {}) {
    super(options, logger);
    this.command = options.command;
    this.args = options.args || [];
    this.shell = options.shell === true;
    this.timeout = options.timeoutMs || 10000;
  }

  // Overridable so tests can drive the contract without spawning processes.
  run(detectedIp) {
    return new Promise((resolve, reject) => {
      execFile(
        this.command,
        this.args,
        {
          shell: this.shell,
          timeout: this.timeout,
          encoding: 'utf8',
          // The detected IP is passed through so a script can compare it with
          // what the router believes, without having to look it up again.
          env: { ...process.env, DDNS_DETECTED_IP: detectedIp || '' },
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error((stderr || '').trim() || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  parse(stdout) {
    const output = String(stdout).trim();
    if (!output) return { ok: false, publishable: false, reason: 'command produced no output' };

    if (output.startsWith('{')) {
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch (e) {
        return { ok: false, publishable: false, reason: 'command output looked like JSON but did not parse' };
      }
      if (typeof parsed.publishable !== 'boolean') {
        return { ok: false, publishable: false, reason: 'command JSON is missing a boolean "publishable"' };
      }
      return {
        ok: true,
        publishable: parsed.publishable,
        reason: parsed.reason || (parsed.publishable ? 'command reported a publishable connection' : 'command reported the connection is not publishable'),
        detail: parsed.detail,
      };
    }

    if (ipToInt(output) === null) {
      // Deliberately not echoed: a misconfigured command can emit an entire
      // HTML page, and that would end up in the log file.
      return { ok: false, publishable: false, reason: 'command output was neither an IPv4 address nor JSON' };
    }

    return isNonPublicV4(output)
      ? { ok: true, publishable: false, reason: `WAN IP ${output} is in a private/CGNAT range`, detail: { ipaddr: output } }
      : { ok: true, publishable: true, reason: `WAN IP ${output} is publicly routable`, detail: { ipaddr: output } };
  }

  async evaluate(detectedIp) {
    if (!this.command) {
      return { ok: false, publishable: false, reason: 'router driver not usable: command driver needs router.options.command' };
    }
    try {
      return this.parse(await this.run(detectedIp));
    } catch (e) {
      return { ok: false, publishable: false, reason: `command failed (${e.message})` };
    }
  }
}
