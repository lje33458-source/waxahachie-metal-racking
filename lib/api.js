'use strict';
// API for Americase Visual Inventory. Works as a Vercel function and under the local Node server.
// Sessions are signed cookies (no server memory needed), so it runs on serverless hosts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const SEED = require('../seed.json');

const ON_VERCEL = !!process.env.VERCEL;
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const SECURE_COOKIE = ON_VERCEL || process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production';
const TRUST_PROXY = ON_VERCEL || process.env.TRUST_PROXY === '1';
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const ROLES = ['viewer', 'supervisor', 'handler', 'shipping', 'admin'];
// What each role may change. Only admins edit the racking and Master; the page hides the rest the same way.
const CAN = { transfer: ['admin', 'supervisor', 'handler'], receive: ['admin', 'supervisor', 'shipping'], return: ['admin', 'supervisor', 'handler'] };
const USER_ID_RE = /^[A-Za-z0-9._-]{2,40}$/;
const MACHINES = ['EMK', 'EMLK', 'P4', 'L5'];
const LOG_MAX = 10000; // transfer log entries kept
const LOG_RANGES = { today: 1, week: 7, month: 31, year: 366, all: Infinity };
const ADMIN_RANGES = ['year', 'all'];
const UNDO_ID = 'undo-transfers-2026-10-20';
const MAX_PALLETS = 2; // most pallets one transfer may combine
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- passkeys ---------- */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generatePasskey() {
  let s = '';
  for (let i = 0; i < 16; i++) s += (i && i % 4 === 0 ? '-' : '') + ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
function hashPasskey(pk) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('base64') + '$' + crypto.scryptSync(pk, salt, 64).toString('base64');
}
function checkPasskey(pk, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3) return false;
  const expected = Buffer.from(parts[2], 'base64');
  const got = crypto.scryptSync(String(pk), Buffer.from(parts[1], 'base64'), expected.length);
  return crypto.timingSafeEqual(got, expected);
}
const DUMMY_HASH = hashPasskey(crypto.randomBytes(12).toString('hex'));
function passkeyProblem(pk) {
  if (typeof pk !== 'string' || pk.length < 8) return 'Passkey must be at least 8 characters.';
  if (pk.length > 128) return 'Passkey must be 128 characters or fewer.';
  return null;
}

/* ---------- session signing secret ---------- */
let secretPromise = null;
function sessionSecret() {
  if (!secretPromise) secretPromise = (async () => {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    if (ON_VERCEL) throw httpError(500, 'The server is missing its SESSION_SECRET setting.');
    let s = await store.get('session-secret');
    if (!s) { s = crypto.randomBytes(32).toString('base64url'); await store.set('session-secret', s); }
    return s;
  })();
  return secretPromise;
}
function sign(payload, secret) { return crypto.createHmac('sha256', secret).update(payload).digest('base64url'); }
async function makeToken(u) {
  const payload = Buffer.from(JSON.stringify({ u: u.id, v: u.sv || 0, exp: Date.now() + SESSION_HOURS * 3600000 })).toString('base64url');
  return payload + '.' + sign(payload, await sessionSecret());
}
async function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, await sessionSecret());
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
function sessionCookie(token, maxAge) {
  return 'wmr_sid=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (SECURE_COOKIE ? '; Secure' : '');
}

