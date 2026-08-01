import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import {
  runClient,
  createWorkspace,
  cleanupWorkspaces,
  changeScenario,
  hookScript,
  startFakeRouter
} from './helpers/run.js';

after(cleanupWorkspaces);

// nvram values for a router sitting on its 4G failover uplink.
const ON_FAILOVER = { wans_dualwan: 'wan usb', wan1_primary: '1', wan1_ipaddr: '100.64.12.9' };
const ON_PRIMARY = { wans_dualwan: 'wan none', wan1_primary: '0', wan0_ipaddr: '203.0.113.42' };

async function guardWorkspace({ nvram, hooks, lastKnownIp = '198.51.100.7', scenario = changeScenario() }) {
  const router = await startFakeRouter(nvram);
  const paths = createWorkspace({ scenario, config: {} });
  writeFileSync(paths.config, JSON.stringify({
    serviceId: 'test-service',
    ipStateFile: paths.ipStateFile,
    router: {
      driver: 'asuswrt-merlin',
      stateFile: `${paths.dir}/router-guard.json`,
      options: { url: router.url, username: 'admin', password: 'secret' }
    },
    hooks: hooks(paths),
    items: [{ apiKey: 'k', zones: [{ zoneId: 'zone-1', dnsRecords: ['domain.com'] }] }]
  }, null, 2));
  writeFileSync(paths.ipStateFile, `${lastKnownIp}\n`);
  return { paths, router };
}

describe('router guard with hooks', () => {
  test('paused: DNS updates stop and ordinary hooks do not run', async () => {
    const { paths, router } = await guardWorkspace({
      nvram: ON_FAILOVER,
      hooks: workspace => [
        { name: 'ordinary', on: ['publicIpChanged'], command: hookScript(workspace, 'ordinary') }
      ]
    });
    const result = runClient(paths, ['--verbose']);
    await router.close();

    assert.equal(result.updateRequests.length, 0, 'no DNS update while on failover');
    assert.equal(result.hookCalls.length, 0, 'a hook that did not opt in stays put');
    assert.match(result.stderr, /Skipping all DNS updates due to router guard/);
  });

  test('paused: a runWhenPaused hook still fires, with the failover IP', async () => {
    const { paths, router } = await guardWorkspace({
      nvram: ON_FAILOVER,
      hooks: workspace => [
        { name: 'ordinary', on: ['publicIpChanged'], command: hookScript(workspace, 'ordinary') },
        {
          name: 'allowlist',
          on: ['publicIpChanged'],
          runWhenPaused: true,
          command: hookScript(workspace, 'allowlist')
        }
      ]
    });
    const result = runClient(paths);
    await router.close();

    assert.deepEqual(result.hookCalls.map(call => call.hook), ['allowlist']);
    assert.equal(result.hookCalls[0].newIp, '203.0.113.42');
    assert.equal(result.hookCalls[0].oldIp, '198.51.100.7');
    assert.equal(result.hookCalls[0].records, '', 'nothing was updated, so no records are named');
    assert.equal(result.updateRequests.length, 0);
  });

  test('paused: the IP is recorded once the opted-in hook succeeds', async () => {
    const { paths, router } = await guardWorkspace({
      nvram: ON_FAILOVER,
      hooks: workspace => [{
        name: 'allowlist',
        on: ['publicIpChanged'],
        runWhenPaused: true,
        command: hookScript(workspace, 'allowlist')
      }]
    });
    const result = runClient(paths);
    await router.close();

    assert.equal(result.ipState, '203.0.113.42', 'so it does not fire again every minute on 4G');
  });

  test('paused: a failing opted-in hook leaves the change for the next run', async () => {
    const { paths, router } = await guardWorkspace({
      nvram: ON_FAILOVER,
      hooks: workspace => [{
        name: 'allowlist',
        on: ['publicIpChanged'],
        runWhenPaused: true,
        command: hookScript(workspace, 'allowlist', { exitCode: 3 })
      }]
    });
    const result = runClient(paths, ['--verbose']);
    await router.close();

    assert.equal(result.ipState, '198.51.100.7');
    assert.match(result.stderr, /Not recording public IP .* because a hook failed/);
  });

  test('paused with no opted-in hook: the change is left unconsumed', async () => {
    const { paths, router } = await guardWorkspace({
      nvram: ON_FAILOVER,
      hooks: workspace => [
        { name: 'ordinary', on: ['publicIpChanged'], command: hookScript(workspace, 'ordinary') }
      ]
    });
    const result = runClient(paths, ['--verbose']);
    await router.close();

    assert.equal(result.ipState, '198.51.100.7');
    assert.match(result.stdout, /because no hook ran while updates are paused/);
  });

  test('publishable: everything runs as normal', async () => {
    const { paths, router } = await guardWorkspace({
      nvram: ON_PRIMARY,
      hooks: workspace => [
        { name: 'ordinary', on: ['publicIpChanged'], command: hookScript(workspace, 'ordinary') }
      ]
    });
    const result = runClient(paths, ['--verbose']);
    await router.close();

    assert.equal(result.updateRequests.length, 1);
    assert.deepEqual(result.hookCalls.map(call => call.hook), ['ordinary']);
    assert.equal(result.ipState, '203.0.113.42');
    assert.match(result.stdout, /Router guard \[asuswrt-merlin\]: WAN on primary/);
  });

  test('unreachable router: fails open rather than freezing DDNS', async () => {
    const { paths, router } = await guardWorkspace({
      nvram: ON_PRIMARY,
      hooks: workspace => [
        { name: 'ordinary', on: ['publicIpChanged'], command: hookScript(workspace, 'ordinary') }
      ]
    });
    await router.close(); // gone before the client runs
    const result = runClient(paths, ['--verbose']);

    assert.match(result.stderr, /could not determine WAN status; proceeding \(fail-open\)/);
    assert.equal(result.updateRequests.length, 1);
    assert.deepEqual(result.hookCalls.map(call => call.hook), ['ordinary']);
  });

  test('no router config leaves the guard inert', () => {
    const paths = createWorkspace({
      scenario: changeScenario(),
      config: workspace => ({
        ipStateFile: workspace.ipStateFile,
        items: [{ apiKey: 'k', zones: [{ zoneId: 'zone-1', dnsRecords: ['domain.com'] }] }]
      })
    });
    const result = runClient(paths, ['--verbose']);

    assert.doesNotMatch(result.stdout, /Router guard/);
    assert.equal(result.updateRequests.length, 1);
  });
});
