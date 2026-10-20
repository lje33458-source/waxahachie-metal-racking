# Americase Visual Inventory

A shared web app for Americase racking. People sign in with a **User ID + passkey**, assign Part IDs and quantities to rack addresses, and keep the Metal Master list. Admins manage users from the **Admin** tab.

- **Racking**: pick a row, then set the Part ID and quantity at each address (`row-rack-level`). (Separate Challenger and HQ PF1 sections are built in but switched off; see `SECTIONS` in `lib/api.js`.)
- **Master**: the parts list (by Part Number), a pallet tracking sheet with each pallet's routing number and date received (placeholders until real values are typed in), with total quantity, locations and pallets for each part, plus a part-by-row breakdown.
- **Transfer Material**: pick a part number and the quantity needed. Pallets are listed oldest received first, with the oldest two marked Recommended. Choose one green pallet (holds enough on its own) or two pallets that add up (yellow ones hold less; once one is picked, pallets that can't make up the rest turn red). Whole pallets move, two at most. A selected / requested total and a Selected Pallets list show the picks; the machine buttons (EMK, EMLK, P4, L5) appear once enough is selected, and choosing one shows a one-page printable pick sheet. Editors and admins only.
- **Machine Material**: how much of each material has been transferred to each machine, plus the recent transfers.
- **Admin** (admins only): add users, set roles, reset passkeys, disable or delete accounts, and see an activity log of sign-ins, saves and user changes.

Roles:

| Role   | Can view | Can edit and save | Can manage users |
|--------|----------|-------------------|------------------|
| Viewer | ✔        |                   |                  |
| Editor | ✔        | ✔                 |                  |
| Admin  | ✔        | ✔                 | ✔                |

## Requirements

Node.js 18 or newer. There are no packages to install.

## Run it

```bash
ADMIN_PASSKEY='choose-a-strong-passkey' node server.js
```

Open http://localhost:3000 and sign in as **admin** with that passkey.

`ADMIN_PASSKEY` is only used the very first time, to create the `admin` account. If you leave it out, the server makes up a passkey and prints it once in the console. Change it after you sign in (**Change passkey** at the top right).

On Windows PowerShell:

```powershell
$env:ADMIN_PASSKEY='choose-a-strong-passkey'; node server.js
```

## Deploy to Vercel

Vercel doesn't keep files between requests, so on Vercel the app stores its data in **Upstash Redis** (free tier is plenty). The app picks it up automatically.

1. **Install the Vercel CLI and sign in** with the account that owns your other projects (Node.js 18+ required):
   ```bash
   npm i -g vercel
   vercel login
   ```
2. **Create the project.** From inside this folder run:
   ```bash
   vercel
   ```
   Answer the prompts: pick the **same scope (team or personal account)** your other projects use, choose *No* to linking an existing project, name it `waxahachie-metal-racking`, keep the folder as `./`, and accept the detected settings (no build command needed).
3. **Add the database.** In the Vercel dashboard open the project → **Storage** → **Create Database** → **Upstash** → *Upstash for Redis* → free plan → connect it to this project (all environments). This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
4. **Add two settings.** Project → **Settings → Environment Variables** (Production, Preview and Development):
   - `ADMIN_PASSKEY` = the passkey for the first `admin` sign-in.
   - `SESSION_SECRET` = a long random string. Make one with:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
5. **Deploy to production:**
   ```bash
   vercel --prod
   ```
6. Open the production URL, sign in as **admin**, and change the passkey right away (**Change passkey**, top right). Then add your team in the **Admin** tab.

Check the setup any time at `https://<your-app>.vercel.app/api/health`. It should say `"storage":"redis"`.

Notes:
- `ADMIN_PASSKEY` is only used to create the first admin. Changing it later does nothing; reset passkeys from the Admin tab.
- Changing `SESSION_SECRET` signs everyone out.
- Alternative to the CLI: push this folder to a GitHub repo and use **Add New → Project → Import** in Vercel, then do steps 3–6.

## Settings (environment variables)

| Variable        | Default        | What it does |
|-----------------|----------------|--------------|
| `PORT`          | `3000`         | Port to listen on. |
| `DATA_DIR`      | `./data`       | Folder for the data files when not using Redis. **Back this folder up.** |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` |  | Upstash Redis connection (set automatically by the Vercel integration). When present, data is stored in Redis instead of files. `UPSTASH_REDIS_REST_URL`/`_TOKEN` also work. |
| `SESSION_SECRET` | made up and stored | Key used to sign sign-in cookies. **Required on Vercel.** |
| `ADMIN_PASSKEY` | made up, printed once | Passkey for the first `admin` account. Used once only. |
| `NODE_ENV`      |                | Set to `production` when served over HTTPS (marks the sign-in cookie Secure). |
| `COOKIE_SECURE` |                | `1` forces the Secure cookie flag without `NODE_ENV=production`. |
| `TRUST_PROXY`   |                | `1` when behind a reverse proxy or load balancer, so failed sign-in limits use the real client IP. |
| `SESSION_HOURS` | `12`           | How long a sign-in lasts. |

## Other hosting options

The app keeps its data in files, so the host needs a **persistent disk** (or a volume). Always serve it over **HTTPS**.

**Company server or VM (Windows or Linux)**
1. Copy this folder to the server and install Node.js 18+.
2. Start it with `NODE_ENV=production`, `ADMIN_PASSKEY` and a `DATA_DIR` on a backed-up drive.
3. Put it behind your existing HTTPS reverse proxy (IIS, nginx, Caddy) and set `TRUST_PROXY=1`.
4. Keep it running as a service (for example NSSM on Windows or systemd on Linux).

**Docker**
```bash
docker build -t waxahachie-racking .
docker run -d -p 3000:3000 -v racking-data:/data -e ADMIN_PASSKEY='choose-a-strong-passkey' -e TRUST_PROXY=1 waxahachie-racking
```

**Render, Railway, Azure App Service, Fly.io and similar**
- Start command: `node server.js`
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

Copy `DATA_DIR` (or the Docker volume). To restore, stop the app, put the files back and start it again.

If every admin passkey is lost, delete the users record (`users.json` in `DATA_DIR`, or the `wmr:users` key in Redis from the Upstash console) and restart or redeploy with a new `ADMIN_PASSKEY`. The racking data is kept, but all other users will need to be added again.
