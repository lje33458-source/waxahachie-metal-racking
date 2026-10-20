# Americase Visual Inventory: code map

Plain Node 18, no packages. Changes go straight to `main`; Vercel deploys on push.
Read only the section you need: `grep -n "^/\* ---------- " public/app.js` and `grep -n "if (p === '/api" lib/api.js` list them with line numbers.

## Files
- `lib/api.js`: every API route (one `route()` function), data cleaning, migrations. `lib/store.js`: Upstash Redis or JSON files.
- `public/app.js`: the whole page, one IIFE. HTML is built as strings; one click/change/input listener each at the bottom (`/* events */`) dispatches on `data-act`.
- `public/styles.css`: base styles first, then one block per feature, in the order they were added.
- `server.js`: local server. `api/index.js` + `vercel.json`: Vercel.

## public/app.js sections
helpers · sign in · totals · render (tabs, racking, master) · material transfer (incl. `sheet()` print sheet) · receive material · machines (cards, return to rack) · logs (`LOGS`, `logPanel`) · pallet tracking · admin · saving (polling) · events · boot

## Data (Redis key `wmr:racking`, one JSON doc with a version)
- `parts[]` {k, number (Part Number, shown everywhere), description, partId (hidden), qtyPerPallet, …}
- `sections[]` {key, name, rows[{row, racks[{rack, levels[{level, height, items[pallet]}]}]}]}; pallet = {part, qty, routing, received}
- `machines` {EMK|EMLK|P4|L5: [pallet at machine, with `from` spot, `batch`, `requested`]}
- Transfer log: Redis list `wmr:transfers` (kinds transfer, return, receive). Admin activity: `wmr:audit`.
- Writes go through `store.saveRacking(baseVersion, doc)`; build `next` with parts, sections + parked, machines, migrations.

## Test locally
`DATA_DIR=<scratch dir> ADMIN_PASSKEY=testpass123 PORT=3111 node server.js`, then drive it with Playwright (Chromium at /opt/pw-browsers, `NODE_PATH=/opt/node-tools/node_modules`).
