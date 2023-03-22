export default class Ip {
    static async get() {
        const response = await fetch('https://checkip.amazonaws.com');
        return (await response.text()).trim();
    }

    static async resolve(dnsRecord) {
        const response = await fetch(`https://1.1.1.1/dns-query?name=${dnsRecord}`, {
            headers: {
                'accept': 'application/dns-json'
            }
        });
        const jsonResponse = await response.json();
        return jsonResponse?.Answer?.[0]?.data;
    }
}