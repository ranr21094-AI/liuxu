async function authorizedKnowledgeFilePath({ documentId, appOrigin, diaryToken = '', request = fetch } = {}) {
  const id = String(documentId || '');
  if (!/^file:[^/\\?#]{1,160}$/.test(id)) throw new Error('档案标识无效');
  const origin = new URL(appOrigin).origin;
  const headers = diaryToken ? { Cookie: `diary_session=${encodeURIComponent(diaryToken)}` } : {};
  const response = await request(`${origin}/api/knowledge/files/${encodeURIComponent(id)}/location`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '档案不可访问');
  if (typeof body.path !== 'string' || !body.path) throw new Error('档案位置无效');
  return body.path;
}

async function authorizedKnowledgeDocumentFolder({ documentId, appOrigin, diaryToken = '', request = fetch } = {}) {
  const id = String(documentId || '');
  if (!/^(?:file|note):[^/\\?#]{1,160}$/.test(id)) throw new Error('文档标识无效');
  const origin = new URL(appOrigin).origin;
  const headers = diaryToken ? { Cookie: `diary_session=${encodeURIComponent(diaryToken)}` } : {};
  const response = await request(`${origin}/api/knowledge/documents/${encodeURIComponent(id)}/location`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '文档所在文件夹不可访问');
  if (typeof body.path !== 'string' || !body.path) throw new Error('文档文件夹位置无效');
  return body.path;
}

module.exports = { authorizedKnowledgeFilePath, authorizedKnowledgeDocumentFolder };
