// Transfer Material tab: pick a part and the quantity needed, choose one or two whole pallets (oldest first),
// pick a machine, print the pick sheet and move the pallets.
import { app, MACHINES, MAX_PALLETS } from '../state.js';
import { esc, fmt, day, plural, byId } from '../util.js';
import { can, part, partName, palletsOf } from '../model.js';
import { api } from '../api.js';
import { render } from '../render.js';
import { reloadLatest, useServerData } from '../saving.js';
import { on } from '../events.js';
import { loadLog } from './logs.js';
import { sheet, printPanel } from './sheet.js';

// picks: the chosen pallets' keys, in the order picked.
let xfer = blank();
function blank() { return { part: '', qty: '', picks: [], machine: null, busy: false, msg: '', err: '' }; }

function requested() {
  const n = Number(xfer.qty);
  return xfer.qty !== '' && isFinite(n) && n > 0 ? n : 0;
}

// The picked pallets that still exist, in the order picked, and their total.
function picked(list) {
  const byKey = {};
  list.forEach(x => { byKey[x.key] = x; });
  const out = xfer.picks.map(k => byKey[k]).filter(Boolean);
  xfer.picks = out.map(x => x.key);
  return { list: out, total: out.reduce((t, x) => t + x.qty, 0) };
}

export function transferView() {
  let h = '<div class="stack"><div class="panel"><div class="panel-h"><h3>Transfer material</h3><p>Pick the material and quantity, then choose one green pallet or two pallets that add up to it. Oldest received is listed first. Whole pallets are moved.</p></div>';
  h += '<div class="formrow"><div class="field grow"><label for="xf-part">Material type</label><select id="xf-part" data-act="xpart"><option value="">Select part number</option>';
  app.data.parts.forEach(p => { h += '<option value="' + esc(p.k) + '"' + (xfer.part === p.k ? ' selected' : '') + '>' + esc(partName(p)) + '</option>'; });
  h += '</select></div><div class="field"><label for="xf-qty">Quantity requested</label><input id="xf-qty" class="num" type="number" inputmode="numeric" min="1" step="1" data-act="xqty" value="' + esc(xfer.qty) + '"></div></div>';
  h += '</div><div id="xf-results" class="stack">' + results() + '</div></div>';
  return h;
}

// Everything under the form; redrawn as the user types and picks.
function results() {
  let h = xfer.msg ? '<p class="ok-msg" role="status">' + esc(xfer.msg) + '</p>' : '';
  if (!xfer.part || !part(xfer.part)) return h + '<p class="empty-note">Select a material type to see where it is racked.</p>';
  const q = requested(), p = part(xfer.part), list = palletsOf(xfer.part);
  if (!q) xfer.picks = [];
  const P = picked(list), enough = q && P.total >= q;
  if (!enough) xfer.machine = null;
  if (q) h += tally(q, P, enough, list);
  h += palletTable(q, p, P, enough, list);
  if (xfer.err) h += '<p class="err" role="alert">' + esc(xfer.err) + '</p>';
  if (!q) return h;
  h += selectedTable(q, p, P);
  if (!enough) return h;
  h += machinePanel(p, P);
  if (xfer.machine) h += printPanel('Pick sheet for this transfer. It fits on one 8.5 × 11 in page.', pickSheet(p, q, P));
  return h;
}

function tally(q, P, enough, list) {
  const pct = Math.min(100, Math.round(P.total / q * 100));
  // One pallet picked that is too small, and no other pallet makes up the rest.
  const stuck = P.list.length === 1 && !enough && !list.some(x => x.key !== P.list[0].key && P.total + x.qty >= q);
  return '<div class="tally' + (enough ? ' ok' : '') + '"><span class="label">Selected / requested</span><b class="num">' + fmt(P.total) + ' / ' + fmt(q) + '</b>' +
    '<span class="meter"><i style="width:' + pct + '%"></i></span><span class="dim">' + (enough ? 'Enough selected.' : fmt(q - P.total) + ' more needed.') + '</span>' +
    (stuck ? '<span class="err">No other pallet makes up the rest. Remove ' + esc(P.list[0].loc) + ' and pick another.</span>' : '') + '</div>';
}

