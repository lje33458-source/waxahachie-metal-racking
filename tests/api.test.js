'use strict';
// API tests: sign-in rules, permissions and the checks that stop two people from overwriting each other.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, adminClient, ADMIN_PASSKEY } = require('./helpers');

let srv, admin;
before(async () => { srv = await startServer(); admin = await adminClient(srv.base); });
after(async () => { if (srv) await srv.stop(); });

function firstPallet(d, part) {
  for (const s of d.sections) for (const r of s.rows) for (const rk of r.racks) for (const lv of rk.levels) {
    const i = lv.items.findIndex(it => it.part === part);
    if (i >= 0) return { section: s.key, row: r.row, rack: rk.rack, level: lv.level, item: i, qty: lv.items[i].qty };
  }
  return null;
}

test('health reports the storage in use', async () => {
  const r = await client(srv.base).call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.storage);
});

test('writes without the app header are blocked', async () => {
  const r = await fetch(srv.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('everything but sign-in needs a session', async () => {
  const c = client(srv.base);
  for (const [m, u] of [['GET', '/api/data'], ['GET', '/api/version'], ['GET', '/api/transfers'], ['POST', '/api/transfer'], ['GET', '/api/admin/users']]) {
    assert.equal((await c.call(m, u, m === 'GET' ? undefined : {})).status, 401, u);
  }
});

test('five wrong passkeys lock the account for this address', async () => {
  await admin.call('POST', '/api/admin/users', { userId: 'locky', role: 'viewer', passkey: 'right-passkey' });
  const c = client(srv.base);
  for (let i = 0; i < 5; i++) assert.equal((await c.login('locky', 'nope-nope')).status, 401);
  const r = await c.login('locky', 'right-passkey');
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Too many failed attempts/);
});

test('roles are enforced by the server', async () => {
  const users = { v: 'viewer', h: 'handler', s: 'shipping', sup: 'supervisor' };
  const cs = {};
  for (const [id, role] of Object.entries(users)) {
    assert.equal((await admin.call('POST', '/api/admin/users', { userId: 'r-' + id, role, passkey: 'passkey-' + id })).status, 200);
    cs[id] = client(srv.base);
    assert.equal((await cs[id].login('r-' + id, 'passkey-' + id)).status, 200);
  }
  const d = (await admin.call('GET', '/api/data')).body;
  const put = { baseVersion: d.version, parts: d.parts, sections: d.sections };
  for (const id of Object.keys(users)) assert.equal((await cs[id].call('PUT', '/api/data', put)).status, 403, id);
  assert.equal((await cs.s.call('POST', '/api/transfer', {})).status, 403);
  assert.equal((await cs.v.call('POST', '/api/transfer', {})).status, 403);
  assert.equal((await cs.h.call('POST', '/api/receive', {})).status, 403);
  assert.equal((await cs.v.call('POST', '/api/return', {})).status, 403);
  assert.equal((await cs.sup.call('GET', '/api/admin/users')).status, 403);
  assert.equal((await cs.h.call('GET', '/api/transfers?range=all')).status, 403);
  assert.equal((await cs.h.call('GET', '/api/transfers?range=week')).status, 200);
});

test('admin save needs the current version', async () => {
  const d = (await admin.call('GET', '/api/data')).body;
  const ok = await admin.call('PUT', '/api/data', { baseVersion: d.version, parts: d.parts, sections: d.sections });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, d.version + 1);
  const stale = await admin.call('PUT', '/api/data', { baseVersion: d.version, parts: d.parts, sections: d.sections });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.version, d.version + 1);
  const v = await admin.call('GET', '/api/version');
  assert.deepEqual(Object.keys(v.body).sort(), ['savedAt', 'savedBy', 'version']);
  assert.equal(v.body.version, d.version + 1);
  assert.equal(v.body.savedBy, 'admin');
});

