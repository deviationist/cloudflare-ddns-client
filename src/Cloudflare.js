export default class Cloudflare {
    static baseUrl = 'https://api.cloudflare.com/client/v4';
    
    static async getDnsRecord(apiKey, zoneId, dnsRecord) {
        try {
            const response = await fetch(`${Cloudflare.baseUrl}/zones/${zoneId}/dns_records?type=A&name=${dnsRecord}`, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            const jsonResponse = await response.json();
            return jsonResponse?.result?.[0];
        } catch(e) {
            return false;
        }
    }

    static async updateDnsRecord(apiKey, zoneId, dnsRecordId, data) {
        try {
            const response = await fetch(`${Cloudflare.baseUrl}/zones/${zoneId}/dns_records/${dnsRecordId}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });
            return response.status === 200;
        } catch(e) {
            return false;
        }
    }
}