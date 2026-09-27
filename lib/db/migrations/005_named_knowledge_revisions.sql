CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_named
  ON knowledge_revisions(document_id, name, captured_at DESC, id DESC);
