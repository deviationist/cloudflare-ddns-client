export default class Cloudflare {
    static baseUrl = 'https://api.cloudflare.com/client/v4';

    static buildHeaders(apiKey, additional = {}) {
        return {
            ...additional,
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        };
    }
    
    static async getDnsRecord(apiKey, zoneId, dnsRecord) {
        try {
            const response = await fetch(`${Cloudflare.baseUrl}/zones/${zoneId}/dns_records?type=A&name=${dnsRecord}`, {
                headers: Cloudflare.buildHeaders(apiKey)
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
                headers: Cloudflare.buildHeaders(apiKey),
                body: JSON.stringify(data)
            });
            return response.status === 200;
        } catch(e) {
            return false;
        }
    }
}