// Master tab: totals, the Metal Master parts list (editable by admins), quantity by row, and for admins the Transfer Log.
import { app, ui } from '../state.js';
import { esc, num, fmt, uid, refocus, byId } from '../util.js';
import { canEdit, isAdmin, disabledUnlessEditor, part, partName, rowKey, eachLevel } from '../model.js';
import { render } from '../render.js';
import { changed } from '../saving.js';
import { on } from '../events.js';
import { logPanel } from './logs.js';

export function masterView(T) {
  return '<div class="stack">' + kpis(T) + partsTable(T) + byRowTable(T) + (isAdmin() ? logPanel('mlog') : '') + '</div>';
}

function kpis(T) {
  const grand = app.data.parts.reduce((t, p) => t + (T.t[p.k] || 0), 0);
  return '<div class="kpis">' +
    '<div class="kpi"><span class="label">Parts on master</span><b class="num">' + app.data.parts.length + '</b></div>' +
    '<div class="kpi"><span class="label">Total quantity racked</span><b class="num">' + fmt(grand) + '</b></div>' +
    '<div class="kpi"><span class="label">Locations filled</span><b class="num">' + T.filled + ' / ' + T.slots + '</b></div></div>';
}

function partsTable(T) {
  const parts = app.data.parts;
  const grand = parts.reduce((t, p) => t + (T.t[p.k] || 0), 0);
  // Part Numbers used more than once are outlined.
  const seen = {};
  parts.forEach(p => { const n = (p.number || '').trim().toLowerCase(); if (n) seen[n] = (seen[n] || 0) + 1; });
  let h = '<div class="panel"><div class="panel-h"><h3>Metal Master</h3></div><div class="scroll"><table><thead><tr>' +
    '<th style="min-width:190px">Part Number</th><th style="min-width:380px">Part Description</th>' +
    '<th class="r" style="min-width:90px">Qty / Pallet</th><th style="min-width:110px">Dedicated Case</th><th class="r" style="min-width:90px">Qty / Case</th>' +
    '<th class="r">Total Qty</th><th class="r">Locations</th><th class="r">Pallets</th>' + (canEdit() ? '<th></th>' : '') + '</tr></thead><tbody>';
  if (!parts.length) h += '<tr><td colspan="9" class="empty-note">No parts yet.</td></tr>';
  parts.forEach(p => {
    const tot = T.t[p.k] || 0, loc = T.loc[p.k] || 0;
    const dup = (p.number || '').trim() && seen[p.number.trim().toLowerCase()] > 1;
    const cell = (f, cls, isNumber, extra) => '<td' + (cls ? ' class="' + cls + '"' : '') + '><input id="' + f + '-' + p.k + '" data-act="pf" data-p="' + p.k + '" data-f="' + f + '"' +
      (isNumber ? ' type="number" min="0" inputmode="decimal" class="num"' : '') + (extra || '') + disabledUnlessEditor() + ' value="' + esc(p[f]) + '" aria-label="' + f + '"></td>';
    h += '<tr>' +
      cell('number', '', false, dup ? ' class="bad" title="Another part already uses this Part Number"' : '') +
      cell('description') +
      cell('qtyPerPallet', 'r', true) +
      cell('dedicatedCase') +
      cell('qtyPerCase', 'r', true) +
      '<td class="r total num' + (tot ? '' : ' zero') + '">' + fmt(tot) + '</td>' +
      '<td class="r num' + (loc ? '' : ' zero') + '">' + loc + '</td>' +
      '<td class="r num' + (tot ? '' : ' zero') + '">' + (num(p.qtyPerPallet) > 0 ? fmt(tot / num(p.qtyPerPallet)) : '–') + '</td>';
    if (canEdit()) {
      const armed = ui.armed === p.k;
      h += '<td><button class="btn danger ghost' + (armed ? ' armed' : '') + '" data-act="delpart" data-p="' + p.k + '" style="white-space:nowrap">' +
        (armed ? (loc ? 'Remove + clear ' + loc + ' loc.' : 'Confirm') : 'Remove') + '</button></td>';
    }
    h += '</tr>';
  });
  h += '</tbody><tfoot><tr><td colspan="5">All parts</td><td class="r total num">' + fmt(grand) + '</td><td class="r num">' + T.filled + '</td><td colspan="' + (canEdit() ? 2 : 1) + '"></td></tr></tfoot></table></div>' +
    (canEdit() ? '<div class="tablefoot"><button class="btn" data-act="addpart">+ Add part</button></div>' : '') + '</div>';
  return h;
}

// Quantity of each part in each row; section headings only when more than one section is switched on.
function byRowTable(T) {
  const secs = app.data.sections.filter(s => s.rows.length);
  const grouped = secs.length > 1;
  let h = '<div class="panel"><div class="panel-h"><h3>Quantity by row</h3></div><div class="scroll"><table class="matrix"><thead><tr><th' + (grouped ? ' rowspan="2"' : '') + '>Part Number</th>';
  if (grouped) {
    secs.forEach(s => { h += '<th class="sec" colspan="' + s.rows.length + '">' + esc(s.name) + '</th>'; });
    h += '<th class="r" rowspan="2">Total</th></tr><tr>';
  }
  secs.forEach(s => s.rows.forEach(r => { h += '<th class="r">Row ' + esc(r.row) + '</th>'; }));
  h += (grouped ? '' : '<th class="r">Total</th>') + '</tr></thead><tbody>';
  app.data.parts.forEach(p => {
    h += '<tr><td>' + esc(partName(p)) + '</td>';
    secs.forEach(s => s.rows.forEach(r => {
      const v = T.byRow[rowKey(s, r)][p.k];
      h += '<td class="r num' + (v ? '' : ' zero') + '">' + (v ? fmt(v) : '–') + '</td>';
    }));
    h += '<td class="r num"><b>' + fmt(T.t[p.k] || 0) + '</b></td></tr>';
  });
  return h + '</tbody></table></div></div>';
}

/* ---------- actions ---------- */
on('click', 'addpart', () => {
  if (!canEdit()) return;
  const p = { k: uid(), number: '', description: '', partId: '', qtyPerPallet: '', dedicatedCase: '', qtyPerCase: '' };
  app.data.parts.push(p);
  changed();
  render();
  refocus('number-' + p.k);
});

// First click arms the button; the second removes the part and clears it from every level.
on('click', 'delpart', t => {
  if (!canEdit()) return;
  const k = t.dataset.p;
  if (ui.armed !== k) { ui.armed = k; render(); return; }
  app.data.parts = app.data.parts.filter(p => p.k !== k);
  eachLevel(lv => { lv.items = lv.items.filter(it => it.part !== k); });
  ui.armed = null;
  changed();
  render();
});

// Editing a part field. Part Number and Qty / Pallet change other numbers on the page, so those redraw it
// and put the cursor back where it was.
on('input', 'pf', t => {
  if (!canEdit()) return;
  const p = part(t.dataset.p), f = t.dataset.f;
  if (!p) return;
  p[f] = t.type === 'number' ? (t.value === '' ? '' : Math.max(0, num(t.value))) : t.value;
  changed();
  if (f === 'qtyPerPallet' || f === 'number') {
    const id = t.id, pos = t.selectionStart;
    render();
    const n = byId(id);
    if (n) { n.focus(); try { if (pos != null) n.setSelectionRange(pos, pos); } catch (x) { /* number fields have no selection */ } }
  }
});
