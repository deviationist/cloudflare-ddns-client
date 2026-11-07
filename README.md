# Cloudflare DDNS client
This Node-application will check your current public IP address and update the A-record of the specified domain(s) in Cloudflare DNS. There is also support for domains in multiple zones.

## Setup
First make sure you have node installed.

Then:
1. Copy `config-example.json` to `config.json`
2. Configure API key, zones and DNS records. Note that API key can be specified on top level item or on a specific zone.
3. Run `npm run start`, or `npm run dev`

Use option `--dry-run` for testing. Use option `--verbose` to get verbose output of the process. You can override the DNS lookup check by using the `--forceUpdate`-argument, like this `npm run start -- --forceUpdate`. You can also run the script directly with node, like this: `node ./src/index.js --forceUpdate`. You might need to change file permissions for this to work (`chmod +x ./src/index.js`).

### Public IP sources
The client detects your public IP by asking an external echo service. `ipSources`
is an optional list of those services, tried in order until one answers usefully;
omit it to use the built-in defaults (`checkip.amazonaws.com`, `api.ipify.org`,
`icanhazip.com`).

A source is only believed when it answers `2xx` **and** the body parses as an
IPv4 address. Anything else — an HTTP error, an HTML error page served with a
200, a captive-portal redirect, an IPv6 address — is treated as that source being
down, and the next one is tried. If every source fails the run exits non-zero
without touching Cloudflare, leaving your records on their last known-good value.

This matters more than it looks: whatever comes back is written straight into an
A record. On 2026-08-11 the then-single source served `502`/`500`/`504` HTML error
pages for half an hour, and the client tried to publish the error page itself as
an IP address on every run.

