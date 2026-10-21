// Draws the whole page: header, banner, tabs and the current tab's view.
import { app, ui, ROLE_NAMES } from './state.js';
import { esc, when } from './util.js';
import { canEdit, isAdmin, tabAllowed, section, totals, TABS } from './model.js';
import { accountPanel } from './views/account.js';
import { rackingView, palletTracking } from './views/racking.js';
import { masterView } from './views/master.js';
import { transferView } from './views/transfer.js';
import { receiveView } from './views/receive.js';
import { machinesView } from './views/machines.js';
import { adminView } from './views/admin.js';

const root = document.getElementById('app-root');

export function render() {
  const T = totals();
  root.innerHTML = [
    header(),
    ui.account ? accountPanel() : '',
    newerBanner(),
    '<nav class="tabs" role="tablist">',
    app.data.sections.map(s => tab(s.key, esc(s.name))).join(''),
    TABS.filter(([k]) => tabAllowed(k)).map(([k, label]) => tab(k, label)).join(''),
    '</nav>',
    '<section id="view">' + currentView(T) + '</section>',
  ].join('');
  renderStatus();
}

function currentView(T) {
  if (!tabAllowed(ui.tab) && !section(ui.tab)) return '';
  switch (ui.tab) {
    case 'master': return masterView(T);
    case 'transfer': return transferView();
    case 'receive': return receiveView();
    case 'machines': return machinesView();
    case 'admin': return adminView();
    default: return rackingView(T) + (isAdmin() ? palletTracking() : '');
  }
}

function header() {
  return '<header class="top"><div class="brand"><div class="mark" aria-hidden="true"></div><div><h1>Americase Visual Inventory</h1></div></div>' +
    '<div class="top-right"><div class="userbar">Signed in as <b>' + esc(app.me.id) + '</b> <span class="role ' + esc(app.me.role) + '">' + esc(ROLE_NAMES[app.me.role] || app.me.role) + '</span> · ' +
    '<button class="linkbtn" data-act="account">Change passkey</button> · <button class="linkbtn" data-act="logout">Sign out</button></div>' +
    '<div class="savebar" id="savebar"></div></div></header>';
}

function newerBanner() {
  const n = app.newer;
  if (!n) return '';
  return '<div class="banner" role="status"><span><b>' + esc(n.savedBy || 'Someone') + '</b> saved a newer version at ' + esc(when(n.savedAt)) + '. ' +
    (app.dirty ? 'Your unsaved changes were made on the older version. Load the latest to continue; your edits will be discarded.' : '') + '</span>' +
    '<button class="btn" data-act="reload">Load latest</button></div>';
}

function tab(k, label) {
  return '<button class="tab" role="tab" id="tab-' + k + '" aria-selected="' + (ui.tab === k) + '" data-act="tab" data-v="' + k + '">' + label + '</button>';
}

// The save status and buttons at the top right. Redrawn on its own while typing, so fields keep focus.
export function renderStatus() {
  const el = document.getElementById('savebar');
  if (!el) return;
  let cls = '', txt;
  if (!canEdit()) { cls = 'off'; txt = 'View only'; }
  else if (app.saving) txt = 'Saving…';
  else if (app.saveErr) { cls = 'dirty'; txt = app.saveErr; }
  else if (app.dirty) { cls = 'dirty'; txt = 'Unsaved changes'; }
  else txt = app.server.savedAt ? 'Saved ' + when(app.server.savedAt) + (app.server.savedBy ? ' by ' + app.server.savedBy : '') : 'Loaded from HQ_Metal_Racking.xlsx';
  el.innerHTML = '<span class="status ' + cls + '" role="status">' + esc(txt) + '</span>' +
    (canEdit() && app.dirty ? '<button class="btn ghost" data-act="revert">Undo all</button>' : '') +
    (canEdit() ? '<button class="btn primary" data-act="save" ' + (!app.dirty || app.saving || app.newer ? 'disabled' : '') + '>Save changes</button>' : '');
}
