# Cloudflare DDNS client
This Node-application will check your current public IP address and update the A-record of the specified domain(s) in Cloudflare DNS. There is also support for domains in multiple zones.

## Setup
First make sure you have node installed.

Then:
1. Copy `config-example.json` to `config.json`
2. Configure API key, zones and DNS records
3. Run `npm run start`, or `npm run dev`

You can override the DNS lookup check by using the `--forceUpdate`-argument, like this `npm run start -- --forceUpdate`.
You can also run the script directly with node, like this: `node ./src/index.js --forceUpdate`. You might need to change file permissions for this to work (`chmod +x ./src/index.js`).

To run this script automatically you can add it to your crontab. My setup looks like this and runs every 5 minute:
`*/5 * * * * /usr/bin/env node /path/to/your/code/src/index.js > /dev/null 2>&1`

Use [crontab.guru](https://crontab.guru/) to find a different interval.