/* ---------- users ---------- */
async function getUsers() {
  let users = await store.get('users');
  if (Array.isArray(users) && users.length) {
    // "Editor" became "Material Handler" on 2026-10-20.
    if (users.some(u => u.role === 'editor')) { users.forEach(u => { if (u.role === 'editor') u.role = 'handler'; }); await store.set('users', users); }
    return users;
  }
  const pk = process.env.ADMIN_PASSKEY || (ON_VERCEL ? null : generatePasskey());
  if (!pk) throw httpError(500, 'Set the ADMIN_PASSKEY setting in Vercel, then redeploy.');
  users = [{ id: 'admin', role: 'admin', active: true, hash: hashPasskey(pk), sv: 0, createdAt: new Date().toISOString(), createdBy: 'setup', lastLogin: null }];
  await store.set('users', users);
  await audit('setup', 'create-user', 'admin (admin)');
  console.log('\n  Created admin account. User ID: admin');
  console.log(process.env.ADMIN_PASSKEY ? '  Passkey: the value of ADMIN_PASSKEY\n' : '  Passkey: ' + pk + '   <- shown once, change it after signing in\n');
  return users;
}
function findUser(users, id) { const k = String(id || '').toLowerCase(); return users.find(u => u.id.toLowerCase() === k) || null; }
function activeAdmins(users) { return users.filter(u => u.role === 'admin' && u.active).length; }
function publicUser(u) { return { id: u.id, role: u.role, active: u.active, createdAt: u.createdAt, createdBy: u.createdBy, lastLogin: u.lastLogin }; }
function audit(user, action, detail) { return store.log({ at: new Date().toISOString(), user, action, detail: detail || '' }); }

