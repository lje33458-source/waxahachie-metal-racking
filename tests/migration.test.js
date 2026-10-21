'use strict';
// Moving from the earlier Redis / JSON-file storage: the first start copies the old data in (leaving it untouched),
// clears the placeholder values the old app made up, and a backup can be written back for a rollback.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const run = require('util').promisify(execFile);
const { startServer, adminClient, ROOT, ADMIN_PASSKEY } = require('./helpers');
const { placeholder } = require('../lib/legacy');

const cleanup = [];
// Passkey hashes as the old app stored them (same format as now).
function hash(pk) {
  const crypto = require('crypto'), salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('base64') + '$' + crypto.scryptSync(pk, salt, 64).toString('base64');
}
after(async () => { for (const f of cleanup.reverse()) await f(); });

// A tiny stand-in for Upstash's REST API: POST a JSON command array, get { result }.
function fakeRedis(data) {
  const kv = new Map(Object.entries(data));
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      const [c, key, ...a] = JSON.parse(body);
      let result = null;
      const list = () => { if (!kv.has(key)) kv.set(key, []); return kv.get(key); };
      switch (c.toUpperCase()) {
        case 'GET': result = kv.has(key) ? kv.get(key) : null; break;
        case 'SET': kv.set(key, a[0]); result = 'OK'; break;
        case 'DEL': result = kv.delete(key) ? 1 : 0; break;
        case 'LPUSH': list().unshift(...a.reverse()); result = list().length; break;
        case 'RPUSH': list().push(...a); result = list().length; break;
        case 'LTRIM': kv.set(key, list().slice(Number(a[0]), Number(a[1]) + 1)); result = 'OK'; break;
        case 'LRANGE': { const l = list(), end = Number(a[1]) < 0 ? l.length + Number(a[1]) : Number(a[1]); result = l.slice(Number(a[0]), end + 1); break; }
        case 'EVAL': { // the old app's conditional save: version key, racking key
          const [, n, vk, rk, base, doc, ver] = [c, key, ...a];
          const cur = kv.get(vk);
          if (cur && Number(cur) !== Number(base)) result = 0; else { kv.set(rk, doc); kv.set(vk, ver); result = 1; }
          void n; break;
        }
        default: res.writeHead(400); return res.end(JSON.stringify({ error: 'unsupported ' + c }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }));
    });
  });
  return new Promise(resolve => srv.listen(0, () => resolve({ url: 'http://127.0.0.1:' + srv.address().port, kv, close: () => new Promise(r => { srv.close(r); srv.closeAllConnections(); }) })));
}

