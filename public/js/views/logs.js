// The three transfer logs. They read the same list from the server:
//   tlog  Machine Transfer Log (Machine tab): transfers to and returns from machines
//   rlog  Receiving Log (Receive Material tab): receipts
//   mlog  Transfer Log (Master tab, admins): everything, with menus for date and machine / receiving
import { ui, MACHINES } from '../state.js';
import { esc, fmt, when, byId } from '../util.js';
import { isAdmin } from '../model.js';
import { api } from '../api.js';
import { on } from '../events.js';

// [range, label, admins only]
const RANGES = [['today', 'Today'], ['week', 'Last week'], ['month', 'Last month'], ['year', 'Last year', true], ['all', 'All time', true]];

const LOGS = {
  tlog: { title: 'Machine Transfer Log', only: 'machine', st: { range: 'today', entries: null, err: '' } },
  rlog: { title: 'Receiving Log', only: 'receive', st: { range: 'today', entries: null, err: '' } },
  mlog: { title: 'Transfer Log', menus: true, st: { range: 'today', machine: 'all', entries: null, err: '' } },
};

function redraw(id) {
  const el = byId(id);
  if (el) el.outerHTML = logPanel(id);
}

// Loads one log, or with no id, the log on the tab being shown.
export function loadLog(id) {
  if (!id) {
    if (ui.tab === 'machines') loadLog('tlog');
    if (ui.tab === 'receive') loadLog('rlog');
    if (ui.tab === 'master' && isAdmin()) loadLog('mlog');
    return;
  }
  const st = LOGS[id].st;
  // "Today" starts at the viewer's midnight, which the server can't know.
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  return api('GET', '/api/transfers?range=' + st.range + '&since=' + since.getTime())
    .then(j => { st.entries = j.entries; st.err = ''; redraw(id); })
    .catch(x => { if (!x.silent) { st.err = x.message; redraw(id); } });
}

function filters(id) {
  const L = LOGS[id], st = L.st, ranges = RANGES.filter(r => !r[2] || isAdmin());
  if (!L.menus) {
    return '<div class="chips">' + ranges.map(r => '<button class="chip sm" data-act="lrange" data-log="' + id + '" data-v="' + r[0] + '" aria-pressed="' + (st.range === r[0]) + '">' + r[1] + '</button>').join('') + '</div>';
  }
  const opt = (v, label, cur) => '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
  return '<div class="menus">' +
    '<label class="field"><span>Date</span><select data-act="lrangesel" data-log="' + id + '">' + ranges.map(r => opt(r[0], r[1], st.range)).join('') + '</select></label>' +
    '<label class="field"><span>Machine / receiving</span><select data-act="lmachsel" data-log="' + id + '">' +
    [['all', 'All'], ['receive', 'Receiving']].concat(MACHINES.map(m => [m, m])).map(o => opt(o[0], o[1], st.machine)).join('') + '</select></label>' +
    '<button class="btn sm" data-act="lreset" data-log="' + id + '">Reset to default</button></div>';
}

// Which entries a log shows.
function visible(L, e) {
  const receipt = e.kind === 'receive';
  if (L.only === 'machine') return !receipt && !!e.machine;
  if (L.only === 'receive') return receipt;
  return L.st.machine === 'all' || (L.st.machine === 'receive' ? receipt : !receipt && e.machine === L.st.machine);
}

// From and To for one entry: Receiving → spots; spots → machine; machine → spots (and pallets used up).
function fromTo(e) {
  const pallets = Array.isArray(e.pallets) ? e.pallets : [];
  if (e.kind === 'receive') {
    return { parts: [e.partNumber || e.part], from: '<b>Receiving</b>', to: esc(pallets.map(x => x.loc + ' (' + fmt(x.qty) + ')').join(', ')) };
  }
  const isReturn = e.kind === 'return';
  const parts = isReturn ? pallets.map(x => x.partNumber || x.part) : [e.partNumber || e.part];
  const usedUp = isReturn ? pallets.filter(x => !x.qty).length : 0;
  const spots = pallets.filter(x => !isReturn || x.qty).map(x => x.loc + (isReturn ? ' (' + fmt(x.qty) + ')' : ''));
  if (usedUp) spots.push('Used (' + usedUp + ' pallet' + (usedUp > 1 ? 's' : '') + ')');
  const rack = esc(spots.join(', ')), machine = '<b>' + esc(e.machine) + '</b>';
  return { parts, from: isReturn ? machine : rack, to: isReturn ? rack : machine };
}

export function logPanel(id) {
  const L = LOGS[id], st = L.st;
  let h = '<div class="panel" id="' + id + '"><div class="panel-h"><h3>' + L.title + '</h3>' + filters(id) + '</div><div class="scroll"><table class="log"><thead><tr>' +
    '<th>When</th><th>User</th><th>Action</th><th>Part Number</th><th class="r">Qty</th><th>From</th><th>To</th></tr></thead><tbody>';
  const list = (st.entries || []).filter(e => visible(L, e));
  if (st.err) h += '<tr><td colspan="7" class="err">' + esc(st.err) + '</td></tr>';
  else if (!st.entries) h += '<tr><td colspan="7" class="empty-note">Loading…</td></tr>';
  else if (!list.length) h += '<tr><td colspan="7" class="empty-note">Nothing in this period.</td></tr>';
  list.forEach(e => {
    const f = fromTo(e), parts = [...new Set(f.parts)];
    h += '<tr><td class="dim">' + esc(when(e.at)) + '</td><td>' + esc(e.by) + '</td><td>' + (e.kind === 'receive' ? 'Receive' : 'Transfer') + '</td>' +
      '<td>' + esc(parts.join(', ')) + '</td><td class="r num">' + fmt(e.qty) + '</td>' +
      '<td class="detail">' + f.from + '</td><td class="detail">' + f.to + '</td></tr>';
  });
  return h + '</tbody></table></div></div>';
}

/* ---------- actions ---------- */
function setRange(id, range) {
  const st = LOGS[id].st;
  st.range = range;
  st.entries = null;
}
on('click', 'lrange', t => {
  setRange(t.dataset.log, t.dataset.v);
  redraw(t.dataset.log);
  loadLog(t.dataset.log);
});
on('click', 'lreset', t => {
  setRange(t.dataset.log, 'today');
  LOGS[t.dataset.log].st.machine = 'all';
  redraw(t.dataset.log);
  loadLog(t.dataset.log);
});
on('change', 'lrangesel', t => {
  setRange(t.dataset.log, t.value);
  loadLog(t.dataset.log);
});
// Machine filter: the entries are already loaded, just redraw.
on('change', 'lmachsel', t => {
  LOGS[t.dataset.log].st.machine = t.value;
  redraw(t.dataset.log);
});
