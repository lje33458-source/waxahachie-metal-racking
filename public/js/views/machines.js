// Machine tab: a card per machine with the pallets there, Return to Rack, totals by part, and the Machine Transfer Log.
import { app, MACHINES } from '../state.js';
import { esc, num, fmt, plural, byId, markStep } from '../util.js';
import { can, part, partName, atMachine, machineTotal, fromLoc, returnPlan } from '../model.js';
import { api } from '../api.js';
import { render } from '../render.js';
import { reloadLatest, useServerData } from '../saving.js';
import { on } from '../events.js';
import { logPanel, loadLog } from './logs.js';
import { sheet, printPanel } from './sheet.js';

// ret: the machine whose return panel is open; used: the quantity used there, as typed.
let mach = { ret: null, used: '', confirmed: false, busy: false, msg: '', err: '' };

// Default quantity used: what was requested for each transfer still at the machine, capped at what is there.
function requestedAt(m) {
  const seen = {};
  let req = 0;
  atMachine(m).forEach(x => { if (x.batch && !seen[x.batch]) { seen[x.batch] = 1; req += num(x.requested); } });
  return Math.min(req, machineTotal(m));
}

export function machinesView() {
  let h = '<div class="stack"><div class="mcards">' + MACHINES.map(card).join('') + '</div>';
  if (mach.msg) h += '<p class="ok-msg" role="status">' + esc(mach.msg) + '</p>';
  if (mach.ret && atMachine(mach.ret).length) h += '<div id="mr-results" class="stack">' + returnPanel() + '</div>';
  h += totalsTable();
  h += logPanel('tlog');
  return h + '</div>';
}

function card(m) {
  const list = atMachine(m), open = mach.ret === m;
  let h = '<div class="mcard' + (open ? ' on' : '') + '"><div class="mcard-h"><h3>' + m + '</h3>' +
    (list.length && can('return') ? '<button class="btn' + (open ? ' primary' : '') + '" data-act="mret" data-v="' + m + '">' + (open ? 'Close return' : 'Return to Rack') + '</button>' : '') +
    '</div><div class="mpals">';
  if (!list.length) h += '<p class="dim">No material at this machine.</p>';
  list.forEach(x => {
    const p = part(x.part), f = fromLoc(x);
    // The stack of sheets is drawn in proportion to a full pallet (Qty / Pallet), so a part-used pallet looks lower.
    const full = p && num(p.qtyPerPallet) > 0 ? num(p.qtyPerPallet) : num(x.qty);
    const height = Math.round(6 + 54 * Math.min(1, full ? num(x.qty) / full : 1));
    h += '<div class="mpal" title="Pallet from ' + esc(f.loc) + '"><div class="info"><b class="pn">' + esc(p ? partName(p) : 'Removed part') + '</b><span class="tagl inline">' + esc(f.loc) + '</span>' +
      '<span class="q num">' + fmt(num(x.qty)) + ' <small>/ ' + (x.requested ? fmt(num(x.requested)) : '–') + '</small></span><small class="lbl">pallet qty / requested</small></div>' +
      '<div class="stackwrap" aria-hidden="true"><div class="load" style="height:' + height + 'px"></div></div><div class="deck" aria-hidden="true"><i></i><i></i><i></i></div></div>';
  });
  return h + '</div></div>';
}