// Old-format data as production has it: sections, a pallet at a machine, placeholder values saved by an earlier save,
// one pallet with a real routing # and date, an "editor" account, and both logs.
function oldData() {
  const ph = (row, rack, level, i) => placeholder('hq', row, rack, level, i);
  const seed = require('../seed.json');
  const rows = JSON.parse(JSON.stringify(seed.rows));
  rows.forEach(r => r.racks.forEach(rk => rk.levels.forEach(lv => lv.items.forEach((it, i) => Object.assign(it, ph(r.row, rk.rack, lv.level, i))))));
  // 2-1-8 had its routing # typed in by hand, the date is still made up.
  rows[0].racks[0].levels[1].items[0].routing = 'R-55021';
  // 2-1-9 was received for real.
  Object.assign(rows[0].racks[0].levels[0].items[0], { routing: 'RCV-REAL', received: '2026-10-05' });
  // 2-2-9 went to EMK, with its made-up values.
  const atMachine = Object.assign({ id: 'abc123', part: 'p63', qty: 12, from: { section: 'hq', row: 2, rack: 2, level: 9 }, loc: '2-2-9', batch: 'b1', requested: 10, at: '2026-10-20T15:00:00.000Z', by: 'traci' }, ph(2, 2, 9, 0));
  rows[0].racks[1].levels[0].items = [];
  const racking = { version: 41, savedAt: '2026-10-20T15:00:00.000Z', savedBy: 'traci', parts: seed.parts, sections: [{ key: 'hq', name: 'Racking', rows }], machines: { EMK: [atMachine] }, migrations: ['undo-transfers-2026-10-20'] };
  const users = [
    { id: 'admin', role: 'admin', active: true, hash: hash(ADMIN_PASSKEY), sv: 0, createdAt: '2026-10-15T00:00:00.000Z', createdBy: 'setup', lastLogin: null },
    { id: 'Bob', role: 'editor', active: true, hash: hash('bob-passkey'), sv: 2, createdAt: '2026-10-16T00:00:00.000Z', createdBy: 'admin', lastLogin: '2026-10-19T00:00:00.000Z' },
  ];
  const transfers = [ // newest first, as Redis keeps them
    { at: '2026-10-20T15:00:00.000Z', by: 'traci', kind: 'transfer', part: 'p63', partNumber: 'ATP-6061T6-063-48144', qty: 12, requested: 10, machine: 'EMK', pallets: [{ loc: '2-2-9', qty: 12 }] },
    { at: '2026-10-05T12:00:00.000Z', by: 'traci', kind: 'receive', part: 'p80', partNumber: 'ATP-6061T6-080-48144', qty: 12, received: '2026-10-05', pallets: [{ loc: '2-1-9', qty: 12, routing: 'RCV-REAL' }] },
  ];
  const audit = [
    { at: '2026-10-20T15:00:01.000Z', user: 'traci', action: 'save', detail: 'version 41' },
    { at: '2026-10-19T00:00:00.000Z', user: 'Bob', action: 'login', detail: '' },
  ];
  return { racking, users, transfers, audit };
}

async function checkImported(srv, source) {
  const c = await adminClient(srv.base);
  const d = (await c.call('GET', '/api/data')).body;
  assert.equal(d.version, 42, 'version goes up by one');
  const lv = (row, rack, level) => d.sections[0].rows.find(r => r.row === row).racks.find(r => r.rack === rack).levels.find(l => l.level === level);
  assert.deepEqual(lv(2, 1, 9).items.map(x => [x.routing, x.received]), [['RCV-REAL', '2026-10-05']]);
  assert.deepEqual(lv(2, 1, 8).items.map(x => [x.routing, x.received]), [['R-55021', '']]);
  assert.deepEqual(lv(2, 1, 7).items.map(x => [x.routing, x.received]), [['', '']]);
  assert.equal(lv(2, 2, 9).items.length, 0);
  assert.equal(d.machines.EMK.length, 1);
  assert.deepEqual([d.machines.EMK[0].id, d.machines.EMK[0].routing, d.machines.EMK[0].received, d.machines.EMK[0].requested], ['abc123', '', '', 10]);
  assert.deepEqual(d.machines.EMK[0].from, { section: 'hq', row: 2, rack: 2, level: 9 });
  const users = (await c.call('GET', '/api/admin/users')).body.users;
  assert.deepEqual(users.map(u => [u.id, u.role]), [['admin', 'admin'], ['Bob', 'handler']]);
  // Old passkeys and sessions still work.
  const bob = require('./helpers').client(srv.base);
  assert.equal((await bob.login('bob', 'bob-passkey')).status, 200);
  const log = (await c.call('GET', '/api/transfers?range=all')).body.entries;
  assert.deepEqual(log.map(e => e.kind), ['transfer', 'receive']);
  const audit = (await c.call('GET', '/api/admin/audit')).body.entries;
  const imp = audit.find(e => e.action === 'import');
  assert.ok(imp, 'import is in the activity log');
  assert.match(imp.detail, new RegExp('Copied from ' + source + ': 2 parts, 8 pallets, 2 users, 2 transfer log entries, 2 activity entries\\. Removed made-up placeholder values: 6 routing numbers, 7 dates received\\.'));
  return c;
}

