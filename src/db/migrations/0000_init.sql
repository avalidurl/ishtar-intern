-- 0000_init.sql — Ishtar Intern local D1 schema.
-- Sole stateful store for the quarantined agent. Contains NO datebook/Ishtar
-- data, NO PII, NO secrets — only operational bookkeeping (kill switch,
-- de-dup, action audit log, daily budget counters).

-- Runtime settings. The kill switch lives here and gates ALL writes.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default OFF: the agent does nothing destructive until the founder flips this.
INSERT OR IGNORE INTO settings (key, value) VALUES ('enabled', 'false');

-- De-dup: posts the agent has already considered/acted on, so a heartbeat
-- never re-acts on the same item.
CREATE TABLE IF NOT EXISTS seen_posts (
  post_id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_seen_posts_seen_at ON seen_posts (seen_at);

-- Append-only audit log of every action attempt (founder-reviewable).
CREATE TABLE IF NOT EXISTS action_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,            -- Action.kind (upvote|comment|reply|post|follow|noop)
  target     TEXT,                     -- post id / agent name / submolt
  ok         INTEGER NOT NULL DEFAULT 0, -- 1 = succeeded, 0 = failed/skipped
  detail     TEXT,                     -- short reason / error (NEVER a secret)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_action_log_created_at ON action_log (created_at);
CREATE INDEX IF NOT EXISTS idx_action_log_kind ON action_log (kind);

-- Per-UTC-day budget counters. Hard stops: actions vs DAILY_ACTION_BUDGET,
-- usd vs DAILY_USD_BUDGET. `day` is an ISO date string 'YYYY-MM-DD'.
CREATE TABLE IF NOT EXISTS budget_counters (
  day     TEXT PRIMARY KEY,
  actions INTEGER NOT NULL DEFAULT 0,
  usd     REAL    NOT NULL DEFAULT 0
);
