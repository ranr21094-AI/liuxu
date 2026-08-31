-- Performance metadata and access paths.  All statements are idempotent so
-- opening an older database can safely retry this migration after a crash.
CREATE TABLE IF NOT EXISTS knowledge_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS knowledge_index_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_index_changes_version
  ON knowledge_index_changes(version);

INSERT INTO knowledge_index_state (id, version, updated_at)
VALUES (1, 0, 0)
ON CONFLICT(id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_created
  ON agent_runs(parent_run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session_sort
  ON agent_messages(session_id, sort_index);
