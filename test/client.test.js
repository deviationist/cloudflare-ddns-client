import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  runClient,
  createWorkspace,
  cleanupWorkspaces,
  changeScenario,
  singleRecordConfig,
  mailConfig
} from './helpers/run.js';

after(cleanupWorkspaces);

describe('update decision', () => {
  test('updates the Cloudflare record when the public IP has changed', () => {
    const paths = createWorkspace({ config: singleRecordConfig(), scenario: changeScenario() });
    const result = runClient(paths);

    assert.equal(result.code, 0);
    assert.equal(result.updateRequests.length, 1);
    const [update] = result.updateRequests;
    assert.match(update.url, /\/zones\/zone-1\/dns_records\/rec-1$/);
    assert.deepEqual(update.body, {
      type: 'A',
      name: 'domain.com',
      content: '203.0.113.42',
      ttl: 1,
      proxied: false
    });
  });

  test('skips the update when DNS already resolves to the current IP', () => {
    const paths = createWorkspace({
      config: singleRecordConfig(),
      scenario: changeScenario({ dnsResolve: { 'domain.com': '203.0.113.42' } })
    });
    const result = runClient(paths, ['--verbose']);

    assert.equal(result.updateRequests.length, 0);
    assert.match(result.stdout, /is currently set to "203\.0\.113\.42", no changes needed/);
    // The Cloudflare API is never consulted in this case.
    assert.equal(result.requests.filter(request => request.url.includes('dns_records')).length, 0);
  });

  test('skips the update when Cloudflare already holds the current IP', () => {
    const paths = createWorkspace({
      config: singleRecordConfig(),
      scenario: changeScenario({
        cfRecords: { 'zone-1|domain.com': { id: 'rec-1', content: '203.0.113.42' } }
      })
    });
    const result = runClient(paths, ['--verbose']);

    assert.equal(result.updateRequests.length, 0);
    assert.match(result.stdout, /Cloudflare record already set to "203\.0\.113\.42", no changes needed/);
    assert.equal(result.mails.length, 0, 'no notification for a record that did not change');
    assert.equal(result.ipHistory, '', 'no history entry for a record that did not change');
  });

  test('--forceUpdate bypasses both the DNS and the Cloudflare check', () => {
    const paths = createWorkspace({
      config: singleRecordConfig(),
      scenario: changeScenario({
        dnsResolve: { 'domain.com': '203.0.113.42' },
        cfRecords: { 'zone-1|domain.com': { id: 'rec-1', content: '203.0.113.42' } }
      })
    });
    const result = runClient(paths, ['--forceUpdate']);

    assert.equal(result.updateRequests.length, 1);
    // No DNS resolution is attempted when the check is bypassed.
    assert.equal(result.requests.filter(request => request.url.includes('dns-query')).length, 0);
  });

  test('--dryRun reports success without issuing the update', () => {
    const paths = createWorkspace({ config: singleRecordConfig(), scenario: changeScenario() });
    const result = runClient(paths, ['--dryRun', '--verbose']);

    assert.equal(result.updateRequests.length, 0);
    assert.match(result.stdout, /\[DRY RUN\] Successfully updated IP address to 203\.0\.113\.42/);
  });
});

