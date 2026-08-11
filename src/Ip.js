import { isIP } from 'net';

export default class Ip {
    // Tried in order; the first source that answers with a usable address wins.
    // More than one because a single provider having a bad afternoon should not
    // stop us updating DNS — on 2026-08-11 checkip served 500/502/504 for half
    // an hour and every run in that window failed.
    static sources = [
        'https://checkip.amazonaws.com',
        'https://api.ipify.org',
        'https://icanhazip.com'
    ];

    static timeoutMs = 10000;

    // Whatever this returns goes straight into an A record, and nothing
    // downstream re-checks it, so a source is only believed when it answers 2xx
    // *and* the body parses as an IPv4 address. An error page, a captive-portal
    // redirect, or a 200 full of HTML all count as "this source is down" and we
    // move on to the next one.
    static async get({ logger = () => {}, sources = Ip.sources } = {}) {
        for (const source of sources) {
            try {
                const response = await fetch(source, { signal: AbortSignal.timeout(Ip.timeoutMs) });
                if (!response.ok) {
                    logger(`IP lookup via ${source} returned HTTP ${response.status}, trying next source.`, 'warn');
                    continue;
                }
                // Deliberately not logged on failure: a broken source may answer
                // with a whole HTML page, and that ends up in the log file.
                const body = (await response.text()).trim();
                if (isIP(body) !== 4) {
                    logger(`IP lookup via ${source} did not return an IPv4 address, trying next source.`, 'warn');
                    continue;
                }
                return body;
            } catch(e) {
                logger(`IP lookup via ${source} failed (${e.message}), trying next source.`, 'warn');
            }
        }
        return false;
    }

    static async resolve(dnsRecord) {
        try {
            const response = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(dnsRecord)}`, {
                headers: {
                    'accept': 'application/dns-json'
                },
                signal: AbortSignal.timeout(Ip.timeoutMs)
            });
            if (!response.ok) return false;
            const jsonResponse = await response.json();
            // The first answer is not necessarily the A record — a CNAME chain
            // puts the alias first, and returning that would compare a hostname
            // against an IP and force a needless update every run.
            return jsonResponse?.Answer?.find(answer => isIP(answer?.data) === 4)?.data;
        } catch(e) {
            return false;
        }
    }
}
