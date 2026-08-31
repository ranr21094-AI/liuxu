CREATE TABLE IF NOT EXISTS knowledge_link_targets (
  document_id TEXT PRIMARY KEY,
  normalized_title TEXT NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'note',
  visibility TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'active',
  knowledge_base TEXT NOT NULL DEFAULT '',
  folder_path TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_knowledge_link_targets_title
  ON knowledge_link_targets(normalized_title);

CREATE TABLE IF NOT EXISTS knowledge_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  target_document_id TEXT,
  source_version INTEGER NOT NULL DEFAULT 0,
  target_label TEXT NOT NULL DEFAULT '',
  raw_target TEXT NOT NULL DEFAULT '',
  char_offset INTEGER NOT NULL DEFAULT 0,
  occurrence_index INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  UNIQUE(source_document_id, occurrence_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_links_target
  ON knowledge_links(target_document_id, source_document_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_links_source
  ON knowledge_links(source_document_id, occurrence_index);

CREATE TABLE IF NOT EXISTS knowledge_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  document_version INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'auto',
  snapshot TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_document
  ON knowledge_revisions(document_id, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_retention
  ON knowledge_revisions(captured_at);

INSERT INTO meta (key, value) VALUES ('knowledge_links_index_version', '0')
ON CONFLICT(key) DO NOTHING;

INSERT INTO meta (key, value) VALUES ('knowledge_links_index_built', '0')
ON CONFLICT(key) DO NOTHING;
