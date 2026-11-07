import https from 'https';
import http from 'http';
import { execFile } from 'child_process';
import { URL } from 'url';

// Transport plumbing shared by the drivers. Nothing here knows about any one
// router: it moves bytes over HTTP(S) or SSH and leaves the meaning to the driver.

export function httpRequest(
  urlStr,
  { method = 'GET', headers = {}, body = null, rejectUnauthorized = true, ca = undefined, timeout = 10000 } = {}
) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers,
      timeout,
    };
    if (u.protocol === 'https:') {
      opts.rejectUnauthorized = rejectUnauthorized;
      if (ca) opts.ca = ca;
    }
    const req = mod.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

// Arguments for one non-interactive ssh invocation. BatchMode makes a missing
// key or an unknown host fail immediately rather than prompting and hanging a
// cron run forever.
export function sshArgs(ssh, timeoutMs, remoteCommand) {
  const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.max(1, Math.round(timeoutMs / 1000))}`];
  if (ssh.strictHostKeyChecking) args.push('-o', `StrictHostKeyChecking=${ssh.strictHostKeyChecking}`);
  if (ssh.identityFile) args.push('-i', ssh.identityFile);
  if (ssh.port) args.push('-p', String(ssh.port));
  args.push(ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host, remoteCommand);
  return args;
}

export function execSsh(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(binary || 'ssh', args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || '').trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
