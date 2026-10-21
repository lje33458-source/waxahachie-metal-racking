#!/usr/bin/env node
'use strict';
// Rollback: puts a backup (downloaded from Admin > Backup) into Upstash Redis in the format the earlier,
// Redis-only version of the app reads. After this, redeploy that earlier version and it carries on with
// today's data.
//
// Usage:
//   KV_REST_API_URL=https://… KV_REST_API_TOKEN=… node scripts/rollback-to-redis.js americase-inventory-backup.json
//
// The URL and token are in Vercel > Storage > (the Upstash database) > .env.local. This overwrites the keys
// wmr:racking, wmr:racking:version, wmr:users, wmr:transfers and wmr:audit.

const fs = require('fs');
const legacy = require('../lib/legacy');

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Give the backup file: node scripts/rollback-to-redis.js <backup.json>');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data.racking || !Array.isArray(data.users)) throw new Error(file + ' is not a backup from this app.');
  const cmd = legacy.redis();
  if (!cmd) throw new Error('Set KV_REST_API_URL and KV_REST_API_TOKEN to the Upstash database first.');
  await legacy.writeRedis(cmd, data);
  console.log('Wrote racking version ' + data.racking.version + ', ' + data.users.length + ' users, ' +
    data.transfers.length + ' transfer log entries and ' + data.audit.length + ' activity entries to Redis.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
