-- Avoid parsing every document when updating a file's annotation children.
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_parent
  ON knowledge_documents(json_extract(body, '$.parentDocumentId'));
