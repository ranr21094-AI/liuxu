import { apiFetch } from '../auth.js';
import { showToast, $ } from '../helpers.js';
import { loadLogs } from '../logList.js';

export function initKnowledgeImport() {
  const button = $('#btnKnowledgeImport');
  const input = $('#knowledgeImportInput');
  if (!button || !input) return;
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const body = new FormData();
    body.append('file', file);
    const res = await apiFetch('/api/knowledge/imports', { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || '导入失败', 'error');
      return;
    }
    showToast(data.duplicate ? '文件已存在，已打开已有文档' : `已导入 ${data.document?.title || file.name}`, 'success');
    await loadLogs();
  });
}
