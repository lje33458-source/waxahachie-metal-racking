'use strict';
// Local / self-hosted server: serves the page and hands /api/* to the same handler Vercel uses.
const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('./lib/api');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-cache',
};

http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) return api(req, res);
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const hit = req.method === 'GET' && STATIC[pathname];
  if (!hit) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, Object.assign({ 'Content-Type': hit[1] }, HEADERS));
  res.end(fs.readFileSync(path.join(PUBLIC_DIR, hit[0])));
}).listen(PORT, async () => {
  console.log('Americase Visual Inventory running on http://localhost:' + PORT + ' (storage: ' + api.store.kind + ')');
  try { await api.ensureAdmin(); } catch (e) { console.error(e.message); }
});
