-- WakaWise feedback database (Cloudflare D1, bound as DB).
-- Create:  npx wrangler d1 execute wakawise --remote --file db/schema.sql
-- Read:    Cloudflare dashboard -> Storage & Databases -> D1 -> wakawise -> Console,
--          e.g. SELECT * FROM reports ORDER BY at DESC LIMIT 50;

-- "Report a problem" and places users chose to share
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,            -- unix seconds
  kind TEXT NOT NULL,             -- 'problem' | 'place'
  slug TEXT NOT NULL,             -- state
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  topic TEXT,                     -- problem type, or the place's kind
  name TEXT,                      -- place / road name
  detail TEXT,                    -- free text or the place's address
  client TEXT,                    -- hashed IP, only for rate limiting (rotates daily)
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS reports_client ON reports (client, at);

-- Opt-in trip speeds: total seconds and count per road piece and hour of the week.
-- No coordinates, device IDs or trip IDs are stored, only these totals.
CREATE TABLE IF NOT EXISTS edge_times (
  slug TEXT NOT NULL,
  build TEXT NOT NULL,            -- map build the edge ids belong to
  edge INTEGER NOT NULL,
  bucket INTEGER NOT NULL,        -- 0-23 weekday hour, 24-47 weekend hour (Nigeria time)
  seconds REAL NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (slug, build, edge, bucket)
);

-- how many uploads each client sent recently (rate limiting)
CREATE TABLE IF NOT EXISTS uploads (
  client TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_client ON uploads (client, at);
