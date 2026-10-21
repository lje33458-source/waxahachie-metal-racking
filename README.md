# Americase Visual Inventory

A shared web app for Americase racking. People sign in with a **User ID + passkey**, assign Part IDs and quantities to rack addresses, and keep the Metal Master list. Admins manage users from the **Admin** tab.

- **Racking**: (admins also get a Pallet tracking sheet under the racks, to edit routing numbers and dates received and to add or remove pallets) pick a row, then set the Part ID and quantity at each address (`row-rack-level`). (Separate Challenger and HQ PF1 sections are built in but switched off; see `SECTIONS` in `lib/api.js`.)
- **Master**: the parts list (by Part Number), and for admins a Transfer Log of every transfer and receipt (drop-down filters for date and for machine or receiving, with Reset to default), with total quantity, locations and pallets for each part, plus a part-by-row breakdown.
- **Receive Material**: pick the part number, how many pallets came in, the quantity and routing number on each (both required) and the date received, press Confirm, then click an open spot on the racking map for each pallet. A one-page put-away sheet marks the spots; receiving adds the pallets to the racking. A Receiving Log sits underneath.
- **Transfer Material**: pick a part number and the quantity needed. Pallets are listed oldest received first, with the oldest two marked Recommended. Choose one green pallet (holds enough on its own) or two pallets that add up (yellow ones hold less; once one is picked, pallets that can't make up the rest turn red). Whole pallets move, two at most. A selected / requested total and a Selected Pallets list show the picks; the machine buttons (EMK, EMLK, P4, L5) appear once enough is selected, and choosing one shows a one-page printable pick sheet. Editors and admins only.
- **Machine**: one card per machine (2 × 2) showing the pallets there drawn as pallets, each with its part number, the rack spot it came from and pallet qty / requested. **Return to Rack** on a card takes the quantity used at that machine off the pallets (oldest received first) and sends what is left on each pallet back to its original spot; pallets used up completely go to Used instead. The quantity used must be confirmed first. A one-page printable sheet goes with it. Below: **Material at Machine** totals and the **Machine Transfer Log** with From and To columns (Today, Last week, Last month; admins also Last year and All time).
- **Admin** (admins only): add users, set roles, reset passkeys, disable or delete accounts, see an activity log of sign-ins, saves and user changes, and download a full backup.

Roles:

| Role                   | Tabs                                         | Can do                                   |
|------------------------|----------------------------------------------|------------------------------------------|
| Viewer                 | all but Admin                                | look only                                |
| Material Handler       | Racking (view only), Transfer Material, Machine | transfer to machines, return to rack  |
| Shipping and Receiving | Racking (view only), Receive Material        | receive material                         |
| Supervisor             | all but Admin; Racking view only, no pallet quantities there | receive, transfer, return to rack |
| Admin                  | all, plus Pallet tracking                    | everything, incl. racking/Master edits and users |

The server enforces the same rules.

Data is kept in Postgres: parts, racks, levels and pallets each have their own table, and every change is recorded
with who made it. See [docs/DATABASE.md](docs/DATABASE.md) for the tables and every query the server makes.

## Requirements

Node.js 20 or newer. Two packages: `pg` (Postgres client) and `@electric-sql/pglite` (embedded Postgres for local use).

## Run it

```bash
npm install
ADMIN_PASSKEY='choose-a-strong-passkey' node server.js
```

Without `DATABASE_URL` the app keeps an embedded Postgres in `./data/pgdata`. To use a Postgres server instead,
set `DATABASE_URL=postgres://…`; the tables are created on first start.

Open http://localhost:3000 and sign in as **admin** with that passkey.

`ADMIN_PASSKEY` is only used the very first time, to create the `admin` account. If you leave it out, the server makes up a passkey and prints it once in the console. Change it after you sign in (**Change passkey** at the top right).

On Windows PowerShell:

```powershell
$env:ADMIN_PASSKEY='choose-a-strong-passkey'; node server.js
```

## Tests

```bash
NODE_PATH=/path/to/playwright/node_modules npm test       # embedded Postgres
TEST_DATABASE_URL=postgres://user@host/postgres npm test   # a real Postgres server (a new database per test file)
```

`tests/api.test.js` covers sign-in, roles and the checks against two people saving at once; `tests/e2e.test.js`
drives every tab in a browser (needs Playwright with Chromium); `tests/migration.test.js` covers the copy from
the old Redis / file storage and the rollback.

## Deploy to Vercel

Vercel doesn't keep files between requests, so on Vercel the app stores its data in a **Neon Postgres** database connected through Vercel's Storage tab. The app picks it up automatically.

1. **Install the Vercel CLI and sign in** with the account that owns your other projects (Node.js 20+ required):
   ```bash
   npm i -g vercel
   vercel login
   ```
2. **Create the project.** From inside this folder run:
   ```bash
   vercel
   ```
   Answer the prompts: pick the **same scope (team or personal account)** your other projects use, choose *No* to linking an existing project, name it `waxahachie-metal-racking`, keep the folder as `./`, and accept the detected settings (no build command needed).
3. **Add the database.** In the Vercel dashboard open the project → **Storage** → **Create Database** → **Neon** (Serverless Postgres) → pick the region closest to your Vercel functions → free plan → connect it to this project. This adds `DATABASE_URL` (and `POSTGRES_URL`) for you.
4. **Add two settings.** Project → **Settings → Environment Variables** (Production, Preview and Development):
   - `ADMIN_PASSKEY` = the passkey for the first `admin` sign-in.
   - `SESSION_SECRET` = a long random string. Make one with:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
5. **Deploy to production:**
   ```bash
   vercel --prod
   ```
6. Open the production URL, sign in as **admin**, and change the passkey right away (**Change passkey**, top right). Then add your team in the **Admin** tab.

Check the setup any time at `https://<your-app>.vercel.app/api/health`. It should say `"storage":"postgres"`.

Notes:
- `ADMIN_PASSKEY` is only used to create the first admin. Changing it later does nothing; reset passkeys from the Admin tab.
- Changing `SESSION_SECRET` signs everyone out.
- Alternative to the CLI: push this folder to a GitHub repo and use **Add New → Project → Import** in Vercel, then do steps 3–6.

## Moving from the Redis version

Earlier versions kept everything in Upstash Redis as one JSON document. The first time this version starts on an
empty database it copies all of it (racking, parts, pallets at machines, users and their passkeys, both logs) into
Postgres. **Redis is only read, never changed**, so it stays as a backup. Made-up routing numbers and dates the old
version filled in are recognised and cleared during the copy.

1. In Vercel → **Storage**, create the Neon database and connect it to the project for **Production only**
   (untick Preview and Development). Leave the Upstash database connected: the copy reads from it.
   Production keeps running the old version until the new one is deployed.
2. Merge the change to `main`. Vercel deploys it; the first request copies the data.
3. Open `/api/health` (should say `"storage":"postgres"`), sign in, and check **Admin → Activity** for a
   "Copied old data" line with the counts.

Why Production only: a preview deployment connected to the same database would copy the data early, and
anything saved in the old version after that would not be in the copy. If that happens anyway, the Activity log
shows "Old data changed after copy".

**Rolling back:** Admin → Backup → **Download backup**, then (with the Upstash URL and token from Vercel → Storage)
`KV_REST_API_URL=… KV_REST_API_TOKEN=… node scripts/rollback-to-redis.js <backup file>`, and redeploy the earlier
version. It carries on with today's data.

## Settings (environment variables)

| Variable        | Default        | What it does |
|-----------------|----------------|--------------|
| `PORT`          | `3000`         | Port to listen on. |
| `DATABASE_URL`  |                | Postgres connection (set by Vercel's Neon integration; `POSTGRES_URL` also works). Without it the app uses an embedded Postgres in `DATA_DIR`. |
| `DATA_DIR`      | `./data`       | Folder for the embedded Postgres when there is no `DATABASE_URL`. **Back this folder up.** |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` |  | The old Upstash Redis database. Only read once, to copy old data into an empty database. `UPSTASH_REDIS_REST_URL`/`_TOKEN` also work. |
| `DB_POOL_MAX`   | `3`            | Most Postgres connections per server instance. |
| `SESSION_SECRET` | made up and stored | Key used to sign sign-in cookies. **Required on Vercel.** |
| `ADMIN_PASSKEY` | made up, printed once | Passkey for the first `admin` account. Used once only. |
| `NODE_ENV`      |                | Set to `production` when served over HTTPS (marks the sign-in cookie Secure). |
| `COOKIE_SECURE` |                | `1` forces the Secure cookie flag without `NODE_ENV=production`. |
| `TRUST_PROXY`   |                | `1` when behind a reverse proxy or load balancer, so failed sign-in limits use the real client IP. |
| `SESSION_HOURS` | `12`           | How long a sign-in lasts. |

## Other hosting options

Either point `DATABASE_URL` at a Postgres server (recommended; your usual database backups then cover it), or let the
app keep its embedded Postgres in `DATA_DIR`, in which case the host needs a **persistent disk** (or a volume).
Always serve it over **HTTPS**.

**Company server or VM (Windows or Linux)**
1. Copy this folder to the server, install Node.js 20+ and run `npm ci --omit=dev`.
2. Start it with `NODE_ENV=production`, `ADMIN_PASSKEY` and a `DATA_DIR` on a backed-up drive.
3. Put it behind your existing HTTPS reverse proxy (IIS, nginx, Caddy) and set `TRUST_PROXY=1`.
4. Keep it running as a service (for example NSSM on Windows or systemd on Linux).

**Docker**
```bash
docker build -t waxahachie-racking .
docker run -d -p 3000:3000 -v racking-data:/data -e ADMIN_PASSKEY='choose-a-strong-passkey' -e TRUST_PROXY=1 waxahachie-racking
```

**Render, Railway, Azure App Service, Fly.io and similar**
- Build command: `npm ci --omit=dev`; start command: `node server.js`
- Add a persistent disk and set `DATA_DIR` to its mount path (for example `/var/data`). Without a disk, data is lost on every redeploy.
- Set `NODE_ENV=production`, `TRUST_PROXY=1` and `ADMIN_PASSKEY`.
- Health check path: `/api/health`

## How it protects access

- Passkeys are never stored. The server keeps a salted scrypt hash and checks it on every sign-in.
- After 5 wrong passkeys for the same User ID from the same address, sign-in is locked for 15 minutes.
- Sign-in uses a signed, HttpOnly, SameSite=Strict cookie. Changes require a custom header, which blocks cross-site requests.
- Every save is checked on the server for role and data shape. If two people edit at once, the second save is refused and that person is asked to load the latest version, so nobody silently overwrites someone else.
- Resetting, disabling or deleting a user signs them out everywhere.
- There must always be at least one active admin.

## Backups and restore

- **Admin → Backup → Download backup** saves everything in one JSON file.
- On Neon, restore to an earlier point in time from the Neon console (how far back depends on the plan).
- With the embedded Postgres, copy `DATA_DIR` (or the Docker volume) while the app is stopped.

If every admin passkey is lost, run `DELETE FROM users;` in the database (Neon console → SQL Editor) and redeploy
with a new `ADMIN_PASSKEY`; the app creates `admin` again when there are no users. The racking data is kept, but the other users will need to be added again.
