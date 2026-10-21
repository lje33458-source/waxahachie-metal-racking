// Admin tab: add users, change roles, reset passkeys, disable or delete accounts, the activity log, and a backup download.
import { app, ui, ROLE_NAMES } from '../state.js';
import { esc, when, byId, refocus, generatePasskey } from '../util.js';
import { api } from '../api.js';
import { render } from '../render.js';
import { on, onSubmit, onEveryClick } from '../events.js';

// created: { id, pk } just added or reset, shown once; resetFor: the user whose passkey is being reset;
// armed: the user whose Delete button waits for its second click.
const admin = { users: [], log: [], msg: '', err: '', created: null, resetFor: null, armed: null };

const ACTIONS = {
  'login': 'Signed in', 'login-failed': 'Failed sign-in', 'save': 'Saved racking', 'create-user': 'Added user', 'update-user': 'Changed user',
  'delete-user': 'Deleted user', 'change-passkey': 'Changed own passkey', 'transfer': 'Transferred material', 'return': 'Returned to rack',
  'undo-transfers': 'Undid all transfers', 'import': 'Copied old data', 'import-warning': 'Old data changed after copy', 'export': 'Downloaded backup',
};
const ROLE_ORDER_NEW = ['handler', 'shipping', 'supervisor', 'viewer', 'admin']; // most likely first when adding
const ROLE_ORDER = ['viewer', 'handler', 'shipping', 'supervisor', 'admin'];

export function loadAdmin() {
  return Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/audit')])
    .then(([u, a]) => { admin.users = u.users; admin.log = a.entries; if (ui.tab === 'admin') render(); })
    .catch(x => { if (!x.silent) { admin.err = x.message; render(); } });
}

export function adminView() {
  return '<div class="stack">' + addUserForm() + usersTable() + activityTable() + backupPanel() + '</div>';
}

function addUserForm() {
  return '<form class="panel" id="add-user-form"><div class="panel-h"><h3>Add user</h3></div>' +
    '<div class="formrow">' +
    '<div class="field"><label for="nu-id">User ID</label><input id="nu-id" autocomplete="off" autocapitalize="none" spellcheck="false" required pattern="[A-Za-z0-9._\\-]{2,40}" title="2–40 letters, numbers, dots, dashes or underscores"></div>' +
    '<div class="field"><label for="nu-role">Role</label><select id="nu-role">' + ROLE_ORDER_NEW.map(r => '<option value="' + r + '">' + ROLE_NAMES[r] + '</option>').join('') + '</select></div>' +
    '<div class="field grow"><label for="nu-pk">Passkey</label><div class="pkrow"><input id="nu-pk" autocomplete="new-password" minlength="8" required spellcheck="false"><button class="btn" type="button" data-act="genpk" data-for="nu-pk">Generate</button></div></div>' +
    '<button class="btn primary" type="submit">Add user</button></div>' +
    (admin.created ? '<div class="notice" role="status"><span>Give <b>' + esc(admin.created.id) + '</b> this passkey. The app keeps only a scrambled copy, so it cannot be shown again.</span><code>' + esc(admin.created.pk) + '</code>' +
      '<button class="btn sm" type="button" data-act="copy" data-v="' + esc(admin.created.pk) + '">Copy</button><button class="btn ghost sm" type="button" data-act="dismiss">Done</button></div>' : '') +
    (admin.err ? '<p class="err" role="alert" style="padding:0 14px 12px">' + esc(admin.err) + '</p>' : '') +
    (admin.msg ? '<p class="ok-msg" role="status" style="padding:0 14px 12px">' + esc(admin.msg) + '</p>' : '') +
    '</form>';
}

