import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import {
  runClient,
  createWorkspace,
  cleanupWorkspaces,
  changeScenario,
  hookScript,
  mailConfig
} from './helpers/run.js';

after(cleanupWorkspaces);

// A workspace whose config is built once the hook scripts exist, since the
// config has to point at them.
function hookWorkspace({ hooks, scenario = changeScenario(), config = {}, lastKnownIp } = {}) {
  const paths = createWorkspace({ scenario, config: {} });
  const resolvedHooks = hooks(paths);
  writeFileSync(paths.config, JSON.stringify({
    serviceId: 'test-service',
    ipStateFile: paths.ipStateFile,
    hooks: resolvedHooks,
    items: [{ apiKey: 'k', zones: [{ zoneId: 'zone-1', dnsRecords: ['domain.com'] }] }],
    ...config
  }, null, 2));
  if (lastKnownIp) writeFileSync(paths.ipStateFile, `${lastKnownIp}\n`);
  return paths;
}

describe('events', () => {
  test('publicIpChanged fires when the IP differs from the recorded one', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [{ name: 'ip', on: ['publicIpChanged'], command: hookScript(workspace, 'ip') }]
    });
    const result = runClient(paths);

    assert.equal(result.hookCalls.length, 1);
    assert.deepEqual(result.hookCalls[0], {
      hook: 'ip',
      event: 'publicIpChanged',
      oldIp: '198.51.100.7',
      newIp: '203.0.113.42',
      records: 'domain.com',
      errors: '',
      custom: ''
    });
  });

  test('publicIpChanged fires even when Cloudflare already holds the new IP', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      scenario: changeScenario({
        dnsResolve: { 'domain.com': '203.0.113.42' },
        cfRecords: { 'zone-1|domain.com': { id: 'rec-1', content: '203.0.113.42' } }
      }),
      hooks: workspace => [{ name: 'ip', on: ['publicIpChanged'], command: hookScript(workspace, 'ip') }]
    });
    const result = runClient(paths);

    assert.equal(result.updateRequests.length, 0, 'nothing to update in Cloudflare');
    assert.equal(result.hookCalls.length, 1, 'but the IP still rotated');
  });

  test('the first run is a baseline: the IP is recorded and no event fires', () => {
    const paths = hookWorkspace({
      hooks: workspace => [{ name: 'ip', on: ['publicIpChanged'], command: hookScript(workspace, 'ip') }]
    });
    const result = runClient(paths);

    assert.equal(result.hookCalls.length, 0);
    assert.equal(result.ipState, '203.0.113.42');
  });

  test('an unchanged IP fires nothing', () => {
    const paths = hookWorkspace({
      lastKnownIp: '203.0.113.42',
      scenario: changeScenario({ dnsResolve: { 'domain.com': '203.0.113.42' } }),
      hooks: workspace => [{ name: 'ip', on: ['publicIpChanged'], command: hookScript(workspace, 'ip') }]
    });

    assert.equal(runClient(paths).hookCalls.length, 0);
  });

  test('dnsRecordUpdated fires only when a record was written', () => {
    const hooks = workspace => [
      { name: 'dns', on: ['dnsRecordUpdated'], command: hookScript(workspace, 'dns') }
    ];

    const updated = hookWorkspace({ hooks });
    assert.equal(runClient(updated).hookCalls.length, 1);

    const unchanged = hookWorkspace({
      hooks,
      scenario: changeScenario({ dnsResolve: { 'domain.com': '203.0.113.42' } })
    });
    assert.equal(runClient(unchanged).hookCalls.length, 0);
  });

  test('always fires on every run, changed or not', () => {
    const hooks = workspace => [
      { name: 'every', on: ['always'], command: hookScript(workspace, 'every') }
    ];

    const changed = hookWorkspace({ hooks });
    assert.equal(runClient(changed).hookCalls.length, 1);

    const unchanged = hookWorkspace({
      hooks,
      scenario: changeScenario({ dnsResolve: { 'domain.com': '203.0.113.42' } })
    });
    assert.equal(runClient(unchanged).hookCalls.length, 1);
  });

  test('error fires with the collected messages, before the error mail', () => {
    const paths = hookWorkspace({
      config: { mailConfig, notificationMailAddress: 'ops@example.com' },
      scenario: changeScenario({ cfUpdate: 500 }),
      hooks: workspace => [{ name: 'err', on: ['error'], command: hookScript(workspace, 'err') }]
    });
    const result = runClient(paths);

    assert.equal(result.hookCalls.length, 1);
    assert.equal(result.hookCalls[0].event, 'error');
    assert.match(result.hookCalls[0].errors, /Could not update DNS-record/);
    assert.equal(result.mails.length, 1);
  });

  test('events dispatch in order: publicIpChanged, dnsRecordUpdated, always', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [
        { name: 'c', on: ['always'], command: hookScript(workspace, 'c') },
        { name: 'b', on: ['dnsRecordUpdated'], command: hookScript(workspace, 'b') },
        { name: 'a', on: ['publicIpChanged'], command: hookScript(workspace, 'a') }
      ]
    });

    assert.deepEqual(
      runClient(paths).hookCalls.map(call => call.event),
      ['publicIpChanged', 'dnsRecordUpdated', 'always']
    );
  });

  test('a hook listening to an unknown event never fires', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [{ name: 'nope', on: ['notAnEvent'], command: hookScript(workspace, 'nope') }]
    });
    const result = runClient(paths, ['--verbose']);

    assert.equal(result.hookCalls.length, 0);
    assert.match(result.stderr, /listens to unknown event "notAnEvent"/);
  });
});

