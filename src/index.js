#!/usr/bin/env node
import Config from './Config.js';
import Ip from './Ip.js';
import Cloudflare from './Cloudflare.js';
import yargs from 'yargs';
import ErrorHandler from './ErrorHandler.js';
import Mailer from './Mailer.js';
import Logger from './Logger.js';
import Hooks from './Hooks.js';

const argv = yargs(process.argv).argv;

const forceUpdate = argv.forceUpdate;
const verbose = argv.verbose;
const dryRun = argv.dryRun;
const skipHooks = argv.skipHooks;
const configPath = argv.configPath;
if (configPath) Config.filePath = configPath;

const logFile = Config.get('logFile') || null;
const ipHistoryFile = Config.get('ipHistoryFile') || null;
const appLogger = new Logger({ logFile, ipHistoryFile, dryRun, verbose });
const logger = (message, level = 'log') => appLogger.log(message, level);

const errorHandler = new ErrorHandler(Config, logger);
const mailer = new Mailer(Config);

const ipAddress = await Ip.get();
if (!ipAddress) {
  errorHandler.add({ message: 'Could not obtain IP address' }).handle();
}

logger(`Current IP address: ${ipAddress}`);

const items = Config.get('items');
if (!items) {
  logger('Configuration is missing.', 'error');
  process.exit(1);
}

const updatedRecords = [];

await Promise.all(items.flatMap(item =>
  item.zones.flatMap(zone =>
    zone.dnsRecords.map(async (dnsRecord) => {
      if (!forceUpdate && ipAddress == await Ip.resolve(dnsRecord)) {
        logger(`Domain "${dnsRecord}" is currently set to "${ipAddress}", no changes needed.`);
        return;
      }

      const apiKey = Config.resolveApiKey(item, zone);
      if (!apiKey) {
        logger(`Missing API key!`, 'error');
        return;
      }

      const dnsRecordFromCf = await Cloudflare.getDnsRecord(apiKey, zone.zoneId, dnsRecord);
      if (!dnsRecordFromCf || !dnsRecordFromCf?.id) {
        logger(`Could not get DNS record ID for "${dnsRecord}". Aborting.`, 'error');
        return;
      }
      logger(`DNS record Id for "${dnsRecord}" is "${dnsRecordFromCf?.id}".`);

      const oldIp = dnsRecordFromCf.content;

      if (!forceUpdate && oldIp === ipAddress) {
        logger(`Domain "${dnsRecord}" Cloudflare record already set to "${ipAddress}", no changes needed.`);
        return;
      }

      let success = false;
      if (dryRun) {
        success = true;
      } else {
        success = await Cloudflare.updateDnsRecord(apiKey, zone.zoneId, dnsRecordFromCf.id, {
          type: 'A',
          name: dnsRecord,
          content: ipAddress,
          ttl: 1,
          proxied: false
        });
      }

      if (success) {
        logger(`Successfully updated IP address to ${ipAddress} for "${dnsRecord}".`);
        updatedRecords.push({ dnsRecord, oldIp, newIp: ipAddress });
      } else {
        errorHandler.add({
          message: 'Could not update DNS-record',
          ipAddress,
          dnsRecord,
          zone: zone.name
        });
      }
    })
  )
));

if (updatedRecords.length > 0) {
  appLogger.logIpChange(
    updatedRecords[0].oldIp,
    ipAddress,
    updatedRecords.map(r => r.dnsRecord)
  );
}

// Hooks run before the notification mail on purpose: a hook may be what makes
// outbound mail work again after an IP change (e.g. re-authorizing the new IP
// with the SMTP provider).
if (updatedRecords.length > 0 && !skipHooks) {
  const hooks = new Hooks(Config, logger, { dryRun });
  if (hooks.isConfigured()) {
    const results = await hooks.runIpChangeHooks({
      oldIp: updatedRecords[0].oldIp,
      newIp: ipAddress,
      records: updatedRecords.map(r => r.dnsRecord),
      serviceId: Config.get('serviceId') || null,
      dryRun: !!dryRun
    });
    results.filter(result => !result.success).forEach(result => {
      errorHandler.add({
        message: `Hook "${result.hook.name}" failed: ${result.error}`,
        ipAddress
      });
    });
  }
}

if (updatedRecords.length > 0 && mailer.isConfigured()) {
  const toAddress = Config.get('notificationMailAddress');
  if (toAddress) {
    const serviceId = Config.get('serviceId');
    const oldIp = updatedRecords[0].oldIp;
    const recordList = updatedRecords.map(r => `  - ${r.dnsRecord}`).join('\n');
    try {
      await mailer.send(
        toAddress,
        Mailer.generateSubject('IP address changed', serviceId),
        `Your home IP address has changed.\n\nOld IP: ${oldIp}\nNew IP: ${ipAddress}\n\nThe following DNS records have been updated:\n${recordList}\n\nAll listed domains now point to your new IP address.`
      );
      logger(`Sent IP change notification email to ${toAddress}.`);
    } catch (e) {
      logger('Could not send IP change notification email', 'error');
    }
  }
}

if (errorHandler.hasErrors()) {
  errorHandler.handle();
}
