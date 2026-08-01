import { spawnSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stubPath = join(projectRoot, 'test', 'helpers', 'stub.js');
const workspaces = [];

export function cleanupWorkspaces() {
  while (workspaces.length > 0) {
    rmSync(workspaces.pop(), { recursive: true, force: true });
  }
}

// Creates an isolated directory holding the config, scenario and artifacts for
// a single run.
export function createWorkspace({ config = {}, scenario = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ddns-test-'));
  workspaces.push(dir);
  const artifacts = join(dir, 'artifacts');
  mkdirSync(artifacts);

  const paths = {
    dir,
    artifacts,
    config: join(dir, 'config.json'),
    scenario: join(dir, 'scenario.json'),
    logFile: join(dir, 'app.log'),
    ipHistoryFile: join(dir, 'ip-history.log'),
    ipStateFile: join(dir, 'last-ip')
  };

  // `config` may be a function so it can reference the workspace's own paths.
  const resolvedConfig = typeof config === 'function' ? config(paths) : config;
  writeFileSync(paths.config, JSON.stringify(resolvedConfig, null, 2));
  writeFileSync(paths.scenario, JSON.stringify(scenario, null, 2));
  return paths;
}

const readLines = file => (existsSync(file)
  ? readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []);

const readText = file => (existsSync(file) ? readFileSync(file, 'utf-8') : '');

// Runs src/index.js as a real subprocess with the network stubbed out.
export function runClient(paths, args = []) {
  const result = spawnSync(
    process.execPath,
    ['--import', stubPath, join(projectRoot, 'src', 'index.js'), `--configPath=${paths.config}`, ...args],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        DDNS_TEST_SCENARIO: paths.scenario,
        DDNS_TEST_ARTIFACTS: paths.artifacts
      }
    }
  );

  const requests = readLines(join(paths.artifacts, 'requests.jsonl'));
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    requests,
    updateRequests: requests.filter(request => request.method === 'PUT'),
    mails: readLines(join(paths.artifacts, 'mails.jsonl')),
    hookCalls: readLines(join(paths.artifacts, 'hooks.jsonl')),
    log: readText(paths.logFile),
    ipHistory: readText(paths.ipHistoryFile),
    ipState: readText(paths.ipStateFile).trim() || null
  };
}

// A stand-in for an AsusWRT-Merlin router, speaking just enough of its HTTP
// interface for the guard driver: a login that hands out a token cookie, and
// nvram_get lookups answered from `nvram`. Runs in its own process — see
// test/helpers/fake-router.js for why.
export function startFakeRouter(nvram = {}) {
  const child = spawn(
    process.execPath,
    [join(projectRoot, 'test', 'helpers', 'fake-router.js'), JSON.stringify(nvram)],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );

  return new Promise((resolve, reject) => {
    let buffered = '';
    child.stdout.on('data', chunk => {
      buffered += chunk;
      const port = buffered.match(/PORT=(\d+)/)?.[1];
      if (!port) return;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => {
          child.once('exit', done);
          child.kill();
        })
      });
    });
    child.once('error', reject);
  });
}

// Writes an executable hook script that records the environment it was called
// with, then exits with `exitCode` (after optionally sleeping, to exercise
// timeouts).
export function hookScript(paths, name, { exitCode = 0, sleepSeconds = 0 } = {}) {
  const file = join(paths.dir, `${name}.sh`);
  writeFileSync(file, [
    '#!/bin/sh',
    `printf '{"hook":"%s","event":"%s","oldIp":"%s","newIp":"%s","records":"%s","errors":"%s","custom":"%s"}\\n' \\`,
    `  "${name}" "$DDNS_EVENT" "$DDNS_OLD_IP" "$DDNS_NEW_IP" "$DDNS_RECORDS" "$DDNS_ERRORS" "$HOOK_CUSTOM_VAR" \\`,
    '  >> "$DDNS_TEST_ARTIFACTS/hooks.jsonl"',
    sleepSeconds ? `sleep ${sleepSeconds}` : '',
    `exit ${exitCode}`,
    ''
  ].join('\n'));
  chmodSync(file, 0o755);
  return file;
}

export const mailConfig = {
  fromAddress: 'ddns@example.com',
  smtp: { host: 'smtp.example.com', port: 587, secure: false, login: 'user', password: 'pass' }
};

// Single zone, single record, with the client's IP differing from both DNS and
// Cloudflare — i.e. the ordinary "IP has rotated" case.
export function changeScenario(overrides = {}) {
  return {
    publicIp: '203.0.113.42',
    dnsResolve: { 'domain.com': '198.51.100.7' },
    cfRecords: { 'zone-1|domain.com': { id: 'rec-1', content: '198.51.100.7' } },
    ...overrides
  };
}

export function singleRecordConfig(overrides = {}) {
  return {
    serviceId: 'test-service',
    items: [{ apiKey: 'top-level-key', zones: [{ zoneId: 'zone-1', dnsRecords: ['domain.com'] }] }],
    ...overrides
  };
}
