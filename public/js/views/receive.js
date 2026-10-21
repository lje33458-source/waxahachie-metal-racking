// Receive Material tab: pick the part, how many pallets came in, the quantity and routing # on each, confirm,
// then click an open spot on the racking map for each pallet. Prints a put-away sheet; the Receiving Log is below.
import { app } from '../state.js';
import { esc, fmt, day, today, plural, byId, markStep } from '../util.js';
import { can, part, partName, locLabel, levelNumbers } from '../model.js';
import { api } from '../api.js';
import { render } from '../render.js';
import { reloadLatest, useServerData } from '../saving.js';
import { on } from '../events.js';
import { logPanel, loadLog } from './logs.js';
import { sheet, printPanel } from './sheet.js';

const MAX_RECEIVE = 50;

// spots: keys of the open spots chosen, in order (one per pallet).
let recv = blank();
function blank() { return { part: '', count: '', qtys: [], routings: [], date: today(), spots: [], confirmed: false, busy: false, msg: '', err: '' }; }
// Start each sign-in with an empty form (today's date may have changed).
export function resetReceive() { recv = blank(); }

function count() {
  const n = Number(recv.count);
  return recv.count !== '' && Number.isInteger(n) && n > 0 && n <= MAX_RECEIVE ? n : 0;
}
function qtyOf(i) {
  const v = recv.qtys[i], n = Number(v);
  return v !== '' && v != null && isFinite(n) && n > 0 ? n : 0;
}
// Every pallet needs a quantity and a routing # before spots are offered.
function missing() {
  const bad = [];
  for (let i = 0; i < count(); i++) if (!qtyOf(i) || !String(recv.routings[i] || '').trim()) bad.push(i + 1);
  return bad;
}
function ready() { return count() > 0 && !missing().length; }

function spotKey(s, r, rk, lv) { return s.key + '|' + r.row + '|' + rk.rack + '|' + lv.level; }

// The chosen spots that are still open, in the order chosen.
function chosenSpots() {
  const open = {};
  app.data.sections.forEach(s => s.rows.forEach(r => r.racks.forEach(rk => rk.levels.forEach(lv => {
    if (lv.items.length) return;
    const addr = r.row + '-' + rk.rack + '-' + lv.level;
    open[spotKey(s, r, rk, lv)] = { section: s.key, row: r.row, rack: rk.rack, level: lv.level, addr, loc: locLabel(s.key, addr) };
  }))));
  recv.spots = recv.spots.filter(k => open[k]).slice(0, count());
  return recv.spots.map(k => open[k]);
}

export function receiveView() {
  let h = '<div class="stack"><div class="panel"><div class="panel-h"><h3>Receive Material</h3><p>Pick the material, how many pallets came in and the quantity on each, then an open spot on the racking for each pallet.</p></div>';
  h += '<div class="formrow"><div class="field grow"><label for="rv-part">Material type</label><select id="rv-part" data-act="rpart"><option value="">Select part number</option>';
  app.data.parts.forEach(p => { h += '<option value="' + esc(p.k) + '"' + (recv.part === p.k ? ' selected' : '') + '>' + esc(partName(p)) + '</option>'; });
  h += '</select></div>' +
    '<div class="field"><label for="rv-count">Pallets received</label><input id="rv-count" class="num" type="number" inputmode="numeric" min="1" max="' + MAX_RECEIVE + '" step="1" data-act="rcount" value="' + esc(recv.count) + '"></div>' +
    '<div class="field"><label for="rv-date">Date received</label><input id="rv-date" type="date" data-act="rdate" value="' + esc(recv.date) + '"></div></div>';
  if (recv.msg) h += '<p class="ok-msg" role="status" style="padding:0 14px 12px">' + esc(recv.msg) + '</p>';
  h += '<div id="rv-qtys">' + palletForm() + '</div></div><div id="rv-body" class="stack">' + body() + '</div>' + logPanel('rlog') + '</div>';
  return h;
}

