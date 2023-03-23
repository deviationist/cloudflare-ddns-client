import Config from './Config.js';
import Ip from './Ip.js';
import Cloudflare from './Cloudflare.js';

const items = Config.get();

const ipAddress = await Ip.get();
if (!ipAddress) {
    console.error('Coult not obtain IP address.');
    process.exit(1);
}

const forceUpdate = process.argv.includes('--forceUpdate');

console.log(`Current IP address: ${ipAddress}`);

items.map(item => {
    item.zones.map(zone => {
        zone.dnsRecords.map(async (dnsRecord) => {
            
            if (!forceUpdate && ipAddress == await Ip.resolve(dnsRecord)) {
                console.log(`Domain "${dnsRecord}" is currently set to "${ipAddress}", no changes needed.`);
                return;
            }

            const apiKey = Config.resolveApiKey(item, zone);
            if (!apiKey) {
                console.error('Missing API key!');
                return;
            }

            const dnsRecordFromCf = await Cloudflare.getDnsRecord(apiKey, zone.zoneId, dnsRecord);
            if (!dnsRecordFromCf) {
                console.error(`Could not get DNS record ID for "${dnsRecord}". Aborting.`);
                return;
            }
            console.log(`DNS record Id for "${dnsRecord}" is "${dnsRecordFromCf?.id}".`);

            const success = await Cloudflare.updateDnsRecord(apiKey, zone.zoneId, dnsRecordFromCf?.id, {
                type: 'A',
                name: dnsRecord,
                content: ipAddress,
                ttl: 1,
                proxied: false
            });

            if (success) {
                console.log(`Successfully updated IP address to ${ipAddress} for "${dnsRecord}".`);
            } else {
                console.error(`Error: could not update IP address to ${ipAddress} for "${dnsRecord}".`);
            }
        });
    });
});