test('first start copies old JSON files in and clears made-up values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmr-old-'));
  const old = oldData();
  fs.writeFileSync(path.join(dir, 'racking.json'), JSON.stringify(old.racking));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(old.users));
  fs.writeFileSync(path.join(dir, 'transfers-list.json'), old.transfers.slice().reverse().map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'audit.log'), old.audit.slice().reverse().map(e => JSON.stringify(e)).join('\n') + '\n');
  const before = fs.readFileSync(path.join(dir, 'racking.json'), 'utf8');
  const srv = await startServer({ dataDir: dir });
  cleanup.push(srv.stop);
  await checkImported(srv, 'data files');
  assert.equal(fs.readFileSync(path.join(dir, 'racking.json'), 'utf8'), before, 'old file left as it was');
  // A restart does not copy again.
  await srv.stop();
  const again = await startServer({ dataDir: dir, env: process.env.TEST_DATABASE_URL ? { DATABASE_URL: srv.dbUrl } : undefined });
  cleanup.push(again.stop);
  const c = await adminClient(again.base);
  assert.equal((await c.call('GET', '/api/admin/audit')).body.entries.filter(e => e.action === 'import').length, 1);
});

test('first start copies old Redis data in; a backup rolls back to the old app', async () => {
  const old = oldData();
  const redis = await fakeRedis({
    'wmr:racking': JSON.stringify(old.racking), 'wmr:racking:version': '41', 'wmr:users': JSON.stringify(old.users),
    'wmr:transfers': old.transfers.map(e => JSON.stringify(e)), 'wmr:audit': old.audit.map(e => JSON.stringify(e)),
  });
  cleanup.push(redis.close);
  const before = redis.kv.get('wmr:racking');
  const env = { KV_REST_API_URL: redis.url, KV_REST_API_TOKEN: 'test-token' };
  const srv = await startServer({ env });
  cleanup.push(srv.stop);
  const c = await checkImported(srv, 'Redis');
  assert.equal(redis.kv.get('wmr:racking'), before, 'Redis left as it was');

  // Work in the new app: a transfer back from EMK.
  const d = (await c.call('GET', '/api/data')).body;
  assert.equal((await c.call('POST', '/api/return', { machine: 'EMK', used: 2, ids: d.machines.EMK.map(x => x.id) })).status, 200);

  // Download the backup and write it back to Redis.
  const r = await fetch(srv.base + '/api/admin/export', { headers: { Cookie: (await loginCookie(srv.base)) } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="americase-inventory-backup-/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmr-bak-')), 'backup.json');
  fs.writeFileSync(file, await r.text());
  // Not execFileSync: the stand-in Redis runs in this process and must keep answering.
  await run(process.execPath, [path.join(ROOT, 'scripts/rollback-to-redis.js'), file], { env: Object.assign({}, process.env, env) });
  const back = JSON.parse(redis.kv.get('wmr:racking'));
  assert.equal(back.version, 43);
  assert.deepEqual(back.migrations, ['undo-transfers-2026-10-20']);
  assert.equal(redis.kv.get('wmr:racking:version'), '43');
  assert.equal(JSON.parse(redis.kv.get('wmr:transfers')[0]).kind, 'return');

  // The earlier version of the app runs on the rolled-back data.
  const oldApp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmr-oldapp-'));
  execFileSync('sh', ['-c', 'git -C "$0" archive a9a6b99 | tar -x -C "$1"', ROOT, oldApp]);
  const legacySrv = await startServer({ root: oldApp, env: Object.assign({ DATABASE_URL: '' }, env) });
  cleanup.push(legacySrv.stop);
  const lc = await adminClient(legacySrv.base);
  const ld = (await lc.call('GET', '/api/data')).body;
  assert.equal(ld.version, 43);
  assert.equal(ld.machines.EMK.length, 0);
  const spot = ld.sections[0].rows.find(x => x.row === 2).racks.find(x => x.rack === 2).levels.find(x => x.level === 9);
  assert.deepEqual(spot.items.map(x => [x.part, x.qty]), [['p63', 10]]);
  assert.equal((await lc.call('GET', '/api/transfers?range=all')).body.entries[0].kind, 'return');
});

async function loginCookie(base) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WMR': '1' }, body: JSON.stringify({ userId: 'admin', passkey: ADMIN_PASSKEY }) });
  return r.headers.get('set-cookie').split(';')[0];
}