/* ---------- racking data ---------- */
// The racking is split into sections (tabs). Data saved before sections existed holds only the HQ rows at the top level.
// The Challenger and HQ PF1 sections and the HQ rename are switched off for now; uncomment to bring them back.
const SECTIONS = [
  { key: 'hq', name: 'Racking' },
  // { key: 'hq', name: 'HQ Metal Racking' },
  // { key: 'challenger', name: 'Challenger Racking' },
  // { key: 'pf1', name: 'HQ PF1 Racking' },
];
// Challenger: rows A–N, 26 racks, 5 levels; rack 11 has no levels 1 and 2.
function challengerRows() {
  return 'ABCDEFGHIJKLMN'.split('').map(row => ({
    row,
    racks: Array.from({ length: 26 }, (_, i) => ({
      rack: i + 1, label: '',
      levels: [5, 4, 3, 2, 1].filter(l => !(i + 1 === 11 && l <= 2)).map(level => ({ level, height: '', items: [] })),
    })),
  }));
}
function defaultRows(key, legacyRows) {
  if (key === 'hq') return legacyRows || SEED.rows;
  if (key === 'challenger') return challengerRows();
  return [];
}
// Placeholder routing numbers and received dates (within the year before 2026-10-20) for pallets that have none yet.
// They come from the pallet's location, so they stay the same on every read until someone saves real values.
function fillDummies(sections) {
  sections.forEach(s => s.rows.forEach(r => r.racks.forEach(rk => rk.levels.forEach(lv => lv.items.forEach((it, i) => {
    if (it.routing && it.received) return;
    const h = crypto.createHash('sha256').update(s.key + '|' + r.row + '-' + rk.rack + '-' + lv.level + '|' + i).digest();
    if (!it.routing) it.routing = 'RT-' + String(100000 + h.readUInt32BE(0) % 900000);
    if (!it.received) it.received = new Date(Date.UTC(2026, 9, 20) - (5 + h.readUInt16BE(4) % 355) * 86400000).toISOString().slice(0, 10);
  })))));
  return sections;
}
function withSections(r) {
  const have = Array.isArray(r.sections) ? r.sections : [];
  const sections = SECTIONS.map(d => {
    const s = have.find(x => x.key === d.key);
    return { key: d.key, name: d.name, rows: s ? s.rows : clone(defaultRows(d.key, r.rows)) };
  });
  fillDummies(sections);
  // Stored sections that are switched off are kept as they are, so their data comes back if they are re-enabled.
  const parked = have.filter(x => !SECTIONS.some(d => d.key === x.key));
  const out = Object.assign({}, r, { sections, parked, machines: cleanMachines(r.machines), migrations: Array.isArray(r.migrations) ? r.migrations : [] });
  delete out.transfers;
  delete out.rows;
  return out;
}
async function getRacking() {
  const r = await store.get('racking');
  if (r && !(r.migrations || []).includes(UNDO_ID)) return undoTransfers(r);
  if (r) return withSections(r);
  const fresh = withSections({ version: 1, savedAt: null, savedBy: null, parts: SEED.parts, migrations: [UNDO_ID] });
  await store.saveRacking(0, fresh).catch(() => {});
  return withSections((await store.get('racking')) || fresh);
}
// Pallets sitting at each machine: { EMK: [{ id, part, qty, routing, received, from: {section,row,rack,level}, loc, batch, requested, at, by }], ... }.
function cleanMachines(m) {
  const out = {};
  MACHINES.forEach(k => { out[k] = m && Array.isArray(m[k]) ? m[k] : []; });
  return out;
}
function findLevel(r, from) {
  const s = r.sections.find(x => x.key === (from.section || 'hq'));
  const row = s && s.rows.find(x => String(x.row) === String(from.row));
  const rk = row && row.racks.find(x => x.rack === Number(from.rack));
  return rk && rk.levels.find(x => x.level === Number(from.level));
}
// How a return splits up: the quantity used comes off the oldest-received pallets first; the rest of each pallet goes back.
// The page runs the same steps to show the plan before it is confirmed.
function returnPlan(list, used) {
  const total = list.reduce((t, x) => t + (Number(x.qty) || 0), 0);
  if (!Number.isFinite(used) || used < 0 || used > total) return null;
  let left = used;
  return list.map((p, n) => ({ p, n })).sort((a, b) => String(a.p.received || '9999').localeCompare(String(b.p.received || '9999')) || a.n - b.n)
    .map(({ p }) => { const u = Math.min(left, Number(p.qty) || 0); left -= u; return { p, used: u, back: (Number(p.qty) || 0) - u }; });
}
function parseLoc(loc) { const m = String(loc || '').trim().match(/^(.+)-(\d+)-(\d+)$/); return m ? { row: m[1], rack: m[2], level: m[3] } : null; }
// One-off (2026-10-20, Traci's request): put every pallet sent to a machine so far back where it came from and empty the machines.
// The data as it was is kept in racking-backup-2026-10-20 first.
async function undoTransfers(raw) {
  if (!(await store.get('racking-backup-2026-10-20'))) await store.set('racking-backup-2026-10-20', raw);
  const r = withSections(raw);
  const parts = new Map(r.parts.map(p => [p.k, p]));
  const back = (from, item) => { const lv = findLevel(r, from); if (lv) lv.items.push(item); return !!lv; };
  let moved = 0;
  (Array.isArray(raw.transfers) ? raw.transfers : []).slice().reverse().forEach(e => {
    if (!parts.has(e.part)) return;
    if (Array.isArray(e.pallets)) { // whole pallets with their own quantities
      e.pallets.forEach(x => { const f = parseLoc(x.loc); if (f && back(f, { part: e.part, qty: x.qty, routing: x.routing || '', received: x.received || '' })) moved += x.qty; });
    } else if (typeof e.pallets === 'number') { // whole pallets, only the total kept: refill at qty per pallet, the rest on the last one
      const locs = String(e.from).split(',').map(parseLoc).filter(Boolean), qpp = Number(parts.get(e.part).qtyPerPallet) || 0;
      locs.forEach((f, i) => {
        const q = i < locs.length - 1 ? (qpp || Math.floor(e.qty / locs.length)) : e.qty - (qpp || Math.floor(e.qty / locs.length)) * (locs.length - 1);
        if (q > 0 && back(f, { part: e.part, qty: q })) moved += q;
      });
    } else { // partial quantity taken off one pallet
      const f = parseLoc(e.from); if (!f) return;
      const lv = findLevel(r, Object.assign({ section: e.section }, f)); if (!lv) return;
      const it = lv.items.find(x => x.part === e.part);
      if (it) it.qty = (Number(it.qty) || 0) + e.qty; else lv.items.push({ part: e.part, qty: e.qty });
      moved += e.qty;
    }
  });
  const next = { version: r.version + 1, savedAt: new Date().toISOString(), savedBy: 'system', parts: r.parts, sections: r.sections.concat(r.parked || []), machines: cleanMachines(null), migrations: r.migrations.concat(UNDO_ID) };
  if (await store.saveRacking(r.version, next)) await audit('system', 'undo-transfers', moved + ' sheets put back on the racking');
  return withSections((await store.get('racking')) || next);
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : (typeof v === 'number' ? String(v).slice(0, max) : ''); }
function qty(v) { if (v === '' || v == null) return ''; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e9) : ''; }
function int(v, lo, hi) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
function cleanRows(rows, keys) {
  if (!Array.isArray(rows) || rows.length > 500) throw httpError(400, 'Each section needs a list of rows (500 at most).');
  return rows.map(r => {
    if (!Array.isArray(r.racks) || r.racks.length > 50) throw httpError(400, 'Each row needs a list of racks.');
    return {
      row: typeof r.row === 'number' ? int(r.row, 0, 100000) : (str(r.row, 20) || '?'),
      racks: r.racks.map(rk => {
        if (!Array.isArray(rk.levels) || rk.levels.length > 100) throw httpError(400, 'Each rack needs a list of levels.');
        return {
          rack: int(rk.rack, 0, 1000), label: str(rk.label, 60),
          levels: rk.levels.map(lv => ({
            level: int(lv.level, 0, 1000), height: qty(lv.height),
            items: (Array.isArray(lv.items) ? lv.items.slice(0, 20) : []).filter(it => it && keys.has(it.part)).map(it => ({ part: it.part, qty: qty(it.qty), routing: str(it.routing, 40), received: DATE_RE.test(it.received) ? it.received : '' })),
          })),
        };
      }),
    };
  });
}
// Section names and keys come from the server; the client only supplies rows. An older page that sends top-level rows updates HQ only.
function cleanData(body, cur) {
  if (!body || !Array.isArray(body.parts) || (!Array.isArray(body.sections) && !Array.isArray(body.rows))) throw httpError(400, 'Data must include parts and sections.');
  if (body.parts.length > 1000) throw httpError(400, 'Too many parts.');
  const parts = body.parts.map(p => ({
    k: str(p.k, 40) || 'p' + crypto.randomBytes(4).toString('hex'),
    number: str(p.number, 200), description: str(p.description, 500), partId: str(p.partId, 120),
    qtyPerPallet: qty(p.qtyPerPallet), dedicatedCase: str(p.dedicatedCase, 120), qtyPerCase: qty(p.qtyPerCase),
  }));
  const keys = new Set(parts.map(p => p.k));
  const sent = Array.isArray(body.sections) ? body.sections : [{ key: 'hq', rows: body.rows }];
  const sections = cur.sections.map(s => {
    const b = sent.find(x => x && x.key === s.key);
    return { key: s.key, name: s.name, rows: cleanRows(b ? b.rows : s.rows, keys) };
  });
  return { parts, sections };
}

