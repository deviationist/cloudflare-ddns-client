import { spawn } from 'child_process';

const DEFAULT_TIMEOUT = 60000;

export default class Hooks {
  hooks;
  logger;
  dryRun;

  constructor(Config, logger, { dryRun = false } = {}) {
    const configured = Config.get('hooks')?.onIpChange ?? [];
    this.hooks = Hooks.normalize(configured);
    this.logger = logger;
    this.dryRun = dryRun;
  }

  // Accepts either a plain command string or a full hook object.
  static normalize(hooks) {
    if (!Array.isArray(hooks)) return [];
    return hooks
      .map((hook, index) => {
        if (typeof hook === 'string') hook = { command: hook };
        if (!hook?.command) return null;
        return {
          name: hook.name || hook.command,
          command: hook.command,
          args: Array.isArray(hook.args) ? hook.args.map(String) : [],
          cwd: hook.cwd || undefined,
          env: hook.env && typeof hook.env === 'object' ? hook.env : {},
          shell: hook.shell === true,
          timeout: Number.isFinite(hook.timeout) ? hook.timeout : DEFAULT_TIMEOUT,
          enabled: hook.enabled !== false,
          index
        };
      })
      .filter(Boolean);
  }

  isConfigured() {
    return this.hooks.some(hook => hook.enabled);
  }

  buildEnv(hook, payload) {
    return {
      ...process.env,
      ...hook.env,
      DDNS_EVENT: 'ip-change',
      DDNS_OLD_IP: payload.oldIp ?? '',
      DDNS_NEW_IP: payload.newIp ?? '',
      DDNS_RECORDS: (payload.records ?? []).join(','),
      DDNS_SERVICE_ID: payload.serviceId ?? '',
      DDNS_PAYLOAD: JSON.stringify(payload)
    };
  }

  // Runs every enabled hook sequentially. Resolves to an array of results;
  // a failing hook never rejects, so one bad script can't stop the others.
  async runIpChangeHooks(payload) {
    const results = [];
    for (const hook of this.hooks) {
      if (!hook.enabled) {
        this.logger(`Hook "${hook.name}" is disabled, skipping.`);
        continue;
      }
      if (this.dryRun) {
        this.logger(`Would run hook "${hook.name}": ${hook.command} ${hook.args.join(' ')}`.trim());
        results.push({ hook, skipped: true, success: true });
        continue;
      }
      results.push(await this.run(hook, payload));
    }
    return results;
  }

  run(hook, payload) {
    return new Promise(resolve => {
      this.logger(`Running hook "${hook.name}".`);

      const child = spawn(hook.command, hook.args, {
        cwd: hook.cwd,
        env: this.buildEnv(hook, payload),
        shell: hook.shell,
        timeout: hook.timeout,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });

      child.on('error', error => {
        this.logger(`Hook "${hook.name}" could not be executed: ${error.message}`, 'error');
        resolve({ hook, success: false, error: error.message });
      });

      child.on('close', (code, signal) => {
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        if (output) this.logger(`Hook "${hook.name}" output: ${output}`);

        if (signal) {
          const message = signal === 'SIGKILL'
            ? `timed out after ${hook.timeout}ms`
            : `was killed by signal ${signal}`;
          this.logger(`Hook "${hook.name}" ${message}.`, 'error');
          resolve({ hook, success: false, error: message, output });
          return;
        }

        if (code === 0) {
          this.logger(`Hook "${hook.name}" completed successfully.`);
          resolve({ hook, success: true, output });
        } else {
          this.logger(`Hook "${hook.name}" exited with code ${code}.`, 'error');
          resolve({ hook, success: false, error: `exited with code ${code}`, output });
        }
      });
    });
  }
}
