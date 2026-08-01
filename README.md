# Cloudflare DDNS client
This Node-application will check your current public IP address and update the A-record of the specified domain(s) in Cloudflare DNS. There is also support for domains in multiple zones.

## Setup
First make sure you have node installed.

Then:
1. Copy `config-example.json` to `config.json`
2. Configure API key, zones and DNS records. Note that API key can be specified on top level item or on a specific zone.
3. Run `npm run start`, or `npm run dev`

Use option '--dryRun' for testing. Use option `--verbose` to get verbose output of the process. You can override the DNS lookup check by using the `--forceUpdate`-argument, like this `npm run start -- --forceUpdate`. You can also run the script directly with node, like this: `node ./src/index.js --forceUpdate`. You might need to change file permissions for this to work (`chmod +x ./src/index.js`).

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

### Cron setup

To run this script automatically you can add it to your crontab. My setup looks like this and runs every 5 minute:
`*/5 * * * * /usr/bin/env node /path/to/your/code/src/index.js > /dev/null 2>&1`

Use [crontab.guru](https://crontab.guru/) to find a different interval.
