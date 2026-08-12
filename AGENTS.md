# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

A small Node.js (ES modules) CLI that checks the current public IP and updates
Cloudflare DNS records for the configured domains. It supports multiple zones
and multiple API keys, optional email notifications, file logging, and an
opt-in router guard that pauses updates while the connection is on a WAN
failover path / behind CGNAT.

The project is intentionally **agnostic apart from two hard couplings: Node and
Cloudflare.** Keep router-, host-, and deployment-specific details out of the
core — they belong behind an abstraction (see Router drivers) or in the user's
local `config.json`.

## Layout

```
src/
  index.js          # entry point: orchestrates the whole run (top-level await)
  Config.js         # reads ./config.json (overridable via --configPath); dot-notation getter
  Ip.js             # Ip.get() = current public IP; Ip.resolve(name) = current DNS value
  Cloudflare.js     # Cloudflare API v4 calls (getDnsRecord / updateDnsRecord)
  Mailer.js         # nodemailer wrapper, driven by config.mailConfig
  ErrorHandler.js   # collects errors and emails them once at the end
  Logger.js         # console (when --verbose) + optional logFile / ipHistoryFile
  Constants.js      # serviceName etc.
  Hooks.js          # runs user scripts on publicIpChanged / dnsRecordUpdated / always / error
  IpState.js        # last-known public IP, for change detection independent of Cloudflare
  mailTest.js       # `npm run mailtest`
  hookTest.js       # `npm run hooktest`
  routers/          # opt-in, driver-based WAN guard (see below)
    RouterDriver.js   # base contract
    addresses.js      # shared: is an IPv4 publicly routable? (used by every driver)
    AsuswrtMerlin.js  # Asuswrt driver, ssh + web transports
    CommandDriver.js  # router-agnostic: a user command's stdout is the verdict
    index.js          # registry + createRouterDriver() factory
    GuardState.js     # transition state for de-duped notifications
test/               # node:test suite; helpers/ stubs the network + a fake router
config-example.json # copy to config.json and fill in (config.json is gitignored)
.env.example        # copy to .env for router credentials (gitignored)
```

## Running

- `npm run start` — run once. `npm run dev` — watch mode (nodemon).
- Flags: `--dry-run` (no writes), `--verbose` (console output), `--forceUpdate`
  (skip the "already correct?" short-circuit), `--configPath <path>`.
- `npm run mailtest` / `npm run hooktest` — exercise the mailer / hooks alone.

## Testing

`npm test` runs everything on node's built-in runner (no test deps). **Run it
before and after any change.** The suite covers units, the router guard against
a fake router, the hook runner, and end-to-end runs of `src/index.js` as a real
subprocess with `fetch` and nodemailer stubbed (`test/helpers/stub.js`),
asserting on the exact requests that would have reached Cloudflare.

When fixing a bug, **check the new test actually fails against the unfixed
code** — revert the fix, watch it go red, restore. A test written from the fixed
code frequently passes for the wrong reason.

## Conventions

- **ES modules**, Node 18+ for the library itself (developed on Node 24); the
  documented `--env-file-if-exists` invocation needs Node 20.18+ / 22.9+. Prefer
  built-in modules over new dependencies; current runtime deps are just
  `nodemailer` and `yargs`.
- **No secrets in git.** `config.json` is gitignored and holds API keys, SMTP
  credentials, etc. `config-example.json` must contain only placeholders. Router
  credentials are referenced by **environment variable name** (`passwordEnv` /
  `usernameEnv`), never stored in config; `.env` is gitignored and loaded via
  node's native `--env-file-if-exists` (no dotenv dependency). Do not hardcode
  real IPs, hostnames, usernames, or credentials anywhere in tracked files.
- Network failures should degrade gracefully (functions return `false`/`null`
  rather than throwing) so a single bad run never corrupts a DNS record.
- The client only writes a record when the value actually changed (it checks
  both the live DNS answer and the current Cloudflare record first).

## Router drivers (opt-in WAN guard)

When a `router` block is present in config, the client asks a driver whether the
detected public IP is safe to publish, and **skips the update** when the router
is on a failover/CGNAT path (the public IP would be a shared carrier address
that can't route back home). With no `router` block, the whole feature is inert.

A driver extends `RouterDriver` and implements:

```
async evaluate(detectedIp) -> {
  ok:          boolean,   // could the WAN state be determined?
  publishable: boolean,   // is this a real, routable public connection?
  reason:      string,    // human-readable, gets logged/emailed
  detail?:     object     // optional diagnostics
}
```

Core semantics the driver must honor:
- `ok === false` → caller **fails open** (updates as normal); use this for "I
  couldn't reach/parse the router", so a transient glitch never freezes DDNS.
- `ok === true && publishable === false` → caller **skips** the update.

To add a driver: implement the class in `src/routers/`, then register it in
`src/routers/index.js` under its `driver` key. Keep all router-specific HTTP /
auth / parsing inside the driver; the core must stay router-agnostic.

The bundled `asuswrt-merlin` driver reads the same nvram keys over either of two
transports, selected by `options.transport` (`auto` | `ssh` | `web`; `auto`
prefers ssh and falls back):

- **ssh** — `nvram get` over SSH, all keys in one round trip, `BatchMode=yes`.
  No stored password when key auth is used. Keys are validated against
  `/^[a-z0-9_]+$/` before interpolation into the remote command.
- **web** — `/login.cgi` → token cookie, then `/appGet.cgi?hook=nvram_get`.

It decides `publishable` from: active WAN unit (failover), private/CGNAT WAN IP
(incl. `100.64.0.0/10` **and** the RFC1918 ranges — carriers hand out `10.x` on
mobile uplinks as readily as the official CGNAT range), or a mismatch between
the WAN IP and the router's own external-IP probe.

The `command` driver is the router-agnostic escape hatch: the user supplies a
command, and its stdout is the verdict — either a bare IPv4 (classified via
`addresses.js`) or `{"publishable": bool, "reason", "detail"}` JSON. Its exit
status is deliberately **not** the verdict; a non-zero exit, timeout, or
unparseable output all mean "could not determine" and fail open, so a typo in a
user's command cannot silently freeze DNS updates.

Address classification lives in `addresses.js`, not in any driver — "is this
reachable from the internet" is the question the guard exists to answer, and it
is not router-specific. New drivers must import it rather than restating the
ranges.

## Roadmap

See the **TODO / Roadmap** section in `README.md` (currently: IPv6 / AAAA
record support).