describe('multiple records and zones', () => {
  const multiConfig = {
    serviceId: 'test-service',
    items: [
      {
        apiKey: 'item-key',
        zones: [
          { zoneId: 'zone-1', dnsRecords: ['domain.com', 'domain.eu'] },
          { zoneId: 'zone-2', apiKey: 'zone-key', dnsRecords: ['foo.com'] }
        ]
      }
    ]
  };

  const multiScenario = {
    publicIp: '203.0.113.42',
    dnsResolve: { 'domain.com': '198.51.100.7', 'domain.eu': '198.51.100.7', 'foo.com': '198.51.100.7' },
    cfRecords: {
      'zone-1|domain.com': { id: 'rec-1', content: '198.51.100.7' },
      'zone-1|domain.eu': { id: 'rec-2', content: '198.51.100.7' },
      'zone-2|foo.com': { id: 'rec-3', content: '198.51.100.7' }
    }
  };

  test('updates every record across every zone', () => {
    const paths = createWorkspace({ config: multiConfig, scenario: multiScenario });
    const result = runClient(paths);

    assert.equal(result.updateRequests.length, 3);
    assert.deepEqual(
      result.updateRequests.map(request => request.body.name).sort(),
      ['domain.com', 'domain.eu', 'foo.com']
    );
  });

  test('a zone-level API key overrides the item-level one', () => {
    const paths = createWorkspace({ config: multiConfig, scenario: multiScenario });
    const result = runClient(paths);

    const byRecord = Object.fromEntries(
      result.updateRequests.map(request => [request.body.name, request.authorization])
    );
    assert.equal(byRecord['domain.com'], 'Bearer item-key');
    assert.equal(byRecord['domain.eu'], 'Bearer item-key');
    assert.equal(byRecord['foo.com'], 'Bearer zone-key');
  });

  test('a record with no API key anywhere is skipped, the others still run', () => {
    const config = {
      items: [
        { zones: [{ zoneId: 'zone-1', dnsRecords: ['domain.com'] }] },
        { apiKey: 'item-key', zones: [{ zoneId: 'zone-2', dnsRecords: ['foo.com'] }] }
      ]
    };
    const paths = createWorkspace({
      config,
      scenario: {
        publicIp: '203.0.113.42',
        dnsResolve: { 'domain.com': '198.51.100.7', 'foo.com': '198.51.100.7' },
        cfRecords: {
          'zone-1|domain.com': { id: 'rec-1', content: '198.51.100.7' },
          'zone-2|foo.com': { id: 'rec-3', content: '198.51.100.7' }
        }
      }
    });
    const result = runClient(paths, ['--verbose']);

    assert.match(result.stderr, /Missing API key!/);
    assert.equal(result.updateRequests.length, 1);
    assert.equal(result.updateRequests[0].body.name, 'foo.com');
  });
});