// Material at Machine: quantity of each part at each machine.
function totalsTable() {
  const tot = {};
  MACHINES.forEach(m => { tot[m] = 0; });
  let any = false, grand = 0, rowsHtml = '';
  app.data.parts.forEach(p => {
    const v = {};
    let row = 0;
    MACHINES.forEach(m => { v[m] = atMachine(m).reduce((t, x) => t + (x.part === p.k ? num(x.qty) : 0), 0); row += v[m]; tot[m] += v[m]; });
    if (!row) return;
    any = true;
    grand += row;
    rowsHtml += '<tr><td>' + esc(partName(p)) + '</td>' + MACHINES.map(m => '<td class="r num' + (v[m] ? '' : ' zero') + '">' + (v[m] ? fmt(v[m]) : '–') + '</td>').join('') + '<td class="r num"><b>' + fmt(row) + '</b></td></tr>';
  });
  return '<div class="panel"><div class="panel-h"><h3>Material at Machine</h3></div><div class="scroll"><table class="matrix"><thead><tr><th>Part Number</th>' +
    MACHINES.map(m => '<th class="r">' + m + '</th>').join('') + '<th class="r">Total</th></tr></thead><tbody>' +
    (any ? rowsHtml : '<tr><td colspan="' + (MACHINES.length + 2) + '" class="empty-note">No material is at a machine.</td></tr>') + '</tbody>' +
    (any ? '<tfoot><tr><td>All material</td>' + MACHINES.map(m => '<td class="r num">' + fmt(tot[m]) + '</td>').join('') + '<td class="r num">' + fmt(grand) + '</td></tr></tfoot>' : '') +
    '</table></div></div>';
}

/* ---------- return to rack ---------- */
function returnPanel() {
  const m = mach.ret, total = machineTotal(m);
  let h = '<div class="panel"><div class="panel-h"><h3>Return to rack · ' + m + '</h3><p>Enter how much was used at ' + m + '. That comes off the oldest pallets first, and what is left on each pallet goes back to the spot it came from.</p></div>';
  h += '<div id="mr-step" class="formrow' + (mach.confirmed ? '' : ' confirm-step') + '"><div class="field"><label for="mr-used">Quantity used</label><input id="mr-used" class="num" type="number" inputmode="numeric" min="0" max="' + total + '" step="1" data-act="mused" value="' + esc(mach.used) + '"></div>' +
    '<p class="dim" style="margin:0 0 10px">' + fmt(total) + ' sheets at ' + m + '</p>' +
    '<button class="btn primary" data-act="mconfirm">Confirm</button></div><p class="err" id="mr-cerr" role="alert" style="padding:0 14px 12px"></p></div>';
  return h + '<div id="mr-body" class="stack">' + returnBody() + '</div>';
}

// The plan, the button and the print sheet. Nothing moves until the quantity used is confirmed;
// editing it asks for Confirm again.
function returnBody() {
  const m = mach.ret, list = atMachine(m), total = machineTotal(m);
  const used = mach.used === '' ? NaN : Number(mach.used), plan = returnPlan(list, used);
  if (!mach.confirmed || !plan) return '<p class="empty-note">Enter the quantity used at ' + esc(m) + ' and press Confirm.</p>';
  let back = 0;
  const usedUp = plan.filter(x => !x.back).length;
  let h = '<div class="panel"><div class="panel-h"><h3>Back to Racking</h3></div><div class="scroll"><table><thead><tr><th>Pallet from</th><th>Part Number</th><th>Routing #</th><th class="r">At machine</th><th class="r">Used</th><th class="r">Quantity to Return</th></tr></thead><tbody>';
  plan.forEach(x => {
    const p = part(x.p.part), f = fromLoc(x.p);
    back += x.back;
    h += '<tr><td><span class="tagl inline">' + esc(f.loc) + '</span></td><td>' + esc(p ? partName(p) : 'Removed part') + '</td><td class="num">' + esc(x.p.routing) + '</td>' +
      '<td class="r num">' + fmt(num(x.p.qty)) + '</td><td class="r num">' + fmt(x.used) + '</td><td class="r num"><b>' + (x.back ? fmt(x.back) : '<span class="trash">Used</span>') + '</b></td></tr>';
  });
  h += '</tbody><tfoot><tr><td colspan="3">Total</td><td class="r num">' + fmt(total) + '</td><td class="r num">' + fmt(used) + '</td><td class="r num">' + fmt(back) + '</td></tr></tfoot></table></div>';
  if (mach.err) h += '<p class="err" role="alert" style="padding:10px 14px 0">' + esc(mach.err) + '</p>';
  h += '<div class="tablefoot' + (can('return') && !app.dirty ? ' confirm-step' : '') + '">';
  if (app.dirty) h += '<p class="err">Save or undo your racking changes before returning material.</p>';
  else {
    const label = back
      ? 'Return to rack' + (usedUp ? ' and move ' + usedUp + ' ' + plural(usedUp, 'pallet') + ' to Used' : '')
      : 'Move ' + (usedUp > 1 ? usedUp + ' pallets' : 'pallet') + ' to Used';
    h += '<button class="btn primary" data-act="mgo"' + (mach.busy ? ' disabled' : '') + '>' + (mach.busy ? 'Working…' : label) + '</button> <button class="btn ghost" data-act="mret" data-v="' + m + '">Cancel</button>';
  }
  h += '</div></div>';
  const items = plan.filter(x => x.back).map(x => {
    const p = part(x.p.part), f = fromLoc(x.p);
    return { section: f.section, row: f.row, addr: f.addr, loc: f.loc, pn: p ? partName(p) : '', qty: x.back, routing: x.p.routing, received: x.p.received };
  });
  h += printPanel('Return sheet: put each pallet back in the spot marked. It fits on one 8.5 × 11 in page.', sheet({
    title: back ? 'Return to rack' : 'Pallets used', dir: 'From', machine: m,
    sub: 'Used at ' + esc(m) + ': <b>' + fmt(used) + '</b> of ' + fmt(total) + ' sheets. ' + (back ? 'Return each pallet below to the spot it came from.' : '') +
      (usedUp ? ' <b>' + usedUp + ' used-up ' + plural(usedUp, 'pallet') + ' go' + (usedUp > 1 ? '' : 'es') + ' to Used.</b>' : ''),
    items, foot: items.length + ' ' + plural(items.length, 'pallet') + ' back to the racking', footQty: back,
  }));
  return h;
}

