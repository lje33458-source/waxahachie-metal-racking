// Small helpers with no knowledge of the app: escaping, number and date formatting, browser storage.

// Escapes text for use inside HTML. Every value from data or the user goes through this.
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A number, or 0 for anything that isn't one (blank quantities count as 0).
export function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

// 1234 -> "1,234"; 2.5 -> "2.5" (at most two decimals).
export function fmt(n) {
  const r = Math.round(n * 100) / 100;
  return r === Math.round(n) ? Math.round(n).toLocaleString() : r.toLocaleString();
}

// "s" when a count needs a plural: plural(2, 'pallet') -> "pallets".
export function plural(n, word) {
  return word + (n === 1 ? '' : 's');
}

// ISO time -> "Oct 21, 3:05 PM"; empty -> "never".
export function when(iso) {
  return iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
}

// "2026-10-21" -> "Oct 21, 2026"; empty -> "–".
export function day(d) {
  if (!d) return '–';
  const p = d.split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

// Today's date in the viewer's time zone, as "YYYY-MM-DD".
export function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

// A new key for a part added on the page.
export function uid() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// A new pallet's id. The server keeps it, so the pallet's history can be followed.
export function palletId() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

// localStorage, ignoring browsers that block it. remember(key) with no value removes the key.
export function remember(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* storage blocked */ }
}
export function recall(key) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}

export function byId(id) {
  return document.getElementById(id);
}

export function refocus(id) {
  const e = byId(id);
  if (e) e.focus();
}

// Green outline on a confirm step while it is waiting to be confirmed.
export function markStep(id, on) {
  const e = byId(id);
  if (e) e.classList.toggle('confirm-step', on);
}

// A random passkey like "K7QM-2XPA-…", same alphabet as the server's (no 0/O, 1/I).
const PASSKEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePasskey() {
  const a = new Uint32Array(16);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < 16; i++) s += (i && i % 4 === 0 ? '-' : '') + PASSKEY_CHARS[a[i] % PASSKEY_CHARS.length];
  return s;
}