// A row per pallet: quantity (defaults to the part's Qty / Pallet) and routing #.
function palletForm() {
  const n = count(), p = part(recv.part);
  if (!p || !n) return '';
  let h = '<div id="rv-step" class="' + (recv.confirmed ? '' : 'confirm-step') + '"><div class="scroll"><table class="rvq"><thead><tr><th>Pallet</th><th class="r" style="width:140px">Quantity on pallet</th><th style="width:200px">Routing #</th></tr></thead><tbody>';
  for (let i = 0; i < n; i++) {
    if (recv.qtys[i] == null) recv.qtys[i] = p.qtyPerPallet !== '' && p.qtyPerPallet != null ? String(p.qtyPerPallet) : '';
    h += '<tr><td>Pallet ' + (i + 1) + '</td>' +
      '<td><input id="rv-q-' + i + '" class="num" type="number" inputmode="numeric" min="1" step="1" data-act="rqty" data-i="' + i + '" value="' + esc(recv.qtys[i]) + '" aria-label="Quantity on pallet ' + (i + 1) + '"></td>' +
      '<td><input id="rv-rt-' + i + '" data-act="rrt" data-i="' + i + '" value="' + esc(recv.routings[i] || '') + '" aria-label="Routing number for pallet ' + (i + 1) + '" required></td></tr>';
  }
  return h + '</tbody></table></div><div class="confirmrow"><p class="err" id="rv-cerr" role="alert"></p><button class="btn primary" data-act="rconfirm">Confirm</button></div></div>';
}

// Under the form: the open-spot maps, then once every pallet has a spot, the receive button and put-away sheet.
function body() {
  const n = count(), p = part(recv.part);
  if (!p) return '<p class="empty-note">Select a material type to start.</p>';
  if (!n) return '<p class="empty-note">Enter how many pallets were received (up to ' + MAX_RECEIVE + ').</p>';
  if (!recv.confirmed) return '<p class="empty-note">Enter the quantity and routing # for each pallet, then press Confirm to see open spots on the racking.</p>';
  if (!ready()) return '<p class="err">Every pallet needs a quantity and a routing #. Fill them in to see open spots.</p>';
  const S = chosenSpots();
  let h = '<div class="tally' + (S.length === n ? ' ok' : '') + '"><span class="label">Open spots chosen</span><b class="num">' + S.length + ' / ' + n + '</b><span class="dim">' +
    (S.length === n ? 'Every pallet has a spot.' : 'Click an open spot for pallet ' + (S.length + 1) + '.') + '</span></div>';
  h += spotMaps(S, n);
  if (recv.err) h += '<p class="err" role="alert">' + esc(recv.err) + '</p>';
  if (S.length < n) return h;
  let total = 0;
  const items = S.map((x, i) => { total += qtyOf(i); return { section: x.section, row: x.row, addr: x.addr, loc: x.loc, pn: partName(p), qty: qtyOf(i), routing: recv.routings[i] || '', received: recv.date }; });
  h += '<div class="panel"><div class="panel-h"><h3>Put away</h3><p>' + n + ' ' + plural(n, 'pallet') + ' · ' + fmt(total) + ' × ' + esc(partName(p)) + '</p></div><div class="tablefoot' + (can('receive') && !app.dirty ? ' confirm-step' : '') + '">';
  if (!can('receive')) h += '<p class="dim">Your account can view but not receive material.</p>';
  else if (app.dirty) h += '<p class="err">Save or undo your racking changes before receiving material.</p>';
  else h += '<button class="btn primary" data-act="rgo"' + (recv.busy ? ' disabled' : '') + '>' + (recv.busy ? 'Receiving…' : 'Receive ' + n + ' ' + plural(n, 'pallet') + ' onto the racking') + '</button>';
  h += '</div></div>';
  h += printPanel('Put-away sheet: take each pallet to the spot marked. It fits on one 8.5 × 11 in page.', sheet({
    title: 'Receive material', dir: 'To', machine: 'Racking', noMachine: true,
    sub: '<b>' + esc(partName(p)) + '</b>' + (p.description ? ' · ' + esc(p.description) : '') + ' · received ' + esc(day(recv.date)),
    items, foot: n + ' ' + plural(n, 'pallet') + ' received', footQty: total,
  }));
  return h;
}

