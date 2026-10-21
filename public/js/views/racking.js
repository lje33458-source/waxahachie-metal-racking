// Racking tab: pick a row, see each rack drawn with its levels, and (admins) set the part and quantity on each level.
// Below it, admins get Pallet tracking: every pallet with its routing # and date received, and a form to add one.
import { app, ui } from '../state.js';
import { esc, num, fmt, today, palletId } from '../util.js';
import { canEdit, isAdmin, disabledUnlessEditor, part, partName, section, rows, rowKey, sameRow, locLabel, levelNumbers, totals } from '../model.js';
import { render } from '../render.js';
import { changed, saveUi } from '../saving.js';
import { on } from '../events.js';
import { refocus, byId } from '../util.js';

export function rackingView(T) {
  const S = section(), R = S.rows;
  let r = null, ri = -1;
  R.forEach((x, i) => { if (sameRow(x.row, ui.rows[S.key])) { r = x; ri = i; } });
  if (!r && R.length) { r = R[0]; ri = 0; ui.rows[S.key] = r.row; }
  let h = rowPicker(S, R, ri, T);
  if (!r) return h + '<p class="empty-note">No rows in ' + esc(S.name) + ' yet.' + (canEdit() ? ' Add a row to start assigning parts.' : '') + '</p>';
  h += rowHeader(S, r, T);
  h += '<div class="racks">';
  const levelNums = levelNumbers(r);
  r.racks.forEach((rk, ki) => {
    h += '<div class="rack"><div class="rack-h"><b>Rack ' + esc(rk.rack) + '</b><span>' + esc(rk.label) + '</span></div><div class="frame">';
    levelNums.forEach(n => { h += levelBox(r, ri, rk, ki, n); });
    h += '</div><div class="floor" aria-hidden="true"></div></div>';
  });
  return h + '</div>';
}

// The row chips across the top, each with how full the row is.
function rowPicker(S, R, ri, T) {
  let h = '<div class="rowpick"><div class="label">Select row</div><div class="chips">';
  R.forEach((x, i) => {
    const b = T.byRow[rowKey(S, x)], pct = b._slots ? Math.round(b._filled / b._slots * 100) : 0;
    h += '<button class="chip" data-act="row" data-v="' + i + '" aria-pressed="' + (i === ri) + '"><b>Row ' + esc(x.row) + '</b>' +
      '<span class="meter"><i style="width:' + pct + '%"></i></span><small class="num">' + b._filled + ' / ' + b._slots + ' filled</small></button>';
  });
  if (canEdit()) h += '<button class="chip add" data-act="addrow">+ Add row</button>';
  return h + '</div></div>';
}

// "Row 2", the quantity of each part in it, and the remove-row button.
function rowHeader(S, r, T) {
  const b = T.byRow[rowKey(S, r)];
  let h = '<div class="rowhead"><h2>Row ' + esc(r.row) + '</h2><div class="pills">';
  let any = false;
  app.data.parts.forEach(p => {
    if (b[p.k] == null) return;
    any = true;
    h += '<span class="pill"><b class="num">' + fmt(b[p.k]) + '</b> × ' + esc(partName(p)) + '</span>';
  });
  if (!any) h += '<span class="pill muted">No parts assigned in this row</span>';
  h += '<span class="pill muted num">' + b._filled + ' of ' + b._slots + ' locations filled</span>';
  if (canEdit()) {
    const armed = ui.armed === 'row';
    h += '<button class="btn danger ghost' + (armed ? ' armed' : '') + '" data-act="delrow">' + (armed ? 'Confirm remove Row ' + esc(r.row) : 'Remove row') + '</button>';
  }
  return h + '</div></div>';
}

// One level of a rack: its address, and a part picker + quantity for each pallet on it (or an empty one).
function levelBox(r, ri, rk, ki, n) {
  const li = rk.levels.findIndex(x => x.level === n);
  if (li < 0) return '<div class="level gap"><div class="addr"><span class="tagl">' + esc(r.row + '-' + rk.rack + '-' + n) + '</span></div><div class="lines"><span class="gapnote">No slot</span></div></div>';
  const lv = rk.levels[li], addr = r.row + '-' + rk.rack + '-' + lv.level;
  const filled = lv.items.some(it => it.part);
  let h = '<div class="level' + (filled ? '' : ' empty') + '"><div class="addr"><span class="tagl">' + esc(addr) + '</span>' +
    (lv.height !== '' && lv.height != null ? '<span class="ht">' + esc(lv.height) + ' in</span>' : '') + '</div><div class="lines">';
  (lv.items.length ? lv.items : [null]).forEach((it, i) => {
    const id = addr + '-' + (it ? i : 'new');
    const d = 'data-r="' + ri + '" data-k="' + ki + '" data-l="' + li + '" data-i="' + (it ? i : 'new') + '"';
    h += '<div class="line"><select id="sel-' + id + '" data-act="part" ' + d + ' aria-label="Part number at ' + addr + '"' + disabledUnlessEditor() + '><option value="">Select part number</option>';
    app.data.parts.forEach(p => { h += '<option value="' + esc(p.k) + '"' + (it && it.part === p.k ? ' selected' : '') + '>' + esc(partName(p)) + '</option>'; });
    h += '</select>';
    // Supervisors see what is on each pallet but not its quantity.
    if (app.me.role === 'supervisor') h += '<span></span>';
    else h += '<input id="qty-' + id + '" class="num" type="number" inputmode="numeric" min="0" step="1" data-act="qty" ' + d + ' aria-label="Quantity at ' + addr + '" value="' +
      (it && it.qty !== '' && it.qty != null ? esc(it.qty) : '') + '"' + (it && it.part && canEdit() ? '' : ' disabled placeholder="Qty"') + '>';
    h += it && canEdit() ? '<button class="x" data-act="rmline" ' + d + ' aria-label="Clear ' + addr + '" title="Clear">×</button>' : '<span></span>';
    h += '</div>';
  });
  return h + '</div></div>';
}