### Mail notification on failure
Alternatively you can configure the script to notify you whenever something is wrong. You need a Gmail-account and a an App Password. Go to [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and create an app (for example called "Cloudflare DDNS Client"). Copy the password into the `config.json`-file in the mailConfig.password field. Be sure to remove the whitespace from the password. Also configure the mailConfig.fromfromAddress (the sender) and the errorRecipientMailAddress (the recipient). Optionally you can also specify a service name to identify which system sent the notification (this is useful if you have multiple instances). Note that mailConfig.fromfromAddress must be the Gmail-address that is connected to the account where you created the App Password. You can test the mailer by running `npm run mailtest`.

### Hooks (run scripts on events)

You can have the client execute one or more scripts when something happens — most usefully when your public IP changes. The motivating case: re-authorizing a rotated residential IP with an SMTP provider that uses an IP allowlist.

Configure hooks under `hooks` in `config.json`. Each entry is either a plain command string, or an object:

```json
"hooks": [
  "/path/to/simple-script.sh",
  {
    "name": "brevo-ip-allowlist",
    "on": ["publicIpChanged", "dnsRecordUpdated"],
    "once": true,
    "stopOnError": false,
    "command": "/path/to/authorize-ip.sh",
    "args": ["--provider", "brevo"],
    "cwd": "/path/to",
    "env": { "BREVO_API_KEY": "your-brevo-api-key" },
    "timeout": 60000,
    "shell": false,
    "enabled": true
  },
  {
    "name": "alert-on-failure",
    "on": ["error"],
    "command": "/path/to/alert.sh"
  }
]
```

You can also key hooks by event name instead of listing them in an array:

```json
"hooks": {
  "publicIpChanged": ["/path/to/authorize-ip.sh"],
  "error": ["/path/to/alert.sh"]
}
```

#### Events

| Event | Fires when |
| --- | --- |
| `publicIpChanged` | Your detected public IP differs from the last one recorded in `ipStateFile`. Independent of Cloudflare — it fires even if the DNS records were already correct. |
| `dnsRecordUpdated` | At least one Cloudflare record was actually updated in this run. |
| `error` | One or more errors occurred (including failed hooks). Runs just before the error mail. |
| `always` | Every run, whether anything changed or not. |

`publicIpChanged` requires `ipStateFile` to be set — it is the file where the client records the last public IP it saw:

```json
"ipStateFile": "/var/lib/cloudflare-ddns/last-ip"
```

The first run with no recorded IP is treated as a baseline: the IP is written to the file and no event fires.

#### Hook options

| Field | Default | Description |
| --- | --- | --- |
| `command` | *required* | Executable to run. |
| `on` | `["publicIpChanged"]` | Events this hook reacts to. |
| `name` | the command | Label used in logs and error mails. |
| `args` | `[]` | Arguments passed to the command. |
| `cwd` | inherited | Working directory. |
| `env` | `{}` | Extra environment variables, merged on top of the process environment. |
| `timeout` | `60000` | Milliseconds before the hook is killed (SIGKILL) and reported as failed. |
| `shell` | `false` | Set to `true` to run the command through a shell (needed for pipes, globbing, etc.). |
| `once` | `true` | Run at most once per run. A hook listening to several events fires on the first one that triggers and is skipped for the rest. Set to `false` to run it once per matching event. |
| `stopOnError` | `false` | If this hook fails, skip all remaining hooks for the rest of the run — including hooks for later events. |
| `runWhenPaused` | `false` | Run this hook even when the reachability guard has paused DNS updates. See below. |
| `enabled` | `true` | Set to `false` to keep a hook in the config without running it. |

#### Environment passed to hooks

| Variable | Example |
| --- | --- |
| `DDNS_EVENT` | `publicIpChanged` |
| `DDNS_OLD_IP` | `203.0.113.10` |
| `DDNS_NEW_IP` | `203.0.113.42` |
| `DDNS_RECORDS` | `domain.com,foo.com` (comma-separated) |
| `DDNS_ERRORS` | error messages, newline-separated (`error` event) |
| `DDNS_SERVICE_ID` | `your-ddns-service` |
| `DDNS_PAYLOAD` | the same data as a JSON object |

#### Hooks and the reachability guard

When the [reachability guard](#publish-only-a-reachable-ip-cgnat--wan-failover-guard) pauses DNS updates, hooks are skipped along with them — with one exception: a hook with `runWhenPaused: true` still fires for `publicIpChanged`.

That exists because the two concerns pull in opposite directions. Publishing a CGNAT address to DNS is wrong, so updates stop. But that carrier address *is* where your outbound traffic now comes from, so anything keyed on your egress IP — an SMTP provider's IP allowlist, for instance — needs to know about it precisely while the guard is active.

While paused, only `publicIpChanged` is dispatched, only to hooks that opted in, and `records` is empty since nothing was updated. The payload carries `updatesPaused: true`. `ipStateFile` is written only if such a hook actually ran and succeeded, so if you have none configured the change is left unconsumed for the next unpaused run.

#### Behaviour

- Hooks run **sequentially**, in config order, and events are dispatched in this order: `publicIpChanged`, `dnsRecordUpdated`, `always`, then `error`.
- Hooks run **before** the IP change notification mail. That ordering is deliberate: if a hook is what re-authorizes your new IP with the SMTP provider, the notification mail itself has a chance to go through.
- A failing hook (non-zero exit, timeout, or unusable command) does not stop the remaining hooks unless it sets `stopOnError`. Failures are logged and included in the error notification mail.
- **The new IP is only recorded in `ipStateFile` once its `publicIpChanged` hooks succeed.** If a hook fails, the IP is not recorded and the event fires again on the next run — so a transient failure retries instead of being silently lost. Hooks should therefore be idempotent, and a permanently broken hook will retry (and mail you) every run.
- With `--dryRun` hooks are only logged, not executed, and `ipStateFile` is not written. `--skipHooks` skips them in a normal run, and likewise leaves `ipStateFile` untouched so the change is not consumed — the next normal run still sees it.

Test your hooks without waiting for a real IP change:

```
npm run hooktest
```

It runs the hooks for `publicIpChanged` with placeholder values. Override with `--event` (comma-separated), `--oldIp`, `--newIp` and `--records`, e.g. `node ./src/hookTest.js --event publicIpChanged,error --newIp 203.0.113.42 --records domain.com,foo.com`.
### Publish only a reachable IP (CGNAT / WAN failover guard)

A public IP is not the same thing as a *reachable* one. Behind carrier-grade
NAT (CGNAT) — Starlink, mobile broadband, a 4G/5G modem on WAN failover, or an
ISP that has simply run out of IPv4 — the address the internet sees is a
*shared* carrier address that cannot route back to you. Publish it and your
domain points at somewhere nobody can reach.

That failure is silent, which is what makes it worth guarding. The DDNS update
succeeds, the record changes, nothing errors; the address just doesn't come
back to you. Nothing in the client's own view can tell the difference, because
the echo service returns a perfectly well-formed address either way.

So this optional guard asks your **router** what its uplink actually looks like
and, when the answer means inbound traffic can't arrive, **skips the update and
leaves your records on the last known-good IP**.

Two things worth being clear about:

- **It infers, it does not probe.** It reads router state and concludes; it
  never tests reachability from outside. That keeps it cheap and dependency-free,
  but it only catches causes a driver knows to look for.
- **It assumes you use DDNS for inbound reachability.** If you run DDNS purely
  to track your *egress* address — an SMTP or API allowlist, say — then pausing
  is the wrong behaviour for you, and hooks are the answer: see
  [Hooks and the guard](#hooks-and-the-reachability-guard). DNS records are for
  getting traffic *in*; a hook can still consume the address you now go *out*
  from, precisely while updates are paused.

CGNAT is the most common cause, not the definition — the guard also pauses on a
plain WAN failover, and on an upstream NAT that is not carrier-grade at all.

The feature is **opt-in and driver-based**: add a `router` block to
`config.json` to enable it; omit it and the client behaves exactly as before.
Drivers live in `src/routers/`. Three ship with the client:

| `driver` | Use when |
|---|---|
| `command` | **Any router.** You supply a command; its stdout decides. No JavaScript required. |
| `asuswrt-merlin` | Asuswrt / Asuswrt-Merlin routers, read over SSH or the web UI. |
| `routeros` | MikroTik RouterOS 7, read over SSH or the REST API. |

A third option is to write your own: implement the `evaluate()` contract (see
`src/routers/RouterDriver.js`) and register it in `src/routers/index.js`.

### The `command` driver (works with any router)

Point it at anything that can tell you about your WAN — a vendor CLI, an SSH
call into the router, `curl` plus `grep` of a modem status page, an SNMP query:

```json
"router": {
  "driver": "command",
  "stateFile": "/var/lib/cloudflare-ddns/router-guard.json",
  "options": {
    "command": "/usr/local/bin/wan-state",
    "args": [],
    "shell": false,
    "timeoutMs": 10000
  }
}
```

Two output shapes are accepted on stdout:

1. **A bare IPv4 address** — your WAN address as the router sees it. The client
   classifies it, so a private or CGNAT address means "don't publish". This
   covers most routers and is usually a one-liner:

   ```json
   { "command": "ssh router 'nvram get wan0_ipaddr'", "shell": true }
   ```

2. **JSON** — `{"publishable": true|false, "reason": "...", "detail": {...}}`
   for states an address alone can't express, such as being on a failover
   uplink that happens to have a routable address.

The command receives the detected public IP as `DDNS_DETECTED_IP`, so it can
compare that with what the router believes without looking it up again.

**The exit status is not the verdict.** A non-zero exit, a timeout, or output
that is neither an IP nor JSON all mean *"could not determine"*, which fails
open. That is deliberate: if a broken script could signal "paused", a typo in
your command would silently freeze DNS updates forever. Say "don't publish"
explicitly, in the output, or not at all.

Set `shell: true` to run the command through `/bin/sh -c` when you need a pipe
or a redirect. Your config is trusted input, but note the command runs with the
same privileges as the client.

### The `asuswrt-merlin` driver

```json
"router": {
  "driver": "asuswrt-merlin",
  "stateFile": "/var/lib/cloudflare-ddns/router-guard.json",
  "options": {
    "transport": "auto",
    "ssh": { "host": "192.168.1.1", "user": "admin" },
    "url": "https://192.168.1.1:8443",
    "username": "admin",
    "passwordEnv": "ROUTER_PASSWORD",
    "verifySsl": false
  }
}
```

#### Transports

The `asuswrt-merlin` driver can read the router's nvram two ways. Configure
either or both; `transport` picks between them:

| `transport` | Behaviour |
|---|---|
| `"auto"` (default) | Try `ssh` first, fall back to `web`. A rotated password or revoked key degrades instead of blinding the guard. |
| `"ssh"` | SSH only. |
| `"web"` | Web UI only. |

- **`ssh`** — runs `nvram get` over SSH, reading every key in one round trip.
  Needs no password at all when key auth is set up, which also means no
  credential on disk. Options: `host` (required), `user`, `port`,
  `identityFile`, `strictHostKeyChecking`, `sshBinary`. It always runs with
  `BatchMode=yes`, so an unknown host key fails fast rather than hanging a cron
  run on a prompt — add the router to `known_hosts` first.
- **`web`** — authenticates at `/login.cgi` and reads keys via `/appGet.cgi`.
  Needs `url`, `username` and a password. Use `verifySsl: false` for the
  router's self-signed certificate.

Prefer `ssh` where you can. Beyond avoiding a stored password, routers with an
admin source-allowlist commonly permit a host SSH but not the web UI, and the
web transport is the one that gets blocked.

Both `username` and `password` can be read from the environment instead of the
config file, via `usernameEnv` and `passwordEnv`. The username is worth hiding
too when it isn't the stock `admin`.

- `passwordEnv` — name of the **environment variable** holding the router
  password (the password is never stored in `config.json`). Export it before
  running, e.g. `ROUTER_PASSWORD=... node ./src/index.js`, or keep it in a `.env`
  file and let node load it — see *Supplying the router password* below.
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

#### Supplying the router password

Copy `.env.example` to `.env`, set `ROUTER_PASSWORD`, and `chmod 600 .env`. Node
loads it natively — no dependency, no dotenv:

```
node --env-file-if-exists=./.env ./src/index.js
```

`--env-file-if-exists` rather than `--env-file` so the client still starts on a
host where the guard isn't configured and no `.env` exists.

Prefer this over putting the password in the crontab line directly: cron treats
an unescaped `%` as a newline, so a password containing one is silently
truncated. Keeping it in `.env` sidesteps that entirely.

Note the router account needs access to the **web UI** specifically. On Asus
firmware with *Administration → System → Access Restriction* enabled, a client
allowed only SSH can still reach the router yet gets a filtered port on the
web-UI port, and the guard will fail open on every run.

### The `routeros` driver (MikroTik)

For MikroTik routers on **RouterOS 7**. It reads two tables, the default
routes and the interface addresses, and needs nothing router-specific in
config to work:

```json
"router": {
  "driver": "routeros",
  "stateFile": "/var/lib/cloudflare-ddns/router-guard.json",
  "options": {
    "transport": "auto",
    "ssh": { "host": "192.168.88.1", "user": "ddns-guard" },
    "url": "https://192.168.88.1",
    "username": "ddns-guard",
    "passwordEnv": "ROUTER_PASSWORD",
    "caFile": "/etc/ssl/routeros-ca.pem"
  }
}
```

How it decides (either one pauses updates):

1. **Failover.** RouterOS fails over by route distance: the backup uplink's
   default route has a higher distance and becomes active only when every
   better route is gone, however the primary is health-checked (link down,
   `check-gateway`, a recursive route, netwatch). So *the active default route
   has a higher distance than the best enabled one* means failover. Checked
   first, so a backup uplink with a routable address still pauses.
2. **The router doesn't hold the public IP.** The detected public IP must be
   assigned to one of the router's interfaces. If it isn't, something upstream
   (CGNAT, a carrier NAT, an ISP modem doing NAT) owns it, and inbound traffic
   would land there, not on you.

If it can't reach or parse the router, or finds no active default route, it
**fails open** like the other drivers.

#### Transports

Both are read-only and both return JSON. A user in the built-in **`read`**
group is enough for either; create a dedicated one rather than reusing an
admin account.

| `transport` | Behaviour |
|---|---|
| `"auto"` (default) | Try `ssh`, fall back to `rest`. |
| `"ssh"` | SSH only. Runs `:serialize to=json` (**RouterOS 7.13+**), both tables in one round trip. Key auth, so no stored password. Options as for `asuswrt-merlin` (`host`, `user`, `port`, `identityFile`, ...); add the router to `known_hosts` first. |
| `"rest"` | The REST API at `/rest` (RouterOS 7.1+), with HTTP Basic auth. Served by the **`www-ssl`** service, so the binary API services (`api`, `api-ssl`) can stay disabled. Needs `url`, `username`/`usernameEnv` and `password`/`passwordEnv`. |

For a router signing its own certificate, give its CA as `caFile` (a PEM file)
rather than `verifySsl: false`: the client then verifies the router without
your host trusting that CA for anything else.

Setting up the read-only user, with key auth for ssh:

```
/user add name=ddns-guard group=read password=<long random>
/user ssh-keys add user=ddns-guard key="ssh-ed25519 AAAA... ddns@host"
```

#### Telling it about your setup

The defaults suit the usual RouterOS failover. Each option covers a setup they
can't see:

| Option | Default | Use when |
|---|---|---|
| `routingTable` | `"main"` | Your default routes live in another table. |
| `failover` | `"distance"` | `"off"` leaves only the address check, e.g. for a load-balancing setup where equal-distance routes are all primaries. |
| `primaryDistance` | best enabled distance | Your failover **disables** the primary route (a netwatch script) instead of letting it go inactive. A disabled route is ignored, which would make the backup look like the best one left; pin the primary's distance here. |
| `backupRoute` | none | `{ "gateway": "<regex>", "comment": "<regex>" }`. An active route matching either is a backup, whatever its distance, e.g. `{ "gateway": "^lte" }`. |
| `checkAddress` | `true` | `false` for a router behind 1:1 NAT that never holds its public IP, where the address check would pause forever. |

A bad value (an unknown `failover` mode, an invalid regex) is reported in the
log and fails open; it never crashes the run.

Not modelled: VRFs and policy routing that keep the internet default route out
of a single table (fails open), and load balancing where the echo service may
be reached over either uplink.

### Tests

```
npm test
```

Runs the whole suite on node's built-in test runner — no test dependencies. It
covers the units, the router guard (against a fake router), the hook runner, and
end-to-end runs of `src/index.js` as a real subprocess with the network stubbed
out, asserting on the exact requests that would have hit Cloudflare. It needs no
credentials, no network and no router, so it passes on a fresh clone.

#### Testing against a real router (opt-in)

If you use the guard, `npm run test:router` checks the bits mocks cannot: that
your router still authenticates, that the nvram keys the driver depends on still
carry values, and — if both are configured — that the ssh and web transports
report identical values. It deliberately does not assert a *verdict*, since the
right answer depends on what your WAN is doing at the time.

```
DDNS_TEST_ROUTER_URL=https://192.168.1.1:8443 \
DDNS_TEST_ROUTER_USER=admin \
DDNS_TEST_ROUTER_SSH_HOST=192.168.1.1 \
npm run test:router
```

`ROUTER_PASSWORD` comes from `.env`. These tests are read-only — the driver has
no write path to the router at all.

They run only when `DDNS_TEST_ROUTER=1` (which the npm script sets). Credentials
being present is deliberately *not* enough: anyone running this client already
has `ROUTER_PASSWORD` in their environment, and `npm test` must never start
talking to their router because of that. Under a plain `npm test` these skip
with a visible reason rather than passing quietly.

### Cron setup

To run this script automatically you can add it to your crontab. My setup looks like this and runs every 5 minute:
`*/5 * * * * /usr/bin/env node /path/to/your/code/src/index.js > /dev/null 2>&1`

Use [crontab.guru](https://crontab.guru/) to find a different interval.

## TODO / Roadmap

- **Verify the guard's pause path against a real failover.** Every pause verdict
  so far has come from synthetic router state — unit tests, the fake router, and
  `npm run test:router` against a live router that was healthy at the time. The
  logic is well covered, but the end-to-end path (router fails over → guard
  pauses → records stay on the last known-good IP → "paused" mail → recovery)
  has never run for real.

  To exercise it: drop the primary WAN and let the router move to its secondary
  uplink. Expect DNS updates to stop, records to hold their previous value, one
  "DNS updates paused" mail per configured host, and a matching "resumed" mail
  once the primary returns.

  Note this generally **cannot be tested remotely.** The condition being tested
  is precisely the one that removes inbound reachability, so a VPN or any other
  remote path into the network goes down with it. It wants doing on-site.

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