/* ---------- http helpers ---------- */
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
function send(res, status, body, headers) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, isJson ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}, headers || {}));
  res.end(isJson ? JSON.stringify(body) : body);
}
function readBody(req) {
  if (req.body !== undefined) { // Vercel parses JSON bodies already
    if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body || '{}')); } catch (e) { return Promise.reject(httpError(400, 'Invalid JSON.')); } }
    if (Buffer.isBuffer(req.body)) { try { return Promise.resolve(JSON.parse(req.body.toString('utf8') || '{}')); } catch (e) { return Promise.reject(httpError(400, 'Invalid JSON.')); } }
    return Promise.resolve(req.body || {});
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 4 * 1024 * 1024) { reject(httpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(httpError(400, 'Invalid JSON.')); } });
    req.on('error', reject);
  });
}
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
function failKey(req, id) { return 'fail:' + crypto.createHash('sha256').update(clientIp(req) + '|' + String(id).toLowerCase()).digest('hex').slice(0, 32); }

/* ---------- routes ---------- */
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname.replace(/\/+$/, '');
  // If the host passes the rewritten path instead of the original, rebuild it from the ?path= parameter.
  if (p === '/api/index' && url.searchParams.get('path')) p = '/api/' + url.searchParams.get('path').replace(/^\/+/, '');
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    // CSRF guard: browsers will not send this header cross-site without CORS approval.
    if (req.headers['x-wmr'] !== '1' || !String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 403, { error: 'Request blocked.' });
  }

  if (p === '/api/health') return send(res, 200, { ok: true, storage: store.kind });

  if (p === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const id = String(body.userId || '').trim(), pk = String(body.passkey || '');
    const fk = failKey(req, id);
    const f = await store.get(fk);
    if (f && f.until && f.until > Date.now()) return send(res, 429, { error: 'Too many failed attempts. Try again in ' + Math.ceil((f.until - Date.now()) / 60000) + ' minutes.' });
    const users = await getUsers();
    const u = findUser(users, id);
    const match = checkPasskey(pk, u ? u.hash : DUMMY_HASH);
    if (!match || !u || !u.active) {
      const n = (f ? f.count : 0) + 1;
      await store.set(fk, { count: n, until: n >= MAX_FAILS ? Date.now() + LOCK_MINUTES * 60000 : 0 }, LOCK_MINUTES * 60);
      await audit(id || '?', 'login-failed', clientIp(req));
      return send(res, 401, { error: 'User ID or passkey is incorrect.' });
    }
    await store.del(fk);
    u.lastLogin = new Date().toISOString();
    await store.set('users', users);
    await audit(u.id, 'login', '');
    return send(res, 200, { user: publicUser(u) }, { 'Set-Cookie': sessionCookie(await makeToken(u), SESSION_HOURS * 3600) });
  }

  if (p === '/api/logout' && method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });

  // Everything below needs a signed-in, active user whose session has not been revoked.
  const tok = await readToken(parseCookies(req).wmr_sid);
  let users = tok ? await getUsers() : null;
  const me = tok ? findUser(users, tok.u) : null;
  if (!me || !me.active || (me.sv || 0) !== tok.v) return send(res, 401, { error: 'Please sign in.' });

  if (p === '/api/me' && method === 'GET') return send(res, 200, { user: publicUser(me) });

  if (p === '/api/me/passkey' && method === 'POST') {
    const body = await readBody(req);
    if (!checkPasskey(String(body.current || ''), me.hash)) return send(res, 400, { error: 'Current passkey is incorrect.' });
    const prob = passkeyProblem(body.next); if (prob) return send(res, 400, { error: prob });
    me.hash = hashPasskey(body.next); me.sv = (me.sv || 0) + 1; // signs out other devices
    await store.set('users', users);
    await audit(me.id, 'change-passkey', 'own');
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(await makeToken(me), SESSION_HOURS * 3600) });
  }

  if (p === '/api/version' && method === 'GET') { const r = await getRacking(); return send(res, 200, { version: r.version, savedAt: r.savedAt, savedBy: r.savedBy }); }
  if (p === '/api/data' && method === 'GET') return send(res, 200, await getRacking());

  if (p === '/api/data' && method === 'PUT') {
    if (me.role !== 'admin') return send(res, 403, { error: 'Only admins can edit the racking and Master.' });
    const body = await readBody(req);
    const cur = await getRacking();
    const clean = cleanData(body, cur);
    const next = { version: cur.version + 1, savedAt: new Date().toISOString(), savedBy: me.id, parts: clean.parts, sections: clean.sections.concat(cur.parked || []), machines: cur.machines, migrations: cur.migrations };
    if (body.baseVersion !== cur.version || !(await store.saveRacking(cur.version, next))) {
      const latest = await getRacking();
      return send(res, 409, { error: 'conflict', version: latest.version, savedAt: latest.savedAt, savedBy: latest.savedBy });
    }
    await audit(me.id, 'save', 'version ' + next.version);
    return send(res, 200, { version: next.version, savedAt: next.savedAt, savedBy: next.savedBy });
  }

  // Moves whole pallets of one material from the racking to a machine. Applied to the latest saved data, retrying if someone saves at the same moment.
  if (p === '/api/transfer' && method === 'POST') {
    if (!CAN.transfer.includes(me.role)) return send(res, 403, { error: 'Your account can not transfer material.' });
    const body = await readBody(req);
    const requested = Number(body.requested);
    if (!Number.isFinite(requested) || requested <= 0) return send(res, 400, { error: 'Enter the quantity requested.' });
    if (!MACHINES.includes(body.machine)) return send(res, 400, { error: 'Choose a machine.' });
    if (!Array.isArray(body.pallets) || !body.pallets.length) return send(res, 400, { error: 'Choose at least one pallet.' });
    if (body.pallets.length > MAX_PALLETS) return send(res, 400, { error: 'Choose ' + MAX_PALLETS + ' pallets at most.' });
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await getRacking();
      const pt = cur.parts.find(x => x.k === body.part);
      if (!pt) return send(res, 400, { error: 'That material type no longer exists.' });
      const picks = [];
      for (const b of body.pallets) {
        const s = b && cur.sections.find(x => x.key === b.section);
        const r = s && s.rows.find(x => String(x.row) === String(b.row));
        const rk = r && r.racks.find(x => x.rack === Number(b.rack));
        const lv = rk && rk.levels.find(x => x.level === Number(b.level));
        const loc = r && rk && lv ? r.row + '-' + rk.rack + '-' + lv.level : '?';
        const it = lv && lv.items[Number(b.item)];
        if (!it || it.part !== pt.k || Number(it.qty) !== Number(b.qty) || picks.some(x => x.it === it)) return send(res, 409, { error: 'The pallet at ' + loc + ' has changed since you picked it. Check the list and pick again.' });
        picks.push({ lv, it, loc, qty: Number(it.qty), routing: it.routing || '', received: it.received || '', from: { section: s.key, row: r.row, rack: rk.rack, level: lv.level } });
      }
      const total = picks.reduce((t, x) => t + x.qty, 0);
      if (total < requested) return send(res, 400, { error: 'The pallets picked hold ' + total + ', less than the ' + requested + ' requested.' });
      picks.forEach(x => x.lv.items.splice(x.lv.items.indexOf(x.it), 1));
      const at = new Date().toISOString(), batch = crypto.randomBytes(6).toString('hex');
      const machines = cur.machines;
      picks.forEach(x => machines[body.machine].push({ id: crypto.randomBytes(6).toString('hex'), part: pt.k, qty: x.qty, routing: x.routing, received: x.received, from: x.from, loc: x.loc, batch, requested, at, by: me.id }));
      const next = { version: cur.version + 1, savedAt: at, savedBy: me.id, parts: cur.parts, sections: cur.sections.concat(cur.parked || []), machines, migrations: cur.migrations };
      if (await store.saveRacking(cur.version, next)) {
        await store.push('transfers', { at, by: me.id, kind: 'transfer', part: pt.k, partNumber: pt.number || pt.partId, qty: total, requested, machine: body.machine, pallets: picks.map(x => ({ loc: x.loc, qty: x.qty, routing: x.routing, received: x.received })) }, LOG_MAX);
        return send(res, 200, withSections(next));
      }
    }
    return send(res, 409, { error: 'The racking is being saved by someone else. Try again.' });
  }

  // Sends everything at a machine back to the racking: the quantity used is taken off the pallets, oldest received first,
  // and whatever is left on each pallet goes back to the spot it came from.
  if (p === '/api/return' && method === 'POST') {
    if (!CAN.return.includes(me.role)) return send(res, 403, { error: 'Your account can not return material.' });
    const body = await readBody(req);
    if (!MACHINES.includes(body.machine)) return send(res, 400, { error: 'Choose a machine.' });
    const used = Number(body.used);
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await getRacking();
      const list = cur.machines[body.machine];
      if (!list.length) return send(res, 400, { error: 'There is no material at ' + body.machine + '.' });
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (ids.length !== list.length || !list.every(x => ids.includes(x.id))) return send(res, 409, { error: 'The material at ' + body.machine + ' has changed. Check it and try again.' });
      const plan = returnPlan(list, used);
      if (!plan) return send(res, 400, { error: 'Enter the quantity used at the machine, between 0 and the total there.' });
      for (const x of plan) {
        if (!x.back) continue;
        const lv = findLevel(cur, x.p.from || {});
        if (!lv) return send(res, 409, { error: 'The spot ' + x.p.loc + ' is no longer on the racking. Add it back before returning.' });
        lv.items.push({ part: x.p.part, qty: x.back, routing: x.p.routing || '', received: x.p.received || '' });
      }
      const machines = cur.machines;
      machines[body.machine] = [];
      const at = new Date().toISOString();
      const next = { version: cur.version + 1, savedAt: at, savedBy: me.id, parts: cur.parts, sections: cur.sections.concat(cur.parked || []), machines, migrations: cur.migrations };
      if (await store.saveRacking(cur.version, next)) {
        const pn = k => { const pt = cur.parts.find(x => x.k === k); return pt ? (pt.number || pt.partId) : k; };
        await store.push('transfers', { at, by: me.id, kind: 'return', machine: body.machine, used, qty: plan.reduce((t, x) => t + x.back, 0), pallets: plan.map(x => ({ loc: x.p.loc, part: x.p.part, partNumber: pn(x.p.part), qty: x.back, used: x.used, routing: x.p.routing || '', received: x.p.received || '' })) }, LOG_MAX);
        return send(res, 200, withSections(next));
      }
    }
    return send(res, 409, { error: 'The racking is being saved by someone else. Try again.' });
  }

  // New pallets put away into open spots on the racking.
  if (p === '/api/receive' && method === 'POST') {
    if (!CAN.receive.includes(me.role)) return send(res, 403, { error: 'Your account can not receive material.' });
    const body = await readBody(req);
    const received = DATE_RE.test(body.received) ? body.received : new Date().toISOString().slice(0, 10);
    if (!Array.isArray(body.pallets) || !body.pallets.length || body.pallets.length > 50) return send(res, 400, { error: 'Enter how many pallets were received (up to 50).' });
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await getRacking();
      const pt = cur.parts.find(x => x.k === body.part);
      if (!pt) return send(res, 400, { error: 'Choose a material type.' });
      const puts = [];
      for (const b of body.pallets) {
        const q = Number(b && b.qty);
        if (!Number.isFinite(q) || q <= 0) return send(res, 400, { error: 'Enter the quantity on every pallet.' });
        if (!str(b.routing, 40).trim()) return send(res, 400, { error: 'Enter the routing # for every pallet.' });
        const lv = b && findLevel(cur, b);
        const loc = b ? b.row + '-' + b.rack + '-' + b.level : '?';
        if (!lv || lv.items.length || puts.some(x => x.lv === lv)) return send(res, 409, { error: 'The spot ' + loc + ' is no longer open. Pick another spot.' });
        puts.push({ lv, loc, item: { part: pt.k, qty: Math.min(q, 1e9), routing: str(b.routing, 40).trim(), received } });
      }
      puts.forEach(x => x.lv.items.push(x.item));
      const at = new Date().toISOString();
      const next = { version: cur.version + 1, savedAt: at, savedBy: me.id, parts: cur.parts, sections: cur.sections.concat(cur.parked || []), machines: cur.machines, migrations: cur.migrations };
      if (await store.saveRacking(cur.version, next)) {
        await store.push('transfers', { at, by: me.id, kind: 'receive', part: pt.k, partNumber: pt.number || pt.partId, qty: puts.reduce((t, x) => t + x.item.qty, 0), received, pallets: puts.map(x => ({ loc: x.loc, qty: x.item.qty, routing: x.item.routing })) }, LOG_MAX);
        return send(res, 200, withSections(next));
      }
    }
    return send(res, 409, { error: 'The racking is being saved by someone else. Try again.' });
  }

  if (p === '/api/transfers' && method === 'GET') {
    const range = url.searchParams.get('range') || 'today';
    if (!LOG_RANGES[range]) return send(res, 400, { error: 'Unknown range.' });
    if (ADMIN_RANGES.includes(range) && me.role !== 'admin') return send(res, 403, { error: 'Admins only.' });
    // "Today" starts at the viewer's own midnight, which the page sends; the server's clock may be in another time zone.
    const mid = Number(url.searchParams.get('since'));
    const since = range === 'today' ? (mid > Date.now() - 2 * 86400000 && mid <= Date.now() ? mid : Date.now() - 86400000) : Date.now() - LOG_RANGES[range] * 86400000;
    const entries = (await store.list('transfers', LOG_MAX)).filter(e => range === 'all' || Date.parse(e.at) >= since);
    return send(res, 200, { entries });
  }

  /* admin only below */
  if (p.startsWith('/api/admin/') && me.role !== 'admin') return send(res, 403, { error: 'Admins only.' });

  if (p === '/api/admin/users' && method === 'GET') return send(res, 200, { users: users.map(publicUser) });

  if (p === '/api/admin/users' && method === 'POST') {
    const body = await readBody(req);
    const id = String(body.userId || '').trim();
    if (!USER_ID_RE.test(id)) return send(res, 400, { error: 'User ID must be 2–40 letters, numbers, dots, dashes or underscores.' });
    if (findUser(users, id)) return send(res, 400, { error: 'That User ID already exists.' });
    if (!ROLES.includes(body.role)) return send(res, 400, { error: 'Choose a role.' });
    const prob = passkeyProblem(body.passkey); if (prob) return send(res, 400, { error: prob });
    const u = { id, role: body.role, active: true, hash: hashPasskey(body.passkey), sv: 0, createdAt: new Date().toISOString(), createdBy: me.id, lastLogin: null };
    users.push(u);
    await store.set('users', users);
    await audit(me.id, 'create-user', id + ' (' + u.role + ')');
    return send(res, 200, { user: publicUser(u) });
  }

  const m = p.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (m) {
    const target = findUser(users, decodeURIComponent(m[1]));
    if (!target) return send(res, 404, { error: 'User not found.' });
    if (method === 'PATCH') {
      const body = await readBody(req);
      const changes = [];
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return send(res, 400, { error: 'Unknown role.' });
        if (target.role === 'admin' && body.role !== 'admin' && target.active && activeAdmins(users) <= 1) return send(res, 400, { error: 'Keep at least one active admin.' });
        if (target.role !== body.role) { changes.push('role ' + target.role + ' → ' + body.role); target.role = body.role; }
      }
      if (body.active !== undefined) {
        const next = !!body.active;
        if (!next && target.id === me.id) return send(res, 400, { error: 'You cannot disable your own account.' });
        if (!next && target.role === 'admin' && target.active && activeAdmins(users) <= 1) return send(res, 400, { error: 'Keep at least one active admin.' });
        if (target.active !== next) { changes.push(next ? 'enabled' : 'disabled'); target.active = next; }
      }
      if (body.passkey !== undefined) {
        const prob = passkeyProblem(body.passkey); if (prob) return send(res, 400, { error: prob });
        target.hash = hashPasskey(body.passkey); changes.push('passkey reset');
      }
      let cookie;
      if (changes.length) {
        target.sv = (target.sv || 0) + 1; // signs the user out everywhere
        if (target.id === me.id) cookie = sessionCookie(await makeToken(me), SESSION_HOURS * 3600);
        await store.set('users', users);
        await audit(me.id, 'update-user', target.id + ': ' + changes.join(', '));
      }
      return send(res, 200, { user: publicUser(target) }, cookie ? { 'Set-Cookie': cookie } : undefined);
    }
    if (method === 'DELETE') {
      if (target.id === me.id) return send(res, 400, { error: 'You cannot delete your own account.' });
      if (target.role === 'admin' && target.active && activeAdmins(users) <= 1) return send(res, 400, { error: 'Keep at least one active admin.' });
      users = users.filter(u => u !== target);
      await store.set('users', users);
      await audit(me.id, 'delete-user', target.id);
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/admin/audit' && method === 'GET') return send(res, 200, { entries: await store.readLog(150) });

  return send(res, 404, { error: 'Not found.' });
}

module.exports = async function handler(req, res) {
  try { await route(req, res); }
  catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error. Please try again.' });
  }
};
module.exports.store = store;
module.exports.getUsers = getUsers;