describe('once', () => {
  test('a hook on several events runs once and is skipped for later events', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [{
        name: 'multi',
        on: ['publicIpChanged', 'dnsRecordUpdated', 'always'],
        command: hookScript(workspace, 'multi')
      }]
    });
    const result = runClient(paths, ['--verbose']);

    assert.equal(result.hookCalls.length, 1);
    assert.equal(result.hookCalls[0].event, 'publicIpChanged', 'fires on the first matching event');
    assert.match(result.stdout, /already ran this session, skipping "dnsRecordUpdated"/);
  });

  test('once: false runs the hook once per matching event', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [{
        name: 'multi',
        on: ['publicIpChanged', 'dnsRecordUpdated'],
        once: false,
        command: hookScript(workspace, 'multi')
      }]
    });

    assert.deepEqual(
      runClient(paths).hookCalls.map(call => call.event),
      ['publicIpChanged', 'dnsRecordUpdated']
    );
  });
});

describe('stopOnError', () => {
  test('a failure skips the remaining hooks, including later events', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [
        { name: 'first', on: ['publicIpChanged'], command: hookScript(workspace, 'first') },
        {
          name: 'critical',
          on: ['publicIpChanged'],
          stopOnError: true,
          command: hookScript(workspace, 'critical', { exitCode: 3 })
        },
        { name: 'later', on: ['publicIpChanged'], command: hookScript(workspace, 'later') },
        { name: 'other-event', on: ['always'], command: hookScript(workspace, 'other-event') }
      ]
    });
    const result = runClient(paths, ['--verbose']);

    assert.deepEqual(result.hookCalls.map(call => call.hook), ['first', 'critical']);
    assert.match(result.stderr, /has stopOnError set, skipping all remaining hooks/);
  });

  test('without stopOnError a failure does not stop the others', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [
        { name: 'failing', on: ['publicIpChanged'], command: hookScript(workspace, 'failing', { exitCode: 3 }) },
        { name: 'later', on: ['publicIpChanged'], command: hookScript(workspace, 'later') },
        { name: 'other-event', on: ['always'], command: hookScript(workspace, 'other-event') }
      ]
    });

    assert.deepEqual(
      runClient(paths).hookCalls.map(call => call.hook),
      ['failing', 'later', 'other-event']
    );
  });
});

describe('failure handling', () => {
  test('a failing hook is reported by mail and exits non-zero', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      config: { mailConfig, notificationMailAddress: 'ops@example.com' },
      hooks: workspace => [
        { name: 'failing', on: ['publicIpChanged'], command: hookScript(workspace, 'failing', { exitCode: 3 }) }
      ]
    });
    const result = runClient(paths);

    assert.equal(result.code, 1);
    const errorMail = result.mails.find(mail => mail.subject.startsWith('Error'));
    assert.match(errorMail.text, /Hook "failing" failed on "publicIpChanged": exited with code 3/);
  });

  test('a hook that times out is killed and reported', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [{
        name: 'slow',
        on: ['publicIpChanged'],
        timeout: 500,
        command: hookScript(workspace, 'slow', { sleepSeconds: 30 })
      }]
    });
    const result = runClient(paths, ['--verbose']);

    assert.match(result.stderr, /Hook "slow" timed out after 500ms/);
  });

  test('does not wait on a background child the hook leaves behind', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: () => [{
        name: 'spawner',
        on: ['publicIpChanged'],
        shell: true,
        timeout: 30000,
        command: 'sleep 30 & echo started'
      }]
    });

    const startedAt = Date.now();
    const result = runClient(paths, ['--verbose']);
    const elapsed = Date.now() - startedAt;

    assert.match(result.stdout, /Hook "spawner" completed successfully/);
    assert.ok(elapsed < 10000, `the run should not wait for the background child (took ${elapsed}ms)`);
  });

  test('a command that cannot be executed is reported without waiting out the timeout', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: () => [{ name: 'missing', on: ['publicIpChanged'], command: '/nonexistent/binary' }]
    });

    const startedAt = Date.now();
    const result = runClient(paths, ['--verbose']);
    const elapsed = Date.now() - startedAt;

    assert.match(result.stderr, /Hook "missing" could not be executed/);
    assert.ok(elapsed < 10000, `an unusable command should fail fast (took ${elapsed}ms)`);
  });

  test('a disabled hook never runs', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [
        { name: 'off', on: ['publicIpChanged'], enabled: false, command: hookScript(workspace, 'off') }
      ]
    });

    assert.equal(runClient(paths).hookCalls.length, 0);
  });
});

