import { appendFileSync } from 'fs';

export default class Logger {
  constructor({ logFile, ipHistoryFile, dryRun, verbose } = {}) {
    this.logFile = logFile || null;
    this.ipHistoryFile = ipHistoryFile || null;
    this.verbose = verbose || false;
    this.prefix = dryRun ? '[DRY RUN] ' : '';
  }

  log(message, level = 'log') {
    const prefixed = `${this.prefix}${message}`;
    if (this.verbose) console[level](prefixed);
    if (this.logFile) {
      const tag = level === 'error' ? 'ERROR' : 'INFO';
      appendFileSync(this.logFile, `${new Date().toISOString()} [${tag}] ${prefixed}\n`);
    }
  }

  logIpChange(oldIp, newIp, records) {
    if (!this.ipHistoryFile) return;
    const recordList = records.join(', ');
    appendFileSync(this.ipHistoryFile, `${new Date().toISOString()}  ${oldIp} -> ${newIp}  ${recordList}\n`);
  }
}
