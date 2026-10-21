// Event wiring. Buttons and fields carry a data-act attribute naming their action; each tab's module registers
// what its actions do with on(), and one listener per event type looks the action up here.
//
//   on('click', 'addrow', target => …)       a click on any element with data-act="addrow"
//   on('change', 'xpart', target => …)       a change event (selects)
//   on('input', 'xqty', target => …)         every keystroke in a field
//   onSubmit('add-user-form', form => …)     a form's submit, by form id

import { app } from './state.js';

const handlers = { click: {}, change: {}, input: {} };
const submits = {};
const beforeClick = [];

export function on(type, act, fn) { handlers[type][act] = fn; }
export function onSubmit(formId, fn) { submits[formId] = fn; }
// Runs before every click action (used to disarm "click again to confirm" buttons).
export function onEveryClick(fn) { beforeClick.push(fn); }

export function listen(root) {
  root.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (!t || !app.me) return;
    // Selects and fields act on change/input, not click.
    if (t.tagName === 'SELECT' || t.tagName === 'INPUT') return;
    const act = t.dataset.act;
    beforeClick.forEach(fn => fn(act));
    if (handlers.click[act]) handlers.click[act](t, e);
  });
  for (const type of ['change', 'input']) {
    root.addEventListener(type, e => {
      const t = e.target, fn = t.dataset && handlers[type][t.dataset.act];
      if (fn) fn(t, e);
    });
  }
  // On document, so the sign-in form (shown before anyone is signed in) is covered too.
  document.addEventListener('submit', e => {
    const fn = submits[e.target.id];
    if (!fn) return;
    e.preventDefault();
    fn(e.target, e);
  });
}
