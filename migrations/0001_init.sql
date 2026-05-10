CREATE TABLE IF NOT EXISTS incidents (
  id              TEXT PRIMARY KEY,
  agency_id       TEXT,
  call_type       TEXT,
  raw_call_type   TEXT,
  latitude        REAL,
  longitude       REAL,
  address         TEXT,
  call_received   TEXT,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  closed          INTEGER NOT NULL DEFAULT 0,
  closed_at       TEXT,
  units           TEXT
);

CREATE INDEX IF NOT EXISTS idx_incidents_call_received ON incidents(call_received);
CREATE INDEX IF NOT EXISTS idx_incidents_call_type     ON incidents(call_type);
CREATE INDEX IF NOT EXISTS idx_incidents_closed        ON incidents(closed);
