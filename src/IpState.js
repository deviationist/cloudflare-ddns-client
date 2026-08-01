import { readFileSync, writeFileSync, existsSync } from 'fs';

// Remembers the last public IP the client saw, so an IP change can be detected
// independently of what Cloudflare happens to hold.
export default class IpState {
  filePath;
  logger;

  constructor(filePath, logger) {
    this.filePath = filePath || null;
    this.logger = logger;
  }

  isConfigured() {
    return this.filePath !== null;
  }

  read() {
    if (!this.isConfigured() || !existsSync(this.filePath)) return null;
    try {
      return readFileSync(this.filePath, 'utf-8').trim() || null;
    } catch (error) {
      this.logger(`Could not read IP state file "${this.filePath}": ${error.message}`, 'error');
      return null;
    }
  }

  write(ipAddress) {
    if (!this.isConfigured()) return false;
    try {
      writeFileSync(this.filePath, `${ipAddress}\n`);
      return true;
    } catch (error) {
      this.logger(`Could not write IP state file "${this.filePath}": ${error.message}`, 'error');
      return false;
    }
  }
}
