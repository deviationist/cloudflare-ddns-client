import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import Config from '../src/Config.js';
import Ip from '../src/Ip.js';
import Cloudflare from '../src/Cloudflare.js';
import Logger from '../src/Logger.js';
import Mailer from '../src/Mailer.js';
import ErrorHandler from '../src/ErrorHandler.js';
import { serviceName } from '../src/Constants.js';

const dirs = [];
const workDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ddns-unit-'));
  dirs.push(dir);
  return dir;
};

after(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));

const resetConfig = () => {
  Config.data = null;
  Config.filePath = './config.json';
};

const configFrom = data => {
  const file = join(workDir(), 'config.json');
  writeFileSync(file, JSON.stringify(data));
  resetConfig();
  Config.filePath = file;
  return file;
};

describe('Config', () => {
  beforeEach(resetConfig);

  test('reads values by dot notation', () => {
    configFrom({ serviceId: 'svc', mailConfig: { smtp: { host: 'smtp.example.com' } } });

    assert.equal(Config.get('serviceId'), 'svc');
    assert.equal(Config.get('mailConfig.smtp.host'), 'smtp.example.com');
  });

  test('returns the whole config when no key is given', () => {
    configFrom({ serviceId: 'svc' });

    assert.deepEqual(Config.get(), { serviceId: 'svc' });
  });

  test('returns null when the config file does not exist', () => {
    resetConfig();
    Config.filePath = join(workDir(), 'missing.json');

    assert.equal(Config.get('serviceId'), null);
    assert.equal(Config.exists(), false);
  });

  test('caches the file after the first read', () => {
    const file = configFrom({ serviceId: 'first' });
    assert.equal(Config.get('serviceId'), 'first');

    writeFileSync(file, JSON.stringify({ serviceId: 'second' }));
    assert.equal(Config.get('serviceId'), 'first', 'later reads come from the cache');
  });

  describe('resolveApiKey', () => {
    test('prefers the zone key over the item key', () => {
      assert.equal(Config.resolveApiKey({ apiKey: 'item' }, { apiKey: 'zone' }), 'zone');
    });

    test('falls back to the item key', () => {
      assert.equal(Config.resolveApiKey({ apiKey: 'item' }, {}), 'item');
    });

    test('returns false when neither has one', () => {
      assert.equal(Config.resolveApiKey({}, {}), false);
      assert.equal(Config.resolveApiKey(undefined, undefined), false);
    });
  });
});

