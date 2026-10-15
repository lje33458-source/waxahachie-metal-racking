'use strict';
// Storage for users, racking data, sign-in throttling and the activity log.
// Uses Upstash Redis (Vercel Marketplace) when its REST URL/token are set, otherwise JSON files in DATA_DIR.

const fs = require('fs');
const path = require('path');

// Vercel's Upstash integration may add a custom prefix (e.g. STORAGE_KV_REST_API_URL), so match by suffix too.
function envBySuffix(...names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  const k = Object.keys(process.env).find(k => names.some(n => k.endsWith('_' + n)) && process.env[k]);
  return k ? process.env[k] : undefined;
}
const REDIS_URL = envBySuffix('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
const REDIS_TOKEN = envBySuffix('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');
const PREFIX = 'wmr:';
const LOG_MAX = 2000;

/* ---------- Upstash Redis over REST (no packages needed) ---------- */
function redisStore() {
  async function cmd(args) {
    const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error('Database error: ' + (j.error || r.status));
    return j.result;
  }
  // Saves racking data only if nobody else saved since baseVersion.
  const SAVE_IF_VERSION = "local cur = redis.call('GET', KEYS[1]) if cur and tonumber(cur) ~= tonumber(ARGV[1]) then return 0 end redis.call('SET', KEYS[2], ARGV[2]) redis.call('SET', KEYS[1], ARGV[3]) return 1";
  return {
    kind: 'redis',
    async get(key) { const v = await cmd(['GET', PREFIX + key]); return v == null ? null : JSON.parse(v); },
    async set(key, val, ttlSec) { await cmd(ttlSec ? ['SET', PREFIX + key, JSON.stringify(val), 'EX', String(ttlSec)] : ['SET', PREFIX + key, JSON.stringify(val)]); },
    async del(key) { await cmd(['DEL', PREFIX + key]); },
    async saveRacking(baseVersion, data) {
      const ok = await cmd(['EVAL', SAVE_IF_VERSION, '2', PREFIX + 'racking:version', PREFIX + 'racking', String(baseVersion), JSON.stringify(data), String(data.version)]);
      return ok === 1;
    },
    async log(entry) { await cmd(['LPUSH', PREFIX + 'audit', JSON.stringify(entry)]); await cmd(['LTRIM', PREFIX + 'audit', '0', String(LOG_MAX - 1)]); },
    async readLog(n) { return (await cmd(['LRANGE', PREFIX + 'audit', '0', String(n - 1)]) || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean); },
  };
}

/* ---------- JSON files (local server, Docker, VM) ---------- */
function fileStore() {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = key => path.join(dir, key.replace(/[^a-z0-9._-]/gi, '_') + '.json');
  const auditFile = path.join(dir, 'audit.log');
  function read(key) {
    try {
      const v = JSON.parse(fs.readFileSync(file(key), 'utf8'));
      if (v && v.__exp) { if (v.__exp < Date.now()) return null; return v.value; }
      return v;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  function write(key, val) { const f = file(key), tmp = f + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(val, null, 1)); fs.renameSync(tmp, f); }
  return {
    kind: 'files',
    dir,
    async get(key) { return read(key); },
    async set(key, val, ttlSec) { write(key, ttlSec ? { __exp: Date.now() + ttlSec * 1000, value: val } : val); },
    async del(key) { try { fs.unlinkSync(file(key)); } catch (e) { /* already gone */ } },
    async saveRacking(baseVersion, data) {
      const cur = read('racking');
      if (cur && cur.version !== baseVersion) return false;
      write('racking', data);
      return true;
    },
    async log(entry) { fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n'); },
    async readLog(n) {
      let lines = [];
      try { lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n'); } catch (e) { /* no log yet */ }
      return lines.slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    },
  };
}

/* ---------- Vercel without a database: explain instead of crashing ---------- */
function missingStore() {
  const fail = async () => {
    const e = new Error('The database is not connected. In Vercel, open Storage, connect the Upstash Redis database to this project, then redeploy.');
    e.status = 503;
    throw e;
  };
  return { kind: 'none', get: fail, set: fail, del: fail, saveRacking: fail, log: fail, readLog: fail };
}

module.exports = (REDIS_URL && REDIS_TOKEN) ? redisStore() : (process.env.VERCEL ? missingStore() : fileStore());
