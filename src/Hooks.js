import { spawn } from 'child_process';

const DEFAULT_TIMEOUT = 60000;

export const EVENTS = ['publicIpChanged', 'dnsRecordUpdated', 'error', 'always'];

// Config keys from the object form that map onto an event name.
const EVENT_ALIASES = { onIpChange: 'dnsRecordUpdated' };

export default class Hooks {
  hooks;
  logger;
  dryRun;
  executed = new Set();
  aborted = false;

  constructor(Config, logger, { dryRun = false } = {}) {
    this.logger = logger;
    this.dryRun = dryRun;
    this.hooks = Hooks.normalize(Config.get('hooks'));
    this.hooks.forEach(hook => {
      hook.on
        .filter(event => !EVENTS.includes(event))
        .forEach(event => this.logger(`Hook "${hook.name}" listens to unknown event "${event}", it will never fire.`, 'error'));
    });
  }

  // Accepts an array of hooks, or an object keyed by event name. Each entry is
  // either a plain command string or a full hook object.
  static normalize(configured) {
    if (!configured) return [];

    const entries = [];
    if (Array.isArray(configured)) {
      configured.forEach(hook => entries.push([null, hook]));
    } else if (typeof configured === 'object') {
      Object.entries(configured).forEach(([key, value]) => {
        const event = EVENT_ALIASES[key] || key;
        (Array.isArray(value) ? value : [value]).forEach(hook => entries.push([event, hook]));
      });
    }

    return entries
      .map(([event, hook], index) => {
        if (typeof hook === 'string') hook = { command: hook };
        if (!hook?.command) return null;

        const on = event
          ? [event]
          : (Array.isArray(hook.on) ? hook.on : [hook.on || 'publicIpChanged']);

        return {
          name: hook.name || hook.command,
          command: hook.command,
          args: Array.isArray(hook.args) ? hook.args.map(String) : [],
          cwd: hook.cwd || undefined,
          env: hook.env && typeof hook.env === 'object' ? hook.env : {},
          shell: hook.shell === true,
          timeout: Number.isFinite(hook.timeout) ? hook.timeout : DEFAULT_TIMEOUT,
          enabled: hook.enabled !== false,
          once: hook.once !== false,
          stopOnError: hook.stopOnError === true,
          on: on.map(String),
          index
        };
      })
      .filter(Boolean);
  }

  isConfigured() {
    return this.hooks.some(hook => hook.enabled);
  }

  hasHooksFor(event) {
    return this.hooks.some(hook => hook.enabled && hook.on.includes(event));
  }

  buildEnv(hook, event, payload) {
    return {
      ...process.env,
      ...hook.env,
      DDNS_EVENT: event,
      DDNS_OLD_IP: payload.oldIp ?? '',
      DDNS_NEW_IP: payload.newIp ?? '',
      DDNS_RECORDS: (payload.records ?? []).join(','),
      DDNS_ERRORS: (payload.errors ?? []).join('\n'),
      DDNS_SERVICE_ID: payload.serviceId ?? '',
      DDNS_PAYLOAD: JSON.stringify({ event, ...payload })
    };
  }

  // Runs every enabled hook subscribed to `event`, sequentially. Never rejects:
  // failures come back as results so the caller decides what they mean.
  async dispatch(event, payload = {}) {
    const results = [];
    for (const hook of this.hooks) {
      if (this.aborted) break;
      if (!hook.enabled || !hook.on.includes(event)) continue;

      if (hook.once && this.executed.has(hook.index)) {
        this.logger(`Hook "${hook.name}" already ran this session, skipping "${event}".`);
        continue;
      }
      this.executed.add(hook.index);

      let result;
      if (this.dryRun) {
        this.logger(`Would run hook "${hook.name}" for "${event}": ${`${hook.command} ${hook.args.join(' ')}`.trim()}`);
        result = { hook, event, skipped: true, success: true };
      } else {
        result = await this.run(hook, event, payload);
      }
      results.push(result);

      if (!result.success && hook.stopOnError) {
        this.aborted = true;
        this.logger(`Hook "${hook.name}" failed and has stopOnError set, skipping all remaining hooks.`, 'error');
      }
    }
    return results;
  }

  run(hook, event, payload) {
    return new Promise(resolve => {
      this.logger(`Running hook "${hook.name}" for "${event}".`);

      const child = spawn(hook.command, hook.args, {
        cwd: hook.cwd,
        env: this.buildEnv(hook, event, payload),
        shell: hook.shell,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });

      // The timer is ours rather than spawn's own `timeout` option: that one
      // stays armed when the spawn itself fails, holding the process open for
      // the whole timeout after an unusable command.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, hook.timeout);

      // Settle on "exit" rather than "close": a hook that leaves a background
      // child behind keeps the output pipes open, and waiting for those to
      // close would hang the client for as long as that child lives — past the
      // hook's own timeout.
      let settled = false;
      const settle = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(result);
      };

      child.on('error', error => {
        this.logger(`Hook "${hook.name}" could not be executed: ${error.message}`, 'error');
        settle({ hook, event, success: false, error: error.message });
      });

      child.on('exit', (code, signal) => setImmediate(() => {
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        if (output) this.logger(`Hook "${hook.name}" output: ${output}`);

        if (timedOut || signal) {
          const message = timedOut
            ? `timed out after ${hook.timeout}ms`
            : `was killed by signal ${signal}`;
          this.logger(`Hook "${hook.name}" ${message}.`, 'error');
          settle({ hook, event, success: false, error: message, output });
          return;
        }

        if (code === 0) {
          this.logger(`Hook "${hook.name}" completed successfully.`);
          settle({ hook, event, success: true, output });
        } else {
          this.logger(`Hook "${hook.name}" exited with code ${code}.`, 'error');
          settle({ hook, event, success: false, error: `exited with code ${code}`, output });
        }
      }));
    });
  }
}
