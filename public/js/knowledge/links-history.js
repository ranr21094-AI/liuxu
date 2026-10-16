import { mountMindmapHistory } from './mindmap-history.js';
import { imageTokens, escapeAttr } from './note-images.js';
import { escHtml, showToast } from '../helpers.js';
import { renderToHtmlUncached } from '../markdown.js';

const WIKI_LINK_RE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;
const DOCUMENT_ID_RE = /^(?:note|file):(?:[1-9]\d*|[a-f0-9]{32})$/;

export function rewriteRelativeImages(markdown, documentId) {
  if (!DOCUMENT_ID_RE.test(String(documentId || ''))) return markdown;
  let result = String(markdown || '');
  for (const token of imageTokens(result).reverse()) {
    const source = token.src.replace(/&amp;/gi, '&');
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(source)) continue;
    const match = source.match(/^([^?#]*)([?#].*)?$/);
    if (!match?.[1]) continue;
    let pathname;
    try {
      const segments = match[1].split('/').map(segment => decodeURIComponent(segment));
      while (segments[0] === '.') segments.shift();
      if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment))) continue;
      pathname = segments.map(segment => encodeURIComponent(segment)).join('/');
    } catch { continue; }
    const target = `/api/knowledge/assets/${encodeURIComponent(documentId)}/${pathname}${match[2] || ''}`;
    const replacement = token.html
      ? token.raw.replace(/(\ssrc\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i, (_raw, prefix) => `${prefix}"${escapeAttr(target)}"`)
      : token.raw.replace(token.src, target);
    result = result.slice(0, token.start) + replacement + result.slice(token.end);
  }
  return result;
}

function safeLabel(value) {
  return String(value || '').replace(/\|/g, '｜').replace(/\]\]/g, '］］').replace(/\r?\n/g, ' ').trim().slice(0, 200);
}

export function renderKnowledgeMarkdown(value, options = {}) {
  // Keep code blocks untouched while turning only validated wiki tokens into
  // local hash links. The backend remains authoritative for link status.
  const source = String(value || '');
  const outgoingLinks = Array.isArray(options.outgoingLinks) ? options.outgoingLinks : [];
  let position = 0;
  const chunks = source.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  const transformed = chunks.map((chunk, index) => {
    if (index % 2 === 1) {
      position += chunk.length;
      return chunk;
    }
    const result = chunk.replace(WIKI_LINK_RE, (raw, left, right, offset) => {
      const label = String(left || '').trim();
      const targetId = String(right || '').trim();
      const detail = outgoingLinks.find(item => (
        item.raw === raw && (Number(item.start) === position + Number(offset) || !item.start)
      )) || outgoingLinks.find(item => item.raw === raw);
      const status = detail?.status || (targetId && DOCUMENT_ID_RE.test(targetId) ? 'resolved' : 'unresolved');
      if (!targetId || !DOCUMENT_ID_RE.test(targetId)) {
        const title = status === 'ambiguous' ? '链接有多个匹配' : '链接尚未解析';
        return `<span class="wiki-link-unresolved" title="${escHtml(title)}">${escHtml(raw)}</span>`;
      }
      const cls = status === 'missing' || status === 'locked'
        ? 'wiki-link-missing'
        : status === 'archived' ? 'wiki-link-archived' : 'wiki-link';
      const title = detail?.targetTitle ? `${label || targetId} · ${detail.targetTitle}` : (label || targetId);
      const href = `#knowledge?doc=${encodeURIComponent(targetId)}`;
      return `<a class="${cls}" data-liuxu-knowledge-id="${escHtml(targetId)}" href="${escHtml(href)}" title="${escHtml(title)}">${escHtml(label || targetId)}</a>`;
    });
    position += chunk.length;
    return result;
  }).join('');
  return renderToHtmlUncached(rewriteRelativeImages(transformed, options.documentId));
}

export function bindKnowledgeLinkClicks(host, navigate) {
  if (!host) return () => {};
  const handler = event => {
    const link = event.target.closest('[data-liuxu-knowledge-id]');
    if (!link) return;
    event.preventDefault();
    const id = link.dataset.liuxuKnowledgeId || '';
    if (!DOCUMENT_ID_RE.test(id) || typeof navigate !== 'function') return;
    navigate('knowledge', id).catch?.(() => {});
  };
  host.addEventListener('click', handler);
  return () => host.removeEventListener('click', handler);
}

function formatRevisionReason(reason) {
  return ({ auto: '自动历史', pre_restore: '恢复前快照', external_sync: '本地文件同步', restore_merge: '备份合并', folder_migration: '知识库迁移', agent_write: 'AI 修改前', assistant_edit: '应用 AI 提案前', manual: '命名版本' })[reason] || '历史快照';
}

