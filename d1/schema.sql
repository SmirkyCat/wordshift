CREATE TABLE IF NOT EXISTS word_review_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  approved_json TEXT NOT NULL DEFAULT '[]',
  rejected_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

INSERT OR IGNORE INTO word_review_state (id, approved_json, rejected_json, updated_at)
VALUES (1, '[]', '[]', CAST(strftime('%s','now') AS INTEGER));
