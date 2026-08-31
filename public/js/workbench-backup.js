import { apiFetch } from './auth.js';
import { $, showToast } from './helpers.js';

function filenameFromDisposition(disposition, fallback) {
  const match = /filename="?([^";]+)"?/i.exec(String(disposition || ''));
  return match?.[1] || fallback;
}

async function downloadApiExport(url, fallbackName) {
  const response = await apiFetch(url);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || '导出失败');
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get('Content-Disposition'), fallbackName);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function restoreModeQuery() {
  return $('#restoreModeSelect')?.value === 'merge' ? 'merge' : 'replace';
}

export function createBackupActions({ confirmAction, reloadKnowledge }) {
  async function exportJsonBackup() {
    await downloadApiExport('/api/backup', 'liuxu-backup.json');
    showToast('JSON 备份已开始下载', 'success');
  }

  async function exportZipBackup() {
    await downloadApiExport('/api/workspace/export', 'liuxu-workspace.zip');
    showToast('ZIP 工作区已开始下载', 'success');
  }

  async function restoreJsonBackup(file) {
    if (!file) return;
    const mode = restoreModeQuery();
    const confirmed = await confirmAction({
      title: mode === 'merge' ? '合并 JSON 备份' : '替换为 JSON 备份',
      message: mode === 'merge'
        ? '将把备份中的数据合并到当前工作区，冲突项保留较新的版本。'
        : '将用备份覆盖当前结构数据（分类、待办等），此操作不可撤销。',
      confirmText: mode === 'merge' ? '合并' : '替换',
    });
    if (!confirmed) return;
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('JSON 文件格式无效');
    }
    const response = await apiFetch(`/api/restore?mode=${encodeURIComponent(mode)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '恢复失败');
    showToast('JSON 备份已恢复', 'success');
    await reloadKnowledge();
  }

  async function restoreZipBackup(file) {
    if (!file) return;
    const mode = restoreModeQuery();
    const confirmed = await confirmAction({
      title: mode === 'merge' ? '合并 ZIP 工作区' : '替换为 ZIP 工作区',
      message: mode === 'merge'
        ? '将把 ZIP 中的数据合并到当前工作区。'
        : '将用 ZIP 覆盖当前工作区（含知识附件与 Agent 数据），此操作不可撤销。',
      confirmText: mode === 'merge' ? '合并' : '替换',
    });
    if (!confirmed) return;
    const form = new FormData();
    form.append('archive', file);
    const response = await apiFetch(`/api/workspace/restore?mode=${encodeURIComponent(mode)}`, {
      method: 'POST',
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '恢复失败');
    showToast(data.secretsReset
      ? 'ZIP 工作区已恢复；跨设备加密的 API Key 已清空，请在模型设置中重新填写'
      : 'ZIP 工作区已恢复', 'success');
    await reloadKnowledge();
  }

  function bindBackupEvents() {
    $('#exportJsonBackupButton')?.addEventListener('click', () => exportJsonBackup().catch(error => showToast(error.message, 'error')));
    $('#exportZipBackupButton')?.addEventListener('click', () => exportZipBackup().catch(error => showToast(error.message, 'error')));
    $('#restoreJsonBackupButton')?.addEventListener('click', () => $('#restoreJsonInput').click());
    $('#restoreZipBackupButton')?.addEventListener('click', () => $('#restoreZipInput').click());
    $('#restoreJsonInput')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) restoreJsonBackup(file).catch(error => showToast(error.message, 'error'));
    });
    $('#restoreZipInput')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) restoreZipBackup(file).catch(error => showToast(error.message, 'error'));
    });
  }

  return { bindBackupEvents };
}
