export default class Ip {
    static async get() {
        try {
            const response = await fetch('https://checkip.amazonaws.com');
            return (await response.text()).trim();
        } catch(e) {
            return false;
        }
    }

    static async resolve(dnsRecord) {
        try {
            const response = await fetch(`https://1.1.1.1/dns-query?name=${dnsRecord}`, {
                headers: {
                    'accept': 'application/dns-json'
                }
            });
            const jsonResponse = await response.json();
            return jsonResponse?.Answer?.[0]?.data;
        } catch(e) {
            return false;
        }
    }
}