import Config from './Config.js';
import Hooks from './Hooks.js';
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
  console.log('No enabled hooks configured under hooks.onIpChange');
  process.exit(1);
}

const results = await hooks.runIpChangeHooks({
  oldIp: argv.oldIp || '192.0.2.1',
  newIp: argv.newIp || '192.0.2.2',
  records: (argv.records || 'example.com').split(','),
  serviceId: Config.get('serviceId') || null,
  dryRun: !!dryRun
});

const failed = results.filter(result => !result.success);
console.log(`\n${results.length - failed.length}/${results.length} hook(s) succeeded.`);
if (failed.length > 0) process.exit(1);