// The level a racking control belongs to (data-r/-k/-l index the row, rack and level on screen).
function levelOf(t) { return rows()[+t.dataset.r].racks[+t.dataset.k].levels[+t.dataset.l]; }

/* ---------- racking actions ---------- */
on('click', 'row', t => {
  const rw = rows()[+t.dataset.v];
  if (rw) ui.rows[ui.tab] = rw.row;
  saveUi();
  render();
});

// New rows copy the last row's racks and levels. Lettered rows continue A, B, C…; numbered rows count up.
on('click', 'addrow', () => {
  if (!canEdit()) return;
  const R = rows(), last = R[R.length - 1];
  let n;
  if (last && typeof last.row === 'string' && /^[A-Z]$/.test(last.row)) n = last.row === 'Z' ? 'AA' : String.fromCharCode(last.row.charCodeAt(0) + 1);
  else n = R.reduce((m, r) => Math.max(m, num(r.row)), 0) + 1;
  const racks = last
    ? last.racks.map(rk => ({ rack: rk.rack, label: rk.label, levels: rk.levels.map(lv => ({ level: lv.level, height: lv.height, items: [] })) }))
    : [1, 2].map(k => ({ rack: k, label: '12 ft', levels: [9, 8, 7, 6, 5, 4, 3, 2, 1].map(l => ({ level: l, height: 17, items: [] })) }));
  R.push({ row: n, racks });
  ui.rows[ui.tab] = n;
  saveUi();
  changed();
  render();
});

// First click arms the button, the second removes the row.
on('click', 'delrow', () => {
  if (!canEdit()) return;
  if (ui.armed !== 'row') { ui.armed = 'row'; render(); return; }
  const S = section();
  S.rows = S.rows.filter(r => !sameRow(r.row, ui.rows[S.key]));
  ui.armed = null;
  ui.rows[S.key] = S.rows.length ? S.rows[0].row : null;
  saveUi();
  changed();
  render();
});

on('click', 'rmline', t => {
  if (!canEdit()) return;
  levelOf(t).items.splice(+t.dataset.i, 1);
  changed();
  render();
});

// Picking a part on a level: an empty line adds a pallet (quantity defaults to the part's Qty / Pallet).
on('change', 'part', t => {
  if (!canEdit()) return;
  const lv = levelOf(t), v = t.value, p = part(v);
  if (t.dataset.i === 'new') {
    if (!v) return;
    lv.items.push({ id: palletId(), part: v, qty: p && p.qtyPerPallet !== '' ? num(p.qtyPerPallet) : '', routing: '', received: today() });
  } else {
    const it = lv.items[+t.dataset.i];
    it.part = v;
    if (v && (it.qty === '' || it.qty == null) && p && p.qtyPerPallet !== '') it.qty = num(p.qtyPerPallet);
  }
  changed();
  render();
  const r = rows()[+t.dataset.r], rk = r.racks[+t.dataset.k], i = t.dataset.i === 'new' ? lv.items.length - 1 : t.dataset.i;
  refocus('qty-' + r.row + '-' + rk.rack + '-' + lv.level + '-' + i);
});

// Typing a quantity: update the totals in the row header and row chips without redrawing the fields.
on('input', 'qty', t => {
  if (!canEdit()) return;
  const it = levelOf(t).items[+t.dataset.i];
  if (!it) return;
  it.qty = t.value === '' ? '' : Math.max(0, num(t.value));
  changed();
  const fresh = document.createElement('div'), view = byId('view');
  fresh.innerHTML = rackingView(totals());
  for (const sel of ['.rowhead', '.rowpick']) {
    const old = view.querySelector(sel), now = fresh.querySelector(sel);
    if (old && now) old.replaceWith(now);
  }
});