describe('failures', () => {
  test('a failed Cloudflare update is reported by mail and exits non-zero', () => {
    const paths = createWorkspace({
      config: singleRecordConfig({ mailConfig, notificationMailAddress: 'ops@example.com' }),
      scenario: changeScenario({ cfUpdate: 500 })
    });
    const result = runClient(paths);

    assert.equal(result.code, 1);
    assert.equal(result.mails.length, 1);
    assert.match(result.mails[0].subject, /^Error - Cloudflare DDNS Client \(test-service\)$/);
    assert.match(result.mails[0].text, /Could not update DNS-record/);
  });

  test('a record that cannot be looked up in Cloudflare is skipped without mail', () => {
    const paths = createWorkspace({
      config: singleRecordConfig({ mailConfig, notificationMailAddress: 'ops@example.com' }),
      scenario: changeScenario({ cfRecords: {} })
    });
    const result = runClient(paths, ['--verbose']);

    assert.match(result.stderr, /Could not get DNS record ID for "domain\.com"\. Aborting\./);
    assert.equal(result.updateRequests.length, 0);
    assert.equal(result.mails.length, 0, 'a missing record is logged, not mailed');
    assert.equal(result.code, 0);
  });

  test('several failures are collected into a single mail', () => {
    const config = {
      serviceId: 'test-service',
      mailConfig,
      notificationMailAddress: 'ops@example.com',
      items: [{ apiKey: 'k', zones: [{ zoneId: 'zone-1', dnsRecords: ['domain.com', 'domain.eu'] }] }]
    };
    const paths = createWorkspace({
      config,
      scenario: {
        publicIp: '203.0.113.42',
        dnsResolve: { 'domain.com': '198.51.100.7', 'domain.eu': '198.51.100.7' },
        cfRecords: {
          'zone-1|domain.com': { id: 'rec-1', content: '198.51.100.7' },
          'zone-1|domain.eu': { id: 'rec-2', content: '198.51.100.7' }
        },
        cfUpdate: 500
      }
    });
    const result = runClient(paths);

    assert.equal(result.mails.length, 1);
    assert.match(result.mails[0].subject, /^Multiple errors - /);
    assert.equal(result.mails[0].text.match(/- Could not update DNS-record/g).length, 2);
  });

  test('an unreachable public IP service is reported', () => {
    const paths = createWorkspace({
      config: singleRecordConfig({ mailConfig, notificationMailAddress: 'ops@example.com' }),
      scenario: changeScenario({ publicIp: 'THROW' })
    });
    const result = runClient(paths);

    assert.equal(result.mails.length, 1);
    assert.match(result.mails[0].text, /Could not obtain IP address/);
    assert.equal(result.updateRequests.length, 0);
  });

  // Regression, 2026-08-11: every IP source was serving nginx error pages, the
  // client took the HTML as its public IP, and tried to write that into an A
  // record on both hosts. Cloudflare's own validation was the only thing that
  // stopped it being published.
  test('an HTML error page from every IP source never reaches Cloudflare', () => {
    const errorPage = {
      status: 502,
      body: '<html>\n<head><title>502 Bad Gateway</title></head>\n<body>\n<center><h1>502 Bad Gateway</h1></center>\n</body>\n</html>'
    };
    const paths = createWorkspace({
      config: singleRecordConfig({ mailConfig, notificationMailAddress: 'ops@example.com' }),
      scenario: changeScenario({ publicIp: errorPage })
    });
    const result = runClient(paths);

    assert.equal(result.code, 1);
    assert.equal(result.updateRequests.length, 0);
    assert.equal(result.requests.filter(request => request.url.includes('dns_records')).length, 0);
    assert.doesNotMatch(result.log, /<html>/);
    assert.match(result.mails[0].text, /Could not obtain IP address from any source/);
  });

  test('a 200 response that is not an IP address is not published', () => {
    const paths = createWorkspace({
      config: singleRecordConfig({ mailConfig, notificationMailAddress: 'ops@example.com' }),
      scenario: changeScenario({ publicIp: { status: 200, body: 'Service Temporarily Unavailable' } })
    });
    const result = runClient(paths);

    assert.equal(result.code, 1);
    assert.equal(result.updateRequests.length, 0);
  });

  test('one failing IP source falls through to the next and the update proceeds', () => {
    const paths = createWorkspace({
      config: singleRecordConfig(),
      scenario: changeScenario({
        ipResponses: {
          'checkip.amazonaws.com': { status: 504, body: '<html><title>504 Gateway Time-out</title></html>' },
          'api.ipify.org': '203.0.113.42'
        }
      })
    });
    const result = runClient(paths);

    assert.equal(result.code, 0);
    assert.equal(result.updateRequests.length, 1);
    assert.equal(result.updateRequests[0].body.content, '203.0.113.42');
  });

  test('the alert names which record failed, not just that one did', () => {
    const paths = createWorkspace({
      config: singleRecordConfig({ mailConfig, notificationMailAddress: 'ops@example.com' }),
      scenario: changeScenario({ cfUpdate: 400 })
    });
    const result = runClient(paths);

    assert.match(result.mails[0].text, /Could not update DNS-record for domain\.com/);
    assert.match(result.mails[0].text, /203\.0\.113\.42/);
  });

  test('missing configuration exits non-zero without touching the network', () => {
    const paths = createWorkspace({ config: {}, scenario: { publicIp: '203.0.113.42' } });
    const result = runClient(paths, ['--verbose']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Configuration is missing\./);
    assert.equal(result.requests.filter(request => request.url.includes('dns_records')).length, 0);
  });

  test('a mailer that throws does not take the run down', () => {
    const paths = createWorkspace({
      config: singleRecordConfig({ mailConfig, notificationMailAddress: 'ops@example.com' }),
      scenario: changeScenario({ mailFail: true })
    });
    const result = runClient(paths, ['--verbose']);

    assert.equal(result.code, 0);
    assert.equal(result.updateRequests.length, 1, 'the record was still updated');
    assert.match(result.stderr, /Could not send IP change notification email/);
  });
});

