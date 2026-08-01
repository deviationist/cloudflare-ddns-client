// Preloaded with --import before src/index.js runs. Replaces the two things
// the client talks to the outside world with: fetch and nodemailer. Everything
// they are asked to do is recorded so tests can assert on it.
import { appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import nodemailer from 'nodemailer';

const scenario = JSON.parse(readFileSync(process.env.DDNS_TEST_SCENARIO, 'utf-8'));
const artifacts = process.env.DDNS_TEST_ARTIFACTS;

const record = (file, entry) => appendFileSync(join(artifacts, file), `${JSON.stringify(entry)}\n`);

const jsonResponse = (status, body) => ({
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const method = options.method || 'GET';
  record('requests.jsonl', {
    method,
    url: target,
    body: options.body ? JSON.parse(options.body) : null,
    authorization: options.headers?.Authorization ?? null
  });

  if (target.includes('checkip.amazonaws.com')) {
    if (scenario.publicIp === 'THROW') throw new Error('stub: public IP lookup failed');
    return { status: 200, text: async () => `${scenario.publicIp}\n` };
  }

  if (target.includes('dns-query')) {
    const name = new URL(target).searchParams.get('name');
    const answer = scenario.dnsResolve?.[name];
    if (answer === 'THROW') throw new Error('stub: DNS lookup failed');
    if (answer === undefined || answer === null) return jsonResponse(200, {});
    return jsonResponse(200, { Answer: [{ data: answer }] });
  }

  if (target.includes('/dns_records?')) {
    const parsed = new URL(target);
    const zoneId = parsed.pathname.split('/')[4];
    const name = parsed.searchParams.get('name');
    const cfRecord = scenario.cfRecords?.[`${zoneId}|${name}`];
    if (cfRecord === 'THROW') throw new Error('stub: Cloudflare lookup failed');
    if (!cfRecord) return jsonResponse(200, { result: [] });
    return jsonResponse(200, { result: [cfRecord] });
  }

  if (target.includes('/dns_records/')) {
    if (scenario.cfUpdate === 'THROW') throw new Error('stub: Cloudflare update failed');
    return jsonResponse(scenario.cfUpdate ?? 200, { success: true });
  }

  throw new Error(`stub: unexpected request to ${target}`);
};

nodemailer.createTransport = config => ({
  config,
  sendMail: async message => {
    record('mails.jsonl', message);
    if (scenario.mailFail) throw new Error('stub: sending mail failed');
    return { accepted: [message.to] };
  }
});
