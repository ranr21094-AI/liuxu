CREATE TABLE IF NOT EXISTS knowledge_file_observations (
  document_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  file_state TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_file_observations_path
  ON knowledge_file_observations(relative_path);
