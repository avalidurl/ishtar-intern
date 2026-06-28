-- 0001_slack.sql — operator chat (Slack) state for the Ishtar Intern.
-- Internal operator transcript only. NO datebook/Ishtar data, NO PII of daters,
-- NO secrets. The founder talks to the intern here; the brain self-gates on budget.

-- De-dup Slack event deliveries. Slack retries on any non-2xx / slow ack, so we
-- record each event_id once and ignore replays (prevents double replies).
CREATE TABLE IF NOT EXISTS slack_events (
  event_id   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slack_events_created_at ON slack_events (created_at);

-- Short-term per-thread memory so the intern can hold a conversation. Keyed by the
-- Slack thread (thread_ts, or the root message ts for a new thread). role is
-- 'user' (operator) or 'assistant' (intern). Pruned by age in the heartbeat janitor.
CREATE TABLE IF NOT EXISTS slack_turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_key TEXT NOT NULL,
  role       TEXT NOT NULL,            -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slack_turns_thread ON slack_turns (thread_key, id);
CREATE INDEX IF NOT EXISTS idx_slack_turns_created_at ON slack_turns (created_at);