describe('Ip', () => {
  const originalFetch = globalThis.fetch;
  after(() => { globalThis.fetch = originalFetch; });

  const ok = body => ({ ok: true, status: 200, text: async () => body });
  const errorPage = status => ({
    ok: false,
    status,
    text: async () => `<html>\n<head><title>${status} Bad Gateway</title></head>\n</html>`
  });

  test('trims the whitespace off the public IP', async () => {
    globalThis.fetch = async () => ok('  203.0.113.42\n');

    assert.equal(await Ip.get(), '203.0.113.42');
  });

  test('returns false when the lookup throws', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };

    assert.equal(await Ip.get({ sources: ['https://one.example'] }), false);
  });

  // The 2026-08-11 outage: the source answered 502/500/504 with an HTML error
  // page, and the whole page was published as the A record's content.
  test('never returns the body of an HTTP error response', async () => {
    globalThis.fetch = async () => errorPage(502);

    assert.equal(await Ip.get({ sources: ['https://one.example'] }), false);
  });

  test('rejects a 200 response that is not an IPv4 address', async () => {
    globalThis.fetch = async () => ok('<html><body>hello</body></html>');

    assert.equal(await Ip.get({ sources: ['https://one.example'] }), false);
  });

  test('rejects an IPv6 answer, because the records written are A records', async () => {
    globalThis.fetch = async () => ok('2606:4700:4700::1111');

    assert.equal(await Ip.get({ sources: ['https://one.example'] }), false);
  });

  test('falls back to the next source when the first one errors', async () => {
    const seen = [];
    globalThis.fetch = async url => {
      seen.push(String(url));
      return String(url).includes('one') ? errorPage(504) : ok('203.0.113.42');
    };

    const result = await Ip.get({ sources: ['https://one.example', 'https://two.example'] });

    assert.equal(result, '203.0.113.42');
    assert.deepEqual(seen, ['https://one.example', 'https://two.example']);
  });

  test('falls back when a source throws rather than answering', async () => {
    globalThis.fetch = async url => {
      if (String(url).includes('one')) throw new Error('network down');
      return ok('203.0.113.42');
    };

    assert.equal(await Ip.get({ sources: ['https://one.example', 'https://two.example'] }), '203.0.113.42');
  });

  test('stops at the first usable source', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return ok('203.0.113.42'); };

    await Ip.get({ sources: ['https://one.example', 'https://two.example'] });

    assert.equal(calls, 1);
  });

  test('reports each failing source to the logger without echoing the body', async () => {
    globalThis.fetch = async () => errorPage(502);
    const lines = [];

    await Ip.get({ sources: ['https://one.example'], logger: message => lines.push(message) });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /https:\/\/one\.example/);
    assert.match(lines[0], /502/);
    assert.doesNotMatch(lines[0], /<html>/);
  });

  test('defaults to more than one source', async () => {
    assert.ok(Ip.sources.length > 1);
  });

  test('resolves a record through DNS-over-HTTPS', async () => {
    globalThis.fetch = async url => {
      assert.match(String(url), /1\.1\.1\.1\/dns-query\?name=domain\.com/);
      return { ok: true, status: 200, json: async () => ({ Answer: [{ data: '203.0.113.42' }] }) };
    };

    assert.equal(await Ip.resolve('domain.com'), '203.0.113.42');
  });

  test('skips a CNAME answer and returns the A record behind it', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ Answer: [{ data: 'alias.example.com' }, { data: '203.0.113.42' }] })
    });

    assert.equal(await Ip.resolve('domain.com'), '203.0.113.42');
  });

  test('returns undefined for a record with no answer', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

    assert.equal(await Ip.resolve('domain.com'), undefined);
  });

  test('returns false when the resolver answers with an HTTP error', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

    assert.equal(await Ip.resolve('domain.com'), false);
  });

  test('returns false when the resolve throws', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };

    assert.equal(await Ip.resolve('domain.com'), false);
  });
});

describe('Cloudflare', () => {
  const originalFetch = globalThis.fetch;
  after(() => { globalThis.fetch = originalFetch; });

  test('sends a bearer token and returns the first matching record', async () => {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.cloudflare.com/client/v4/zones/z1/dns_records?type=A&name=domain.com');
      assert.equal(options.headers.Authorization, 'Bearer key');
      assert.equal(options.headers['Content-Type'], 'application/json');
      return { json: async () => ({ result: [{ id: 'rec-1' }, { id: 'rec-2' }] }) };
    };

    assert.deepEqual(await Cloudflare.getDnsRecord('key', 'z1', 'domain.com'), { id: 'rec-1' });
  });

  test('returns undefined when no record matches', async () => {
    globalThis.fetch = async () => ({ json: async () => ({ result: [] }) });

    assert.equal(await Cloudflare.getDnsRecord('key', 'z1', 'domain.com'), undefined);
  });

  test('returns false when the lookup throws', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };

    assert.equal(await Cloudflare.getDnsRecord('key', 'z1', 'domain.com'), false);
  });

  test('PUTs the record and treats only 200 as success', async () => {
    const payload = { type: 'A', name: 'domain.com', content: '203.0.113.42', ttl: 1, proxied: false };
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.cloudflare.com/client/v4/zones/z1/dns_records/rec-1');
      assert.equal(options.method, 'PUT');
      assert.deepEqual(JSON.parse(options.body), payload);
      return { status: 200 };
    };
    assert.equal(await Cloudflare.updateDnsRecord('key', 'z1', 'rec-1', payload), true);

    globalThis.fetch = async () => ({ status: 403 });
    assert.equal(await Cloudflare.updateDnsRecord('key', 'z1', 'rec-1', payload), false);

    globalThis.fetch = async () => { throw new Error('network down'); };
    assert.equal(await Cloudflare.updateDnsRecord('key', 'z1', 'rec-1', payload), false);
  });

  test('logs the reason Cloudflare gave for rejecting an update', async () => {
    globalThis.fetch = async () => ({
      status: 400,
      json: async () => ({ errors: [{ message: 'Content for A record must be a valid IPv4 address' }] })
    });
    const lines = [];

    await Cloudflare.updateDnsRecord('key', 'z1', 'rec-1', {}, message => lines.push(message));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /400/);
    assert.match(lines[0], /must be a valid IPv4 address/);
  });

  test('survives an error body that is not the documented JSON shape', async () => {
    globalThis.fetch = async () => ({
      status: 502,
      json: async () => { throw new Error('Unexpected token < in JSON'); }
    });
    const lines = [];

    assert.equal(await Cloudflare.updateDnsRecord('key', 'z1', 'rec-1', {}, m => lines.push(m)), false);
    assert.match(lines[0], /unparseable error body/);
  });

  test('logs the reason a request failed outright', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };
    const lines = [];

    await Cloudflare.updateDnsRecord('key', 'z1', 'rec-1', {}, message => lines.push(message));

    assert.match(lines[0], /network down/);
  });
});

