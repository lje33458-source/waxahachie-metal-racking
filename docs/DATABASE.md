# Database: tables and every query the server makes

Americase Visual Inventory stores its data in **Postgres**. On Vercel that is a Neon database connected through
`DATABASE_URL` (or `POSTGRES_URL`); locally and in Docker, when no `DATABASE_URL` is set, an embedded Postgres
(PGlite) keeps its files in `DATA_DIR/pgdata`. Both run the same SQL.

All database access is in [`lib/store.js`](../lib/store.js); the tables are defined in [`lib/schema.sql`](../lib/schema.sql).
Nothing else talks to the database.

## Tables

| Table | One row per | Notes |
|---|---|---|
| `meta` | (one row) | `version` of the racking data, bumped on every change; `saved_at`, `saved_by`; where the data was first copied from. |
| `settings` | setting | Schema version, local cookie-signing key (only off Vercel), import notes. |
| `users` | user | `role` is one of viewer, supervisor, handler, shipping, admin. `passkey_hash` is scrypt; passkeys are never stored. `session_version` signs a user out everywhere when raised. User IDs are unique ignoring case. |
| `parts` | part on the Master list | `number` is the Part Number shown everywhere; `position` is the list order. |
| `sections` | racking area (tab) | Only `hq` ("Racking") is switched on; others stay stored if switched off. |
| `rack_rows` | row in a section | `row` is text ('2', '3', … or a letter). |
| `racks` | rack in a row | `label` e.g. "12 ft". |
| `levels` | level of a rack | `height` in inches. Primary key `(section, row, rack, level)`. |
| `pallets` | pallet in stock | Either on the racking (`section, row, rack, level` set) or at a machine (`machine` set, with `from_*` = the spot it came from, `batch`, `requested`, `moved_at`, `moved_by`). Used-up pallets are deleted (the history keeps them). |
| `stock_moves` | transfer, return or receipt | The transfer log. `entry` (jsonb) is the log line as the page shows it. |
| `activity` | admin-log event | Sign-ins, failed sign-ins (with IP), saves, user changes, backups. |
| `login_failures` | IP + User ID with recent failures | 5 failures lock sign-in for 15 minutes; rows expire. |
| `history` | change to any row | Filled by triggers on `parts, sections, rack_rows, racks, levels, pallets, users`: the row before (`old_row`) and after (`new_row`), `op` (INSERT/UPDATE/DELETE), `actor` (User ID), time. Passkey hashes and sign-in times are left out. |

Foreign keys tie racks to rows, levels to racks and pallets on the racking to their level. Pallets refer to
parts by `part_k` without a foreign key, because a pallet at a machine keeps a part that was since removed from Master.

### Views for reporting

| View | Shows |
|---|---|
| `stock_on_racking` | Every pallet on the racking with part number, quantity, routing #, date received and location. |
| `stock_at_machines` | Every pallet at a machine, where it came from, who moved it and when. |
| `stock_by_part` | Per part: quantity and pallets on the racking, quantity at machines. |

Example queries:

```sql
-- Everything that happened to one pallet
SELECT at, actor, op, old_row->>'qty' AS qty_before, new_row->>'qty' AS qty_after, new_row->>'machine' AS machine
FROM history WHERE table_name = 'pallets' AND row_key = 'abc123' ORDER BY id;

-- Who changed the Master list this week
SELECT at, actor, op, coalesce(new_row, old_row)->>'number' AS part_number FROM history
WHERE table_name = 'parts' AND at > now() - interval '7 days' ORDER BY at;

-- Sheets sent to each machine last month
SELECT machine, sum(qty) FROM stock_moves WHERE kind = 'transfer' AND at > now() - interval '1 month' GROUP BY machine;
```

## How a change is saved

Every change (an admin save, a transfer, a return, a receipt) runs in **one transaction**:

1. `SELECT set_config('app.actor', <user>, true)` so the history triggers record who made the change.
2. `SELECT version FROM meta WHERE id = 1 FOR UPDATE`. If the version is not the one the change was based on,
   someone else saved first: nothing is written and the user is told (the page offers to load the newer version;
   transfers, returns and receipts retry up to 5 times against the latest data).
3. For each of `parts, sections, rack_rows, racks, levels, pallets`: read the current rows, compare with the new data,
   then one `DELETE`, one `UPDATE` and one `INSERT` statement for the rows that differ (each takes all its rows as one JSON parameter).
4. `UPDATE meta SET version = version + 1, saved_at, saved_by`.
5. `INSERT INTO stock_moves` (transfer, return, receive) or `INSERT INTO activity` (admin save).

So the stock change and its log line are recorded together or not at all.

## Queries per request

"Auth" is the check every signed-in request makes first: `SELECT * FROM users WHERE lower(id) = lower($1)` (1 query).
"Read racking" is 7 `SELECT`s: `meta`, `parts`, `sections`, `rack_rows`, `racks`, `levels`, `pallets`.

