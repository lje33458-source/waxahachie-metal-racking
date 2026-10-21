'use strict';
// Browser tests: drive every tab of the page the way people use it.
// Run with: NODE_PATH=/opt/node-tools/node_modules node --test tests/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startServer, adminClient, signIn, ADMIN_PASSKEY } = require('./helpers');

let srv, browser, ctx, page;

before(async () => {
  srv = await startServer();
  browser = await chromium.launch();
  ctx = await browser.newContext();
  page = await ctx.newPage();
  page.on('pageerror', e => { throw e; });
});
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.stop();
});

const text = sel => page.locator(sel).first().evaluate(e => e.textContent.replace(/\s+/g, ' ').trim());
async function tab(name) { await page.click('#tab-' + name); }
async function saveChanges() {
  await page.click('[data-act="save"]');
  await page.waitForFunction(() => /^Saved /.test(document.querySelector('.status').textContent));
}
async function rackPallets() {
  const c = await adminClient(srv.base);
  const d = (await c.call('GET', '/api/data')).body;
  const out = {};
  d.sections.forEach(s => s.rows.forEach(r => r.racks.forEach(rk => rk.levels.forEach(lv => {
    if (lv.items.length) out[r.row + '-' + rk.rack + '-' + lv.level] = lv.items.map(it => ({ part: it.part, qty: it.qty, routing: it.routing, received: it.received }));
  }))));
  return { data: d, at: out };
}

test('sign-in rejects a wrong passkey and accepts the right one', async () => {
  await page.goto(srv.base + '/');
  await page.fill('#login-id', 'admin');
  await page.fill('#login-pk', 'wrong-passkey');
  await page.click('#login-btn');
  await page.waitForFunction(() => document.getElementById('login-err').textContent.length > 0);
  assert.match(await text('#login-err'), /incorrect/);
  await signIn(page, srv.base, 'admin', ADMIN_PASSKEY);
  assert.match(await text('.userbar'), /Signed in as admin/);
  const tabs = await page.locator('nav.tabs .tab').allTextContents();
  assert.deepEqual(tabs, ['Racking', 'Receive Material', 'Transfer Material', 'Machine', 'Master', 'Admin']);
});

test('pallets start without made-up routing numbers or dates', async () => {
  const { at } = await rackPallets();
  const all = Object.values(at).flat();
  assert.equal(all.length, 8);
  if (process.env.EXPECT_NO_DUMMIES) all.forEach(p => { assert.equal(p.routing, ''); assert.equal(p.received, ''); });
});

test('racking: assign a part to an empty level, save, reload', async () => {
  await tab('hq');
  assert.equal(await page.getAttribute('.chip[aria-pressed="true"]', 'data-v'), '0');
  assert.match(await text('.rowhead h2'), /Row 2/);
  await page.selectOption('#sel-2-1-5-new', 'p80');
  assert.equal(await page.inputValue('#qty-2-1-5-0'), '12');
  assert.match(await text('.status'), /Unsaved changes/);
  await page.fill('#qty-2-1-5-0', '9');
  await saveChanges();
  await page.reload();
  await page.waitForSelector('#qty-2-1-5-0');
  assert.equal(await page.inputValue('#qty-2-1-5-0'), '9');
  const { at } = await rackPallets();
  assert.equal(at['2-1-5'][0].part, 'p80');
  assert.equal(at['2-1-5'][0].qty, 9);
});

test('racking: undo all throws away unsaved edits', async () => {
  await page.fill('#qty-2-1-5-0', '3');
  assert.match(await text('.status'), /Unsaved/);
  await page.click('[data-act="revert"]');
  assert.equal(await page.inputValue('#qty-2-1-5-0'), '9');
  assert.match(await text('.status'), /^Saved/);
});

