CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_base
  ON knowledge_revisions(document_id, base_revision_id);
