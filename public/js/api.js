// Calls to the server. Every request sends the X-WMR header, which the server requires on changes (blocks cross-site requests).

let onSignedOut = () => {};
// What to do when the server says the session has ended (set by main.js).
export function whenSignedOut(fn) { onSignedOut = fn; }

// Resolves with the JSON body. Rejects with { status, body, message }, or { silent: true } when the
// session ended (the sign-in screen is already showing then, so callers need not show an error).
export function api(method, url, body) {
  return fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-WMR': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(r => r.json().catch(() => ({})).then(j => {
    if (r.status === 401 && url !== '/api/login') {
      onSignedOut();
      throw { silent: true };
    }
    if (!r.ok) throw { status: r.status, body: j, message: j.error || 'Something went wrong.' };
    return j;
  }));
}
