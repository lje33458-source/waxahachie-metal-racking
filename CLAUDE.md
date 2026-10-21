# Americase Visual Inventory: code map

Node 20+, two packages (`pg`, `@electric-sql/pglite`), no build step. Changes go to `main`; Vercel deploys on push.
Read only the section you need: `grep -n "if (p === '/api" lib/api.js` lists the routes; each page module starts with a comment saying what it holds.

## Server
- `lib/api.js`: every API route (one `route()` function), sign-in, roles, data checks. Builds the next racking document and hands it to the store.
- `lib/store.js`: all database access. Builds the racking document from the tables, and on save writes only the rows that changed, in one transaction with a version check. Also users, logs, failed sign-ins, backup export.
- `lib/schema.sql`: the tables, history triggers and reporting views. Bump `SCHEMA_VERSION` in store.js when changing it.
- `lib/db.js`: Postgres via `DATABASE_URL`, else embedded PGlite in `DATA_DIR/pgdata`.
- `lib/legacy.js`: reads the old Redis / JSON-file data for the one-time copy into an empty database; writes it back for a rollback (`scripts/rollback-to-redis.js`).
- `server.js`: local server (serves `public/`). `api/index.js` + `vercel.json`: Vercel.
- `docs/DATABASE.md`: tables and every query per endpoint, for IT. Keep it in step with store.js.

## Page (public/)
ES modules, HTML built as strings. `js/main.js` boots; `state.js` (shared state), `model.js` (parts, pallets, totals, permissions),
`render.js` (layout + tabs), `saving.js` (save, drafts, 20 s polling), `events.js` (actions), `api.js`.
One file per tab in `js/views/`: racking (incl. Pallet tracking), master, transfer, receive, machines, logs, sheet (print sheets), admin, account (sign-in, passkey).
Buttons and fields carry `data-act="name"`; the tab's module handles it with `on('click', 'name', target => …)`.
`styles.css`: base styles first, then one block per feature, in the order they were added.

## Data
Document shape the page uses (`GET /api/data`): `{version, parts[], sections[{key, name, rows[{row, racks[{rack, label, levels[{level, height, items[pallet]}]}]}]}], machines{EMK|EMLK|P4|L5: [pallet + from, batch, requested]}}`; pallet = `{id, part, qty, routing, received}`.
Tables: parts, sections, rack_rows, racks, levels, pallets (racking or machine), stock_moves (transfer log), activity (admin log), users, history (every change, by trigger).
Writes: `store.saveRacking(baseVersion, next, { by, move, activity })`; build `next` with `nextDoc()` in api.js. Pallets keep their `id` across moves.

## Test locally
`npm install`, then `NODE_PATH=/opt/node-tools/node_modules npm test` (Playwright + Chromium at /opt/pw-browsers).
Real Postgres: add `TEST_DATABASE_URL=postgres://…`. Manual run: `DATA_DIR=<scratch dir> ADMIN_PASSKEY=testpass123 PORT=3111 node server.js`.
