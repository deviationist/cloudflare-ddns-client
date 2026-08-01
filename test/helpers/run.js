import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
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
    log: readText(paths.logFile),
    ipHistory: readText(paths.ipHistoryFile),
    ipState: readText(paths.ipStateFile).trim() || null
  };
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
