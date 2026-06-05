# Cloudflare DDNS client
This Node-application will check your current public IP address and update the A-record of the specified domain(s) in Cloudflare DNS. There is also support for domains in multiple zones.

## Setup
First make sure you have node installed.

Then:
1. Copy `config-example.json` to `config.json`
2. Configure API key, zones and DNS records. Note that API key can be specified on top level item or on a specific zone.
3. Run `npm run start`, or `npm run dev`

Use option `--dry-run` for testing. Use option `--verbose` to get verbose output of the process. You can override the DNS lookup check by using the `--forceUpdate`-argument, like this `npm run start -- --forceUpdate`. You can also run the script directly with node, like this: `node ./src/index.js --forceUpdate`. You might need to change file permissions for this to work (`chmod +x ./src/index.js`).

### Mail notification on failure
Alternatively you can configure the script to notify you whenever something is wrong. You need a Gmail-account and a an App Password. Go to [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and create an app (for example called "Cloudflare DDNS Client"). Copy the password into the `config.json`-file in the mailConfig.password field. Be sure to remove the whitespace from the password. Also configure the mailConfig.fromfromAddress (the sender) and the errorRecipientMailAddress (the recipient). Optionally you can also specify a service name to identify which system sent the notification (this is useful if you have multiple instances). Note that mailConfig.fromfromAddress must be the Gmail-address that is connected to the account where you created the App Password. You can test the mailer by running `npm run mailtest`.

### WAN failover / CGNAT guard (optional, driver-based)

If your connection can fall back to a path that sits behind carrier-grade NAT
(CGNAT) — for example a 4G/5G USB modem used as WAN failover — the public IP
seen from the internet becomes a *shared* carrier address that cannot route back
to your network. Publishing it would point your domain at a dead address. This
optional guard asks your router whether it is currently on such a path and, if
so, **skips the update and leaves your records on the last known-good IP**.

The feature is **opt-in and driver-based**: add a `router` block to
`config.json` to enable it; omit it and the client behaves exactly as before.
Drivers live in `src/routers/`. The bundled driver is `asuswrt-merlin`
(Asuswrt / Asuswrt-Merlin routers, read over the router's web UI). Other routers
can be supported by adding a driver that implements the same `evaluate()`
contract (see `src/routers/RouterDriver.js`) and registering it in
`src/routers/index.js`.

```json
"router": {
  "driver": "asuswrt-merlin",
  "stateFile": "/var/log/cloudflare-ddns/router-guard.json",
  "options": {
    "url": "https://192.168.1.1:8443",
    "username": "admin",
    "passwordEnv": "ROUTER_PASSWORD",
    "verifySsl": false
  }
}
```

- `passwordEnv` — name of the **environment variable** holding the router
  password (the password is never stored in `config.json`). Export it before
  running, e.g. `ROUTER_PASSWORD=... node ./src/index.js`.
- `verifySsl` — set `false` for a router's self-signed certificate; `true` (the
  default) if you reach it through a valid certificate.
- `stateFile` — optional. When set, a "DNS updates paused / resumed" email is
  sent **only on a state transition** (not every run), reusing your `mailConfig`
  and `notificationMailAddress`. Without it, transitions are logged but not
  emailed.

How the `asuswrt-merlin` driver decides (any one is enough to pause updates):
the router has failed over to its **secondary WAN**; the active WAN IP is in a
private/CGNAT range (incl. `100.64.0.0/10`); or the router's own external-IP
probe disagrees with its WAN IP (an upstream NAT). If the router can't be
reached, the guard **fails open** so a transient glitch never freezes DDNS.

## TODO / Roadmap

- **IPv6 (AAAA) support.** The client currently manages IPv4 `A` records only
  (the record type is hardcoded to `A`, and the IP is sourced from an IPv4-only
  endpoint). Planned: make the record `type` configurable per DNS record
  (default `A`), use it both when querying the existing record and in the
  update payload, and add an IPv6 address source. Note the IPv6 nuance — there
  is usually no NAT on IPv6, so each host has its own global address; an AAAA
  often wants a per-host/interface address rather than a single egress lookup.
  This also pairs with the WAN failover guard: many CGNAT'd uplinks still hand
  out a routable IPv6, so AAAA records can preserve inbound reachability when
  IPv4 is behind CGNAT.

### Cron setup

To run this script automatically you can add it to your crontab. My setup looks like this and runs every 5 minute:
`*/5 * * * * /usr/bin/env node /path/to/your/code/src/index.js > /dev/null 2>&1`

Use [crontab.guru](https://crontab.guru/) to find a different interval.
