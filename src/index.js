#!/usr/bin/env node
import Config from './Config.js';
import Ip from './Ip.js';
import Cloudflare from './Cloudflare.js';
import yargs from 'yargs';
import ErrorHandler from './ErrorHandler.js';
import Mailer from './Mailer.js';
import Logger from './Logger.js';
import Hooks from './Hooks.js';
import IpState from './IpState.js';

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
const hooks = new Hooks(Config, logger, { dryRun });
const ipState = new IpState(Config.get('ipStateFile') || null, logger);

const ipAddress = await Ip.get();
if (!ipAddress) {
  errorHandler.add({ message: 'Could not obtain IP address' }).handle();
}

logger(`Current IP address: ${ipAddress}`);

// Detected against our own last-seen value rather than against Cloudflare, so
// the event fires even if Cloudflare already holds the new address.
const lastKnownIp = ipState.read();
const publicIpChanged = lastKnownIp !== null && lastKnownIp !== ipAddress;
if (ipState.isConfigured() && lastKnownIp === null) {
  logger('No previously recorded public IP, treating this run as the baseline.');
} else if (publicIpChanged) {
  logger(`Public IP changed from ${lastKnownIp} to ${ipAddress}.`);
}

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
const hookResults = [];
if (!skipHooks && hooks.isConfigured()) {
  const payload = {
    newIp: ipAddress,
    records: updatedRecords.map(r => r.dnsRecord),
    serviceId: Config.get('serviceId') || null,
    dryRun: !!dryRun
  };

  if (publicIpChanged) {
    hookResults.push(...await hooks.dispatch('publicIpChanged', { ...payload, oldIp: lastKnownIp }));
  }
  if (updatedRecords.length > 0) {
    hookResults.push(...await hooks.dispatch('dnsRecordUpdated', { ...payload, oldIp: updatedRecords[0].oldIp }));
  }
  hookResults.push(...await hooks.dispatch('always', { ...payload, oldIp: lastKnownIp }));

  hookResults.filter(result => !result.success).forEach(result => {
    errorHandler.add({
      message: `Hook "${result.hook.name}" failed on "${result.event}": ${result.error}`,
      ipAddress
    });
  });
}

// Only record the new IP once its hooks have succeeded, so a failed hook is
// retried on the next run instead of the change being silently consumed.
if (ipState.isConfigured() && (publicIpChanged || lastKnownIp === null)) {
  const ipHookFailed = hookResults.some(result => result.event === 'publicIpChanged' && !result.success);
  if (dryRun) {
    logger(`Would record public IP ${ipAddress} as last known.`);
  } else if (skipHooks && lastKnownIp !== null && hooks.hasHooksFor('publicIpChanged')) {
    logger(`Not recording public IP ${ipAddress} because hooks were skipped.`);
  } else if (ipHookFailed) {
    logger(`Not recording public IP ${ipAddress} because a hook failed, it will be retried on the next run.`, 'error');
  } else {
    ipState.write(ipAddress);
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
  if (!skipHooks && hooks.hasHooksFor('error')) {
    // Failures here are logged only, to avoid feeding the error handler more
    // errors while it is already reporting.
    await hooks.dispatch('error', {
      newIp: ipAddress,
      oldIp: lastKnownIp,
      records: updatedRecords.map(r => r.dnsRecord),
      errors: errorHandler.errors.map(error => error.message),
      serviceId: Config.get('serviceId') || null,
      dryRun: !!dryRun
    });
  }
  errorHandler.handle();
}
