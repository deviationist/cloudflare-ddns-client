import Config from './Config.js';
import Hooks, { EVENTS } from './Hooks.js';
import Logger from './Logger.js';
import yargs from 'yargs';

const argv = yargs(process.argv).argv;
const configPath = argv.configPath;
if (configPath) Config.filePath = configPath;

const dryRun = argv.dryRun;
const appLogger = new Logger({ dryRun, verbose: true });
const logger = (message, level = 'log') => appLogger.log(message, level);

const hooks = new Hooks(Config, logger, { dryRun });

if (!hooks.isConfigured()) {
  console.log('No enabled hooks configured under "hooks"');
  process.exit(1);
}

const events = argv.event ? String(argv.event).split(',') : ['publicIpChanged'];
const unknown = events.filter(event => !EVENTS.includes(event));
if (unknown.length > 0) {
  console.log(`Unknown event(s): ${unknown.join(', ')}. Known events: ${EVENTS.join(', ')}`);
  process.exit(1);
}

const payload = {
  oldIp: argv.oldIp || '192.0.2.1',
  newIp: argv.newIp || '192.0.2.2',
  records: (argv.records || 'example.com').split(','),
  errors: ['Example error message'],
  serviceId: Config.get('serviceId') || null,
  dryRun: !!dryRun
};

const results = [];
for (const event of events) {
  results.push(...await hooks.dispatch(event, payload));
}

const failed = results.filter(result => !result.success);
console.log(`\n${results.length - failed.length}/${results.length} hook run(s) succeeded.`);
if (failed.length > 0) process.exit(1);
