#!/usr/bin/env node
import Config from './Config.js';
import Ip from './Ip.js';
import Cloudflare from './Cloudflare.js';
import yargs from 'yargs';

const argv = yargs(process.argv).argv;

const forceUpdate = argv.forceUpdate;
const verbose = argv.verbose;
const configPath = argv.configPath;

const ipAddress = await Ip.get();
if (!ipAddress) {
    if (verbose) console.error('Coult not obtain IP address.');
    process.exit(1);
}

if (verbose) console.log(`Current IP address: ${ipAddress}`);

if (configPath) Config.filePath = configPath;
const items = Config.get();
if (!items) {
    if (verbose) console.error('Configuration is missing.');
    process.exit(1);
}

items.map(item => {
    item.zones.map(zone => {
        zone.dnsRecords.map(async (dnsRecord) => {
            
            if (!forceUpdate && ipAddress == await Ip.resolve(dnsRecord)) {
                if (verbose) console.log(`Domain "${dnsRecord}" is currently set to "${ipAddress}", no changes needed.`);
                return;
            }

            const apiKey = Config.resolveApiKey(item, zone);
            if (!apiKey) {
                if (verbose) console.error('Missing API key!');
                return;
            }

            const dnsRecordFromCf = await Cloudflare.getDnsRecord(apiKey, zone.zoneId, dnsRecord);
            if (!dnsRecordFromCf || !dnsRecordFromCf?.id) {
                if (verbose) console.error(`Could not get DNS record ID for "${dnsRecord}". Aborting.`);
                return;
            }
            if (verbose) console.log(`DNS record Id for "${dnsRecord}" is "${dnsRecordFromCf?.id}".`);

            const success = await Cloudflare.updateDnsRecord(apiKey, zone.zoneId, dnsRecordFromCf.id, {
                type: 'A',
                name: dnsRecord,
                content: ipAddress,
                ttl: 1,
                proxied: false
            });

            if (success) {
                if (verbose) console.log(`Successfully updated IP address to ${ipAddress} for "${dnsRecord}".`);
            } else {
                if (verbose) console.error(`Error: could not update IP address to ${ipAddress} for "${dnsRecord}".`);
            }
        });
    });
});