function usersTable() {
  let h = '<div class="panel"><div class="panel-h"><h3>Users</h3></div><div class="scroll"><table><thead><tr><th>User ID</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Added</th><th class="r">Actions</th></tr></thead><tbody>';
  admin.users.forEach(u => {
    const self = u.id === app.me.id, key = encodeURIComponent(u.id), d = 'data-u="' + esc(u.id) + '"';
    h += '<tr><td><b>' + esc(u.id) + '</b>' + (self ? ' <span class="dim">(you)</span>' : '') + '</td>' +
      '<td><select data-act="setrole" ' + d + ' aria-label="Role for ' + esc(u.id) + '">' + ROLE_ORDER.map(r => '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + ROLE_NAMES[r] + '</option>').join('') + '</select></td>' +
      '<td><span class="statuspill ' + (u.active ? 'on' : 'off') + '">' + (u.active ? 'Active' : 'Disabled') + '</span></td>' +
      '<td class="dim">' + esc(when(u.lastLogin)) + '</td><td class="dim">' + esc(when(u.createdAt)) + (u.createdBy ? ' by ' + esc(u.createdBy) : '') + '</td><td>';
    if (admin.resetFor === u.id) {
      h += '<div class="inline-reset"><input id="rp-' + key + '" aria-label="New passkey for ' + esc(u.id) + '" minlength="8" spellcheck="false" autocomplete="new-password">' +
        '<button class="btn sm" data-act="genpk" data-for="rp-' + key + '">Generate</button><button class="btn primary sm" data-act="savereset" ' + d + '>Set passkey</button><button class="btn ghost sm" data-act="cancelreset">Cancel</button></div>';
    } else {
      h += '<div class="actions"><button class="btn sm" data-act="reset" ' + d + '>Reset passkey</button>' +
        (self ? '' : '<button class="btn sm" data-act="toggle" ' + d + '>' + (u.active ? 'Disable' : 'Enable') + '</button>' +
          '<button class="btn danger sm' + (admin.armed === u.id ? ' armed' : '') + '" data-act="deluser" ' + d + '>' + (admin.armed === u.id ? 'Confirm delete' : 'Delete') + '</button>') + '</div>';
    }
    h += '</td></tr>';
  });
  return h + '</tbody></table></div></div>';
}

function activityTable() {
  let h = '<div class="panel"><div class="panel-h"><h3>Activity</h3><button class="btn ghost sm" data-act="refreshlog">Refresh</button></div><div class="scroll"><table class="log"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>';
  if (!admin.log.length) h += '<tr><td colspan="4" class="empty-note">No activity yet.</td></tr>';
  // Transfers and returns have their own log on the Master tab.
  admin.log.filter(e => e.action !== 'transfer' && e.action !== 'return').slice(0, 100).forEach(e => {
    h += '<tr><td class="dim">' + esc(when(e.at)) + '</td><td>' + esc(e.user) + '</td><td>' + esc(ACTIONS[e.action] || e.action) + '</td><td class="detail dim">' + esc(e.detail) + '</td></tr>';
  });
  return h + '</tbody></table></div></div>';
}

function backupPanel() {
  return '<div class="panel"><div class="panel-h"><h3>Backup</h3><p>Everything in one file: racking, parts, pallets at machines, users and both logs.</p>' +
    '<a class="btn" href="/api/admin/export" download>Download backup</a></div></div>';
}

// Runs an admin request, then shows okMsg and reloads the lists (or shows the error).
function adminDo(request, okMsg) {
  admin.err = ''; admin.msg = '';
  return request
    .then(() => { admin.msg = okMsg || ''; admin.armed = null; admin.resetFor = null; return loadAdmin(); })
    .catch(x => { if (!x.silent) { admin.err = x.message; render(); } });
}
const userUrl = id => '/api/admin/users/' + encodeURIComponent(id);

/* ---------- actions ---------- */
onEveryClick(act => { if (act !== 'deluser' && admin.armed) admin.armed = null; });

onSubmit('add-user-form', () => {
  const id = byId('nu-id').value.trim(), role = byId('nu-role').value, pk = byId('nu-pk').value;
  adminDo(api('POST', '/api/admin/users', { userId: id, role, passkey: pk }).then(() => { admin.created = { id, pk }; }), 'Added ' + id + '.');
});
on('click', 'genpk', t => {
  const f = byId(t.dataset.for);
  if (f) { f.value = generatePasskey(); f.focus(); }
});
on('click', 'copy', t => {
  (navigator.clipboard ? navigator.clipboard.writeText(t.dataset.v) : Promise.reject())
    .then(() => { t.textContent = 'Copied'; }, () => { t.textContent = 'Select and copy'; });
});
on('click', 'dismiss', () => { admin.created = null; render(); });
on('click', 'reset', t => {
  admin.resetFor = t.dataset.u; admin.err = ''; admin.msg = '';
  render();
  refocus('rp-' + encodeURIComponent(t.dataset.u));
});
on('click', 'cancelreset', () => { admin.resetFor = null; render(); });
on('click', 'savereset', t => {
  const u = t.dataset.u, input = byId('rp-' + encodeURIComponent(u)), pk = input ? input.value : '';
  adminDo(api('PATCH', userUrl(u), { passkey: pk }).then(() => { admin.created = { id: u, pk }; }), 'Passkey reset for ' + u + '. Their other sessions were signed out.');
});
on('click', 'toggle', t => {
  const u = admin.users.find(x => x.id === t.dataset.u);
  if (!u) return;
  adminDo(api('PATCH', userUrl(u.id), { active: !u.active }), u.id + (u.active ? ' disabled.' : ' enabled.'));
});
on('click', 'deluser', t => {
  if (admin.armed !== t.dataset.u) { admin.armed = t.dataset.u; render(); return; }
  adminDo(api('DELETE', userUrl(t.dataset.u)), t.dataset.u + ' deleted.');
});
on('click', 'refreshlog', () => loadAdmin());
on('change', 'setrole', t => {
  adminDo(api('PATCH', userUrl(t.dataset.u), { role: t.value }), t.dataset.u + ' is now ' + (ROLE_NAMES[t.value] || t.value) + '.');
});