/* ---------- pallet tracking (admins) ---------- */
export function palletTracking() {
  let n = 0, spots = '';
  let h = '<div class="panel"><div class="panel-h"><h3>Pallet tracking</h3></div><div class="scroll"><table class="tracking"><thead><tr>' +
    '<th>Location</th><th style="min-width:190px">Part Number</th><th class="r">Qty</th><th style="min-width:130px">Routing #</th><th style="min-width:150px">Date received</th><th></th></tr></thead><tbody>';
  app.data.sections.forEach(s => s.rows.forEach((r, ri) => r.racks.forEach((rk, ki) => rk.levels.forEach((lv, li) => {
    const loc = r.row + '-' + rk.rack + '-' + lv.level, lab = locLabel(s.key, loc);
    const d0 = 'data-s="' + esc(s.key) + '" data-r="' + ri + '" data-k="' + ki + '" data-l="' + li + '"';
    spots += '<option value="' + esc(s.key + '|' + ri + '|' + ki + '|' + li) + '">' + esc(lab) + (lv.items.length ? ' (has a pallet)' : '') + '</option>';
    lv.items.forEach((it, ii) => {
      const p = part(it.part);
      if (!p) return;
      n++;
      const d = d0 + ' data-i="' + ii + '"';
      h += '<tr><td><span class="tagl inline">' + esc(lab) + '</span></td><td>' + esc(partName(p)) + '</td><td class="r num">' + fmt(num(it.qty)) + '</td>' +
        '<td><input data-act="pt" data-f="routing" ' + d + ' value="' + esc(it.routing) + '" aria-label="Routing number at ' + esc(loc) + '"></td>' +
        '<td><input type="date" data-act="pt" data-f="received" ' + d + ' value="' + esc(it.received) + '" aria-label="Date received at ' + esc(loc) + '"></td>' +
        '<td><button class="x" data-act="ptdel" ' + d + ' aria-label="Remove pallet at ' + esc(loc) + '" title="Remove pallet">×</button></td></tr>';
    });
  }))));
  if (!n) h += '<tr><td colspan="6" class="empty-note">No pallets on the racking.</td></tr>';
  h += '</tbody></table></div>';
  h += '<div class="formrow addpal">' +
    '<div class="field"><label for="ap-loc">Location</label><select id="ap-loc"><option value="">Select location</option>' + spots + '</select></div>' +
    '<div class="field grow"><label for="ap-part">Part Number</label><select id="ap-part"><option value="">Select part number</option>' +
    app.data.parts.map(p => '<option value="' + esc(p.k) + '">' + esc(partName(p)) + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="ap-qty">Qty</label><input id="ap-qty" class="num" type="number" min="1" step="1" inputmode="numeric" placeholder="Qty / pallet"></div>' +
    '<div class="field"><label for="ap-rt">Routing #</label><input id="ap-rt" autocomplete="off"></div>' +
    '<div class="field"><label for="ap-date">Date received</label><input id="ap-date" type="date" value="' + today() + '"></div>' +
    '<button class="btn primary" data-act="addpallet">Add pallet</button></div>' +
    '<p class="err" id="ap-err" role="alert" style="padding:0 14px 12px"></p></div>';
  return h;
}

// The pallet a tracking control belongs to (data-s is the section, then row/rack/level/item indexes).
function trackedPallet(t) {
  const S = section(t.dataset.s);
  return S && S.rows[+t.dataset.r].racks[+t.dataset.k].levels[+t.dataset.l].items[+t.dataset.i];
}

on('input', 'pt', t => {
  if (!canEdit()) return;
  const it = trackedPallet(t);
  if (!it) return;
  it[t.dataset.f] = t.value;
  changed();
});

on('click', 'ptdel', t => {
  if (!isAdmin()) return;
  section(t.dataset.s).rows[+t.dataset.r].racks[+t.dataset.k].levels[+t.dataset.l].items.splice(+t.dataset.i, 1);
  changed();
  render();
});

on('click', 'addpallet', () => {
  if (!isAdmin()) return;
  const err = byId('ap-err'), spot = byId('ap-loc').value.split('|'), k = byId('ap-part').value, p = part(k), qtyText = byId('ap-qty').value;
  if (spot.length < 4) { err.textContent = 'Choose a location.'; return; }
  if (!p) { err.textContent = 'Choose a part number.'; return; }
  const qty = qtyText === '' ? num(p.qtyPerPallet) : Number(qtyText);
  if (!(qty > 0)) { err.textContent = 'Enter the quantity on the pallet.'; return; }
  section(spot[0]).rows[+spot[1]].racks[+spot[2]].levels[+spot[3]].items.push({ id: palletId(), part: k, qty, routing: byId('ap-rt').value.trim(), received: byId('ap-date').value || today() });
  changed();
  render();
});