// Every pallet of the part, coloured: green holds enough alone, yellow needs a second pallet,
// red can't make up the rest, grey can't be picked now.
function palletTable(q, p, P, enough, list) {
  let h = '<div class="panel"><div class="panel-h"><h3>' + esc(partName(p)) + ' on the racking</h3><p>' +
    (q ? 'Green pallets cover ' + fmt(q) + ' on their own. Yellow pallets have less; pick a second pallet to make up the rest. Red pallets can\'t make up the rest. Up to ' + MAX_PALLETS + ' pallets.' : 'Enter the quantity requested to choose pallets.') +
    '</p></div><div class="scroll"><table class="xfer"><thead><tr><th style="width:44px"></th><th>Date received</th><th>Part Number</th><th>Location</th><th class="r">Quantity</th></tr></thead><tbody>';
  if (!list.length) h += '<tr><td colspan="5" class="empty-note">No pallets of this material are on the racking.</td></tr>';
  list.forEach((x, i) => {
    const sel = xfer.picks.includes(x.key), n = P.list.length;
    let cls = '', pickable = false;
    if (q) {
      // Unpicked pallets can be added while fewer than MAX_PALLETS are picked, the request isn't met yet,
      // and this pallet would meet it as the last pick.
      if (sel) { cls = x.qty >= q ? 'go' : 'part'; pickable = true; }
      else if (enough || n >= MAX_PALLETS) cls = 'off';
      else if (n === MAX_PALLETS - 1 && P.total + x.qty < q) cls = 'no';
      else { cls = x.qty >= q ? 'go' : 'part'; pickable = true; }
    }
    h += '<tr class="' + cls + (sel ? ' picked' : '') + '"' + (pickable ? ' data-act="xpick" data-v="' + esc(x.key) + '"' : '') + '><td>' +
      (pickable ? '<button class="pick" aria-pressed="' + sel + '" aria-label="' + (sel ? 'Remove ' : 'Add ') + esc(x.loc) + '"></button>' : '') + '</td>' +
      '<td class="num">' + esc(day(x.received)) + (i < 2 ? ' <span class="rec">Recommended</span>' : '') + '</td><td>' + esc(partName(p)) + '</td>' +
      '<td><span class="tagl inline">' + esc(x.loc) + '</span></td><td class="r num"><b>' + fmt(x.qty) + '</b></td></tr>';
  });
  return h + '</tbody></table></div></div>';
}

function selectedTable(q, p, P) {
  let h = '<div class="panel"><div class="panel-h"><h3>Selected pallets</h3></div><div class="scroll"><table><thead><tr><th>#</th><th>Location</th><th>Part Number</th><th>Routing #</th><th>Date received</th><th class="r">Quantity</th><th></th></tr></thead><tbody>';
  if (!P.list.length) h += '<tr><td colspan="7" class="empty-note">No pallets selected yet. Pick pallets from the table above.</td></tr>';
  P.list.forEach((x, i) => {
    h += '<tr><td class="num">' + (i + 1) + '</td><td><span class="tagl inline">' + esc(x.loc) + '</span></td><td>' + esc(partName(p)) + '</td><td class="num">' + esc(x.routing) + '</td>' +
      '<td class="num">' + esc(day(x.received)) + '</td><td class="r num">' + fmt(x.qty) + '</td><td class="r"><button class="btn ghost sm" data-act="xpick" data-v="' + esc(x.key) + '">Remove</button></td></tr>';
  });
  h += '</tbody>' + (P.list.length ? '<tfoot><tr><td colspan="5">Total of ' + P.list.length + ' ' + plural(P.list.length, 'pallet') + '</td><td class="r num">' + fmt(P.total) + ' / ' + fmt(q) + '</td><td></td></tr></tfoot>' : '');
  return h + '</table></div></div>';
}

