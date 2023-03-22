import Config from './Config.js';
import Ip from './Ip.js';
import Cloudflare from './Cloudflare.js';

const items = Config.get();

const ipAddress = await Ip.get();
if (!ipAddress) {
    console.error('Coult not obtain IP address.');
    process.exit(1);
}

console.log(`Current IP address: ${ipAddress}`);

items.map(item => {
    item.zones.map(zone => {
        zone.dnsRecords.map(async (dnsRecord) => {
            
            if (ipAddress == await Ip.resolve(dnsRecord)) {
                console.log(`Domain "${dnsRecord}" is currently set to "${ipAddress}", no changes needed.`);
                return;
            }

            const dnsRecordFromCf = await Cloudflare.getDnsRecord(item.apiKey, zone.zoneId, dnsRecord);
            if (!dnsRecordFromCf) {
                console.error(`Could not get DNS record ID for "${dnsRecord}". Aborting.`);
                return;
            }
            console.log(`DNS record Id for "${dnsRecord}" is "${dnsRecordFromCf?.id}".`);

            const success = await Cloudflare.updateDnsRecord(item.apiKey, zone.zoneId, dnsRecordFromCf?.id, {
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