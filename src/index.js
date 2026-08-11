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
import { createRouterDriver } from './routers/index.js';
import { readGuardState, writeGuardState } from './routers/GuardState.js';

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

const ipAddress = await Ip.get({ logger, sources: Config.get('ipSources') || undefined });
if (!ipAddress) {
  // Nothing below can do anything useful without an address, and handle() only
  // exits when a mailer is configured — so exit here regardless rather than
  // carrying a falsy IP into the update loop.
  await errorHandler.add({ message: 'Could not obtain IP address from any source' }).handle();
  process.exit(1);
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

// Records the detected IP as last known, unless something says otherwise. Only
// called once the hooks for the change have had their turn, so a failed hook
// leaves the change unconsumed and the next run retries it.
const recordIpState = (results, { requireHookRun = false } = {}) => {
  if (!ipState.isConfigured() || !(publicIpChanged || lastKnownIp === null)) return;

  const ipHookResults = results.filter(result => result.event === 'publicIpChanged');
  if (dryRun) {
    logger(`Would record public IP ${ipAddress} as last known.`);
  } else if (skipHooks && lastKnownIp !== null && hooks.hasHooksFor('publicIpChanged')) {
    logger(`Not recording public IP ${ipAddress} because hooks were skipped.`);
  } else if (ipHookResults.some(result => !result.success)) {
    logger(`Not recording public IP ${ipAddress} because a hook failed, it will be retried on the next run.`, 'error');
  } else if (requireHookRun && ipHookResults.length === 0) {
    logger(`Not recording public IP ${ipAddress} because no hook ran while updates are paused.`);
  } else {
    ipState.write(ipAddress);
  }
};

// Opt-in router guard: when a `router` driver is configured, refuse to publish
// the detected IP while the router is on a WAN failover path / behind CGNAT
// (where the public IP is a shared carrier address that can't route back home).
// No `router` config -> this whole block is inert.
const routerDriver = createRouterDriver(Config, logger);
if (routerDriver && ipAddress) {
  const verdict = await routerDriver.evaluate(ipAddress);
  logger(`Router guard [${routerDriver.name}]: ${verdict.reason}`, verdict.ok ? 'log' : 'warn');

  const stateFile = Config.get('router.stateFile') || null;
  const notifyTransition = async (publishable, reason) => {
    const prev = readGuardState(stateFile);
    const changed = prev?.publishable !== publishable;
    writeGuardState(stateFile, { publishable, reason, ipAddress, timestamp: new Date().toISOString() });
    if (!stateFile || !changed || !mailer.isConfigured()) return;
    const toAddress = Config.get('notificationMailAddress');
    if (!toAddress) return;
    const serviceId = Config.get('serviceId');
    const [subject, lead] = publishable
      ? ['DNS updates resumed', 'The router is back on a publishable public connection, so DDNS updates have resumed.']
      : ['DNS updates paused (WAN failover/CGNAT)', 'DDNS updates were paused because the router is not on a publishable public connection. Your Cloudflare records were left pointing at the last known-good IP.'];
    try {
      await mailer.send(
        toAddress,
        Mailer.generateSubject(subject, serviceId),
        `${lead}\n\nReason: ${reason}\n\nYou will not receive repeated emails while this state persists.`
      );
      logger(`Sent "${subject}" notification to ${toAddress}.`);
    } catch (e) {
      logger(`Could not send "${subject}" notification`, 'error');
    }
  };

  if (verdict.ok && !verdict.publishable) {
    await notifyTransition(false, verdict.reason);
    logger('Skipping all DNS updates due to router guard.', 'warn');

    // DNS updates are off, but a hook marked runWhenPaused still fires: the
    // failover address is the one outbound traffic now leaves from, which is
    // exactly what an IP-allowlist hook needs to know about.
    let pausedResults = [];
    if (!skipHooks && publicIpChanged && hooks.hasHooksFor('publicIpChanged', { pausedOnly: true })) {
      pausedResults = await hooks.dispatch('publicIpChanged', {
        newIp: ipAddress,
        oldIp: lastKnownIp,
        records: [],
        serviceId: Config.get('serviceId') || null,
        dryRun: !!dryRun,
        updatesPaused: true
      }, { pausedOnly: true });

      pausedResults.filter(result => !result.success).forEach(result => {
        errorHandler.add({
          message: `Hook "${result.hook.name}" failed on "${result.event}": ${result.error}`,
          ipAddress
        });
      });
    }

    recordIpState(pausedResults, { requireHookRun: true });
    if (errorHandler.hasErrors()) await errorHandler.handle();
    process.exit(0);
  } else if (verdict.ok) {
    await notifyTransition(true, verdict.reason);
  } else {
    // Could not determine WAN state — fail open so a transient router glitch
    // never freezes normal DDNS. State file is left untouched.
    logger('Router guard could not determine WAN status; proceeding (fail-open).', 'warn');
  }
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
        }, logger);
      }

      if (success) {
        logger(`Successfully updated IP address to ${ipAddress} for "${dnsRecord}".`);
        updatedRecords.push({ dnsRecord, oldIp, newIp: ipAddress });
      } else {
        errorHandler.add({
          // Named, because the alert mail lists only these messages — two bare
          // "Could not update DNS-record" lines say nothing about which records.
          // Unquoted on purpose: this string is passed to hook scripts as
          // DDNS_ERRORS, where embedded quotes break naive consumers.
          message: `Could not update DNS-record for ${dnsRecord} (tried to set ${ipAddress})`,
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

recordIpState(hookResults);

if (updatedRecords.length > 0 && mailer.isConfigured()) {
  const toAddress = Config.get('notificationMailAddress');
  if (toAddress) {
    const serviceId = Config.get('serviceId');
    const oldIp = updatedRecords[0].oldIp;
    const recordList = updatedRecords.map(r => `  - ${r.dnsRecord}`).join('\n');
    if (dryRun) {
      logger(`Would send IP change notification email to ${toAddress}.`);
    } else {
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
