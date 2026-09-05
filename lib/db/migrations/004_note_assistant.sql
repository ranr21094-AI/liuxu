CREATE INDEX IF NOT EXISTS idx_agent_sessions_document
  ON agent_sessions(document_id, updated_at DESC);
