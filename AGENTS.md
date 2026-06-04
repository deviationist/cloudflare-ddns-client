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
  mailTest.js       # `npm run mailtest`
  routers/          # opt-in, driver-based WAN guard (see below)
    RouterDriver.js   # base contract
    AsuswrtMerlin.js  # reference driver
    index.js          # registry + createRouterDriver() factory
    GuardState.js     # transition state for de-duped notifications
config-example.json # copy to config.json and fill in (config.json is gitignored)
```

## Running

- `npm run start` — run once. `npm run dev` — watch mode (nodemon).
- Flags: `--dryRun` (no writes), `--verbose` (console output), `--forceUpdate`
  (skip the "already correct?" short-circuit), `--configPath <path>`.
- `npm run mailtest` — send a test email using the configured mailer.

## Conventions

- **ES modules**, Node 18+ (developed on Node 24). Prefer built-in modules over
  new dependencies; current runtime deps are just `nodemailer` and `yargs`.
- **No secrets in git.** `config.json` is gitignored and holds API keys, SMTP
  credentials, etc. `config-example.json` must contain only placeholders.
  Router/router-like passwords are referenced by **environment variable name**
  (`passwordEnv`), never stored in config. Do not hardcode real IPs, hostnames,
  usernames, or credentials anywhere in tracked files.
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

The bundled `asuswrt-merlin` driver authenticates to the router web UI
(`/login.cgi` → token cookie) and reads nvram via `/appGet.cgi?hook=nvram_get`,
deciding `publishable` from: active WAN unit (failover), private/CGNAT WAN IP
(incl. `100.64.0.0/10`), or a mismatch between the WAN IP and the router's own
external-IP probe.

## Roadmap

See the **TODO / Roadmap** section in `README.md` (currently: IPv6 / AAAA
record support).
