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

    // The logger is optional, but without it a rejection is indistinguishable
    // from a network failure — the 2026-08-11 incident logged nothing but
    // "Could not update DNS-record" while Cloudflare was saying exactly what
    // was wrong with the payload.
    static async updateDnsRecord(apiKey, zoneId, dnsRecordId, data, logger = () => {}) {
        try {
            const response = await fetch(`${Cloudflare.baseUrl}/zones/${zoneId}/dns_records/${dnsRecordId}`, {
                method: 'PUT',
                headers: Cloudflare.buildHeaders(apiKey),
                body: JSON.stringify(data)
            });
            if (response.status === 200) return true;
            logger(`Cloudflare rejected the update with HTTP ${response.status}: ${await Cloudflare.errorDetail(response)}`, 'error');
            return false;
        } catch(e) {
            logger(`Cloudflare update request failed: ${e.message}`, 'error');
            return false;
        }
    }

    // Best-effort: an error body is not guaranteed to be the documented JSON
    // shape (a gateway in front of the API can return HTML), so never let
    // parsing it throw over the top of the failure we are actually reporting.
    static async errorDetail(response) {
        try {
            const body = await response.json();
            const messages = (body?.errors ?? []).map(error => error?.message).filter(Boolean);
            return messages.length ? messages.join('; ') : 'no error detail returned';
        } catch(e) {
            return 'unparseable error body';
        }
    }
}