-- Database tables for Americase Visual Inventory (Postgres).
-- lib/store.js runs this on start-up whenever SCHEMA_VERSION changes; every statement is safe to run again.

-- One row: the version number of the racking data. It goes up by one on every change, which is how
-- the page notices someone else's save and how two saves at the same moment are kept from overwriting each other.
CREATE TABLE IF NOT EXISTS meta (
  id            int PRIMARY KEY CHECK (id = 1),
  version       int NOT NULL,
  saved_at      timestamptz,
  saved_by      text,
  imported_from text,          -- where the data came from on first start: 'redis', 'files' or 'seed'
  imported_at   timestamptz
);

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              text PRIMARY KEY,
  role            text NOT NULL CHECK (role IN ('viewer', 'supervisor', 'handler', 'shipping', 'admin')),
  active          boolean NOT NULL DEFAULT true,
  passkey_hash    text NOT NULL,              -- scrypt; the passkey itself is never stored
  session_version int NOT NULL DEFAULT 0,     -- raised to sign the user out everywhere
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  last_login      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_id_lower ON users (lower(id));

-- The Master parts list, in the order shown.
CREATE TABLE IF NOT EXISTS parts (
  k              text PRIMARY KEY,            -- internal key; pallets refer to it
  position       int NOT NULL,
  number         text NOT NULL DEFAULT '',    -- Part Number, shown everywhere
  description    text NOT NULL DEFAULT '',
  part_id        text NOT NULL DEFAULT '',
  qty_per_pallet double precision,
  dedicated_case text NOT NULL DEFAULT '',
  qty_per_case   double precision
);

