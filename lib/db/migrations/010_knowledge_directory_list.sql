CREATE INDEX IF NOT EXISTS idx_knowledge_documents_directory_list
ON knowledge_documents (
  COALESCE(NULLIF(json_extract(body, '$.status'), ''), 'active'),
  json_extract(body, '$.knowledgeBase'),
  COALESCE(json_extract(body, '$.folderPath'), ''),
  COALESCE(json_extract(body, '$.pinnedAt'), '') DESC,
  COALESCE(json_extract(body, '$.updatedAt'), json_extract(body, '$.createdAt'), '') DESC
);
