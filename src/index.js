#!/usr/bin/env node
import Config from './Config.js';
import Ip from './Ip.js';
import Cloudflare from './Cloudflare.js';
import yargs from 'yargs';
import ErrorHandler from './ErrorHandler.js';

const argv = yargs(process.argv).argv;

const forceUpdate = argv.forceUpdate;
const verbose = argv.verbose;
const dryRun = argv.dryRun;
const configPath = argv.configPath;
const logMessagePrefix = dryRun ? '[DRY RUN] ' : '';
const logger = (message, method = 'log') => console[method](`${logMessagePrefix}${message}`)
if (configPath) Config.filePath = configPath;

const errorHandler = new ErrorHandler(Config, verbose, logger);

const ipAddress = await Ip.get();
if (!ipAddress) {
  errorHandler.add({ message: 'Could not obtain IP address' }).handle();
}

if (verbose) console.log(`Current IP address: ${ipAddress}`);

const items = Config.get('items');
if (!items) {
  if (verbose) console.error('Configuration is missing.');
  process.exit(1);
}

items.map(item => {
  item.zones.map(zone => {
    zone.dnsRecords.map(async (dnsRecord) => {  
      if (!forceUpdate && ipAddress == await Ip.resolve(dnsRecord)) {
        if (verbose) logger(`${logMessagePrefix}Domain "${dnsRecord}" is currently set to "${ipAddress}", no changes needed.`);
        return;
      }

      const apiKey = Config.resolveApiKey(item, zone);
      if (!apiKey) {
        if (verbose) logger(`${logMessagePrefix}Missing API key!`, 'error');
        return;
      }

      const dnsRecordFromCf = await Cloudflare.getDnsRecord(apiKey, zone.zoneId, dnsRecord);
      if (!dnsRecordFromCf || !dnsRecordFromCf?.id) {
        if (verbose) console.error(`Could not get DNS record ID for "${dnsRecord}". Aborting.`);
        return;
      }
      if (verbose) logger(`${logMessagePrefix}DNS record Id for "${dnsRecord}" is "${dnsRecordFromCf?.id}".`);

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
        if (verbose) logger(`Successfully updated IP address to ${ipAddress} for "${dnsRecord}".`);
      } else {
        errorHandler.add({
          message: 'Could not update DNS-record',
          ipAddress,
          dnsRecord,
          zone: zone.name
        });
        //if (verbose) logger(`${logMessagePrefix}Error: could not update IP address to ${ipAddress} for "${dnsRecord}".`, 'error');
      }
    });
  });
});

if (errorHandler.hasErrors()) {
  errorHandler.handle();
}
