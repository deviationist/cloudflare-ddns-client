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
Alternatively you can configure the script to notify you whenever something is wrong. You need a Gmail-account and a an App Password. Go to [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and create an app (for example called "Cloudflare DDNS Client"). Copy the password into the `config.json`-file in the mailConfig.password field. Be sure to remove the whitespace from the password. Also configure the mailConfig.fromfromAddress (the sender) and the errorRecipientMailAddress (the recipient). Note that mailConfig.fromfromAddress must be the Gmail-address that is connected to the account where you created the App Password. You can test the mailer by running `npm run mailtest`.

### Cron setup

To run this script automatically you can add it to your crontab. My setup looks like this and runs every 5 minute:
`*/5 * * * * /usr/bin/env node /path/to/your/code/src/index.js > /dev/null 2>&1`

Use [crontab.guru](https://crontab.guru/) to find a different interval.
