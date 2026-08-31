import { escHtml } from '../helpers.js';
import { renderToHtmlUncached } from '../markdown.js';

const WIKI_LINK_RE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;
const DOCUMENT_ID_RE = /^(?:note|file):[1-9]\d*$/;

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
  return renderToHtmlUncached(transformed);
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
  return reason === 'pre_restore' ? '恢复前快照' : '自动保存';
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

export function initKnowledgeEnhancements({ apiFetch, state, navigate, confirmAction, onRestore }) {
  const textarea = document.querySelector('#documentContent');
  const picker = document.querySelector('#knowledgeLinkPicker');
  const relations = document.querySelector('#knowledgeRelations');
  const details = document.querySelector('#knowledgeRelationsDetails');
  if (!textarea || !picker || !relations || !details) return { setActiveDocument() {}, onDocumentSaved() {}, clear() {} };

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
  };

  const hidePicker = () => {
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
    try {
      const params = new URLSearchParams({ q: query.query, limit: '20', excludeId: view.document.id });
      const response = await apiFetch(`/api/knowledge/link-targets?${params}`);
      const data = await response.json().catch(() => ({}));
      if (request !== view.pickerRequest || !pickerQuery()) return;
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
    const backlinkCount = Number(document.querySelector('#knowledgeBacklinkCount')?.textContent || 0);
    const revisionCount = Number(document.querySelector('#knowledgeRevisionCount')?.textContent || 0);
    summary.textContent = `${backlinkCount} 条引用 · ${revisionCount} 个版本`;
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
    const cursor = append ? view.backlinksCursor : '';
    if (append && !cursor) return;
    const host = document.querySelector('#knowledgeBacklinksList');
    if (!append) host.innerHTML = '<p class="empty-list">正在加载反向引用…</p>';
    const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(view.document.id)}/backlinks?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '反向引用加载失败');
    document.querySelector('#knowledgeBacklinkCount').textContent = String(data.total || 0);
    renderBacklinks(data.backlinks || [], append);
    view.backlinksCursor = data.nextCursor || '';
    view.backlinksLoaded = true;
    document.querySelector('#knowledgeBacklinksLoadMore').hidden = !view.backlinksCursor;
    updateSummary();
  }

  function renderRevisions(items = [], append = false) {
    const host = document.querySelector('#knowledgeRevisionsList');
    if (!host) return;
    const html = items.length
      ? items.map(item => `<button type="button" class="knowledge-revision-row" data-revision-id="${Number(item.id)}"><strong>版本 ${Number(item.documentVersion) || 1} · ${escHtml(item.title || '未命名')}</strong><small>${escHtml(formatDate(item.capturedAt))} · ${escHtml(formatRevisionReason(item.reason))} · ${Number(item.contentLength) || 0} 字</small></button>`).join('')
      : '<p class="empty-list">还没有可恢复的历史版本。</p>';
    if (append) host.insertAdjacentHTML('beforeend', html);
    else host.innerHTML = html;
  }

  async function loadRevisions({ append = false } = {}) {
    if (!view.document) return;
    const cursor = append ? view.revisionsCursor : '';
    if (append && !cursor) return;
    const host = document.querySelector('#knowledgeRevisionsList');
    if (!append) host.innerHTML = '<p class="empty-list">正在加载版本历史…</p>';
    const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(view.document.id)}/revisions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '版本历史加载失败');
    document.querySelector('#knowledgeRevisionCount').textContent = String(data.total || 0);
    if (!append) view.revisions = [];
    view.revisions.push(...(data.revisions || []));
    renderRevisions(data.revisions || [], append);
    view.revisionsCursor = data.nextCursor || '';
    view.revisionsLoaded = true;
    document.querySelector('#knowledgeRevisionsLoadMore').hidden = !view.revisionsCursor;
    updateSummary();
  }

  function renderRevisionDetail(revision) {
    const host = document.querySelector('#knowledgeRevisionDetail');
    if (!host || !revision) return;
    const current = view.document || {};
    const diff = lineDiff(revision.snapshot?.content || '', current.content || '');
    const body = diff.fallback
      ? `<div class="knowledge-revision-diff"><pre>${escHtml(diff.left)}</pre><pre>${escHtml(diff.right)}</pre></div>`
      : `<div class="knowledge-revision-diff"><pre>${diff.left}</pre><pre>${diff.right}</pre></div>`;
    host.hidden = false;
    host.innerHTML = `<div class="knowledge-revision-detail-head"><span>${escHtml(formatDate(revision.capturedAt))} · 旧版 v${Number(revision.documentVersion) || 1}</span><button type="button" class="secondary-action compact" data-restore-revision="${Number(revision.id)}">恢复此版本</button></div>${body}`;
  }

  async function openRevision(revisionId) {
    if (!view.document) return;
    const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(view.document.id)}/revisions/${encodeURIComponent(revisionId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '历史版本读取失败');
    view.selectedRevision = data.revision;
    renderRevisionDetail(data.revision);
  }

  async function restoreSelected(revisionId) {
    if (!view.document) return;
    const confirmed = await confirmAction({
      title: '恢复历史版本',
      message: '恢复前会自动保存当前内容快照，并将旧版作为新版本写入。',
      confirmText: '比较后恢复',
    });
    if (!confirmed) return;
    const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(view.document.id)}/revisions/${encodeURIComponent(revisionId)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: view.document.version }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '历史版本恢复失败');
    if (typeof onRestore === 'function') await onRestore(data.document);
    setActiveDocument(data.document);
    details.open = true;
    await loadRevisions();
  }

  function setActiveDocument(doc) {
    view.document = doc || null;
    view.backlinksCursor = '';
    view.revisionsCursor = '';
    view.backlinksLoaded = false;
    view.revisionsLoaded = false;
    view.revisions = [];
    view.selectedRevision = null;
    relations.hidden = !doc;
    if (!doc) {
      details.open = false;
      return;
    }
    details.open = false;
    const backlinkCount = window.document.querySelector('#knowledgeBacklinkCount');
    const revisionCount = window.document.querySelector('#knowledgeRevisionCount');
    if (backlinkCount) backlinkCount.textContent = '0';
    if (revisionCount) revisionCount.textContent = '0';
    window.document.querySelector('#knowledgeBacklinksList').innerHTML = '<p class="empty-list">展开后加载引用此文档的内容。</p>';
    window.document.querySelector('#knowledgeRevisionsList').innerHTML = '<p class="empty-list">展开后加载版本历史。</p>';
    window.document.querySelector('#knowledgeRevisionDetail').hidden = true;
    renderIssues(doc.linkIssues || []);
    updateSummary();
  }

  function onDocumentSaved(document) {
    if (!document || view.document?.id !== document.id) return;
    view.document = { ...view.document, ...document };
    renderIssues(document.linkIssues || []);
    if (details.open) {
      view.backlinksLoaded = false;
      view.revisionsLoaded = false;
      Promise.all([loadBacklinks(), loadRevisions()]).catch(() => {});
    }
  }

  textarea.addEventListener('input', () => { refreshPicker(); });
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
    if (!details.open || !view.document) return;
    Promise.all([
      view.backlinksLoaded ? null : loadBacklinks(),
      view.revisionsLoaded ? null : loadRevisions(),
    ].filter(Boolean)).catch(error => {
      document.querySelector('#knowledgeBacklinksList').innerHTML = `<p class="empty-list">${escHtml(error.message)}</p>`;
    });
  });
  document.querySelector('.knowledge-relations-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-knowledge-relations-tab]');
    if (!button) return;
    view.activeTab = button.dataset.knowledgeRelationsTab === 'revisions' ? 'revisions' : 'backlinks';
    document.querySelectorAll('[data-knowledge-relations-tab]').forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelector('#knowledgeBacklinksPanel').hidden = view.activeTab !== 'backlinks';
    document.querySelector('#knowledgeRevisionsPanel').hidden = view.activeTab !== 'revisions';
  });
  document.querySelector('#knowledgeBacklinksLoadMore').addEventListener('click', () => loadBacklinks({ append: true }).catch(error => { document.querySelector('#knowledgeBacklinksList').insertAdjacentHTML('beforeend', `<p class="empty-list">${escHtml(error.message)}</p>`); }));
  document.querySelector('#knowledgeRevisionsLoadMore').addEventListener('click', () => loadRevisions({ append: true }).catch(error => { document.querySelector('#knowledgeRevisionsList').insertAdjacentHTML('beforeend', `<p class="empty-list">${escHtml(error.message)}</p>`); }));
  document.querySelector('#knowledgeBacklinksList').addEventListener('click', event => {
    const row = event.target.closest('[data-backlink-id]');
    if (!row) return;
    navigate('knowledge', row.dataset.backlinkId, { offset: Number(row.dataset.backlinkOffset) || 0 });
  });
  document.querySelector('#knowledgeRevisionsList').addEventListener('click', event => {
    const row = event.target.closest('[data-revision-id]');
    if (row) openRevision(row.dataset.revisionId).catch(error => { document.querySelector('#knowledgeRevisionDetail').hidden = false; document.querySelector('#knowledgeRevisionDetail').textContent = error.message; });
  });
  document.querySelector('#knowledgeRevisionDetail').addEventListener('click', event => {
    const button = event.target.closest('[data-restore-revision]');
    if (button) restoreSelected(button.dataset.restoreRevision).catch(error => { document.querySelector('#knowledgeRevisionDetail').insertAdjacentHTML('afterbegin', `<p class="empty-list">${escHtml(error.message)}</p>`); });
  });

  return { setActiveDocument, onDocumentSaved, clear: () => setActiveDocument(null), renderIssues };
}
