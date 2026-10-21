// One-page printable sheets (pick, put-away, return): each rack row holding a listed pallet drawn as a grid
// (racks across, levels top to bottom) with the spots numbered, then the list with a Done box per pallet.
import { app } from '../state.js';
import { esc, fmt, when, day } from '../util.js';
import { levelNumbers } from '../model.js';
import { on } from '../events.js';

// o: { title, dir ('To' | 'From'), machine, noMachine, sub (html), items: [{ section, row, addr, loc, pn, qty, routing, received }], foot, footQty }
export function sheet(o) {
  const numberOf = {};
  o.items.forEach((x, i) => { numberOf[x.section + '|' + x.addr] = i + 1; });
  const multi = app.data.sections.length > 1;
  let h = '<div class="sheet"><div class="sheet-h"><div><b>' + esc(o.title) + '</b><span>' + esc(when(new Date().toISOString())) + ' · ' + esc(app.me.id) + '</span></div>' +
    '<div class="to">' + o.dir + ' <b>' + esc(o.machine) + '</b></div></div>';
  h += '<p class="sheet-part">' + o.sub + '</p><div class="sheet-racks">';
  app.data.sections.forEach(s => s.rows.forEach(r => {
    if (!o.items.some(x => x.section === s.key && String(x.row) === String(r.row))) return;
    h += '<div class="sheet-row"><div class="sheet-row-h">' + (multi ? esc(s.name) + ' · ' : '') + 'Row ' + esc(r.row) + '</div><table class="rackmap"><thead><tr><th></th>';
    r.racks.forEach(rk => { h += '<th>Rack ' + esc(rk.rack) + '</th>'; });
    h += '</tr></thead><tbody>';
    levelNumbers(r).forEach(n => {
      h += '<tr><th>L' + n + '</th>';
      r.racks.forEach(rk => {
        const lv = rk.levels.find(x => x.level === n), addr = r.row + '-' + rk.rack + '-' + n, k = numberOf[s.key + '|' + addr];
        if (!lv) h += '<td class="none"></td>';
        else if (k) h += '<td class="hit"><b>' + k + '</b> ' + esc(addr) + '</td>';
        else h += '<td class="' + (lv.items.length ? 'full' : '') + '">' + esc(addr) + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
  }));
  const machineCol = o.noMachine ? '' : '<td>' + esc(o.machine) + '</td>';
  h += '</div><table class="sheet-list"><thead><tr><th>#</th><th>Location</th><th>Part Number</th><th>Routing #</th><th>Received</th><th class="r">Quantity</th>' +
    (o.noMachine ? '' : '<th>Machine</th>') + '<th>Done</th></tr></thead><tbody>';
  if (!o.items.length) h += '<tr><td colspan="8">Nothing goes back to the racking.</td></tr>';
  o.items.forEach((x, i) => {
    h += '<tr><td>' + (i + 1) + '</td><td><b>' + esc(x.loc) + '</b></td><td>' + esc(x.pn) + '</td><td>' + esc(x.routing) + '</td><td>' + esc(day(x.received)) + '</td>' +
      '<td class="r">' + fmt(x.qty) + '</td>' + machineCol + '<td><span class="box"></span></td></tr>';
  });
  h += '</tbody><tfoot><tr><td colspan="5">' + esc(o.foot) + '</td><td class="r">' + fmt(o.footQty) + '</td>' + machineCol + '<td></td></tr></tfoot></table></div>';
  return h;
}

// A "Ready for print" panel holding a sheet.
export function printPanel(note, sheetHtml) {
  return '<div class="panel"><div class="panel-h"><h3>Ready for print</h3><p>' + note + '</p><button class="btn" data-act="xprint">Print</button></div><div class="sheet-wrap">' + sheetHtml + '</div></div>';
}

// Prints the sheet on screen: copies it to #print-root, which the print styles show on its own.
on('click', 'xprint', () => {
  const src = document.querySelector('#view .sheet');
  if (!src) return;
  let pr = document.getElementById('print-root');
  if (!pr) { pr = document.createElement('div'); pr.id = 'print-root'; document.body.appendChild(pr); }
  pr.innerHTML = src.outerHTML;
  window.print();
});
