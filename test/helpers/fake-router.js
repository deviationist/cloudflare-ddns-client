// Runs as its own process: the client is started with spawnSync, which blocks
// the test process's event loop, so a server sharing it could never answer.
// Prints "PORT=<n>" once listening. Argv: JSON object of nvram values.
import { createServer } from 'http';

const nvram = JSON.parse(process.argv[2] || '{}');

const server = createServer((req, res) => {
  req.resume();
  if (req.url.startsWith('/login.cgi')) {
    res.setHeader('set-cookie', 'asus_s_token=test-token; HttpOnly');
    res.end('{}');
    return;
  }
  const key = decodeURIComponent(req.url).match(/nvram_get\(([^)]+)\)/)?.[1];
  res.end(JSON.stringify({ [key]: nvram[key] ?? '' }));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});