// A map of every row: open spots are buttons, numbered once chosen; filled spots are grey.
function spotMaps(S, n) {
  const chosen = {};
  S.forEach((x, i) => { chosen[x.section + '|' + x.row + '|' + x.rack + '|' + x.level] = i + 1; });
  const multi = app.data.sections.length > 1;
  let anyOpen = false;
  let h = '<div class="panel"><div class="panel-h"><h3>Open spots on the racking</h3><p>Open spots are white. Click one for each pallet, in order; click it again to clear it.</p></div><div class="spotmaps">';
  app.data.sections.forEach(s => s.rows.forEach(r => {
    h += '<div class="spotmap"><div class="sheet-row-h">' + (multi ? esc(s.name) + ' · ' : '') + 'Row ' + esc(r.row) + '</div><table><thead><tr><th></th>' +
      r.racks.map(rk => '<th>Rack ' + esc(rk.rack) + '</th>').join('') + '</tr></thead><tbody>';
    levelNumbers(r).forEach(L => {
      h += '<tr><th>L' + L + '</th>';
      r.racks.forEach(rk => {
        const lv = rk.levels.find(x => x.level === L);
        if (!lv) { h += '<td class="none"></td>'; return; }
        const addr = r.row + '-' + rk.rack + '-' + L, i = chosen[s.key + '|' + r.row + '|' + rk.rack + '|' + L];
        if (lv.items.length) {
          const q = part(lv.items[0].part);
          h += '<td class="full" title="' + esc(q ? partName(q) : '') + '">' + esc(addr) + '</td>';
          return;
        }
        anyOpen = true;
        const pickable = i || S.length < n;
        h += '<td class="open' + (i ? ' hit' : '') + '"><button data-act="rspot" data-v="' + esc(spotKey(s, r, rk, lv)) + '"' + (pickable ? '' : ' disabled') + ' aria-pressed="' + !!i + '">' +
          (i ? '<b>' + i + '</b> ' : '') + esc(addr) + '</button></td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
  }));
  return h + '</div>' + (anyOpen ? '' : '<p class="empty-note">There are no open spots on the racking.</p>') + '</div>';
}

// Redraws the parts under the form; withForm also redraws the per-pallet rows.
function refresh(withForm) {
  if (withForm) { const q = byId('rv-qtys'); if (q) q.innerHTML = palletForm(); }
  const el = byId('rv-body');
  if (el) el.innerHTML = body();
}

function doReceive() {
  const n = count(), S = chosenSpots();
  if (!n || !recv.confirmed || !ready() || S.length < n || recv.busy || app.dirty || !can('receive')) return;
  recv.busy = true; recv.err = '';
  refresh();
  const name = partName(part(recv.part) || {});
  api('POST', '/api/receive', {
    part: recv.part, received: recv.date,
    pallets: S.map((x, i) => ({ section: x.section, row: x.row, rack: x.rack, level: x.level, qty: qtyOf(i), routing: recv.routings[i] || '' })),
  })
    .then(d => {
      useServerData(d);
      recv = blank();
      recv.msg = 'Received ' + n + ' ' + plural(n, 'pallet') + ' of ' + name + ' into ' + S.map(x => x.loc).join(', ') + '.';
      render();
      loadLog();
    })
    .catch(x => { recv.busy = false; if (x.silent) return; recv.err = x.message; reloadLatest(); });
}

/* ---------- actions ---------- */
function clearConfirmError() { const e = byId('rv-cerr'); if (e) e.textContent = ''; }
on('change', 'rpart', t => { recv.part = t.value; recv.qtys = []; recv.confirmed = false; recv.err = ''; recv.msg = ''; refresh(true); });
on('input', 'rcount', t => { recv.count = t.value; recv.err = ''; recv.confirmed = false; refresh(true); });
on('input', 'rqty', t => { recv.qtys[+t.dataset.i] = t.value; clearConfirmError(); refresh(); });
on('input', 'rrt', t => { recv.routings[+t.dataset.i] = t.value; clearConfirmError(); refresh(); });
on('input', 'rdate', t => { recv.date = t.value || today(); refresh(); });
on('click', 'rconfirm', () => {
  const bad = missing();
  if (bad.length) {
    recv.confirmed = false;
    const e = byId('rv-cerr');
    if (e) e.textContent = 'Enter the quantity and routing # for pallet' + (bad.length > 1 ? 's ' : ' ') + bad.join(', ') + '.';
    refresh();
    return;
  }
  clearConfirmError();
  recv.confirmed = true;
  markStep('rv-step', false);
  refresh();
});
on('click', 'rspot', t => {
  const i = recv.spots.indexOf(t.dataset.v);
  if (i >= 0) recv.spots.splice(i, 1);
  else if (recv.spots.length < count()) recv.spots.push(t.dataset.v);
  recv.err = ''; recv.msg = '';
  refresh();
});
on('click', 'rgo', () => doReceive());
