'use strict';
// All database access. lib/api.js calls only the functions exported here; see lib/schema.sql for the tables.
//
// The page works with the racking as one document ({ version, parts, sections, machines }), so this file
// builds that document from the tables when reading, and on a save works out which rows changed and writes
// only those, inside one transaction, after checking nobody else saved first.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const legacy = require('./legacy');
const SEED = require('../seed.json');

const SCHEMA_VERSION = '1';
const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const LOCK_ID = 7316; // advisory lock taken while creating tables or copying old data, so two servers starting together don't both do it

/* ---------- start-up ---------- */
let started = null;
// The connection, once the tables exist and hold data.
async function conn() {
  const d = await db.connect();
  if (!started) started = setUp(d).catch(e => { started = null; throw e; });
  await started;
  return d;
}
async function setUp(d) {
  await createTables(d);
  await copyOldData(d);
  await warnIfOldDataChanged(d);
}
async function createTables(d) {
  await d.tx(async q => {
    await q('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const has = (await q("SELECT to_regclass('settings') IS NOT NULL AS ok", []))[0].ok;
    const ver = has ? (await q("SELECT value FROM settings WHERE key = 'schema_version'", [])) : [];
    if (!ver.length || ver[0].value !== SCHEMA_VERSION) {
      await q(SCHEMA);
      await q("INSERT INTO settings (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [SCHEMA_VERSION]);
    }
  });
}
async function copyOldData(d) {
  if ((await d.query('SELECT 1 FROM meta', [])).length) return;
  // Empty database: read the old data first (outside the transaction, as it may take a moment), then copy it in
  // unless another server got there first.
  const old = await legacy.read();
  await d.tx(async q => {
    await q('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    if ((await q('SELECT 1 FROM meta', [])).length) return;
    await importData(q, old);
  });
}
// If the old app kept running after the copy (for example the database was connected to a preview deployment
// before going live), Redis has changes the copy doesn't. Say so once in the activity log.
async function warnIfOldDataChanged(d) {
  const [m] = await d.query("SELECT imported_from FROM meta WHERE id = 1", []);
  const copied = Number(await getSettingWith(d, 'import_source_version'));
  if (!m || m.imported_from !== 'redis' || !copied || await getSettingWith(d, 'import_newer_warning')) return;
  const cmd = legacy.redis();
  if (!cmd) return;
  const now = Number(await cmd(['GET', 'wmr:racking:version']).catch(() => 0));
  if (now > copied) {
    await d.query("INSERT INTO settings (key, value) VALUES ('import_newer_warning', $1) ON CONFLICT DO NOTHING", [String(now)]);
    await d.query('INSERT INTO activity (user_id, action, detail) VALUES ($1, $2, $3)', ['system', 'import-warning',
      'Redis has racking version ' + now + ', newer than version ' + copied + ' that was copied. Changes made in the old app after the copy are not here.']);
  }
}
async function getSettingWith(d, key) {
  const rows = await d.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

// First start on an empty database: copy the old app's data in if there is any, otherwise start from seed.json.
async function importData(q, old) {
  const data = old ? legacy.normalize(old) : { source: 'seed', racking: null, users: [], transfers: [], audit: [], cleared: [] };
  const racking = data.racking || { version: 0, parts: SEED.parts, sections: [{ key: 'hq', name: 'Racking', rows: SEED.rows }], machines: {} };
  const now = new Date().toISOString();
  await q("SELECT set_config('app.actor', 'import', true)", []);
  // The version goes up by one so drafts left in browsers from before the copy are discarded.
  const doc = { version: racking.version + 1, savedAt: now, savedBy: 'import', parts: racking.parts, sections: racking.sections, machines: racking.machines };
  await writeDoc(q, doc);
  await q('INSERT INTO meta (id, version, saved_at, saved_by, imported_from, imported_at) VALUES (1, $1, $2, $3, $4, $2)', [doc.version, now, 'import', data.source]);
  if (data.users.length) await q(insertSql('users', USER_COLS), [JSON.stringify(data.users.map(userRow))]);
  // Old logs are newest first; insert oldest first so ids follow time.
  const moves = data.transfers.slice().reverse().filter(e => ['transfer', 'return', 'receive'].includes(e.kind) && e.at);
  if (moves.length) await q(insertSql('stock_moves', MOVE_COLS), [JSON.stringify(moves.map(moveRow))]);
  const acts = data.audit.slice().reverse().filter(e => e.at && e.action);
  if (acts.length) await q(insertSql('activity', ACTIVITY_COLS), [JSON.stringify(acts.map(e => ({ at: e.at, user_id: String(e.user || '?'), action: String(e.action), detail: String(e.detail || '') })))]);
  if (old) {
    const pallets = countPallets(doc);
    let detail = 'Copied from ' + (data.source === 'redis' ? 'Redis' : 'data files') + ': ' + doc.parts.length + ' parts, ' + pallets + ' pallets, ' +
      data.users.length + ' users, ' + moves.length + ' transfer log entries, ' + acts.length + ' activity entries.';
    const r = data.cleared.filter(c => c.routing).length, dt = data.cleared.filter(c => c.received).length;
    if (r || dt) detail += ' Removed made-up placeholder values: ' + r + ' routing numbers, ' + dt + ' dates received.';
    await q('INSERT INTO activity (at, user_id, action, detail) VALUES ($1, $2, $3, $4)', [now, 'system', 'import', detail]);
    if (data.source === 'redis') await q("INSERT INTO settings (key, value) VALUES ('import_source_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [String(racking.version)]);
    // The full list of placeholder values removed, pallet by pallet, for anyone who wants to check.
    await q("INSERT INTO settings (key, value) VALUES ('import_cleared_placeholders', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(data.cleared)]);
    console.log(detail);
  }
}
function countPallets(doc) {
  let n = Object.values(doc.machines || {}).reduce((t, l) => t + (Array.isArray(l) ? l.length : 0), 0);
  doc.sections.forEach(s => s.rows.forEach(r => r.racks.forEach(rk => rk.levels.forEach(lv => { n += (lv.items || []).length; }))));
  return n;
}

/* ---------- racking document <-> tables ---------- */
// Columns written for each table, in table order. Keys are the first `keys` columns.
const TABLES = {
  parts: { keys: 1, cols: ['k', 'position', 'number', 'description', 'part_id', 'qty_per_pallet', 'dedicated_case', 'qty_per_case'] },
  sections: { keys: 1, cols: ['key', 'name', 'position'] },
  rack_rows: { keys: 2, cols: ['section', 'row', 'position'] },
  racks: { keys: 3, cols: ['section', 'row', 'rack', 'label', 'position'] },
  levels: { keys: 4, cols: ['section', 'row', 'rack', 'level', 'height', 'position'] },
  pallets: { keys: 1, cols: ['id', 'part_k', 'qty', 'routing', 'received', 'section', 'row', 'rack', 'level', 'position', 'machine', 'from_section', 'from_row', 'from_rack', 'from_level', 'loc', 'batch', 'requested', 'moved_at', 'moved_by'] },
};
const USER_COLS = ['id', 'role', 'active', 'passkey_hash', 'session_version', 'created_at', 'created_by', 'last_login'];
const MOVE_COLS = ['at', 'by_user', 'kind', 'machine', 'part_k', 'qty', 'entry'];
const ACTIVITY_COLS = ['at', 'user_id', 'action', 'detail'];

const blankToNull = v => (v === '' || v == null ? null : v);
const nullToBlank = v => (v == null ? '' : v);
// Row labels are stored as text; rows numbered 2, 3, … come back as numbers, as the page expects.
const rowOut = r => (/^\d+$/.test(r) ? Number(r) : r);
function newId() { return crypto.randomBytes(6).toString('hex'); }

// The rows each table should hold for this document.
function docRows(doc) {
  const out = { parts: [], sections: [], rack_rows: [], racks: [], levels: [], pallets: [] };
  const ids = new Set(), seen = {};
  const palletId = id => { const ok = typeof id === 'string' && id && !ids.has(id); const v = ok ? id : newId(); ids.add(v); return v; };
  const unique = (table, row, what) => {
    const t = TABLES[table], key = t.cols.slice(0, t.keys).map(c => row[c]).join('|');
    seen[table] = seen[table] || new Set();
    if (seen[table].has(key)) { const e = new Error(what + ' appears twice.'); e.status = 400; throw e; }
    seen[table].add(key);
    out[table].push(row);
  };
  doc.parts.forEach((p, i) => unique('parts', {
    k: p.k, position: i, number: p.number || '', description: p.description || '', part_id: p.partId || '',
    qty_per_pallet: blankToNull(p.qtyPerPallet), dedicated_case: p.dedicatedCase || '', qty_per_case: blankToNull(p.qtyPerCase),
  }, 'Part ' + p.k));
  doc.sections.forEach((s, si) => {
    unique('sections', { key: s.key, name: s.name || s.key, position: si }, 'Section ' + s.key);
    s.rows.forEach((r, ri) => {
      const row = String(r.row);
      unique('rack_rows', { section: s.key, row, position: ri }, 'Row ' + row);
      r.racks.forEach((rk, ki) => {
        unique('racks', { section: s.key, row, rack: rk.rack, label: rk.label || '', position: ki }, 'Rack ' + row + '-' + rk.rack);
        rk.levels.forEach((lv, li) => {
          unique('levels', { section: s.key, row, rack: rk.rack, level: lv.level, height: blankToNull(lv.height), position: li }, 'Level ' + row + '-' + rk.rack + '-' + lv.level);
          (lv.items || []).forEach((it, ii) => out.pallets.push({
            id: palletId(it.id), part_k: it.part, qty: blankToNull(it.qty), routing: it.routing || '', received: blankToNull(it.received),
            section: s.key, row, rack: rk.rack, level: lv.level, position: ii,
            machine: null, from_section: null, from_row: null, from_rack: null, from_level: null, loc: null, batch: null, requested: null, moved_at: null, moved_by: null,
          }));
        });
      });
    });
  });
  Object.keys(doc.machines || {}).forEach(m => (doc.machines[m] || []).forEach((x, i) => {
    const f = x.from || {};
    out.pallets.push({
      id: palletId(x.id), part_k: x.part, qty: blankToNull(x.qty), routing: x.routing || '', received: blankToNull(x.received),
      section: null, row: null, rack: null, level: null, position: i, machine: m,
      from_section: f.section || 'hq', from_row: f.row == null ? null : String(f.row), from_rack: f.rack == null ? null : Number(f.rack), from_level: f.level == null ? null : Number(f.level),
      loc: x.loc || null, batch: x.batch || null, requested: blankToNull(x.requested), moved_at: x.at || null, moved_by: x.by || null,
    });
  }));
  return out;
}

// SQL that turns a JSON array parameter into table rows, so a whole batch goes in one statement.
function insertSql(table, cols) {
  return 'INSERT INTO ' + table + ' (' + cols.join(', ') + ') SELECT ' + cols.join(', ') + ' FROM jsonb_populate_recordset(NULL::' + table + ', $1::jsonb)';
}
function updateSql(table) {
  const t = TABLES[table], keys = t.cols.slice(0, t.keys), rest = t.cols.slice(t.keys);
  return 'UPDATE ' + table + ' t SET ' + rest.map(c => c + ' = n.' + c).join(', ') + ' FROM jsonb_populate_recordset(NULL::' + table + ', $1::jsonb) n WHERE ' + keys.map(c => 't.' + c + ' = n.' + c).join(' AND ');
}
function deleteSql(table) {
  const keys = TABLES[table].cols.slice(0, TABLES[table].keys);
  return 'DELETE FROM ' + table + ' t USING jsonb_populate_recordset(NULL::' + table + ', $1::jsonb) n WHERE ' + keys.map(c => 't.' + c + ' = n.' + c).join(' AND ');
}
// Reads a table's current rows in a form that compares equal to docRows' output.
function selectSql(table) {
  return 'SELECT ' + TABLES[table].cols.map(c => c === 'received' ? "to_char(received, 'YYYY-MM-DD') AS received" : c).join(', ') + ' FROM ' + table;
}
function same(a, b, cols) {
  const norm = v => (v instanceof Date ? v.toISOString() : v == null ? null : v);
  return cols.every(c => {
    const x = norm(a[c]), y = norm(b[c]);
    if (c === 'moved_at' && x && y) return new Date(x).getTime() === new Date(y).getTime();
    return x === y;
  });
}

// Writes only what differs between the tables and the document.
async function writeDoc(q, doc) {
  const want = docRows(doc);
  const order = ['parts', 'sections', 'rack_rows', 'racks', 'levels', 'pallets'];
  for (const table of order) {
    const t = TABLES[table], key = r => t.cols.slice(0, t.keys).map(c => String(r[c])).join('|');
    const have = new Map((await q(selectSql(table), [])).map(r => [key(r), r]));
    const add = [], change = [];
    want[table].forEach(r => {
      const cur = have.get(key(r));
      if (!cur) add.push(r);
      else if (!same(cur, r, t.cols)) change.push(r);
      have.delete(key(r));
    });
    const drop = [...have.values()];
    if (drop.length) await q(deleteSql(table), [JSON.stringify(drop)]);
    if (change.length) await q(updateSql(table), [JSON.stringify(change)]);
    if (add.length) await q(insertSql(table, t.cols), [JSON.stringify(add)]);
  }
}

// The racking document: { version, savedAt, savedBy, parts, sections (every stored section), machines }.
async function getRacking() {
  const d = await conn();
  const [meta] = await d.query('SELECT version, saved_at, saved_by FROM meta WHERE id = 1', []);
  const parts = await d.query('SELECT * FROM parts ORDER BY position', []);
  const sections = await d.query('SELECT * FROM sections ORDER BY position', []);
  const rows = await d.query('SELECT * FROM rack_rows ORDER BY position', []);
  const racks = await d.query('SELECT * FROM racks ORDER BY position', []);
  const levels = await d.query('SELECT * FROM levels ORDER BY position', []);
  const pallets = await d.query(selectSql('pallets') + ' ORDER BY position', []);

  const k = (...a) => a.join('|');
  const levelMap = new Map(), rackMap = new Map(), rowMap = new Map(), secMap = new Map();
  const machines = {};
  const out = {
    version: meta.version, savedAt: meta.saved_at ? new Date(meta.saved_at).toISOString() : null, savedBy: meta.saved_by,
    parts: parts.map(p => ({
      k: p.k, number: p.number, description: p.description, partId: p.part_id,
      qtyPerPallet: nullToBlank(p.qty_per_pallet), dedicatedCase: p.dedicated_case, qtyPerCase: nullToBlank(p.qty_per_case),
    })),
    sections: sections.map(s => { const o = { key: s.key, name: s.name, rows: [] }; secMap.set(s.key, o); return o; }),
    machines,
  };
  rows.forEach(r => { const o = { row: rowOut(r.row), racks: [] }; rowMap.set(k(r.section, r.row), o); secMap.get(r.section).rows.push(o); });
  racks.forEach(r => { const o = { rack: r.rack, label: r.label, levels: [] }; rackMap.set(k(r.section, r.row, r.rack), o); rowMap.get(k(r.section, r.row)).racks.push(o); });
  levels.forEach(l => { const o = { level: l.level, height: nullToBlank(l.height), items: [] }; levelMap.set(k(l.section, l.row, l.rack, l.level), o); rackMap.get(k(l.section, l.row, l.rack)).levels.push(o); });
  pallets.forEach(p => {
    const base = { id: p.id, part: p.part_k, qty: nullToBlank(p.qty), routing: p.routing, received: nullToBlank(p.received) };
    if (!p.machine) return levelMap.get(k(p.section, p.row, p.rack, p.level)).items.push(base);
    (machines[p.machine] = machines[p.machine] || []).push(Object.assign(base, {
      from: { section: p.from_section, row: p.from_row == null ? null : rowOut(p.from_row), rack: p.from_rack, level: p.from_level },
      loc: p.loc, batch: p.batch, requested: nullToBlank(p.requested), at: p.moved_at ? new Date(p.moved_at).toISOString() : null, by: p.moved_by,
    }));
  });
  return out;
}

async function getVersion() {
  const [m] = await (await conn()).query('SELECT version, saved_at, saved_by FROM meta WHERE id = 1', []);
  return { version: m.version, savedAt: m.saved_at ? new Date(m.saved_at).toISOString() : null, savedBy: m.saved_by };
}

// Saves the document only if the stored version is still baseVersion. The transfer log entry (move) and
// the activity entry go in the same transaction, so they are recorded exactly when the change is.
// Returns false if someone else saved first.
async function saveRacking(baseVersion, doc, { by, move, activity } = {}) {
  return (await conn()).tx(async q => {
    await q("SELECT set_config('app.actor', $1, true)", [by || '']);
    const [m] = await q('SELECT version FROM meta WHERE id = 1 FOR UPDATE', []);
    if (!m || m.version !== baseVersion) return false;
    await writeDoc(q, doc);
    await q('UPDATE meta SET version = $1, saved_at = $2, saved_by = $3 WHERE id = 1', [doc.version, doc.savedAt, doc.savedBy]);
    if (move) await q(insertSql('stock_moves', MOVE_COLS), [JSON.stringify([moveRow(move)])]);
    if (activity) await q('INSERT INTO activity (at, user_id, action, detail) VALUES ($1, $2, $3, $4)', [doc.savedAt, by, activity.action, activity.detail || '']);
    return true;
  });
}
function moveRow(e) {
  return { at: e.at, by_user: String(e.by || '?'), kind: e.kind, machine: e.machine || null, part_k: e.part || null, qty: Number(e.qty) || 0, entry: e };
}

// Transfer log entries since a time (ms), newest first.
async function listMoves(sinceMs, limit) {
  const rows = await (await conn()).query('SELECT entry FROM stock_moves WHERE at >= $1 ORDER BY at DESC, id DESC LIMIT $2', [new Date(sinceMs || 0).toISOString(), limit]);
  return rows.map(r => r.entry);
}

/* ---------- users ---------- */
function userRow(u) {
  return {
    id: u.id, role: u.role, active: u.active !== false, passkey_hash: u.hash, session_version: u.sv || 0,
    created_at: u.createdAt || new Date().toISOString(), created_by: u.createdBy || null, last_login: u.lastLogin || null,
  };
}
function userOut(r) {
  const iso = v => (v ? new Date(v).toISOString() : null);
  return { id: r.id, role: r.role, active: r.active, hash: r.passkey_hash, sv: r.session_version, createdAt: iso(r.created_at), createdBy: r.created_by, lastLogin: iso(r.last_login) };
}
async function listUsers() {
  return (await (await conn()).query('SELECT * FROM users ORDER BY created_at, id', [])).map(userOut);
}
// User IDs are matched without regard to case.
async function getUser(id) {
  const rows = await (await conn()).query('SELECT * FROM users WHERE lower(id) = lower($1)', [String(id || '')]);
  return rows.length ? userOut(rows[0]) : null;
}
// Adds a user; false if the User ID is taken.
async function addUser(u, by) {
  return (await conn()).tx(async q => {
    await q("SELECT set_config('app.actor', $1, true)", [by || '']);
    const r = await q(insertSql('users', USER_COLS) + ' ON CONFLICT DO NOTHING RETURNING id', [JSON.stringify([userRow(u)])]);
    return r.length > 0;
  });
}
// Changes one user's fields in place: { role, active, hash, sv, lastLogin }. Other users are not touched,
// so two admins (or a sign-in and an admin) changing different users never undo each other.
async function updateUser(id, fields, by) {
  const map = { role: 'role', active: 'active', hash: 'passkey_hash', sv: 'session_version', lastLogin: 'last_login' };
  const sets = [], vals = [id];
  Object.keys(fields).forEach(f => { vals.push(fields[f]); sets.push(map[f] + ' = $' + vals.length); });
  if (!sets.length) return;
  await (await conn()).tx(async q => {
    await q("SELECT set_config('app.actor', $1, true)", [by || '']);
    await q('UPDATE users SET ' + sets.join(', ') + ' WHERE id = $1', vals);
  });
}
async function deleteUser(id, by) {
  await (await conn()).tx(async q => {
    await q("SELECT set_config('app.actor', $1, true)", [by || '']);
    await q('DELETE FROM users WHERE id = $1', [id]);
  });
}
// Creates the first admin when there are no users at all. Returns true if it did.
async function addFirstAdmin(u) {
  return (await conn()).tx(async q => {
    await q('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    if ((await q('SELECT 1 FROM users LIMIT 1', [])).length) return false;
    await q("SELECT set_config('app.actor', 'setup', true)", []);
    await q(insertSql('users', USER_COLS), [JSON.stringify([userRow(u)])]);
    await q('INSERT INTO activity (user_id, action, detail) VALUES ($1, $2, $3)', ['setup', 'create-user', u.id + ' (' + u.role + ')']);
    return true;
  });
}

/* ---------- activity log ---------- */
async function log(entry) {
  await (await conn()).query('INSERT INTO activity (at, user_id, action, detail) VALUES ($1, $2, $3, $4)', [entry.at, entry.user, entry.action, entry.detail || '']);
}
async function readLog(n) {
  const rows = await (await conn()).query('SELECT at, user_id, action, detail FROM activity ORDER BY at DESC, id DESC LIMIT $1', [n]);
  return rows.map(r => ({ at: new Date(r.at).toISOString(), user: r.user_id, action: r.action, detail: r.detail }));
}

/* ---------- failed sign-ins ---------- */
async function getFailures(key) {
  const rows = await (await conn()).query('SELECT count, locked_until FROM login_failures WHERE key = $1 AND expires_at > now()', [key]);
  return rows.length ? { count: rows[0].count, until: rows[0].locked_until ? new Date(rows[0].locked_until).getTime() : 0 } : null;
}
async function setFailures(key, count, untilMs, ttlSec) {
  const d = await conn();
  await d.query('DELETE FROM login_failures WHERE expires_at <= now()', []);
  await d.query('INSERT INTO login_failures (key, count, locked_until, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4)) ' +
    'ON CONFLICT (key) DO UPDATE SET count = $2, locked_until = $3, expires_at = now() + make_interval(secs => $4)',
  [key, count, untilMs ? new Date(untilMs).toISOString() : null, ttlSec]);
}
async function clearFailures(key) {
  await (await conn()).query('DELETE FROM login_failures WHERE key = $1', [key]);
}

/* ---------- settings ---------- */
async function getSetting(key) {
  const rows = await (await conn()).query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}
// Stores a value unless one is already there; returns the stored value.
async function initSetting(key, value) {
  const d = await conn();
  await d.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
  return getSetting(key);
}

/* ---------- backup ---------- */
// Everything in the format the earlier version of the app used, for a backup download or a rollback.
async function exportAll() {
  const d = await conn();
  const racking = await getRacking();
  const users = await listUsers();
  const moves = (await d.query('SELECT entry FROM stock_moves ORDER BY at DESC, id DESC', [])).map(r => r.entry);
  const audit = (await d.query('SELECT at, user_id, action, detail FROM activity ORDER BY at DESC, id DESC', [])).map(r => ({ at: new Date(r.at).toISOString(), user: r.user_id, action: r.action, detail: r.detail }));
  return { exportedAt: new Date().toISOString(), racking, users, transfers: moves, audit };
}

module.exports = {
  get kind() { return db.kind; },
  ready: conn,
  getRacking, getVersion, saveRacking, listMoves,
  listUsers, getUser, addUser, updateUser, deleteUser, addFirstAdmin,
  log, readLog, getFailures, setFailures, clearFailures, getSetting, initSetting, exportAll,
};