-- Racking layout: section (tab) > row > rack > level.
CREATE TABLE IF NOT EXISTS sections (
  key      text PRIMARY KEY,
  name     text NOT NULL,
  position int NOT NULL
);
CREATE TABLE IF NOT EXISTS rack_rows (
  section  text NOT NULL REFERENCES sections ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  row      text NOT NULL,                     -- '2', '3' … or a letter
  position int NOT NULL,
  PRIMARY KEY (section, row)
);
CREATE TABLE IF NOT EXISTS racks (
  section  text NOT NULL,
  row      text NOT NULL,
  rack     int NOT NULL,
  label    text NOT NULL DEFAULT '',
  position int NOT NULL,
  PRIMARY KEY (section, row, rack),
  FOREIGN KEY (section, row) REFERENCES rack_rows ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS levels (
  section  text NOT NULL,
  row      text NOT NULL,
  rack     int NOT NULL,
  level    int NOT NULL,
  height   double precision,                  -- inches
  position int NOT NULL,
  PRIMARY KEY (section, row, rack, level),
  FOREIGN KEY (section, row, rack) REFERENCES racks ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

-- Every pallet in stock. A pallet is either on the racking (section/row/rack/level set) or at a machine
-- (machine set, with the spot it came from). Used-up pallets are deleted; the history table keeps them.
CREATE TABLE IF NOT EXISTS pallets (
  id          text PRIMARY KEY,
  part_k      text NOT NULL,                  -- parts.k (not a foreign key: a pallet at a machine keeps a part removed from Master)
  qty         double precision,
  routing     text NOT NULL DEFAULT '',
  received    date,
  section     text,
  row         text,
  rack        int,
  level       int,
  position    int NOT NULL,                   -- order within its level, or within its machine
  machine     text CHECK (machine IN ('EMK', 'EMLK', 'P4', 'L5')),
  from_section text,
  from_row    text,
  from_rack   int,
  from_level  int,
  loc         text,                           -- the spot it came from, as shown ('2-1-9')
  batch       text,                           -- pallets sent in one transfer share a batch
  requested   double precision,               -- quantity requested for that transfer
  moved_at    timestamptz,
  moved_by    text,
  CHECK ((machine IS NULL) = (level IS NOT NULL)),
  FOREIGN KEY (section, row, rack, level) REFERENCES levels DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS pallets_part ON pallets (part_k);
CREATE INDEX IF NOT EXISTS pallets_spot ON pallets (section, row, rack, level);

-- Transfer log: transfers to machines, returns to the racking and receipts, oldest first.
-- entry holds the log line as the page shows it.
CREATE TABLE IF NOT EXISTS stock_moves (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL,
  by_user text NOT NULL,
  kind    text NOT NULL CHECK (kind IN ('transfer', 'return', 'receive')),
  machine text,
  part_k  text,
  qty     double precision,
  entry   jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS stock_moves_at ON stock_moves (at);

-- Admin activity log: sign-ins, failed sign-ins, saves, user changes.
CREATE TABLE IF NOT EXISTS activity (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  user_id text NOT NULL,
  action  text NOT NULL,
  detail  text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS activity_at ON activity (at);

-- Failed sign-ins per address + User ID, for the 15-minute lockout. Rows expire.
CREATE TABLE IF NOT EXISTS login_failures (
  key          text PRIMARY KEY,
  count        int NOT NULL,
  locked_until timestamptz,
  expires_at   timestamptz NOT NULL
);

-- Change history: every insert, update and delete on the tables below, with the row before and after
-- and who made the change. Filled by triggers, so no code path can skip it. Passkey hashes are left out.
CREATE TABLE IF NOT EXISTS history (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text,
  table_name text NOT NULL,
  row_key    text NOT NULL,
  op         text NOT NULL,
  old_row    jsonb,
  new_row    jsonb
);
CREATE INDEX IF NOT EXISTS history_row ON history (table_name, row_key, id);
CREATE INDEX IF NOT EXISTS history_at ON history (at);

CREATE OR REPLACE FUNCTION record_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb;
  n jsonb;
  k text := '';
  i int;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD) - 'passkey_hash' - 'last_login'; END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW) - 'passkey_hash' - 'last_login'; END IF;
  IF TG_OP = 'UPDATE' AND o = n THEN RETURN NULL; END IF;
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    k := k || CASE WHEN i > 0 THEN '|' ELSE '' END || coalesce(coalesce(n, o) ->> TG_ARGV[i], '');
  END LOOP;
  INSERT INTO history (actor, table_name, row_key, op, old_row, new_row)
  VALUES (nullif(current_setting('app.actor', true), ''), TG_TABLE_NAME, k, TG_OP, o, n);
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER parts_history AFTER INSERT OR UPDATE OR DELETE ON parts FOR EACH ROW EXECUTE FUNCTION record_history('k');
CREATE OR REPLACE TRIGGER sections_history AFTER INSERT OR UPDATE OR DELETE ON sections FOR EACH ROW EXECUTE FUNCTION record_history('key');
CREATE OR REPLACE TRIGGER rack_rows_history AFTER INSERT OR UPDATE OR DELETE ON rack_rows FOR EACH ROW EXECUTE FUNCTION record_history('section', 'row');
CREATE OR REPLACE TRIGGER racks_history AFTER INSERT OR UPDATE OR DELETE ON racks FOR EACH ROW EXECUTE FUNCTION record_history('section', 'row', 'rack');
CREATE OR REPLACE TRIGGER levels_history AFTER INSERT OR UPDATE OR DELETE ON levels FOR EACH ROW EXECUTE FUNCTION record_history('section', 'row', 'rack', 'level');
CREATE OR REPLACE TRIGGER pallets_history AFTER INSERT OR UPDATE OR DELETE ON pallets FOR EACH ROW EXECUTE FUNCTION record_history('id');
CREATE OR REPLACE TRIGGER users_history AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION record_history('id');

-- Ready-made views for reporting tools.
CREATE OR REPLACE VIEW stock_on_racking AS
  SELECT p.id AS pallet_id, pt.number AS part_number, pt.description, p.qty, p.routing, p.received,
         s.name AS section, p.row, p.rack, p.level, p.row || '-' || p.rack || '-' || p.level AS location
  FROM pallets p
  LEFT JOIN parts pt ON pt.k = p.part_k
  LEFT JOIN sections s ON s.key = p.section
  WHERE p.machine IS NULL;

CREATE OR REPLACE VIEW stock_at_machines AS
  SELECT p.id AS pallet_id, p.machine, pt.number AS part_number, p.qty, p.requested, p.routing, p.received,
         p.loc AS came_from, p.moved_at, p.moved_by
  FROM pallets p
  LEFT JOIN parts pt ON pt.k = p.part_k
  WHERE p.machine IS NOT NULL;

CREATE OR REPLACE VIEW stock_by_part AS
  SELECT pt.number AS part_number, pt.description,
         coalesce(sum(p.qty) FILTER (WHERE p.machine IS NULL), 0) AS qty_on_racking,
         count(p.id) FILTER (WHERE p.machine IS NULL) AS pallets_on_racking,
         coalesce(sum(p.qty) FILTER (WHERE p.machine IS NOT NULL), 0) AS qty_at_machines
  FROM parts pt
  LEFT JOIN pallets p ON p.part_k = pt.k
  GROUP BY pt.k, pt.number, pt.description, pt.position
  ORDER BY pt.position;
