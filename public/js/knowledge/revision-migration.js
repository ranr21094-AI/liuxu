// Cleanup is deferred until the editor has persisted its drafts. Database
// upgrades only mark old rows, so failed saves cannot destroy old history.
export async function cleanupLegacyRevisions({ flushPendingSaves, getActiveDocument, apiFetch }) {
  if (!(await flushPendingSaves())) throw new Error('草稿保存失败，旧历史清理已中止');
  const document = getActiveDocument();
  const response = await apiFetch('/api/knowledge/revisions/cleanup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(document?.sourceType === 'note' && document.status !== 'archived'
      ? { documentId: document.id, baseVersion: document.version } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '旧历史清理失败');
  return result;
}