describe('notification mail on change', () => {
  test('names the old IP, the new IP and every updated record', () => {
    const config = {
      serviceId: 'test-service',
      mailConfig,
      notificationMailAddress: 'ops@example.com',
      items: [{ apiKey: 'k', zones: [{ zoneId: 'zone-1', dnsRecords: ['domain.com', 'domain.eu'] }] }]
    };
    const paths = createWorkspace({
      config,
      scenario: {
        publicIp: '203.0.113.42',
        dnsResolve: { 'domain.com': '198.51.100.7', 'domain.eu': '198.51.100.7' },
        cfRecords: {
          'zone-1|domain.com': { id: 'rec-1', content: '198.51.100.7' },
          'zone-1|domain.eu': { id: 'rec-2', content: '198.51.100.7' }
        }
      }
    });
    const result = runClient(paths);

    assert.equal(result.mails.length, 1);
    const [mail] = result.mails;
    assert.equal(mail.to, 'ops@example.com');
    assert.equal(mail.from, 'ddns@example.com');
    assert.equal(mail.subject, 'IP address changed - Cloudflare DDNS Client (test-service)');
    assert.match(mail.text, /Old IP: 198\.51\.100\.7/);
    assert.match(mail.text, /New IP: 203\.0\.113\.42/);
    assert.match(mail.text, /- domain\.com/);
    assert.match(mail.text, /- domain\.eu/);
  });

  test('no mail is sent when nothing changed', () => {
    const paths = createWorkspace({
      config: singleRecordConfig({ mailConfig, notificationMailAddress: 'ops@example.com' }),
      scenario: changeScenario({ dnsResolve: { 'domain.com': '203.0.113.42' } })
    });
    assert.equal(runClient(paths).mails.length, 0);
  });

  test('no mail is sent when the mailer is not configured', () => {
    const paths = createWorkspace({
      config: singleRecordConfig({ notificationMailAddress: 'ops@example.com' }),
      scenario: changeScenario()
    });
    const result = runClient(paths);

    assert.equal(result.mails.length, 0);
    assert.equal(result.updateRequests.length, 1);
  });
});

describe('logging', () => {
  test('writes nothing to disk when no log file is configured', () => {
    const paths = createWorkspace({ config: singleRecordConfig(), scenario: changeScenario() });
    const result = runClient(paths);

    assert.equal(result.log, '');
    assert.equal(result.ipHistory, '');
  });

  test('writes timestamped INFO lines to the log file', () => {
    const paths = createWorkspace({
      config: workspace => singleRecordConfig({ logFile: workspace.logFile }),
      scenario: changeScenario()
    });
    const result = runClient(paths);

    assert.match(result.log, /\[INFO\] Current IP address: 203\.0\.113\.42/);
    assert.match(result.log, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[INFO\]/m);
    assert.match(result.log, /\[INFO\] Successfully updated IP address to 203\.0\.113\.42 for "domain\.com"\./);
  });

  test('tags errors as ERROR in the log file', () => {
    const paths = createWorkspace({
      config: workspace => ({ logFile: workspace.logFile }),
      scenario: { publicIp: '203.0.113.42' }
    });

    assert.match(runClient(paths).log, /\[ERROR\] Configuration is missing\./);
  });

  test('prefixes log lines with [DRY RUN] on a dry run', () => {
    const paths = createWorkspace({
      config: workspace => singleRecordConfig({ logFile: workspace.logFile }),
      scenario: changeScenario()
    });

    assert.match(runClient(paths, ['--dryRun']).log, /\[INFO\] \[DRY RUN\] Current IP address/);
  });

  test('appends one IP history line per change, listing every record', () => {
    const paths = createWorkspace({
      config: workspace => ({
        ipHistoryFile: workspace.ipHistoryFile,
        items: [{ apiKey: 'k', zones: [{ zoneId: 'zone-1', dnsRecords: ['domain.com', 'domain.eu'] }] }]
      }),
      scenario: {
        publicIp: '203.0.113.42',
        dnsResolve: { 'domain.com': '198.51.100.7', 'domain.eu': '198.51.100.7' },
        cfRecords: {
          'zone-1|domain.com': { id: 'rec-1', content: '198.51.100.7' },
          'zone-1|domain.eu': { id: 'rec-2', content: '198.51.100.7' }
        }
      }
    });
    const result = runClient(paths);

    assert.equal(result.ipHistory.trim().split('\n').length, 1);
    assert.match(result.ipHistory, /198\.51\.100\.7 -> 203\.0\.113\.42 {2}domain\.(com, domain\.eu|eu, domain\.com)/);
  });

  test('stays quiet on stdout unless --verbose is passed', () => {
    const paths = createWorkspace({ config: singleRecordConfig(), scenario: changeScenario() });
    assert.equal(runClient(paths).stdout, '');
    assert.match(runClient(paths, ['--verbose']).stdout, /Current IP address/);
  });
});
