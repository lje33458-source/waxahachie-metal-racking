// Americase Visual Inventory: the page. Starts here.
//
//   state.js      shared state (who is signed in, the data, which tab)
//   model.js      questions about the data: parts, pallets, totals, permissions
//   render.js     draws the page; each tab's view is in views/
//   saving.js     loading, saving, drafts, noticing other people's saves
//   events.js     buttons and fields name an action in data-act; modules say what each action does with on()
//   api.js        calls to the server
//
// The page is drawn as HTML strings and redrawn after each change; there is no framework or build step.

import { app, ui } from './state.js';
import { recall, remember, refocus } from './util.js';
import { api, whenSignedOut } from './api.js';
import { tabAllowed, section, isSectionTab, canEdit } from './model.js';
import { render } from './render.js';
import { useServerData, saveUi, startPolling } from './saving.js';
import { listen, on, onEveryClick } from './events.js';
import { showLogin } from './views/account.js';
import { loadLog } from './views/logs.js';
import { loadAdmin } from './views/admin.js';
import { resetReceive } from './views/receive.js';
import './views/racking.js';
import './views/master.js';
import './views/transfer.js';
import './views/machines.js';

// After signing in: load the data, go back to the tab and rows used last time, and restore any unsaved draft.
export function start() {
  resetReceive();
  return api('GET', '/api/data').then(d => {
    useServerData(d);
    app.dirty = false;
    app.saveErr = '';
    const pref = recall('wmr-ui:' + app.me.id) || {};
    ui.tab = pref.tab || 'hq';
    if (isSectionTab(ui.tab) ? !section(ui.tab) : !tabAllowed(ui.tab)) ui.tab = 'hq';
    ui.rows = pref.rows || {};
    if (location.hash === '#master') ui.tab = 'master';
    const draft = recall('wmr-draft:' + app.me.id);
    if (draft && draft.base === app.server.version && canEdit() && draft.state && Array.isArray(draft.state.sections)) {
      app.data = draft.state;
      app.dirty = true;
    } else remember('wmr-draft:' + app.me.id);
    render();
    if (ui.tab === 'admin') loadAdmin();
    loadLog();
  });
}

on('click', 'tab', t => {
  ui.tab = t.dataset.v;
  ui.armed = null;
  saveUi();
  render();
  refocus('tab-' + ui.tab);
  if (ui.tab === 'admin') loadAdmin();
  loadLog();
});

// Any other click disarms a "click again to confirm" remove button.
onEveryClick(act => {
  if (act !== 'delrow' && act !== 'delpart' && ui.armed) {
    ui.armed = null;
    if (act !== 'tab' && act !== 'row') render();
  }
});

whenSignedOut(() => {
  const had = !!app.me;
  app.me = null;
  showLogin(had ? 'Your session ended. Please sign in again.' : '');
});

listen(document.getElementById('app-root'));
startPolling();
api('GET', '/api/me').then(j => { app.me = j.user; return start(); }).catch(x => { if (!x.silent) showLogin(''); });