function machinePanel(p, P) {
  const n = P.list.length;
  let h = '<div class="panel"><div class="panel-h"><h3>Send to machine</h3><p>' + n + ' ' + plural(n, 'pallet') + ' · ' + fmt(P.total) + ' × ' + esc(partName(p)) + '</p></div><div class="machines">';
  MACHINES.forEach(m => { h += '<button class="machine" data-act="xmachine" data-v="' + m + '" aria-pressed="' + (xfer.machine === m) + '">' + m + '</button>'; });
  h += '</div><div class="tablefoot' + (xfer.machine && can('transfer') && !app.dirty ? ' confirm-step' : '') + '">';
  if (!can('transfer')) h += '<p class="dim">Your account can view but not transfer material.</p>';
  else if (app.dirty) h += '<p class="err">Save or undo your racking changes before transferring.</p>';
  else h += '<button class="btn primary" data-act="xgo"' + (!xfer.machine || xfer.busy ? ' disabled' : '') + '>' +
    (xfer.busy ? 'Transferring…' : xfer.machine ? 'Transfer ' + n + ' ' + plural(n, 'pallet') + ' to ' + xfer.machine : 'Choose a machine') + '</button>';
  return h + '</div></div>';
}

function pickSheet(p, q, P) {
  return sheet({
    title: 'Material transfer', dir: 'To', machine: xfer.machine,
    sub: '<b>' + esc(partName(p)) + '</b>' + (p.description ? ' · ' + esc(p.description) : ''),
    items: P.list.map(x => ({ section: x.section, row: x.row, addr: x.addr, loc: x.loc, pn: partName(p), qty: x.qty, routing: x.routing, received: x.received })),
    foot: P.list.length + ' ' + plural(P.list.length, 'pallet') + ' · requested ' + fmt(q), footQty: P.total,
  });
}

function refresh() {
  const el = byId('xf-results');
  if (el) el.innerHTML = results();
}

function doTransfer() {
  const q = requested(), P = picked(palletsOf(xfer.part));
  if (!q || P.total < q || !xfer.machine || xfer.busy || app.dirty || !can('transfer')) return;
  xfer.busy = true; xfer.err = ''; xfer.msg = '';
  refresh();
  const m = xfer.machine, name = partName(part(xfer.part) || {});
  api('POST', '/api/transfer', {
    part: xfer.part, requested: q, machine: m,
    pallets: P.list.map(x => ({ section: x.section, row: x.row, rack: x.rack, level: x.level, item: x.item, qty: x.qty })),
  })
    .then(d => {
      useServerData(d);
      const n = P.list.length;
      xfer = blank();
      xfer.msg = 'Moved ' + n + ' ' + plural(n, 'pallet') + ' (' + fmt(P.total) + ' × ' + name + ') from ' + P.list.map(x => x.loc).join(', ') + ' to ' + m + '.';
      render();
      loadLog();
    })
    // The pallets may have changed under us: show why and load the latest.
    .catch(x => { xfer.busy = false; if (x.silent) return; xfer.err = x.message; reloadLatest(); });
}

/* ---------- actions ---------- */
on('change', 'xpart', t => { xfer.part = t.value; xfer.picks = []; xfer.machine = null; xfer.err = ''; xfer.msg = ''; refresh(); });
on('input', 'xqty', t => { xfer.qty = t.value; xfer.err = ''; xfer.msg = ''; refresh(); });
on('click', 'xpick', t => {
  const i = xfer.picks.indexOf(t.dataset.v);
  if (i >= 0) xfer.picks.splice(i, 1);
  else if (xfer.picks.length < MAX_PALLETS) xfer.picks.push(t.dataset.v);
  xfer.err = ''; xfer.msg = '';
  refresh();
});
on('click', 'xmachine', t => { xfer.machine = t.dataset.v; refresh(); });
on('click', 'xgo', () => doTransfer());
