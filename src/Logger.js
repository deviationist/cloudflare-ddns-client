import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export default class Logger {
  constructor({ logFile, ipHistoryFile, dryRun, verbose } = {}) {
    this.logFile = logFile || null;
    this.ipHistoryFile = ipHistoryFile || null;
    this.verbose = verbose || false;
    this.prefix = dryRun ? '[DRY RUN] ' : '';
  }

  // Logging must never break the run: ensure the directory exists, and swallow
  // any write failure (surfaced once on stderr) rather than throwing.
  #append(file, line) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, line);
    } catch (e) {
      console.error(`Logger: could not write to ${file}: ${e.message}`);
    }
  }

  log(message, level = 'log') {
    const prefixed = `${this.prefix}${message}`;
    if (this.verbose) console[level](prefixed);
    if (this.logFile) {
      const tag = level === 'error' ? 'ERROR' : 'INFO';
      this.#append(this.logFile, `${new Date().toISOString()} [${tag}] ${prefixed}\n`);
    }
  }

  logIpChange(oldIp, newIp, records) {
    if (!this.ipHistoryFile) return;
    const recordList = records.join(', ');
    this.#append(this.ipHistoryFile, `${new Date().toISOString()}  ${oldIp} -> ${newIp}  ${recordList}\n`);
  }
}
