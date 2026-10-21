'use strict';
// Reads data saved by the earlier version of the app (one JSON document in Upstash Redis, or JSON files in DATA_DIR)
// so it can be copied into the database on first start, and writes it back for a rollback.
// The old data is only read here, never changed: it stays where it was as a backup.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'wmr:';
// The old app kept this marker in its data; without it, the old app would re-run a one-off fix after a rollback.
const OLD_MIGRATIONS = ['undo-transfers-2026-10-20'];

function envBySuffix(...names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  const k = Object.keys(process.env).find(k => names.some(n => k.endsWith('_' + n)) && process.env[k]);
  return k ? process.env[k] : undefined;
}

/* ---------- Upstash Redis over REST ---------- */
function redis() {
  const url = envBySuffix('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
  const token = envBySuffix('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) return null;
  return async function cmd(args, retry = 2) {
    let r;
    try { r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(args) }); }
    catch (e) { if (retry) return cmd(args, retry - 1); throw new Error('Could not reach Redis: ' + e.message); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error('Redis error: ' + (j.error || r.status));
    return j.result;
  };
}
const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };

async function readRedis(cmd) {
  const racking = parse(await cmd(['GET', PREFIX + 'racking']));
  const users = parse(await cmd(['GET', PREFIX + 'users']));
  if (!racking && !users) return null;
  const list = async key => ((await cmd(['LRANGE', PREFIX + key, '0', '-1'])) || []).map(parse).filter(Boolean);
  return { source: 'redis', racking, users, transfers: await list('transfers'), audit: await list('audit') };
}

/* ---------- JSON files in DATA_DIR ---------- */
function readFiles(dir) {
  const json = name => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (e) { return null; } };
  const lines = name => { try { return fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').map(parse).filter(Boolean); } catch (e) { return []; } };
  const racking = json('racking.json'), users = json('users.json');
  if (!racking && !users) return null;
  // Files were appended oldest first; Redis lists are newest first. Return newest first like Redis.
  return { source: 'files', racking, users, transfers: lines('transfers-list.json').reverse(), audit: lines('audit.log').reverse() };
}

// The old data, or null when there is none.
async function read() {
  const cmd = redis();
  if (cmd) return readRedis(cmd);
  if (process.env.VERCEL) return null;
  return readFiles(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
}

/* ---------- placeholder routing numbers and dates ---------- */
// The old app made up a routing number and received date for any pallet without one, from the pallet's spot,
// and those were saved with the next change. Recompute them so they can be told apart from real values.
function placeholder(sectionKey, row, rack, level, i) {
  const h = crypto.createHash('sha256').update(sectionKey + '|' + row + '-' + rack + '-' + level + '|' + i).digest();
  return {
    routing: 'RT-' + String(100000 + h.readUInt32BE(0) % 900000),
    received: new Date(Date.UTC(2026, 9, 20) - (5 + h.readUInt16BE(4) % 355) * 86400000).toISOString().slice(0, 10),
  };
}
// Clears a pallet's routing # and date when they match the made-up values for the spot it is on (or came from).
// A routing # that matches is cleared. A date is cleared when it matches together with the routing #, or matches
// the value made up for the pallet's exact position, so a real date is very unlikely to be caught.
// What was cleared is added to report.
function stripPlaceholders(item, spot, index, report) {
  const fakes = [];
  for (let i = 0; i < 20; i++) fakes.push(placeholder(spot.section, spot.row, spot.rack, spot.level, i));
  const r = fakes.findIndex(f => f.routing === item.routing);
  const cleared = {};
  if (r >= 0) { cleared.routing = item.routing; item.routing = ''; }
  if (item.received && ((r >= 0 && fakes[r].received === item.received) || (index != null && fakes[index] && fakes[index].received === item.received))) {
    cleared.received = item.received; item.received = '';
  }
  if (Object.keys(cleared).length) report.push(Object.assign({ at: spot.section + ' ' + spot.row + '-' + spot.rack + '-' + spot.level }, cleared));
}

// Turns old data into { racking: {version, parts, sections, machines}, users, transfers, audit, cleared }.
// Handles every shape the old app wrote: racking rows at the top level (before sections), the "editor" role.
function normalize(old) {
  const cleared = [];
  let racking = null;
  if (old.racking) {
    const r = old.racking;
    const sections = Array.isArray(r.sections) ? r.sections : [{ key: 'hq', name: 'Racking', rows: Array.isArray(r.rows) ? r.rows : [] }];
    sections.forEach(s => s.rows.forEach(row => row.racks.forEach(rk => rk.levels.forEach(lv => (lv.items || []).forEach((it, i) => {
      stripPlaceholders(it, { section: s.key, row: row.row, rack: rk.rack, level: lv.level }, i, cleared);
    })))));
    const machines = r.machines && typeof r.machines === 'object' ? r.machines : {};
    Object.keys(machines).forEach(m => (machines[m] || []).forEach(x => {
      const f = x.from || {};
      stripPlaceholders(x, { section: f.section || 'hq', row: f.row, rack: f.rack, level: f.level }, null, cleared);
    }));
    racking = { version: Number(r.version) || 1, parts: Array.isArray(r.parts) ? r.parts : [], sections, machines };
  }
  const users = (Array.isArray(old.users) ? old.users : []).map(u => Object.assign({}, u, { role: u.role === 'editor' ? 'handler' : u.role }));
  return { source: old.source, racking, users, transfers: old.transfers || [], audit: old.audit || [], cleared };
}

/* ---------- rollback: write current data back in the old format ---------- */
// data: the object GET /api/admin/export returns.
async function writeRedis(cmd, data) {
  const r = Object.assign({}, data.racking, { migrations: OLD_MIGRATIONS });
  await cmd(['SET', PREFIX + 'racking', JSON.stringify(r)]);
  await cmd(['SET', PREFIX + 'racking:version', String(r.version)]);
  await cmd(['SET', PREFIX + 'users', JSON.stringify(data.users)]);
  for (const [key, list] of [['transfers', data.transfers], ['audit', data.audit]]) {
    await cmd(['DEL', PREFIX + key]);
    // Lists are newest first; RPUSH in that order keeps it.
    for (let i = 0; i < list.length; i += 500) await cmd(['RPUSH', PREFIX + key].concat(list.slice(i, i + 500).map(e => JSON.stringify(e))));
  }
}

module.exports = { read, normalize, redis, writeRedis, placeholder, OLD_MIGRATIONS };