test('bad data is refused', async () => {
  const d = (await admin.call('GET', '/api/data')).body;
  assert.equal((await admin.call('PUT', '/api/data', { baseVersion: d.version })).status, 400);
  const r = await fetch(srv.base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-WMR': '1' }, body: '{bad json' });
  assert.equal(r.status, 401); // no session
});

test('a transfer of a pallet that changed is refused', async () => {
  const d = (await admin.call('GET', '/api/data')).body;
  const p = firstPallet(d, 'p63');
  const wrongQty = await admin.call('POST', '/api/transfer', { part: 'p63', requested: 1, machine: 'P4', pallets: [Object.assign({}, p, { qty: p.qty + 1 })] });
  assert.equal(wrongQty.status, 409);
  assert.equal((await admin.call('POST', '/api/transfer', { part: 'p63', requested: 1, machine: 'XX', pallets: [p] })).status, 400);
  assert.equal((await admin.call('POST', '/api/transfer', { part: 'p63', requested: 1, machine: 'P4', pallets: [p, p] })).status, 409);
  assert.equal((await admin.call('POST', '/api/transfer', { part: 'p63', requested: 999, machine: 'P4', pallets: [p] })).status, 400);
  const ok = await admin.call('POST', '/api/transfer', { part: 'p63', requested: 5, machine: 'P4', pallets: [p] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.machines.P4.length, 1);
  assert.equal(ok.body.machines.P4[0].from.level, p.level);
  // Same pallet again: it is no longer on the racking.
  assert.equal((await admin.call('POST', '/api/transfer', { part: 'p63', requested: 5, machine: 'P4', pallets: [p] })).status, 409);
  // Return needs the exact list at the machine.
  assert.equal((await admin.call('POST', '/api/return', { machine: 'P4', used: 5, ids: [] })).status, 409);
  const ids = ok.body.machines.P4.map(x => x.id);
  assert.equal((await admin.call('POST', '/api/return', { machine: 'P4', used: 999, ids })).status, 400);
  const back = await admin.call('POST', '/api/return', { machine: 'P4', used: 5, ids });
  assert.equal(back.status, 200);
  assert.equal(back.body.machines.P4.length, 0);
  const again = firstPallet(back.body, 'p63');
  assert.ok(again);
  const log = await admin.call('GET', '/api/transfers?range=all');
  assert.deepEqual(log.body.entries.slice(0, 2).map(e => e.kind), ['return', 'transfer']);
  assert.equal(log.body.entries[0].pallets[0].used, 5);
});

test('receive refuses spots that are taken', async () => {
  const d = (await admin.call('GET', '/api/data')).body;
  const p = firstPallet(d, 'p63');
  const r = await admin.call('POST', '/api/receive', { part: 'p63', received: '2026-10-02', pallets: [{ section: 'hq', row: p.row, rack: p.rack, level: p.level, qty: 3, routing: 'X' }] });
  assert.equal(r.status, 409);
  const noRouting = await admin.call('POST', '/api/receive', { part: 'p63', pallets: [{ section: 'hq', row: 3, rack: 1, level: 1, qty: 3, routing: '' }] });
  assert.equal(noRouting.status, 400);
});

test('user rules: one active admin stays, sessions end on reset', async () => {
  assert.equal((await admin.call('PATCH', '/api/admin/users/admin', { role: 'viewer' })).status, 400);
  assert.equal((await admin.call('DELETE', '/api/admin/users/admin')).status, 400);
  assert.equal((await admin.call('POST', '/api/admin/users', { userId: 'x', role: 'viewer', passkey: 'long-enough' })).status, 400);
  assert.equal((await admin.call('POST', '/api/admin/users', { userId: 'shorty', role: 'viewer', passkey: 'short' })).status, 400);
  assert.equal((await admin.call('POST', '/api/admin/users', { userId: 'sess', role: 'viewer', passkey: 'passkey-sess' })).status, 200);
  assert.equal((await admin.call('POST', '/api/admin/users', { userId: 'SESS', role: 'viewer', passkey: 'passkey-sess' })).status, 400);
  const u = client(srv.base);
  assert.equal((await u.login('sess', 'passkey-sess')).status, 200);
  assert.equal((await u.call('GET', '/api/me')).status, 200);
  assert.equal((await admin.call('PATCH', '/api/admin/users/sess', { passkey: 'passkey-new1' })).status, 200);
  assert.equal((await u.call('GET', '/api/me')).status, 401);
  assert.equal((await admin.call('PATCH', '/api/admin/users/sess', { active: false })).status, 200);
  assert.equal((await u.login('sess', 'passkey-new1')).status, 401);
  assert.equal((await admin.call('DELETE', '/api/admin/users/sess')).status, 200);
  const list = (await admin.call('GET', '/api/admin/users')).body.users;
  assert.ok(!list.some(x => x.id === 'sess'));
  assert.ok(list.every(x => !('hash' in x)));
  const audit = (await admin.call('GET', '/api/admin/audit')).body.entries;
  assert.equal(audit[0].action, 'delete-user');
  assert.equal(audit[0].detail, 'sess');
});

test('signing in records the time without losing other user changes', async () => {
  // Many sign-ins at the same moment as an admin change: the change must not be lost.
  await admin.call('POST', '/api/admin/users', { userId: 'busy', role: 'viewer', passkey: 'passkey-busy' });
  const logins = Array.from({ length: 8 }, () => client(srv.base).login('admin', ADMIN_PASSKEY));
  const change = admin.call('PATCH', '/api/admin/users/busy', { active: false });
  await Promise.all(logins.concat(change));
  const list = (await admin.call('GET', '/api/admin/users')).body.users;
  assert.equal(list.find(x => x.id === 'busy').active, false);
});