function refreshReturn() {
  const el = byId('mr-body');
  if (el) el.innerHTML = returnBody();
}

function doReturn() {
  const m = mach.ret, list = atMachine(m), used = Number(mach.used), plan = returnPlan(list, used);
  if (!m || !plan || !mach.confirmed || mach.busy || app.dirty || !can('return') || mach.used === '') return;
  mach.busy = true; mach.err = '';
  refreshReturn();
  api('POST', '/api/return', { machine: m, used, ids: list.map(x => x.id) })
    .then(d => {
      useServerData(d);
      const back = plan.filter(x => x.back), usedUp = plan.length - back.length;
      mach = {
        ret: null, used: '', busy: false, err: '',
        msg: m + ': ' + (back.length ? 'returned ' + back.map(x => fmt(x.back) + ' to ' + fromLoc(x.p).loc).join(', ') : 'nothing returned to the racking') +
          (usedUp ? '; ' + usedUp + ' used-up ' + plural(usedUp, 'pallet') + ' moved to Used' : '') + '. ' + fmt(used) + ' used.',
      };
      render();
      loadLog();
    })
    .catch(x => { mach.busy = false; if (x.silent) return; mach.err = x.message; reloadLatest(); });
}

/* ---------- actions ---------- */
// Opens (or closes) a machine's return panel, with the quantity used filled in from what was requested.
on('click', 'mret', t => {
  if (mach.ret === t.dataset.v) mach.ret = null;
  else { mach.ret = t.dataset.v; mach.used = String(requestedAt(mach.ret)); }
  mach.confirmed = false; mach.err = ''; mach.msg = '';
  render();
});
on('input', 'mused', t => {
  mach.used = t.value;
  mach.err = '';
  if (mach.confirmed) { mach.confirmed = false; markStep('mr-step', true); refreshReturn(); }
  const e = byId('mr-cerr');
  if (e) e.textContent = '';
});
on('click', 'mconfirm', () => {
  const total = machineTotal(mach.ret), used = Number(mach.used), e = byId('mr-cerr');
  if (mach.used === '' || !isFinite(used) || used < 0 || used > total) {
    mach.confirmed = false;
    if (e) e.textContent = 'Enter a quantity used from 0 to ' + fmt(total) + '.';
    refreshReturn();
    return;
  }
  if (e) e.textContent = '';
  mach.confirmed = true;
  markStep('mr-step', false);
  refreshReturn();
});
on('click', 'mgo', () => doReturn());
