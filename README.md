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

### Hooks (run scripts on IP change)

You can have the client execute one or more scripts whenever it actually updates a DNS record — useful for things that need to react to a new public IP, like re-authorizing the IP with an SMTP provider that uses an IP allowlist.

Configure them under `hooks.onIpChange` in `config.json`. Each entry is either a plain command string, or an object:

```json
"hooks": {
  "onIpChange": [
    "/path/to/simple-script.sh",
    {
      "name": "brevo-ip-allowlist",
      "command": "/path/to/authorize-ip.sh",
      "args": ["--provider", "brevo"],
      "cwd": "/path/to",
      "env": { "BREVO_API_KEY": "your-brevo-api-key" },
      "timeout": 60000,
      "shell": false,
      "enabled": true
    }
  ]
}
```

| Field | Default | Description |
| --- | --- | --- |
| `command` | *required* | Executable to run. |
| `name` | the command | Label used in logs and error mails. |
| `args` | `[]` | Arguments passed to the command. |
| `cwd` | inherited | Working directory. |
| `env` | `{}` | Extra environment variables, merged on top of the process environment. |
| `timeout` | `60000` | Milliseconds before the hook is killed (SIGKILL) and reported as failed. |
| `shell` | `false` | Set to `true` to run the command through a shell (needed for pipes, globbing, etc.). |
| `enabled` | `true` | Set to `false` to keep a hook in the config without running it. |

Every hook receives the change details as environment variables:

| Variable | Example |
| --- | --- |
| `DDNS_EVENT` | `ip-change` |
| `DDNS_OLD_IP` | `203.0.113.10` |
| `DDNS_NEW_IP` | `203.0.113.42` |
| `DDNS_RECORDS` | `domain.com,foo.com` (comma-separated) |
| `DDNS_SERVICE_ID` | `your-ddns-service` |
| `DDNS_PAYLOAD` | the same data as a JSON object |

Behaviour:
- Hooks run **sequentially**, and only when at least one DNS record was actually updated.
- Hooks run **before** the IP change notification mail is sent. That ordering is deliberate: if a hook is what re-authorizes your new IP with the SMTP provider, the notification mail itself has a chance to go through.
- A failing hook (non-zero exit, timeout, or unusable command) does not stop the remaining hooks, but it is logged and included in the error notification mail.
- With `--dryRun` hooks are only logged, not executed. Use `--skipHooks` to skip them in a normal run.

Test your hooks without waiting for a real IP change:

```
npm run hooktest
```

It runs every enabled hook with placeholder values. Override them with `--oldIp`, `--newIp` and `--records` (comma-separated), e.g. `node ./src/hookTest.js --newIp 203.0.113.42 --records domain.com,foo.com`.

### Cron setup

To run this script automatically you can add it to your crontab. My setup looks like this and runs every 5 minute:
`*/5 * * * * /usr/bin/env node /path/to/your/code/src/index.js > /dev/null 2>&1`

Use [crontab.guru](https://crontab.guru/) to find a different interval.
