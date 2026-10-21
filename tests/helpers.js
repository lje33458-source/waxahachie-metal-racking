'use strict';
// Shared test helpers: start the app on a free port with its own data folder, call the API, sign in a browser page.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const ADMIN_PASSKEY = 'testpass123';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function freshDatabase() {
  const { Client } = require('pg');
  const name = 'wmr_test_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  await c.query('CREATE DATABASE ' + name);
  await c.end();
  const u = new URL(process.env.TEST_DATABASE_URL);
  u.pathname = '/' + name;
  return u.toString();
}

// Starts server.js (from opts.root, default this repo). Uses a fresh DATA_DIR unless one is given;
// extra env vars (e.g. DATABASE_URL) pass through.
async function startServer(opts = {}) {
  const port = await freePort();
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wmr-test-'));
  const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSKEY }, opts.env || {});
  delete env.VERCEL;
  if (!opts.env || !('KV_REST_API_URL' in opts.env)) { delete env.KV_REST_API_URL; delete env.KV_REST_API_TOKEN; }
  // TEST_DATABASE_URL: run against a real Postgres server, in a new empty database for each server started.
  if (!opts.env || !('DATABASE_URL' in opts.env)) { delete env.DATABASE_URL; if (process.env.TEST_DATABASE_URL) env.DATABASE_URL = await freshDatabase(); }
  const proc = spawn(process.execPath, ['server.js'], { cwd: opts.root || ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode != null) throw new Error('Server exited:\n' + out);
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  // The first request after start creates the admin account, so wait until signing in works.
  await api(base, 'GET', '/api/me');
  return {
    base, port, dataDir, proc, dbUrl: env.DATABASE_URL,
    log: () => out,
    stop: () => new Promise(resolve => { if (proc.exitCode != null) return resolve(); proc.on('exit', resolve); proc.kill('SIGTERM'); }),
  };
}

// Minimal API client that keeps its own session cookie.
function client(base) {
  let cookie = '';
  async function call(method, url, body) {
    const headers = { 'Content-Type': 'application/json', 'X-WMR': '1' };
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = {};
    try { json = await r.json(); } catch (e) { /* empty */ }
    return { status: r.status, body: json };
  }
  return {
    call,
    login: (userId, passkey) => call('POST', '/api/login', { userId, passkey }),
  };
}
async function api(base, method, url, body) { return client(base).call(method, url, body); }

async function adminClient(base) {
  const c = client(base);
  const r = await c.login('admin', ADMIN_PASSKEY);
  if (r.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(r));
  return c;
}

async function signIn(page, base, id, pk) {
  await page.goto(base + '/');
  await page.fill('#login-id', id);
  await page.fill('#login-pk', pk);
  await page.click('#login-btn');
  await page.waitForSelector('header.top');
}

module.exports = { freshDatabase, startServer, client, api, adminClient, signIn, ADMIN_PASSKEY, ROOT };