describe('hook environment and options', () => {
  test('passes custom env vars and runs from the configured cwd', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [{
        name: 'env',
        on: ['publicIpChanged'],
        env: { HOOK_CUSTOM_VAR: 'custom-value' },
        cwd: workspace.dir,
        command: hookScript(workspace, 'env')
      }]
    });

    assert.equal(runClient(paths).hookCalls[0].custom, 'custom-value');
  });

  test('shell: true runs the command through a shell', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: () => [{
        name: 'shell',
        on: ['publicIpChanged'],
        shell: true,
        command: 'printf \'{"hook":"shell","event":"%s","newIp":"%s"}\\n\' "$DDNS_EVENT" "$DDNS_NEW_IP" >> "$DDNS_TEST_ARTIFACTS/hooks.jsonl"'
      }]
    });

    assert.deepEqual(runClient(paths).hookCalls, [
      { hook: 'shell', event: 'publicIpChanged', newIp: '203.0.113.42' }
    ]);
  });

  test('a bare command string defaults to publicIpChanged', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [hookScript(workspace, 'bare')]
    });

    assert.deepEqual(runClient(paths).hookCalls.map(call => call.event), ['publicIpChanged']);
  });

  test('the legacy hooks.onIpChange form still maps onto dnsRecordUpdated', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => ({ onIpChange: [hookScript(workspace, 'legacy')] })
    });

    assert.deepEqual(runClient(paths).hookCalls.map(call => call.event), ['dnsRecordUpdated']);
  });
});

describe('IP state file', () => {
  test('records the new IP once its hooks succeed', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [{ name: 'ok', on: ['publicIpChanged'], command: hookScript(workspace, 'ok') }]
    });

    assert.equal(runClient(paths).ipState, '203.0.113.42');
  });

  test('does not record the new IP when a hook failed, so the next run retries', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [
        { name: 'failing', on: ['publicIpChanged'], command: hookScript(workspace, 'failing', { exitCode: 3 }) }
      ]
    });
    const first = runClient(paths, ['--verbose']);

    assert.equal(first.ipState, '198.51.100.7');
    assert.match(first.stderr, /Not recording public IP .* because a hook failed/);

    // The second run sees the change again rather than losing it.
    assert.equal(runClient(paths).hookCalls.length, 2);
  });

  test('a failing hook on another event does not block recording', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [
        { name: 'ok', on: ['publicIpChanged'], command: hookScript(workspace, 'ok') },
        { name: 'failing', on: ['always'], command: hookScript(workspace, 'failing', { exitCode: 3 }) }
      ]
    });

    assert.equal(runClient(paths).ipState, '203.0.113.42');
  });

  test('--dryRun neither runs hooks nor records the IP', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [{ name: 'ip', on: ['publicIpChanged'], command: hookScript(workspace, 'ip') }]
    });
    const result = runClient(paths, ['--dryRun', '--verbose']);

    assert.equal(result.hookCalls.length, 0);
    assert.equal(result.ipState, '198.51.100.7');
    assert.match(result.stdout, /Would run hook "ip" for "publicIpChanged"/);
  });

  test('--skipHooks leaves the change unconsumed for the next run', () => {
    const paths = hookWorkspace({
      lastKnownIp: '198.51.100.7',
      hooks: workspace => [{ name: 'ip', on: ['publicIpChanged'], command: hookScript(workspace, 'ip') }]
    });
    const skipped = runClient(paths, ['--skipHooks', '--verbose']);

    assert.equal(skipped.hookCalls.length, 0);
    assert.equal(skipped.ipState, '198.51.100.7');
    assert.match(skipped.stdout, /Not recording public IP .* because hooks were skipped/);

    assert.equal(runClient(paths).hookCalls.length, 1, 'the next normal run still sees the change');
  });

  test('without ipStateFile the other events still work', () => {
    const paths = hookWorkspace({
      config: { ipStateFile: undefined },
      hooks: workspace => [
        { name: 'ip', on: ['publicIpChanged'], command: hookScript(workspace, 'ip') },
        { name: 'dns', on: ['dnsRecordUpdated'], command: hookScript(workspace, 'dns') }
      ]
    });
    const result = runClient(paths);

    assert.deepEqual(result.hookCalls.map(call => call.hook), ['dns']);
    assert.equal(result.ipState, null);
  });
});