function formatDate(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function lineDiff(before, after) {
  const left = String(before || '').split('\n');
  const right = String(after || '').split('\n');
  if (left.length > 1200 || right.length > 1200 || (before || '').length + (after || '').length > 700000) {
    return { fallback: true, left: String(before || ''), right: String(after || '') };
  }
  const width = right.length + 1;
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(width));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      removed.push(`<span>${escHtml(left[i])}</span>`);
      added.push(`<span>${escHtml(right[j])}</span>`);
      i += 1; j += 1;
    } else if (j < right.length && (i >= left.length || table[i][j + 1] >= table[i + 1][j])) {
      added.push(`<span class="added">+ ${escHtml(right[j])}</span>`);
      j += 1;
    } else {
      removed.push(`<span class="removed">- ${escHtml(left[i])}</span>`);
      i += 1;
    }
  }
  return { fallback: false, left: removed.join('\n'), right: added.join('\n') };
}

export function initKnowledgeEnhancements({ apiFetch, state, navigate, confirmAction, onRestore, beforeMutation, afterMutation }) {
  const textarea = document.querySelector('#documentContent');
  const picker = document.querySelector('#knowledgeLinkPicker');
  const relations = document.querySelector('#knowledgeRelations');
  const details = document.querySelector('#knowledgeRelationsDetails');
  if (!textarea || !picker || !relations || !details) return { setActiveDocument() {}, onDocumentSaved() {}, clear() {} };

  const revisionDialog = document.querySelector('#knowledgeRevisionDialog');
  let revisionOrigin = null;
  let previewCleanup = null;
  function closeRevision({ focus = true } = {}) {
    previewCleanup?.();
    previewCleanup = null;
    view.revisionDetailRequestSeq += 1;
    if (revisionDialog?.open) revisionDialog.close();
    document.querySelector('#knowledgeRevisionDetail').hidden = true;
    if (focus) {
      if (revisionOrigin?.isConnected) revisionOrigin.focus();
      else document.querySelector('[data-knowledge-relations-tab="revisions"]')?.focus();
    }
  }
  function showRevision() {
    if (revisionDialog && !revisionDialog.open) revisionDialog.showModal();
  }
  function syncOperationControls() {
    document.querySelectorAll('#knowledgeRevisionDetail button, #saveKnowledgeRevision').forEach(button => {
      const fileReadOnly = view.document?.sourceType === 'file' && !view.document.textFileEditable;
      button.disabled = view.operationPending || (fileReadOnly && (button.id === 'saveKnowledgeRevision' || button.matches('[data-restore-revision]')));
    });
  }
  function syncRelationControls() {
    document.querySelectorAll('[data-knowledge-relations-tab]').forEach(button => {
      const active = details.open && button.dataset.knowledgeRelationsTab === view.activeTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-expanded', String(active));
      if (button.hasAttribute('role')) button.setAttribute('aria-selected', String(active));
    });
    const close = document.querySelector('#knowledgeRelationsClose');
    if (close) close.hidden = !details.open;
  }
  function closeRelations({ focus = true } = {}) {
    const tab = view.activeTab;
    details.open = false;
    if (view.document?.sourceType === 'file' && !view.document.textFileSupported) { relations.hidden = true; relations.classList.remove('file-relations-open'); }
    syncRelationControls();
    if (focus) document.querySelector('[data-knowledge-relations-tab="' + tab + '"]')?.focus();
  }

  const view = {
    document: null,
    pickerItems: [],
    pickerIndex: 0,
    pickerRequest: 0,
    backlinksCursor: '',
    revisionsCursor: '',
    backlinksLoaded: false,
    revisionsLoaded: false,
    revisions: [],
    selectedRevision: null,
    activeTab: 'backlinks',
    documentSerial: 0,
    backlinksRequestSeq: 0,
    revisionsRequestSeq: 0,
    revisionDetailRequestSeq: 0,
    backlinksPending: null,
    revisionsPending: null,
    backlinkTotal: null,
    revisionTotal: null,
    operationPending: false,
  };

  let pickerTimer = null;
  let pickerController = null;
  let composing = false;
  const hidePicker = () => {
    clearTimeout(pickerTimer);
    pickerController?.abort();
    view.pickerRequest += 1;
    if (picker.hidden && !picker.childNodes.length) return;
    picker.hidden = true;
    textarea.setAttribute('aria-expanded', 'false');
    picker.innerHTML = '';
    view.pickerItems = [];
    view.pickerIndex = 0;
  };

  function pickerQuery() {
    const before = textarea.value.slice(0, textarea.selectionStart ?? textarea.value.length);
    const match = before.match(/\[\[([^\]\n|]*)$/);
    return match ? { query: match[1], start: before.length - match[0].length } : null;
  }

  function renderPicker() {
    picker.innerHTML = view.pickerItems.length
      ? view.pickerItems.map((item, index) => `
        <button type="button" role="option" aria-selected="${index === view.pickerIndex ? 'true' : 'false'}" data-link-target-index="${index}">
          <strong>${escHtml(item.title || item.id)}</strong>
          <small>${escHtml([item.knowledgeBase, item.folderPath].filter(Boolean).join(' · ') || item.sourceType || '')}</small>
        </button>`).join('')
      : '<p class="empty-list">没有可链接的文档</p>';
    picker.hidden = false;
    textarea.setAttribute('aria-expanded', 'true');
  }

  async function refreshPicker() {
    const query = pickerQuery();
    if (!query || !view.document) return hidePicker();
    const request = ++view.pickerRequest;
    const documentId = view.document.id;
    pickerController?.abort();
    pickerController = new AbortController();
    try {
      const params = new URLSearchParams({ q: query.query, limit: '20', excludeId: view.document.id });
      const response = await apiFetch(`/api/knowledge/link-targets?${params}`, { signal: pickerController.signal });
      const data = await response.json().catch(() => ({}));
      if (request !== view.pickerRequest || view.document?.id !== documentId || pickerQuery()?.query !== query.query) return;
      view.pickerItems = response.ok && Array.isArray(data.targets) ? data.targets : [];
      view.pickerIndex = 0;
      renderPicker();
    } catch {
      if (request === view.pickerRequest) hidePicker();
    }
  }

  function insertPickerItem(index) {
    const item = view.pickerItems[index];
    const query = pickerQuery();
    if (!item || !query) return hidePicker();
    const before = textarea.value.slice(0, query.start);
    const after = textarea.value.slice(textarea.selectionStart ?? textarea.value.length);
    const token = `[[${safeLabel(item.title || item.id)}|${item.id}]]`;
    textarea.value = `${before}${token}${after}`;
    const position = before.length + token.length;
    textarea.setSelectionRange(position, position);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    hidePicker();
    textarea.focus();
  }

  function renderIssues(issues = []) {
    const host = document.querySelector('#knowledgeLinkIssues');
    if (!host) return;
    const list = Array.isArray(issues) ? issues : [];
    if (!list.length) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    host.innerHTML = `<strong>链接需要处理</strong><ul>${list.slice(0, 20).map(item => `<li>${escHtml(item.status === 'ambiguous' ? `“${item.title}”有多个匹配，请使用选择器` : `“${item.title}”暂未找到目标`)}</li>`).join('')}</ul>`;
  }

  function updateSummary() {
    const summary = document.querySelector('#knowledgeRelationsSummary');
    if (!summary) return;
    const backlinkCount = view.backlinkTotal === null ? '引用未加载' : `${view.backlinkTotal} 条引用`;
    const revisionCount = view.revisionTotal === null ? '历史未加载' : `${view.revisionTotal} 个版本`;
    summary.textContent = `${backlinkCount} · ${revisionCount}`;
  }

  function setCount(selector, value) {
    const host = document.querySelector(selector);
    if (host) { host.textContent = value === null ? '' : String(value); host.hidden = value === null; }
  }

  function renderLoadError(host, message, retryAttribute) {
    if (host) host.innerHTML = `<p class="empty-list">${escHtml(message)} <button type="button" class="inline-retry" ${retryAttribute}>重试</button></p>`;
  }

  function renderBacklinks(items = [], append = false) {
    const host = document.querySelector('#knowledgeBacklinksList');
    if (!host) return;
    const html = items.length
      ? items.map(item => `<button type="button" class="knowledge-relation-row" data-backlink-id="${escHtml(item.sourceId)}" data-backlink-offset="${Number(item.offset) || 0}"><strong>${escHtml(item.title || item.sourceId)}</strong><small>${escHtml(item.snippet || '（无上下文）')}</small><em>${escHtml([item.knowledgeBase, item.folderPath].filter(Boolean).join(' · '))}</em></button>`).join('')
      : '<p class="empty-list">还没有文档引用此内容。</p>';
    if (append) host.insertAdjacentHTML('beforeend', html);
    else host.innerHTML = html;
  }

  async function loadBacklinks({ append = false } = {}) {
    if (!view.document) return;
    if (!append && view.backlinksPending) return view.backlinksPending.promise;
    const documentId = view.document.id;
    const serial = view.documentSerial;
    const requestSeq = ++view.backlinksRequestSeq;
    const cursor = append ? view.backlinksCursor : '';
    if (append && !cursor) return;
    const host = document.querySelector('#knowledgeBacklinksList');
    if (!append) host.innerHTML = '<p class="empty-list">正在加载反向引用…</p>';
    const pendingToken = {};
    const request = Promise.resolve().then(async () => {
      try {
        const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}/backlinks?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '反向引用加载失败');
        if (serial !== view.documentSerial || requestSeq !== view.backlinksRequestSeq || documentId !== view.document?.id) return;
        view.backlinkTotal = Number(data.total) || 0;
        setCount('#knowledgeBacklinkCount', view.backlinkTotal);
        renderBacklinks(data.backlinks || [], append);
        view.backlinksCursor = data.nextCursor || '';
        view.backlinksLoaded = true;
        document.querySelector('#knowledgeBacklinksLoadMore').hidden = !view.backlinksCursor;
        updateSummary();
      } catch (error) {
        if (serial === view.documentSerial && requestSeq === view.backlinksRequestSeq && documentId === view.document?.id) renderLoadError(host, error.message || '反向引用加载失败', 'data-retry-backlinks');
        throw error;
      } finally {
        if (view.backlinksPending?.token === pendingToken) view.backlinksPending = null;
      }
    });
    if (!append) view.backlinksPending = { token: pendingToken, promise: request };
    return request;
  }

  function renderRevisions(items = [], append = false) {
    const host = document.querySelector('#knowledgeRevisionsList');
    if (!host) return;
    const html = items.length
      ? items.map(item => `<button type="button" class="knowledge-revision-row${view.selectedRevision?.id === Number(item.id) ? ' selected' : ''}" data-revision-id="${Number(item.id)}"><strong>${item.name ? `★ ${escHtml(item.name)}` : `版本 ${Number(item.documentVersion) || 1} · ${escHtml(item.title || '未命名')}`}</strong><small>${escHtml(formatDate(item.capturedAt))} · ${escHtml(formatRevisionReason(item.reason))} · v${Number(item.documentVersion) || 1} · ${Number(item.contentLength) || 0} 字</small></button>`).join('')
      : '<p class="empty-list">还没有可恢复的历史版本。</p>';
    if (append) host.insertAdjacentHTML('beforeend', html);
    else host.innerHTML = html;
  }

  async function loadRevisions({ append = false } = {}) {
    if (!view.document) return;
    if (!append && view.revisionsPending) return view.revisionsPending.promise;
    const documentId = view.document.id;
    const serial = view.documentSerial;
    const requestSeq = ++view.revisionsRequestSeq;
    const cursor = append ? view.revisionsCursor : '';
    if (append && !cursor) return;
    const host = document.querySelector('#knowledgeRevisionsList');
    if (!append) host.innerHTML = '<p class="empty-list">正在加载版本历史…</p>';
    const pendingToken = {};
    const request = Promise.resolve().then(async () => {
      try {
        const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}/revisions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '版本历史加载失败');
        if (serial !== view.documentSerial || requestSeq !== view.revisionsRequestSeq || documentId !== view.document?.id) return;
        view.revisionTotal = Number(data.total) || 0;
        setCount('#knowledgeRevisionCount', view.revisionTotal);
        if (!append) view.revisions = [];
        view.revisions.push(...(data.revisions || []));
        renderRevisions(data.revisions || [], append);
        view.revisionsCursor = data.nextCursor || '';
        view.revisionsLoaded = true;
        document.querySelector('#knowledgeRevisionsLoadMore').hidden = !view.revisionsCursor;
        updateSummary();
      } catch (error) {
        if (serial === view.documentSerial && requestSeq === view.revisionsRequestSeq && documentId === view.document?.id) renderLoadError(host, error.message || '版本历史加载失败', 'data-retry-revisions');
        throw error;
      } finally {
        if (view.revisionsPending?.token === pendingToken) view.revisionsPending = null;
      }
    });
    if (!append) view.revisionsPending = { token: pendingToken, promise: request };
    return request;
  }

  function renderRevisionDetail(revision) {
    const host = document.querySelector('#knowledgeRevisionDetail');
    if (!host || !revision) return;
    previewCleanup?.();
    previewCleanup = null;
    const current = view.document || {};
    const snapshot = revision.snapshot || {};
    const location = value => [value.knowledgeBase || '其他', value.folderPath].filter(Boolean).join(' / ');
    const fields = [
      ['标题', snapshot.title || '', current.title || ''],
      ['标签', Array.isArray(snapshot.tags) ? snapshot.tags.join('、') : '', Array.isArray(current.tags) ? current.tags.join('、') : ''],
      ['日期', snapshot.documentDate || '（无）', current.documentDate || '（无）'],
      ['位置', location(snapshot), location(current)],
    ];
    const fieldHtml = fields.filter(([, oldValue, newValue]) => oldValue !== newValue).map(([label, oldValue, newValue]) => `<div class="knowledge-revision-field"><strong>${escHtml(label)}</strong><span class="${oldValue === newValue ? '' : 'removed'}">旧版：${escHtml(oldValue || '（无）')}</span><span class="${oldValue === newValue ? '' : 'added'}">当前：${escHtml(newValue || '（无）')}</span></div>`).join('');
    const currentContent = current.sourceType === 'file' ? current.rawContent ?? '' : current.content || '';
    const diff = lineDiff(snapshot.content || '', currentContent);
    let body = diff.fallback
      ? `<div class="knowledge-revision-diff"><section><h4>历史</h4><pre>${escHtml(diff.left)}</pre></section><section><h4>当前</h4><pre>${escHtml(diff.right)}</pre></section></div>`
      : `<div class="knowledge-revision-diff"><section><h4>历史</h4><pre>${diff.left}</pre></section><section><h4>当前</h4><pre>${diff.right}</pre></section></div>`;
    if (current.sourceType === 'file' && typeof current.rawContent !== 'string') {
      body = `<div class="knowledge-revision-diff"><section><h4>历史原件</h4><pre>${escHtml(snapshot.content || '')}</pre></section><section><h4>当前原件</h4><p>当前原件不可读取或不符合 UTF-8 编辑条件，请同步并重新打开后比较。</p></section></div>`;
    }
    const isMindmap = snapshot.documentRole === 'mindmap' && current.documentRole === 'mindmap';
    if (isMindmap) body = `<div class="mindmap-history-pair" data-mindmap-history></div><details class="mindmap-history-json"><summary>JSON 文本对比</summary>${body}</details>`;
    if (snapshot.snapshotKind === 'text_file') body = `<p class="knowledge-revision-image-note">原文件版本 · UTF-8${snapshot.file?.bom ? '（含 BOM）' : ''} · ${Number(snapshot.file?.bytes) || 0} 字节</p>${body}`;
    const actions = revision.name
      ? `<button type="button" class="secondary-action compact" data-rename-revision="${Number(revision.id)}">重命名</button><button type="button" class="danger-action compact" data-delete-revision="${Number(revision.id)}">删除命名版本</button>`
      : '';
    host.hidden = false;
    host.innerHTML = `<div class="knowledge-revision-content"><div class="knowledge-revision-detail-head"><span>${revision.name ? `${escHtml(revision.name)} · ` : ''}${escHtml(formatDate(revision.capturedAt))} · 历史 v${Number(revision.documentVersion) || 1}</span></div>${fieldHtml ? `<div class="knowledge-revision-fields">${fieldHtml}</div>` : '<p class="knowledge-revision-image-note">标题、标签、日期与位置未变化。</p>'}${body}${current.sourceType !== 'file' && !isMindmap ? '<p class="knowledge-revision-image-note">图片文件不会保存历史副本；恢复内容后，仍需图片资源存在才能显示。</p>' : ''}</div><div class="knowledge-revision-footer"><label class="knowledge-revision-location-option"><input type="checkbox" data-restore-location> 同时恢复历史位置</label><div class="knowledge-revision-actions">${actions}<button type="button" class="primary-action compact" data-restore-revision="${Number(revision.id)}">恢复此版本</button></div></div>`;
    showRevision();
    if (isMindmap) previewCleanup = mountMindmapHistory(host.querySelector('[data-mindmap-history]'), snapshot.content, currentContent);
    syncOperationControls();
  }

  async function openRevision(revisionId) {
    if (!view.document) return;
    const documentId = view.document.id;
    const serial = view.documentSerial;
    const requestSeq = ++view.revisionDetailRequestSeq;
    const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}/revisions/${encodeURIComponent(revisionId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '历史版本读取失败');
    if (serial !== view.documentSerial || requestSeq !== view.revisionDetailRequestSeq || documentId !== view.document?.id) return;
    view.selectedRevision = data.revision;
    renderRevisionDetail(data.revision);
    renderRevisions(view.revisions);
    revisionOrigin = document.querySelector(`[data-revision-id="${Number(revisionId)}"]`);
  }

  async function restoreSelected(revisionId) {
    if (!view.document || view.operationPending) return;
    const documentId = view.document.id;
    let revision = view.selectedRevision;
    if (!revision || Number(revision.id) !== Number(revisionId)) throw new Error('请先重新选择并比较此版本');
    const restoreLocationChoice = Boolean(document.querySelector('#knowledgeRevisionDetail [data-restore-location]')?.checked);
    view.operationPending = true;
    syncOperationControls();
    let locked = false;
    try {
      if (typeof beforeMutation === 'function') {
        locked = await beforeMutation(documentId);
        if (!locked) throw new Error('草稿保存失败或文档已切换，未执行恢复');
      }
      await openRevision(revisionId);
      revision = view.selectedRevision;
      const checkbox = document.querySelector('#knowledgeRevisionDetail [data-restore-location]');
      if (checkbox) checkbox.checked = restoreLocationChoice;
      const current = view.document;
      const serial = view.documentSerial;
      const restoreLocation = Boolean(checkbox?.checked);
      const snapshot = revision.snapshot || {};
      const location = value => [value.knowledgeBase || '其他', value.folderPath].filter(Boolean).join(' / ');
      const currentLocation = location(current);
      const oldLocation = location(snapshot);
      const confirmed = await confirmAction({
        title: '恢复历史版本',
        message: `将恢复“${revision.name || revision.title || `v${revision.documentVersion}`}”的正文、标题、标签和日期。${restoreLocation ? `位置：${currentLocation} → ${oldLocation}。` : `保留当前位置：${currentLocation}。`}当前草稿已保存；恢复不会自动保存当前内容为历史版本。`,
        confirmText: '恢复此版本',
      });
      if (!confirmed) return;
      if (serial !== view.documentSerial || view.document?.id !== documentId || view.document.version !== current.version || state.documentDirty) {
        throw new Error('笔记已变化，请重新比较后再恢复');
      }
      let response;
      let data;
      try {
        response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}/revisions/${encodeURIComponent(revisionId)}/restore`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseVersion: current.version, baseFingerprint: current.baseFingerprint, restoreLocation }),
        });
        data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '历史版本恢复失败');
      } catch (error) {
        if (error instanceof TypeError || !response || response.status >= 500) {
          const check = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}`);
          const latest = check.ok ? await check.json().catch(() => null) : null;
          const expectedLocation = restoreLocation ? oldLocation : currentLocation;
          if (latest && Number(latest.version) > Number(current.version)
            && latest.title === snapshot.title && latest.content === snapshot.content
            && (snapshot.snapshotKind !== 'text_file' || latest.fileMeta?.sha256 === snapshot.file?.sha256)
            && JSON.stringify(latest.tags || []) === JSON.stringify(snapshot.tags || [])
            && String(latest.documentDate || '') === String(snapshot.documentDate || '')
            && location(latest) === expectedLocation) data = { document: latest };
          else throw new Error('恢复结果暂时无法确认。没有自动重试，请刷新笔记并检查当前版本。');
        } else throw error;
      }
      if (typeof onRestore === 'function') await onRestore(data.document);
      view.document = data.document;
      view.documentSerial += 1;
      view.revisionsLoaded = false;
      view.revisionsPending = null;
      view.revisionTotal = null;
      setCount('#knowledgeRevisionCount', null);
      view.selectedRevision = null;
      closeRevision();
      details.open = true;
      view.activeTab = 'revisions';
      document.querySelector('#knowledgeBacklinksPanel').hidden = true;
      document.querySelector('#knowledgeRevisionsPanel').hidden = false;
      syncRelationControls();
      updateSummary();
      await loadRevisions();
    } finally {
      if (locked) await afterMutation?.(documentId, { failed: true });
      view.operationPending = false;
      syncOperationControls();
    }
  }

  async function saveNamedRevision() {
    if (!view.document || view.operationPending) return;
    const documentId = view.document.id;
    const input = document.querySelector('#knowledgeRevisionName');
    const name = String(input?.value || '').trim();
    if (!name) throw new Error('请先输入版本名称');
    view.operationPending = true;
    syncOperationControls();
    let locked = false;
    try {
      if (typeof beforeMutation === 'function') {
        locked = await beforeMutation(documentId);
        if (!locked) throw new Error('草稿保存失败或文档已切换，未保存命名版本');
      }
      if (documentId !== view.document?.id || state.documentDirty) throw new Error('笔记已变化，请重新保存后再命名版本');
      const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}/revisions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, baseVersion: view.document.version, baseFingerprint: view.document.baseFingerprint }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '命名版本保存失败');
      if (input) input.value = '';
      view.revisionsLoaded = false;
      view.revisionsPending = null;
      await loadRevisions();
      await openRevision(data.revision.id);
    } finally {
      if (locked) await afterMutation?.(documentId, { failed: true });
      view.operationPending = false;
      syncOperationControls();
    }
  }

  async function mutateNamedRevision(revisionId, action) {
    if (!view.document || view.operationPending) return;
    const documentId = view.document.id;
    const serial = view.documentSerial;
    const revision = view.revisions.find(item => Number(item.id) === Number(revisionId));
    if (!revision?.name) throw new Error('只能管理已命名的版本');
    let name = revision.name;
    if (action === 'rename') {
      name = window.prompt('修改版本名称', revision.name);
      if (name === null) return;
      if (!String(name).trim()) throw new Error('版本名称不能为空');
    } else {
      const confirmed = await confirmAction({ title: '删除命名版本', message: `确定删除“${revision.name}”？此操作不能撤销。`, confirmText: '删除版本' });
      if (!confirmed) return;
    }
    if (serial !== view.documentSerial || documentId !== view.document?.id) throw new Error('笔记已切换，请重新选择版本');
    view.operationPending = true;
    syncOperationControls();
    try {
      const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}/revisions/${encodeURIComponent(revisionId)}`, {
        method: action === 'rename' ? 'PATCH' : 'DELETE',
        ...(action === 'rename' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `命名版本${action === 'rename' ? '重命名' : '删除'}失败`);
      view.selectedRevision = null;
      document.querySelector('#knowledgeRevisionDetail').hidden = true;
      view.revisionsLoaded = false;
      view.revisionsPending = null;
      await loadRevisions();
      if (action === 'rename') await openRevision(data.revision.id);
      else closeRevision();
    } finally {
      view.operationPending = false;
      syncOperationControls();
    }
  }

  function setActiveDocument(doc) {
    closeRevision({ focus: false });
    const create = document.querySelector('#knowledgeRevisionCreate');
    if (create) create.hidden = true;
    document.querySelector('#knowledgeRevisionCreateToggle')?.setAttribute('aria-expanded', 'false');
    const help = document.querySelector('.knowledge-history-help');
    if (help) help.open = false;
    view.document = doc || null;
    view.documentSerial += 1;
    view.backlinksRequestSeq += 1;
    view.revisionsRequestSeq += 1;
    view.revisionDetailRequestSeq += 1;
    view.backlinksPending = null;
    view.revisionsPending = null;
    view.backlinkTotal = null;
    view.revisionTotal = null;
    view.backlinksCursor = '';
    view.revisionsCursor = '';
    view.backlinksLoaded = false;
    view.revisionsLoaded = false;
    view.revisions = [];
    view.selectedRevision = null;
    view.activeTab = 'backlinks';
    relations.hidden = !doc || (doc.sourceType === 'file' && !doc.textFileSupported);
    relations.classList.remove('file-relations-open');
    const revisionsTab = document.querySelector('[data-knowledge-relations-tab="revisions"]');
    const revisionCreate = document.querySelector('.knowledge-revision-create');
    const revisionRetention = document.querySelector('.knowledge-revision-retention');
    const supportsHistory = Boolean(doc && (doc.sourceType !== 'file' || doc.textFileSupported));
    if (revisionsTab) revisionsTab.hidden = !supportsHistory;
    if (revisionCreate) revisionCreate.hidden = relations.classList.contains('is-redesigned') || !supportsHistory;
    if (revisionRetention) revisionRetention.hidden = !supportsHistory;
    document.querySelectorAll('[data-knowledge-relations-tab]').forEach(button => {
      const active = button.dataset.knowledgeRelationsTab === 'backlinks';
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelector('#knowledgeBacklinksPanel').hidden = false;
    document.querySelector('#knowledgeRevisionsPanel').hidden = true;
    if (!doc) {
      details.open = false;
      syncRelationControls();
      return;
    }
    details.open = false;
    const backlinkCount = window.document.querySelector('#knowledgeBacklinkCount');
    const revisionCount = window.document.querySelector('#knowledgeRevisionCount');
    setCount('#knowledgeBacklinkCount', null);
    setCount('#knowledgeRevisionCount', null);
    syncRelationControls();
    window.document.querySelector('#knowledgeBacklinksList').innerHTML = '<p class="empty-list">展开后加载引用此文档的内容。</p>';
    window.document.querySelector('#knowledgeRevisionsList').innerHTML = '<p class="empty-list">展开后加载版本历史。</p>';
    window.document.querySelector('#knowledgeRevisionDetail').hidden = true;
    renderIssues(doc.linkIssues || []);
    updateSummary();
    syncOperationControls();
  }

  function onDocumentSaved(document) {
    if (!document || view.document?.id !== document.id) return;
    view.document = { ...view.document, ...document };
    renderIssues(document.linkIssues || []);
    if (view.selectedRevision && !window.document.querySelector('#knowledgeRevisionDetail').hidden) renderRevisionDetail(view.selectedRevision);
    if (details.open) {
      view.backlinksLoaded = false;
      view.revisionsLoaded = false;
      view.backlinksPending = null;
      view.revisionsPending = null;
      (view.activeTab === 'revisions' ? loadRevisions() : loadBacklinks()).catch(() => {});
    }
  }

  function schedulePicker() {
    clearTimeout(pickerTimer);
    pickerController?.abort();
    view.pickerRequest += 1;
    if (composing || !pickerQuery()) { hidePicker(); return; }
    pickerTimer = setTimeout(refreshPicker, 120);
  }
  textarea.addEventListener('compositionstart', () => { composing = true; hidePicker(); });
  textarea.addEventListener('compositionend', () => { composing = false; schedulePicker(); });
  textarea.addEventListener('input', schedulePicker);
  textarea.addEventListener('keydown', event => {
    if (picker.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); hidePicker(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      view.pickerIndex = Math.max(0, Math.min(Math.max(0, view.pickerItems.length - 1), view.pickerIndex + delta));
      renderPicker();
      return;
    }
    if (event.key === 'Enter' && view.pickerItems.length) { event.preventDefault(); insertPickerItem(view.pickerIndex); }
  });
  picker.addEventListener('mousedown', event => {
    const button = event.target.closest('[data-link-target-index]');
    if (!button) return;
    event.preventDefault();
    insertPickerItem(Number(button.dataset.linkTargetIndex));
  });
  document.addEventListener('mousedown', event => {
    if (!picker.contains(event.target) && event.target !== textarea) hidePicker();
  });
  details.addEventListener('toggle', () => {
    syncRelationControls();
    if (!details.open || !view.document) return;
    if (view.activeTab === 'revisions' && !view.revisionsLoaded) loadRevisions().catch(() => {});
    if (view.activeTab === 'backlinks' && !view.backlinksLoaded) loadBacklinks().catch(() => {});
  });
  document.querySelector('.knowledge-relations-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-knowledge-relations-tab]');
    if (!button) return;
    const nextTab = button.dataset.knowledgeRelationsTab === 'revisions' ? 'revisions' : 'backlinks';
    if (relations.classList.contains('is-redesigned') && details.open && nextTab === view.activeTab) { closeRelations(); return; }
    view.activeTab = nextTab;
    if (relations.classList.contains('is-redesigned')) details.open = true;
    document.querySelectorAll('[data-knowledge-relations-tab]').forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelector('#knowledgeBacklinksPanel').hidden = view.activeTab !== 'backlinks';
    document.querySelector('#knowledgeRevisionsPanel').hidden = view.activeTab !== 'revisions';
    syncRelationControls();
    if (details.open && view.document) {
      if (view.activeTab === 'revisions' && !view.revisionsLoaded) loadRevisions().catch(() => {});
      if (view.activeTab === 'backlinks' && !view.backlinksLoaded) loadBacklinks().catch(() => {});
    }
  });
  document.querySelector('#knowledgeBacklinksLoadMore').addEventListener('click', () => loadBacklinks({ append: true }).catch(() => {}));
  document.querySelector('#knowledgeRevisionsLoadMore').addEventListener('click', () => loadRevisions({ append: true }).catch(() => {}));
  document.querySelector('#knowledgeBacklinksList').addEventListener('click', event => {
    if (event.target.closest('[data-retry-backlinks]')) { view.backlinksLoaded = false; loadBacklinks().catch(() => {}); }
  });
  document.querySelector('#knowledgeRevisionsList').addEventListener('click', event => {
    if (event.target.closest('[data-retry-revisions]')) { view.revisionsLoaded = false; loadRevisions().catch(() => {}); }
  });
  document.querySelector('#knowledgeBacklinksList').addEventListener('click', event => {
    const row = event.target.closest('[data-backlink-id]');
    if (!row) return;
    navigate('knowledge', row.dataset.backlinkId, { offset: Number(row.dataset.backlinkOffset) || 0 });
  });
  document.querySelector('#knowledgeRevisionsList').addEventListener('click', event => {
    const row = event.target.closest('[data-revision-id]');
    if (row) {
      const serial = view.documentSerial;
      revisionOrigin = row;
      openRevision(row.dataset.revisionId).catch(error => {
        if (serial !== view.documentSerial) return;
        document.querySelector('#knowledgeRevisionDetail').hidden = false;
        document.querySelector('#knowledgeRevisionDetail').textContent = error.message;
        showRevision();
      });
    }
  });
  document.querySelector('#knowledgeRevisionDetail').addEventListener('click', event => {
    const button = event.target.closest('[data-restore-revision]');
    if (button) {
      const serial = view.documentSerial;
      restoreSelected(button.dataset.restoreRevision).catch(error => {
        if (serial === view.documentSerial) document.querySelector('#knowledgeRevisionDetail').insertAdjacentHTML('afterbegin', `<p class="empty-list">${escHtml(error.message)}</p>`);
      });
    }
    const rename = event.target.closest('[data-rename-revision]');
    if (rename) {
      const serial = view.documentSerial;
      mutateNamedRevision(rename.dataset.renameRevision, 'rename').catch(error => {
        if (serial === view.documentSerial) document.querySelector('#knowledgeRevisionDetail').insertAdjacentHTML('afterbegin', `<p class="empty-list">${escHtml(error.message)}</p>`);
      });
    }
    const remove = event.target.closest('[data-delete-revision]');
    if (remove) {
      const serial = view.documentSerial;
      mutateNamedRevision(remove.dataset.deleteRevision, 'delete').catch(error => {
        if (serial === view.documentSerial) document.querySelector('#knowledgeRevisionDetail').insertAdjacentHTML('afterbegin', `<p class="empty-list">${escHtml(error.message)}</p>`);
      });
    }
  });

  const knowledgeView = document.querySelector('#knowledgeView');
  if (knowledgeView) new window.MutationObserver(() => {
    if (knowledgeView.hidden) { closeRevision({ focus: false }); closeRelations({ focus: false }); }
  }).observe(knowledgeView, { attributes: true, attributeFilter: ['hidden'] });
  revisionDialog?.querySelector('[data-close-revision]')?.addEventListener('click', () => closeRevision());
  revisionDialog?.addEventListener('cancel', event => { event.preventDefault(); closeRevision(); });
  document.querySelector('#knowledgeRelationsClose')?.addEventListener('click', () => closeRelations());
  document.querySelector('#knowledgeRevisionCreateToggle')?.addEventListener('click', event => {
    const create = document.querySelector('#knowledgeRevisionCreate');
    create.hidden = !create.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!create.hidden));
    if (!create.hidden) document.querySelector('#knowledgeRevisionName').focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (document.querySelector('.date-picker-popup:not([hidden]), dialog[open]') || !picker.hidden) return;
    if (document.querySelector('.select-control-menu:not([hidden])')) return;
    if (details.open) { event.preventDefault(); closeRelations(); }
  });

  document.querySelector('#saveKnowledgeRevision').addEventListener('click', () => saveNamedRevision().catch(error => showToast(error.message, 'error')));

  return { setActiveDocument, onDocumentSaved, clear: () => setActiveDocument(null), renderIssues };
}