describe('Logger', () => {
  test('writes nothing when no log file is configured', () => {
    const logger = new Logger({ verbose: false });

    assert.doesNotThrow(() => logger.log('message'));
    assert.doesNotThrow(() => logger.logIpChange('1.1.1.1', '2.2.2.2', ['domain.com']));
  });

  test('tags INFO and ERROR lines', () => {
    const logFile = join(workDir(), 'app.log');
    const logger = new Logger({ logFile });

    logger.log('all good');
    logger.log('went wrong', 'error');
    const contents = readFileSync(logFile, 'utf-8');

    assert.match(contents, /\[INFO\] all good/);
    assert.match(contents, /\[ERROR\] went wrong/);
  });

  test('prefixes every line on a dry run', () => {
    const logFile = join(workDir(), 'app.log');
    new Logger({ logFile, dryRun: true }).log('all good');

    assert.match(readFileSync(logFile, 'utf-8'), /\[INFO\] \[DRY RUN\] all good/);
  });

  test('appends the IP change to the history file', () => {
    const ipHistoryFile = join(workDir(), 'history.log');
    const logger = new Logger({ ipHistoryFile });

    logger.logIpChange('1.1.1.1', '2.2.2.2', ['domain.com', 'foo.com']);
    logger.logIpChange('2.2.2.2', '3.3.3.3', ['domain.com']);
    const lines = readFileSync(ipHistoryFile, 'utf-8').trim().split('\n');

    assert.equal(lines.length, 2);
    assert.match(lines[0], /1\.1\.1\.1 -> 2\.2\.2\.2 {2}domain\.com, foo\.com/);
  });
});

describe('Mailer', () => {
  beforeEach(resetConfig);

  test('is unconfigured without a from address or credentials', () => {
    configFrom({});
    assert.equal(new Mailer(Config).isConfigured(), false);

    configFrom({ mailConfig: { fromAddress: 'a@example.com' } });
    assert.equal(new Mailer(Config).isConfigured(), false);

    configFrom({ mailConfig: { fromAddress: 'a@example.com', smtp: { login: 'user' } } });
    assert.equal(new Mailer(Config).isConfigured(), false, 'a login without a password is not enough');
  });

  test('is configured with a from address, login and password', () => {
    configFrom({
      mailConfig: { fromAddress: 'a@example.com', smtp: { host: 'smtp.example.com', login: 'u', password: 'p' } }
    });
    const mailer = new Mailer(Config);

    assert.equal(mailer.isConfigured(), true);
    assert.equal(mailer.fromAddress, 'a@example.com');
  });

  test('builds the subject with and without a service id', () => {
    assert.equal(Mailer.generateSubject('Error', 'svc'), `Error - ${serviceName} (svc)`);
    assert.equal(Mailer.generateSubject('Error', null), `Error - ${serviceName}`);
  });
});

describe('ErrorHandler', () => {
  beforeEach(resetConfig);

  test('collects errors and logs each one', () => {
    configFrom({});
    const logged = [];
    const handler = new ErrorHandler(Config, (message, level) => logged.push([message, level]));

    assert.equal(handler.hasErrors(), false);
    handler.add({ message: 'first' }).add({ message: 'second' });

    assert.equal(handler.hasErrors(), true);
    assert.deepEqual(logged, [['first', 'error'], ['second', 'error']]);
  });

  test('does nothing when the mailer is unconfigured', async () => {
    configFrom({ notificationMailAddress: 'ops@example.com' });
    const handler = new ErrorHandler(Config, () => {});
    handler.add({ message: 'boom' });

    // Returns before the process.exit(1) it would otherwise reach.
    await assert.doesNotReject(() => handler.handle());
  });
});