| Endpoint | Who | Queries | Writes |
|---|---|---|---|
| `GET /api/health` | anyone | none | – |
| `POST /api/login` (success) | anyone | `SELECT login_failures`; `SELECT users` (one user); `UPDATE users SET last_login`; `INSERT activity`; `DELETE login_failures` if there were failures | yes |
| `POST /api/login` (wrong passkey) | anyone | `SELECT login_failures`; `SELECT users`; `DELETE` expired + `INSERT … ON CONFLICT UPDATE login_failures`; `INSERT activity` | yes |
| `POST /api/logout` | anyone | none (clears the cookie) | – |
| `GET /api/me` | signed in | auth | – |
| `POST /api/me/passkey` | signed in | auth; `UPDATE users` (hash, session version); `INSERT activity` | yes |
| `GET /api/version` (**every 20 s per open tab**) | signed in | auth; `SELECT version, saved_at, saved_by FROM meta` | – |
| `GET /api/data` | signed in | auth; read racking | – |
| `PUT /api/data` (admin saves racking / Master) | admin | auth; read racking; the save transaction above with an `activity` row. On conflict: `SELECT meta` | yes |
| `POST /api/transfer` | admin, supervisor, handler | auth; read racking; save transaction with a `stock_moves` row; read racking (sent back to the page) | yes |
| `POST /api/return` | admin, supervisor, handler | same as transfer | yes |
| `POST /api/receive` | admin, supervisor, shipping | same as transfer | yes |
| `GET /api/transfers?range=` | signed in (year / all: admin) | auth; `SELECT entry FROM stock_moves WHERE at >= $1 ORDER BY at DESC LIMIT 10000` | – |
| `GET /api/admin/users` | admin | auth; `SELECT * FROM users` | – |
| `POST /api/admin/users` | admin | auth; `SELECT users` (ID taken?); `INSERT users … ON CONFLICT DO NOTHING`; `INSERT activity` | yes |
| `PATCH /api/admin/users/:id` | admin | auth; `SELECT * FROM users` (keep-one-admin check); `UPDATE users` (that user only); `INSERT activity` | yes |
| `DELETE /api/admin/users/:id` | admin | auth; `SELECT * FROM users`; `DELETE FROM users`; `INSERT activity` | yes |
| `GET /api/admin/audit` | admin | auth; `SELECT … FROM activity ORDER BY at DESC LIMIT 150` | – |
| `GET /api/admin/export` (Backup download) | admin | auth; `INSERT activity`; read racking; `SELECT users`, all `stock_moves`, all `activity` | log only |

Once per server start (Vercel starts a new instance after a deploy or a quiet spell):

- Create tables if the schema version changed (`CREATE … IF NOT EXISTS`, under an advisory lock).
- If `meta` is empty: copy the old data in (see below).
- If the data was copied from Redis and Redis is still connected: one Redis `GET wmr:racking:version` to warn
  (in the activity log) if the old app saved after the copy.
- If there are no users: create `admin` from `ADMIN_PASSKEY`.

### Load

The page polls `/api/version` every 20 s while the tab is visible: 2 small indexed queries, no racking data
(before, every poll read the whole racking document).

Neon bills by compute time rather than by query, and suspends the database after a few idle minutes. Any open,
visible tab keeps it awake. Working hours only (10 h × 22 days at the smallest size) is roughly 55 compute-hours a
month; a screen left open around the clock is roughly 180. Compare with the allowance of the Neon plan in use: if a
floor screen stays on overnight, either close it after hours or use a paid plan.

## First start: copying the old data

When the database is empty, the server reads the old data once (Upstash Redis keys `wmr:racking`, `wmr:users`,
`wmr:transfers`, `wmr:audit`, or the JSON files in `DATA_DIR`) and copies it into the tables in one transaction.
The old data is **not changed or deleted**; it stays as a backup.

During the copy the routing numbers and dates the old app made up for pallets without one are recognised (they
are computed from the pallet's spot, so they can be recomputed) and cleared. The activity log records how many;
the full list is in `settings` under `import_cleared_placeholders`.

## Backups and rollback

- **Neon** keeps point-in-time history of the database (how far back depends on the plan); restores are done in the Neon console.
- **Admin > Backup > Download backup** gives a JSON file with everything (racking, pallets at machines, users with
  passkey hashes, both logs) in the format the earlier Redis version of the app used.
- **Rollback to the Redis version**: download a backup, then with the Upstash URL and token
  `KV_REST_API_URL=… KV_REST_API_TOKEN=… node scripts/rollback-to-redis.js backup.json`, and redeploy the earlier
  commit. The earlier app then runs on today's data. (`tests/migration.test.js` does exactly this.)
