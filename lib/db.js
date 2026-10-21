'use strict';
// Database connection. Postgres when DATABASE_URL (or POSTGRES_URL) is set, which is how Vercel's Neon integration
// connects it; otherwise an embedded Postgres (PGlite) that keeps its files in DATA_DIR, for local use and Docker.
// Both speak the same SQL, so the rest of the app does not care which one it gets.

const path = require('path');

// Vercel integrations may add a custom prefix (e.g. STORAGE_DATABASE_URL), so match by suffix too.
function envBySuffix(...names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  const k = Object.keys(process.env).find(k => names.some(n => k.endsWith('_' + n)) && process.env[k]);
  return k ? process.env[k] : undefined;
}
const DATABASE_URL = envBySuffix('DATABASE_URL', 'POSTGRES_URL');

let ready = null;

// Returns { kind, query(sql, params) -> rows, tx(fn) }. In tx, fn gets its own query function; everything it runs
// commits together or not at all. A query without params may hold several statements (used for the schema).
function connect() {
  if (!ready) ready = DATABASE_URL ? postgres() : (process.env.VERCEL ? missing() : embedded());
  return ready;
}

async function postgres() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, max: Number(process.env.DB_POOL_MAX || 3) });
  pool.on('error', e => console.error('Database connection error:', e.message));
  const rows = r => (Array.isArray(r) ? r[r.length - 1] : r).rows;
  return {
    kind: 'postgres',
    async query(sql, params) { return rows(await pool.query(sql, params)); },
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(async (sql, params) => rows(await c.query(sql, params)));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { c.release(); }
    },
    end: () => pool.end(),
  };
}

async function embedded() {
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'pgdata');
  const db = await PGlite.create(dir);
  const run = async (t, sql, params) => {
    if (params) return (await t.query(sql, params)).rows;
    const all = await t.exec(sql);
    return all.length ? all[all.length - 1].rows : [];
  };
  return {
    kind: 'embedded-postgres',
    query: (sql, params) => run(db, sql, params),
    tx: fn => db.transaction(t => fn((sql, params) => run(t, sql, params))),
    end: () => db.close(),
  };
}

// On Vercel without a database: explain instead of crashing.
async function missing() {
  const e = new Error('The database is not connected. In Vercel, open Storage, connect a Neon Postgres database to this project, then redeploy.');
  e.status = 503;
  throw e;
}

module.exports = { connect, kind: DATABASE_URL ? 'postgres' : (process.env.VERCEL ? 'none' : 'embedded-postgres') };
