// Questions about the racking data and the signed-in user: what parts and pallets exist, totals, permissions.
import { app, ui } from './state.js';
import { num } from './util.js';

/* ---------- permissions ---------- */
// Roles: Admin does everything. Supervisor sees every tab but Admin and can receive, transfer and return,
// but not edit the racking. Material Handler transfers and returns; Shipping and Receiving receives; Viewer reads.
// The server checks the same rules.
const CAN = {
  transfer: ['admin', 'supervisor', 'handler'],
  receive: ['admin', 'supervisor', 'shipping'],
  return: ['admin', 'supervisor', 'handler'],
};
export function can(action) { return !!app.me && CAN[action].includes(app.me.role); }
export function isAdmin() { return !!app.me && app.me.role === 'admin'; }
// Only admins edit the racking and Master.
export function canEdit() { return isAdmin(); }
export function disabledUnlessEditor() { return canEdit() ? '' : ' disabled'; }

// The tabs each role sees, besides the racking sections.
export const TABS = [['receive', 'Receive Material'], ['transfer', 'Transfer Material'], ['machines', 'Machine'], ['master', 'Master'], ['admin', 'Admin']];
export function tabAllowed(k) {
  if (!app.me) return false;
  const r = app.me.role;
  if (k === 'admin') return r === 'admin';
  if (k === 'master') return r === 'admin' || r === 'viewer' || r === 'supervisor';
  if (k === 'transfer' || k === 'machines') return r !== 'shipping';
  if (k === 'receive') return r !== 'handler';
  return true;
}
export function isSectionTab(k) { return !TABS.some(t => t[0] === k); }

/* ---------- parts ---------- */
export function part(k) { return app.data.parts.find(p => p.k === k) || null; }
export function partName(p) { return p.number || p.partId || 'Unnamed part'; }

/* ---------- racking layout ---------- */
export function section(k = ui.tab) { return app.data.sections.find(s => s.key === k) || null; }
export function sectionName(k) { const s = section(k); return s ? s.name : k; }
// Rows of the section on screen.
export function rows() { const s = section(); return s ? s.rows : []; }
export function rowKey(s, r) { return s.key + '|' + r.row; }
// Rows may be numbers or letters; compare as text.
export function sameRow(a, b) { return a != null && b != null && String(a) === String(b); }
export function eachLevel(fn) {
  app.data.sections.forEach(s => s.rows.forEach(r => r.racks.forEach(rk => rk.levels.forEach(lv => fn(lv, s, r, rk)))));
}
// Section name in front of a location, only when more than one section is switched on.
export function locLabel(sectionKey, addr) {
  return (app.data.sections.length > 1 ? sectionName(sectionKey) + ' ' : '') + addr;
}
// Every level number used in a row, top first, so a rack missing a level shows a gap there.
export function levelNumbers(row) {
  const all = {};
  row.racks.forEach(rk => rk.levels.forEach(lv => { all[lv.level] = 1; }));
  return Object.keys(all).map(Number).sort((a, b) => b - a);
}

/* ---------- totals ---------- */
// t: quantity per part; loc: locations per part; byRow: per row key, quantity per part plus _filled/_slots counts.
export function totals() {
  const t = {}, loc = {}, byRow = {};
  let filled = 0, slots = 0;
  app.data.sections.forEach(s => s.rows.forEach(r => {
    const br = byRow[rowKey(s, r)] = { _filled: 0, _slots: 0 };
    r.racks.forEach(rk => rk.levels.forEach(lv => {
      let has = false;
      slots++; br._slots++;
      lv.items.forEach(it => {
        if (!it.part || !part(it.part)) return;
        has = true;
        t[it.part] = (t[it.part] || 0) + num(it.qty);
        br[it.part] = (br[it.part] || 0) + num(it.qty);
        loc[it.part] = (loc[it.part] || 0) + 1;
      });
      if (has) { filled++; br._filled++; }
    }));
  }));
  return { t, loc, byRow, filled, slots };
}

/* ---------- pallets ---------- */
// Every pallet on the racking holding part k, oldest received first (pallets without a date last, then racking order).
export function palletsOf(k) {
  const out = [];
  app.data.sections.forEach(s => s.rows.forEach(r => r.racks.forEach(rk => rk.levels.forEach(lv => {
    lv.items.forEach((it, i) => {
      if (it.part !== k || !(num(it.qty) > 0)) return;
      const addr = r.row + '-' + rk.rack + '-' + lv.level;
      out.push({
        key: s.key + '|' + addr + '|' + i, section: s.key, row: r.row, rack: rk.rack, level: lv.level, item: i,
        qty: num(it.qty), addr, loc: locLabel(s.key, addr), routing: it.routing || '', received: it.received || '',
      });
    });
  }))));
  const date = x => x.received || '9999';
  return out.map((x, n) => Object.assign(x, { n })).sort((a, b) => date(a) < date(b) ? -1 : date(a) > date(b) ? 1 : a.n - b.n);
}

// Pallets at a machine, as last loaded from the server.
export function atMachine(m) { return (app.server.machines || {})[m] || []; }
export function machineTotal(m) { return atMachine(m).reduce((t, x) => t + num(x.qty), 0); }

// Where a pallet at a machine came from.
export function fromLoc(x) {
  const f = x.from || {}, section = f.section || 'hq', addr = f.row + '-' + f.rack + '-' + f.level;
  return { section, row: f.row, addr, loc: locLabel(section, x.loc || addr) };
}

// How a return splits up: the quantity used comes off the oldest-received pallets first; the rest of each pallet
// goes back to its spot. Same steps as the server. null if used is out of range.
export function returnPlan(list, used) {
  const total = list.reduce((t, x) => t + num(x.qty), 0);
  if (!isFinite(used) || used < 0 || used > total) return null;
  let left = used;
  return list.map((p, n) => ({ p, n }))
    .sort((a, b) => String(a.p.received || '9999').localeCompare(String(b.p.received || '9999')) || a.n - b.n)
    .map(({ p }) => { const u = Math.min(left, num(p.qty)); left -= u; return { p, used: u, back: num(p.qty) - u }; });
}
