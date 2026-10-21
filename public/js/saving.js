// Loading and saving the racking data, unsaved-edit drafts, and checking for other people's saves.
import { app, ui } from './state.js';
import { clone, remember } from './util.js';
import { api } from './api.js';
import { canEdit } from './model.js';
import { render, renderStatus } from './render.js';
import { on } from './events.js';

const POLL_MS = 20000;
const draftKey = () => 'wmr-draft:' + app.me.id;

// Takes fresh data from the server as both the saved and the working copy.
export function useServerData(d) {
  app.server = d;
  app.data = clone({ parts: d.parts, sections: d.sections });
  app.newer = null;
}

// Call after every edit an admin makes: marks the page unsaved and keeps a draft in the browser,
// so a reload doesn't lose the edits.
export function changed() {
  app.dirty = true;
  app.saveErr = '';
  remember(draftKey(), { base: app.server.version, state: app.data });
  renderStatus();
}

// Remembers the tab and rows picked, per user.
export function saveUi() {
  remember('wmr-ui:' + app.me.id, { tab: ui.tab, rows: ui.rows });
}

export function save() {
  if (!app.dirty || app.saving || !canEdit()) return;
  app.saving = true;
  app.saveErr = '';
  renderStatus();
  api('PUT', '/api/data', { baseVersion: app.server.version, parts: app.data.parts, sections: app.data.sections })
    .then(j => {
      app.saving = false;
      app.dirty = false;
      app.server = Object.assign({}, app.server, { version: j.version, savedAt: j.savedAt, savedBy: j.savedBy, parts: clone(app.data.parts), sections: clone(app.data.sections) });
      remember(draftKey());
      renderStatus();
    })
    .catch(x => {
      app.saving = false;
      if (x.silent) return;
      // Someone else saved first: show the banner offering to load their version.
      if (x.status === 409) { app.newer = x.body; render(); return; }
      app.saveErr = x.message || 'Save failed. Try again.';
      renderStatus();
    });
}

// Throws away unsaved edits and loads what is on the server.
export function reloadLatest() {
  return api('GET', '/api/data').then(d => {
    useServerData(d);
    app.dirty = false;
    app.saveErr = '';
    remember(draftKey());
    render();
  }).catch(() => {});
}

function revert() {
  app.data = clone({ parts: app.server.parts, sections: app.server.sections });
  app.dirty = false;
  app.saveErr = '';
  remember(draftKey());
  render();
}

// A field has focus: don't redraw under the user's cursor.
function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT');
}

// Every 20 seconds, while the tab is visible, ask whether someone else saved. Load their version straight
// away if nothing here is unsaved and nobody is typing; otherwise show the banner.
export function startPolling() {
  setInterval(() => {
    if (!app.me || app.saving || document.hidden) return;
    api('GET', '/api/version').then(v => {
      if (v.version === app.server.version) return;
      if (!app.dirty && !isTyping()) { reloadLatest(); return; }
      if (!app.newer || app.newer.version !== v.version) { app.newer = v; render(); }
    }).catch(() => {});
  }, POLL_MS);
  window.addEventListener('beforeunload', e => {
    if (app.dirty && !app.saving) { e.preventDefault(); e.returnValue = ''; }
  });
}

on('click', 'save', () => save());
on('click', 'reload', () => reloadLatest());
on('click', 'revert', () => revert());