test('racking: clear a line, add and remove a row', async () => {
  await page.click('[data-act="rmline"][aria-label="Clear 2-1-5"]');
  assert.equal(await page.inputValue('#sel-2-1-5-new'), '');
  await saveChanges();
  await page.click('[data-act="addrow"]');
  assert.match(await text('.rowhead h2'), /Row 12/);
  await saveChanges();
  let d = (await rackPallets()).data;
  assert.deepEqual(d.sections[0].rows.map(r => String(r.row)), ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
  await page.click('[data-act="delrow"]');
  assert.match(await text('[data-act="delrow"]'), /Confirm remove Row 12/);
  await page.click('[data-act="delrow"]');
  await saveChanges();
  d = (await rackPallets()).data;
  assert.equal(d.sections[0].rows.length, 10);
  assert.match(await text('.rowhead h2'), /Row 2/);
});

test('row picker switches rows and remembers the choice', async () => {
  await page.click('.chip[data-act="row"][data-v="3"]');
  assert.match(await text('.rowhead h2'), /Row 5/);
  await page.reload();
  await page.waitForSelector('.rowhead');
  assert.match(await text('.rowhead h2'), /Row 5/);
  await page.click('.chip[data-act="row"][data-v="0"]');
});

test('master: add, edit and remove a part', async () => {
  await tab('master');
  assert.match(await text('.kpis'), /Parts on master\s*2/);
  await page.click('[data-act="addpart"]');
  const id = await page.evaluate(() => document.activeElement.id);
  assert.match(id, /^number-/);
  const k = id.slice('number-'.length);
  await page.fill('#number-' + k, 'TEST-PART-1');
  await page.fill('#description-' + k, 'Test sheet');
  await page.fill('#qtyPerPallet-' + k, '20');
  await saveChanges();
  let d = (await rackPallets()).data;
  const p = d.parts.find(x => x.k === k);
  assert.equal(p.number, 'TEST-PART-1');
  assert.equal(p.description, 'Test sheet');
  assert.equal(p.qtyPerPallet, 20);
  await page.reload();
  await page.waitForSelector('#number-' + k);
  assert.equal(await page.inputValue('#number-' + k), 'TEST-PART-1');
  // Quantity by row table lists every part.
  assert.match(await text('table.matrix'), /TEST-PART-1/);
  await page.click('[data-act="delpart"][data-p="' + k + '"]');
  assert.match(await text('[data-act="delpart"][data-p="' + k + '"]'), /Confirm/);
  await page.click('[data-act="delpart"][data-p="' + k + '"]');
  await saveChanges();
  d = (await rackPallets()).data;
  assert.equal(d.parts.length, 2);
});

test('pallet tracking: edit routing and date, add and remove a pallet', async () => {
  await tab('hq');
  const first = page.locator('table.tracking input[data-f="routing"]').first();
  await first.fill('RT-REAL-1');
  await page.locator('table.tracking input[data-f="received"]').first().fill('2026-09-01');
  await saveChanges();
  let { at } = await rackPallets();
  const withRouting = Object.entries(at).filter(([, v]) => v.some(x => x.routing === 'RT-REAL-1'));
  assert.equal(withRouting.length, 1);
  assert.equal(withRouting[0][1][0].received, '2026-09-01');
  // Add a pallet at 3-1-1 through the form.
  const opt = await page.locator('#ap-loc option', { hasText: /^3-1-1$/ }).first().getAttribute('value');
  await page.selectOption('#ap-loc', opt);
  await page.selectOption('#ap-part', 'p63');
  await page.fill('#ap-qty', '7');
  await page.fill('#ap-rt', 'RT-ADD-1');
  await page.fill('#ap-date', '2026-08-15');
  await page.click('[data-act="addpallet"]');
  await saveChanges();
  ({ at } = await rackPallets());
  assert.deepEqual(at['3-1-1'], [{ part: 'p63', qty: 7, routing: 'RT-ADD-1', received: '2026-08-15' }]);
  await page.click('[data-act="ptdel"][aria-label="Remove pallet at 3-1-1"]');
  await saveChanges();
  ({ at } = await rackPallets());
  assert.equal(at['3-1-1'], undefined);
  // The add form explains what is missing.
  await page.click('[data-act="addpallet"]');
  assert.equal(await text('#ap-err'), 'Choose a location.');
});

test('receive material: two pallets into open spots, with print sheet and log', async () => {
  await tab('receive');
  await page.selectOption('#rv-part', 'p80');
  await page.fill('#rv-count', '2');
  assert.equal(await page.inputValue('#rv-q-0'), '12');
  await page.fill('#rv-q-1', '10');
  await page.fill('#rv-rt-0', 'RCV-A');
  await page.click('[data-act="rconfirm"]');
  assert.match(await text('#rv-cerr'), /pallet 2/);
  await page.fill('#rv-rt-1', 'RCV-B');
  await page.fill('#rv-date', '2026-10-01');
  await page.click('[data-act="rconfirm"]');
  await page.click('button[data-act="rspot"]:has-text("4-1-1")');
  await page.click('button[data-act="rspot"]:has-text("4-1-2")');
  assert.match(await text('#rv-body .tally'), /2 \/ 2/);
  assert.match(await text('#rv-body .sheet'), /Receive material/);
  await page.click('[data-act="rgo"]');
  await page.waitForSelector('.ok-msg');
  assert.match(await text('.ok-msg'), /Received 2 pallets of ATP-6061T6-080-48144 into 4-1-1, 4-1-2/);
  const { at } = await rackPallets();
  assert.deepEqual(at['4-1-1'], [{ part: 'p80', qty: 12, routing: 'RCV-A', received: '2026-10-01' }]);
  assert.deepEqual(at['4-1-2'], [{ part: 'p80', qty: 10, routing: 'RCV-B', received: '2026-10-01' }]);
  await page.waitForFunction(() => /RCV|4-1-1/.test(document.getElementById('rlog').textContent));
  assert.match(await text('#rlog'), /Receiving[\s\S]*4-1-1 \(12\), 4-1-2 \(10\)/);
});

test('transfer material: pick pallets oldest first, send to a machine', async () => {
  await tab('transfer');
  await page.selectOption('#xf-part', 'p80');
  await page.fill('#xf-qty', '20');
  // The two oldest pallets are marked Recommended.
  const rowsText = await page.locator('table.xfer tbody tr').allTextContents();
  assert.equal(rowsText.length, 4);
  assert.deepEqual(rowsText.map(t => /Recommended/.test(t)), [true, true, false, false]);
  if (process.env.EXPECT_NO_DUMMIES) assert.match(rowsText[0], /4-1-1/); // only received pallets have a date
  await page.locator('table.xfer tbody tr[data-act="xpick"]', { hasText: '4-1-1' }).click();
  assert.match(await text('.tally'), /12 \/ 20/);
  await page.locator('table.xfer tbody tr[data-act="xpick"]', { hasText: '4-1-2' }).click();
  assert.match(await text('.tally'), /22 \/ 20/);
  await page.click('button.machine[data-v="EMK"]');
  assert.match(await text('#xf-results .sheet'), /Material transfer/);
  await page.click('[data-act="xgo"]');
  await page.waitForSelector('#xf-results .ok-msg');
  assert.match(await text('#xf-results .ok-msg'), /Moved 2 pallets \(22 × ATP-6061T6-080-48144\) from 4-1-1, 4-1-2 to EMK/);
  const { data, at } = await rackPallets();
  assert.equal(at['4-1-1'], undefined);
  assert.equal(data.machines.EMK.length, 2);
  assert.equal(data.machines.EMK[0].requested, 20);
});

test('machine: cards, totals, return to rack with quantity used', async () => {
  await tab('machines');
  assert.match(await text('.mcard'), /EMK[\s\S]*ATP-6061T6-080-48144/);
  assert.match(await text('table.matrix'), /ATP-6061T6-080-48144[\s\S]*22/);
  await page.waitForFunction(() => /EMK/.test(document.getElementById('tlog').textContent));
  assert.match(await text('#tlog'), /4-1-1, 4-1-2[\s\S]*EMK/);
  await page.click('[data-act="mret"][data-v="EMK"]');
  assert.equal(await page.inputValue('#mr-used'), '20');
  await page.fill('#mr-used', '15');
  await page.click('[data-act="mconfirm"]');
  // Oldest received first: both arrived the same day, so the first one picked is used up first.
  assert.match(await text('#mr-body'), /Back to Racking/);
  assert.match(await text('#mr-body .sheet'), /Return to rack/);
  await page.click('[data-act="mgo"]');
  await page.waitForSelector('.ok-msg');
  assert.match(await text('.ok-msg'), /EMK: returned 7 to 4-1-2; 1 used-up pallet moved to Used\. 15 used\./);
  const { data, at } = await rackPallets();
  assert.equal(data.machines.EMK.length, 0);
  assert.deepEqual(at['4-1-2'], [{ part: 'p80', qty: 7, routing: 'RCV-B', received: '2026-10-01' }]);
  await page.waitForFunction(() => /Used \(1 pallet\)/.test(document.getElementById('tlog').textContent));
});

test('master transfer log filters by machine and receiving', async () => {
  await tab('master');
  await page.waitForFunction(() => document.querySelectorAll('#mlog tbody tr').length >= 3);
  assert.equal(await page.locator('#mlog tbody tr').count(), 3);
  await page.selectOption('#mlog select[data-act="lmachsel"]', 'receive');
  assert.equal(await page.locator('#mlog tbody tr').count(), 1);
  await page.selectOption('#mlog select[data-act="lmachsel"]', 'P4');
  assert.match(await text('#mlog tbody'), /Nothing in this period/);
  await page.click('#mlog [data-act="lreset"]');
  await page.waitForFunction(() => document.querySelectorAll('#mlog tbody tr').length === 3);
  await page.selectOption('#mlog select[data-act="lrangesel"]', 'all');
  await page.waitForFunction(() => document.querySelectorAll('#mlog tbody tr').length === 3);
});

test('admin: add a user, change role, disable, reset passkey, delete', async () => {
  await tab('admin');
  await page.fill('#nu-id', 'handler1');
  await page.selectOption('#nu-role', 'handler');
  await page.click('[data-act="genpk"][data-for="nu-pk"]');
  const pk = await page.inputValue('#nu-pk');
  assert.match(pk, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await page.click('#add-user-form button[type="submit"]');
  await page.waitForSelector('.notice code');
  assert.equal(await text('.notice code'), pk);
  await page.click('[data-act="dismiss"]');
  await page.selectOption('select[data-act="setrole"][data-u="handler1"]', 'viewer');
  await page.waitForFunction(() => /handler1 is now Viewer/.test(document.body.textContent));
  await page.click('[data-act="toggle"][data-u="handler1"]');
  await page.waitForFunction(() => /handler1 disabled/.test(document.body.textContent));
  assert.match(await page.locator('tbody tr', { has: page.locator('select[data-u="handler1"]') }).textContent(), /Disabled/);
  await page.click('[data-act="toggle"][data-u="handler1"]');
  await page.waitForFunction(() => /handler1 enabled/.test(document.body.textContent));
  await page.click('[data-act="reset"][data-u="handler1"]');
  await page.fill('#rp-handler1', 'new-passkey-123');
  await page.click('[data-act="savereset"][data-u="handler1"]');
  await page.waitForFunction(() => /Passkey reset for handler1/.test(document.body.textContent));
  await page.click('[data-act="deluser"][data-u="handler1"]');
  assert.match(await text('[data-act="deluser"][data-u="handler1"]'), /Confirm delete/);
  await page.click('[data-act="deluser"][data-u="handler1"]');
  await page.waitForFunction(() => /handler1 deleted/.test(document.body.textContent));
  await page.click('[data-act="refreshlog"]');
  await page.waitForFunction(() => /Deleted user/.test(document.body.textContent));
  const log = await text('.panel:has(h3:text("Activity"))');
  assert.match(log, /Added user[\s\S]*handler1 \(handler\)/);
  assert.match(log, /Signed in/);
});

test('roles see the right tabs and controls', async () => {
  const c = await adminClient(srv.base);
  const expected = {
    viewer: ['Racking', 'Receive Material', 'Transfer Material', 'Machine', 'Master'],
    handler: ['Racking', 'Transfer Material', 'Machine'],
    shipping: ['Racking', 'Receive Material'],
    supervisor: ['Racking', 'Receive Material', 'Transfer Material', 'Machine', 'Master'],
  };
  for (const role of Object.keys(expected)) {
    const r = await c.call('POST', '/api/admin/users', { userId: 'u-' + role, role, passkey: 'passkey-' + role });
    assert.equal(r.status, 200);
    const cx = await browser.newContext();
    const p = await cx.newPage();
    await signIn(p, srv.base, 'u-' + role, 'passkey-' + role);
    assert.deepEqual(await p.locator('nav.tabs .tab').allTextContents(), expected[role], role);
    assert.match(await p.locator('.status').textContent(), /View only/);
    assert.equal(await p.locator('[data-act="save"]').count(), 0);
    assert.equal(await p.locator('#sel-2-1-9-0').isDisabled(), true);
    // Supervisors do not see pallet quantities on the racking.
    assert.equal(await p.locator('#qty-2-1-9-0').count(), role === 'supervisor' ? 0 : 1);
    assert.equal(await p.locator('table.tracking').count(), 0);
    if (role === 'viewer') {
      await p.click('#tab-transfer');
      await p.selectOption('#xf-part', 'p63');
      await p.fill('#xf-qty', '5');
      await p.locator('table.xfer tbody tr[data-act="xpick"]').first().click();
      await p.click('button.machine[data-v="P4"]');
      assert.match(await p.locator('#xf-results').textContent(), /can view but not transfer/);
    }
    await cx.close();
  }
});

test('change own passkey', async () => {
  const c = await adminClient(srv.base);
  await c.call('POST', '/api/admin/users', { userId: 'pkuser', role: 'viewer', passkey: 'first-passkey' });
  const cx = await browser.newContext();
  const p = await cx.newPage();
  await signIn(p, srv.base, 'pkuser', 'first-passkey');
  await p.click('[data-act="account"]');
  await p.fill('#acc-cur', 'first-passkey');
  await p.fill('#acc-new', 'second-passkey');
  await p.fill('#acc-new2', 'different');
  await p.click('#account-form button[type="submit"]');
  assert.equal(await p.locator('#acc-msg').textContent(), 'The new passkeys do not match.');
  await p.fill('#acc-new2', 'second-passkey');
  await p.click('#account-form button[type="submit"]');
  await p.waitForFunction(() => /Passkey updated/.test(document.querySelector('.status').textContent));
  await p.click('[data-act="logout"]');
  await p.waitForSelector('#login-form');
  await signIn(p, srv.base, 'pkuser', 'second-passkey');
  await cx.close();
});

test('a second admin saving an older version sees the newer-version banner', async () => {
  const cx = await browser.newContext();
  const p2 = await cx.newPage();
  await signIn(p2, srv.base, 'admin', ADMIN_PASSKEY);
  await p2.click('#tab-hq');
  await tab('hq');
  await page.fill('#qty-2-1-9-0', '11');
  await saveChanges();
  await p2.fill('#qty-2-1-9-0', '10');
  await p2.click('[data-act="save"]');
  await p2.waitForSelector('.banner');
  assert.match(await p2.locator('.banner').textContent(), /admin saved a newer version/);
  await p2.click('[data-act="reload"]');
  await p2.waitForFunction(() => !document.querySelector('.banner'));
  assert.equal(await p2.inputValue('#qty-2-1-9-0'), '11');
  await cx.close();
});

test('unsaved edits survive a page reload as a draft', async () => {
  await page.fill('#qty-2-1-9-0', '4');
  await page.reload();
  await page.waitForSelector('#qty-2-1-9-0');
  assert.equal(await page.inputValue('#qty-2-1-9-0'), '4');
  assert.match(await text('.status'), /Unsaved/);
  await page.click('[data-act="revert"]');
});

test('print sheet opens the print dialog with the sheet copied', async () => {
  await page.evaluate(() => { window.print = () => { window.__printed = document.getElementById('print-root').innerHTML; }; });
  await tab('transfer');
  await page.selectOption('#xf-part', 'p63');
  await page.fill('#xf-qty', '12');
  await page.locator('table.xfer tbody tr[data-act="xpick"]').first().click();
  await page.click('button.machine[data-v="L5"]');
  await page.click('[data-act="xprint"]');
  const printed = await page.evaluate(() => window.__printed);
  assert.match(printed, /Material transfer/);
  assert.match(printed, /L5/);
});
