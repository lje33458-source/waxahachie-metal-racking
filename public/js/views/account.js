// Sign-in screen, sign-out, and the change-your-passkey panel.
import { app, ui } from '../state.js';
import { esc, byId, refocus } from '../util.js';
import { api } from '../api.js';
import { render } from '../render.js';
import { on, onSubmit } from '../events.js';
import { start } from '../main.js';

export function showLogin(msg) {
  document.getElementById('app-root').innerHTML =
    '<div class="login-wrap"><form class="login" id="login-form" autocomplete="on">' +
    '<div class="brand"><div class="mark" aria-hidden="true"></div><h1>Americase Visual Inventory</h1></div>' +
    '<div class="field"><label for="login-id">User ID</label><input id="login-id" name="username" autocomplete="username" required autocapitalize="none" spellcheck="false"></div>' +
    '<div class="field"><label for="login-pk">Passkey</label><input id="login-pk" name="password" type="password" autocomplete="current-password" required></div>' +
    '<p class="err" id="login-err" role="alert">' + esc(msg || '') + '</p>' +
    '<button class="btn primary" type="submit" id="login-btn">Sign in</button></form></div>';
  refocus('login-id');
}

onSubmit('login-form', () => {
  const btn = byId('login-btn'), err = byId('login-err');
  btn.disabled = true;
  err.textContent = '';
  api('POST', '/api/login', { userId: byId('login-id').value, passkey: byId('login-pk').value })
    .then(j => { app.me = j.user; return start(); })
    .catch(x => { btn.disabled = false; if (!x.silent) err.textContent = x.message; });
});

on('click', 'logout', () => {
  api('POST', '/api/logout', {}).finally(() => { app.me = null; showLogin(''); });
});

export function accountPanel() {
  return '<form class="account" id="account-form"><div class="panel-h"><h3>Change your passkey</h3><button class="btn ghost sm" type="button" data-act="account">Close</button></div>' +
    '<div class="formrow">' +
    '<div class="field"><label for="acc-cur">Current passkey</label><input id="acc-cur" type="password" autocomplete="current-password" required></div>' +
    '<div class="field"><label for="acc-new">New passkey</label><input id="acc-new" type="password" autocomplete="new-password" minlength="8" required></div>' +
    '<div class="field"><label for="acc-new2">Confirm new passkey</label><input id="acc-new2" type="password" autocomplete="new-password" minlength="8" required></div>' +
    '<button class="btn primary" type="submit">Update passkey</button></div>' +
    '<p class="err" id="acc-msg" role="alert" style="padding:0 14px 12px"></p></form>';
}

on('click', 'account', () => {
  ui.account = !ui.account;
  render();
  if (ui.account) refocus('acc-cur');
});

onSubmit('account-form', () => {
  const msg = byId('acc-msg'), next = byId('acc-new').value;
  if (next !== byId('acc-new2').value) { msg.textContent = 'The new passkeys do not match.'; return; }
  api('POST', '/api/me/passkey', { current: byId('acc-cur').value, next })
    .then(() => {
      ui.account = false;
      render();
      const s = document.querySelector('.status');
      if (s) s.textContent = 'Passkey updated';
    })
    .catch(x => { if (!x.silent) msg.textContent = x.message; });
});
