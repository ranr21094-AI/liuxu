import { state } from './state.js';
import { apiFetch, getAuthToken } from './auth.js';
import { showToast, escHtml, confirmDialog, openModal, closeModal, $, $$ } from './helpers.js';
import { renderToHtmlUncached } from './markdown.js';
import { loadLogs, listView } from './logList.js';
import { loadStats } from './stats.js';
import { findAction, getAllShortcuts, setShortcut, resetAllShortcuts, formatKeys, isComboUsed } from './shortcuts.js';
import { closeCategoryManager, loadCategories, populateFilterCategory, populateEditorParentCategory, populateEditorSubCategory } from './categories.js';
import { renderCalendar } from './calendar.js';
import { AUTO_SAVE_MS, SAVE_STATUS_DURATION } from './constants.js';
import { businessDateString, formatTemplateDate, shiftBusinessDate } from './businessDate.js';

const editorView = $('#editorView');
const categoryView = $('#categoryView');
const editTitle = $('#editTitle');
const editContent = $('#editContent');
const editorContentArea = document.querySelector('.editor-content-area');
const editPreview = $('#editPreview');
const editDate = $('#editDate');
const editCategory = $('#editCategory');
const editSubcategory = $('#editSubcategory');
const editHours = $('#editHours');
const saveStatus = $('#saveStatus');

// Editor-internal state
const EDITOR_TAB_STORAGE_KEY = 'editorTabMode';
let editorTab = localStorage.getItem(EDITOR_TAB_STORAGE_KEY) || 'write';
if (!['write', 'preview', 'split'].includes(editorTab)) editorTab = 'write';
let autoSaveTimer = null;
let lastSavedContent = '';
let lastSavedTitle = '';
let lastSavedDate = '';
let lastSavedHours = '';
let lastSavedCategory = '';
let isDirty = false;
let isSaving = false;
let currentSavePromise = null;

export function showListView() {
  listView.style.display = 'flex';
  editorView.style.display = 'none';
  categoryView.style.display = 'none';
  state.editingId = null;
  clearAutoSave();
  loadLogs();
  if (state.listScrollY) {
    requestAnimationFrame(() => window.scrollTo({ top: state.listScrollY, behavior: 'instant' }));
    state.listScrollY = null;
  }
}

function showEditorView() {
  listView.style.display = 'none';
  categoryView.style.display = 'none';
  editorView.style.display = 'flex';
  editContent.focus();
}

function getCategoryValue() {
  const parent = editCategory.value;
  const sub = editSubcategory.value;
  return sub ? parent + '/' + sub : parent;
}

function updateDirtyState() {
  const title = editTitle.value.trim();
  const content = editContent.value;
  const date = editDate.value;
  const hours = editHours.value;
  const category = getCategoryValue();

  const dirty = (
    title !== lastSavedTitle ||
    content !== lastSavedContent ||
    date !== lastSavedDate ||
    hours !== lastSavedHours ||
    category !== lastSavedCategory
  );

  if (dirty !== isDirty) {
    isDirty = dirty;
    if (dirty) {
      saveStatus.textContent = '●';
      saveStatus.title = '未保存';
      document.title = '* 工作日志';
    } else {
      saveStatus.textContent = '';
      saveStatus.title = '';
      document.title = '工作日志';
    }
  }
}

export async function openEditor(id) {
  try {
    const res = await apiFetch(`/api/logs/${id}`);
    const log = await res.json();
    state.editingId = id;
    state.listScrollY = window.scrollY;
    showEditorView();
    editTitle.value = log.title;
    editContent.value = log.content;
    editDate.value = log.log_date || '';
    editHours.value = log.hours;
    lastSavedContent = log.content;
    lastSavedTitle = log.title;
    lastSavedDate = log.log_date || '';
    lastSavedHours = String(log.hours);
    lastSavedCategory = log.category;

    // Parse "parent/sub" into parent and sub dropdowns
    const slashIdx = log.category.indexOf('/');
    const parent = slashIdx === -1 ? log.category : log.category.substring(0, slashIdx);
    const sub = slashIdx === -1 ? '' : log.category.substring(slashIdx + 1);
    if ([...editCategory.options].some(o => o.value === parent)) {
      editCategory.value = parent;
    } else {
      editCategory.value = '其他';
    }
    populateEditorSubCategory(editCategory.value);
    if (sub) {
      setTimeout(() => {
        if ([...editSubcategory.options].some(o => o.value === sub)) {
          editSubcategory.value = sub;
        }
      }, 0);
    }

    isDirty = false;
    saveStatus.textContent = '';
    document.title = '工作日志';

    switchTab(editorTab);
    return true;
  } catch (err) {
    console.error('Load log failed:', err);
    showToast('加载日志失败: ' + err.message, 'error');
    return false;
  }
}

export function newLog() {
  state.listScrollY = window.scrollY;
  state.editingId = null;
  lastSavedContent = '';
  lastSavedTitle = '';
  lastSavedDate = state.selectedDate || '';
  lastSavedHours = '0';
  lastSavedCategory = '其他';
  editTitle.value = '';
  editContent.value = '';
  editDate.value = state.selectedDate || '';
  editHours.value = '0';
  editCategory.value = '其他';
  editSubcategory.value = '';
  populateEditorSubCategory('其他');
  saveStatus.textContent = '';
  isDirty = false;
  document.title = '工作日志';
  showEditorView();
  switchTab(editorTab);
}

$('#btnNewLog').addEventListener('click', newLog);

async function returnToListAfterSave() {
  clearAutoSave();
  if (currentSavePromise) await currentSavePromise;
  updateDirtyState();

  if (state.editingId || editTitle.value.trim() || editContent.value.trim()) {
    const saved = await doSave(false);
    if (!saved) return;
    updateDirtyState();
    if (isDirty) {
      showToast('仍有未保存内容，请稍后再返回', 'error');
      return;
    }
  }
  showListView();
  loadStats();
}

export async function openEditorFromNavigation(id) {
  const targetId = parseInt(id, 10);
  if (!Number.isFinite(targetId)) return false;
  if (state.editingId === targetId) return true;

  const inEditor = editorView.style.display !== 'none';
  if (inEditor) {
    clearAutoSave();
    if (currentSavePromise) await currentSavePromise;
    updateDirtyState();

    if (state.editingId || editTitle.value.trim() || editContent.value.trim()) {
      const saved = await doSave(false);
      if (!saved) return false;
      updateDirtyState();
      if (isDirty) {
        showToast('仍有未保存内容，请稍后再切换', 'error');
        return false;
      }
    }
  }

  return openEditor(targetId);
}

$('#btnBack').addEventListener('click', () => {
  returnToListAfterSave();
});

// Auto-save with dirty detection
function autoSave() {
  updateDirtyState();
  clearAutoSave();
  if (!isDirty) return;
  autoSaveTimer = setTimeout(() => {
    if (state.editingId || editTitle.value.trim() || editContent.value.trim()) {
      doSave(true);
    }
  }, AUTO_SAVE_MS);
}

function clearAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}

export async function doSave(silent) {
  if (isSaving) return currentSavePromise || false;
  const title = editTitle.value.trim();
  const content = editContent.value;
  const log_date = editDate.value;
  const hours = parseFloat(editHours.value) || 0;
  const category = getCategoryValue();

  if (!content) {
    if (!silent) showToast('请填写内容', 'error');
    return false;
  }

  const finalTitle = title || '未命名日志';
  const body = { title: finalTitle, content, log_date, hours, category };
  const url = state.editingId ? `/api/logs/${state.editingId}` : '/api/logs';
  const method = state.editingId ? 'PUT' : 'POST';

  isSaving = true;
  currentSavePromise = (async () => {
    try {
      saveStatus.style.color = '';
      if (!silent) saveStatus.textContent = '保存中...';
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');

      const saved = await res.json();
      if (!state.editingId) {
        state.editingId = saved.id;
      }
      lastSavedContent = content;
      lastSavedTitle = finalTitle;
      lastSavedDate = log_date;
      lastSavedHours = String(hours);
      lastSavedCategory = category;
      saveStatus.style.color = '';
      updateDirtyState();

      if (isDirty) {
        saveStatus.textContent = '●';
        saveStatus.title = '未保存';
        if (silent) autoSave();
      } else if (silent) {
        saveStatus.textContent = '已自动保存';
        setTimeout(() => { if (saveStatus.textContent === '已自动保存') { saveStatus.textContent = ''; } }, SAVE_STATUS_DURATION);
      } else {
        saveStatus.textContent = '已保存';
        setTimeout(() => { if (saveStatus.textContent === '已保存') { saveStatus.textContent = ''; } }, SAVE_STATUS_DURATION);
      }
      return true;
    } catch (err) {
      saveStatus.textContent = '保存失败';
      saveStatus.style.color = 'var(--color-danger)';
      showToast('保存失败: ' + err.message, 'error');
      console.error(err);
      return false;
    } finally {
      isSaving = false;
      currentSavePromise = null;
    }
  })();

  return currentSavePromise;
}

// Modal helpers
function closeAllModals() {
  closeModal($('#logLinkOverlay'));
  closeModal($('#templateModalOverlay'));
  closeModal($('#shortcutHelpOverlay'));
  closeModal($('#diaryUnlockOverlay'));
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  const action = findAction(e);
  if (!action) return;

  const inEditor = editorView.style.display !== 'none';
  const focusedOnContent = document.activeElement === editContent;

  switch (action) {
    case 'save':
      if (inEditor) { e.preventDefault(); doSave(); }
      break;
    case 'preview':
      if (inEditor) { e.preventDefault(); switchTab(nextEditorTab()); }
      break;
    case 'bold':
      if (focusedOnContent) { e.preventDefault(); insertMarkdown('bold'); }
      break;
    case 'italic':
      if (focusedOnContent) { e.preventDefault(); insertMarkdown('italic'); }
      break;
    case 'newLog':
      e.preventDefault(); newLog();
      break;
    case 'search':
      e.preventDefault();
      { const si = $('#searchInput'); si.focus(); si.select(); }
      break;
    case 'clearFilter':
      e.preventDefault();
      state.search = ''; state.category = ''; state.month = '';
      state.selectedDate = null; state.currentPage = 1;
      $('#searchInput').value = '';
      $('#filterCategory').value = '';
      $('#filterSubcategory').value = '';
      $('#filterSubcategory').style.display = 'none';
      $('#filterMonth').value = '';
      renderCalendar();
      loadLogs();
      break;
    case 'help':
      if (!isInput) { e.preventDefault(); openModal($('#shortcutHelpOverlay'), '#shortcutHelpClose'); }
      break;
    case 'escape':
      if (document.getElementById('genericConfirmOverlay')?.style.display === 'flex') {
        e.preventDefault();
      } else if ($('#logLinkOverlay').style.display === 'flex' || $('#templateModalOverlay').style.display === 'flex' || $('#shortcutHelpOverlay').style.display === 'flex' || $('#diaryUnlockOverlay').style.display === 'flex') {
        e.preventDefault(); closeAllModals();
      } else if (categoryView.style.display !== 'none') {
        e.preventDefault(); closeCategoryManager();
      } else if (inEditor) {
        e.preventDefault(); returnToListAfterSave();
      }
      break;
  }
});

// Shortcut manager UI
let pendingEditAction = null;
let pendingNewKeys = null;

function renderShortcutList() {
  const list = $('#shortcutList');
  const all = getAllShortcuts();
  const actions = Object.keys(all);
  if (actions.length === 0) {
    list.innerHTML = '<div class="shortcut-empty">暂无快捷键</div>';
    return;
  }
  list.innerHTML = actions.map(action => {
    const s = all[action];
    return `
      <div class="shortcut-row">
        <span class="shortcut-desc">${escHtml(s.description || action)}</span>
        <button class="shortcut-keys ${s.custom ? 'is-custom' : ''}" data-action="${escHtml(action)}" title="点击修改快捷键">${renderKbd(s.keys)}</button>
        ${s.custom ? '<span class="shortcut-custom-tag">已修改</span>' : ''}
      </div>
    `;
  }).join('');
}

function renderKbd(combo) {
  return combo.split('+').map(p => `<kbd>${escHtml(p.trim())}</kbd>`).join('<span class="kbd-plus">+</span>');
}

function startRebind(action) {
  const el = document.querySelector(`.shortcut-keys[data-action="${CSS.escape(action)}"]`);
  if (!el) return;
  pendingEditAction = action;
  pendingNewKeys = { ctrl: false, shift: false, alt: false, key: '' };
  el.classList.add('listening');
  el.innerHTML = '<kbd class="kbd-listen">按下组合键...</kbd>';
  el.focus();
}

function cancelRebind() {
  pendingEditAction = null;
  pendingNewKeys = null;
  renderShortcutList();
}

function commitRebind() {
  if (!pendingEditAction || !pendingNewKeys || !pendingNewKeys.key) {
    cancelRebind();
    return;
  }
  const newCombo = formatKeys(pendingNewKeys);
  const conflict = isComboUsed(newCombo, pendingEditAction);
  if (conflict) {
    showToast(`冲突: 已被「${getAllShortcuts()[conflict]?.description || conflict}」使用`, 'error');
    cancelRebind();
    return;
  }
  setShortcut(pendingEditAction, { keys: newCombo });
  pendingEditAction = null;
  pendingNewKeys = null;
  renderShortcutList();
  showToast('快捷键已更新', 'success');
}

$('#shortcutList').addEventListener('click', (e) => {
  const keysEl = e.target.closest('.shortcut-keys');
  if (keysEl) {
    startRebind(keysEl.dataset.action);
    return;
  }
});

$('#shortcutList').addEventListener('keydown', (e) => {
  if (!pendingEditAction) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { cancelRebind(); return; }
  if (e.key === 'Enter') { commitRebind(); return; }
  // Capture modifier key combo
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (['Control','Shift','Alt','Meta'].includes(e.key)) return;
  pendingNewKeys = {
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: key,
  };
  const el = document.querySelector(`.shortcut-keys[data-action="${CSS.escape(pendingEditAction)}"]`);
  if (el) el.innerHTML = renderKbd(formatKeys(pendingNewKeys));
});

// Close on click outside
$('#shortcutList').addEventListener('blur', (e) => {
  // Small delay to allow click on other elements
  if (pendingEditAction && !e.relatedTarget?.closest('.shortcut-keys') && !e.relatedTarget?.closest('#shortcutList')) {
    cancelRebind();
  }
}, true);

// Reset all shortcuts
$('#btnShortcutReset').addEventListener('click', () => {
  resetAllShortcuts();
  renderShortcutList();
  showToast('已恢复默认快捷键');
});

// Render list when modal opens
const shortcutOverlay = $('#shortcutHelpOverlay');
const observer = new MutationObserver(() => {
  if (shortcutOverlay.style.display === 'flex') renderShortcutList();
});
observer.observe(shortcutOverlay, { attributes: true, attributeFilter: ['style'] });

// Close handlers
$('#shortcutHelpClose').addEventListener('click', () => { closeModal(shortcutOverlay); });
$('#shortcutHelpDone').addEventListener('click', () => { closeModal(shortcutOverlay); });
shortcutOverlay.addEventListener('click', (e) => {
  if (e.target === shortcutOverlay) closeModal(shortcutOverlay);
});

// Internal log links
function parseInternalLogHref(href) {
  const match = /^#log\/(\d+)$/.exec(href || '');
  if (!match) return null;
  const id = parseInt(match[1], 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function handleInternalLogLinkClick(e) {
  const link = e.target.closest('a[href]');
  if (!link) return false;
  const id = parseInternalLogHref(link.getAttribute('href'));
  if (!id) return false;
  e.preventDefault();
  e.stopPropagation();
  const switched = await openEditorFromNavigation(id);
  if (!switched) showToast('无法打开目标日志', 'error');
  return true;
}

editPreview.addEventListener('click', handleInternalLogLinkClick);

function markdownLinkText(text) {
  return (text || '未命名日志').replace(/([\\\]])/g, '\\$1');
}

function insertLogLink(log) {
  const label = markdownLinkText(log.title || '未命名日志');
  const insert = `[${label}](#log/${log.id})`;
  const ta = editContent;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const before = ta.value.substring(0, start);
  const after = ta.value.substring(end);
  ta.value = before + insert + after;
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + insert.length;
  autoSave();
  if (editorTab !== 'write') renderPreview();
}

let logLinkSearchTimer = null;
let logLinkSearchSeq = 0;
let logLinkResultsById = new Map();

function renderLogLinkResults(items) {
  const results = $('#logLinkResults');
  logLinkResultsById = new Map(items.map(log => [String(log.id), log]));
  if (!items.length) {
    results.innerHTML = '<div class="log-link-empty">没有找到可链接的日志</div>';
    return;
  }
  results.innerHTML = items.map(log => `
    <button type="button" class="log-link-item" data-id="${log.id}">
      <span class="log-link-title">${escHtml(log.title || '未命名日志')}</span>
      <span class="log-link-meta">${escHtml(log.log_date || '无日期')} · ${escHtml(log.category)} · ${log.hours || 0}h</span>
    </button>
  `).join('');
}

async function searchLogLinks() {
  const seq = ++logLinkSearchSeq;
  const query = $('#logLinkSearch').value.trim();
  const results = $('#logLinkResults');
  results.innerHTML = '<div class="log-link-loading">搜索中...</div>';
  const params = new URLSearchParams({ page: '1', limit: '20' });
  if (query) params.set('search', query);
  try {
    const res = await apiFetch(`/api/logs?${params}`);
    const data = await res.json();
    if (seq !== logLinkSearchSeq) return;
    renderLogLinkResults(data.items || []);
  } catch (err) {
    if (seq !== logLinkSearchSeq) return;
    results.innerHTML = `<div class="log-link-empty">搜索失败: ${escHtml(err.message)}</div>`;
  }
}

function openLogLinkPicker() {
  openModal($('#logLinkOverlay'), '#logLinkSearch');
  $('#logLinkSearch').value = '';
  $('#logLinkResults').innerHTML = '<div class="log-link-loading">加载中...</div>';
  searchLogLinks();
  setTimeout(() => $('#logLinkSearch').focus(), 80);
}

function closeLogLinkPicker() {
  closeModal($('#logLinkOverlay'));
}

$('#btnLogLink').addEventListener('click', openLogLinkPicker);
$('#logLinkClose').addEventListener('click', closeLogLinkPicker);
$('#logLinkDone').addEventListener('click', closeLogLinkPicker);
$('#logLinkOverlay').addEventListener('click', (e) => {
  if (e.target === $('#logLinkOverlay')) closeLogLinkPicker();
});
$('#logLinkSearch').addEventListener('input', () => {
  clearTimeout(logLinkSearchTimer);
  logLinkSearchTimer = setTimeout(searchLogLinks, 250);
});
$('#logLinkSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#logLinkResults .log-link-item')?.click();
  }
});
$('#logLinkResults').addEventListener('click', (e) => {
  const item = e.target.closest('.log-link-item');
  if (!item) return;
  const log = logLinkResultsById.get(item.dataset.id);
  if (!log) return;
  insertLogLink(log);
  closeLogLinkPicker();
});

// Markdown formatting toolbar
function insertMarkdown(action) {
  const ta = editContent;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = ta.value.substring(start, end);
  const before = ta.value.substring(0, start);
  const after = ta.value.substring(end);

  const inlineFormats = {
    bold:          { prefix: '**', suffix: '**', placeholder: '加粗文本' },
    italic:        { prefix: '*',  suffix: '*',  placeholder: '斜体文本' },
    strikethrough: { prefix: '~~', suffix: '~~', placeholder: '删除线文本' },
    code:          { prefix: '`',  suffix: '`',  placeholder: '代码' },
    mathInline:    { prefix: '$',  suffix: '$',  placeholder: '公式' },
  };

  const lineFormats = {
    h1:        { prefix: '# ',   placeholder: '标题' },
    h2:        { prefix: '## ',  placeholder: '标题' },
    h3:        { prefix: '### ', placeholder: '标题' },
    ul:        { prefix: '- ',   placeholder: '列表项' },
    ol:        { prefix: '1. ',  placeholder: '列表项' },
    checklist: { prefix: '- [ ] ', placeholder: '任务项' },
    quote:     { prefix: '> ',   placeholder: '引用文本' },
    codeblock:  { prefix: '```\n', suffix: '\n```', placeholder: '代码', line: true },
    mathBlock:  { prefix: '$$\n',  suffix: '\n$$',  placeholder: '公式', line: true },
  };

  if (inlineFormats[action]) {
    const fmt = inlineFormats[action];
    const text = sel || fmt.placeholder;
    const insert = fmt.prefix + text + fmt.suffix;
    ta.value = before + insert + after;
    if (sel) {
      ta.selectionStart = start + fmt.prefix.length;
      ta.selectionEnd = start + fmt.prefix.length + sel.length;
    } else {
      ta.selectionStart = start + fmt.prefix.length;
      ta.selectionEnd = start + fmt.prefix.length + text.length;
    }
  } else if (lineFormats[action]) {
    const fmt = lineFormats[action];
    if (fmt.line) {
      const text = sel || fmt.placeholder;
      const insert = fmt.prefix + text + fmt.suffix;
      ta.value = before + insert + after;
      ta.selectionStart = start + fmt.prefix.length;
      ta.selectionEnd = start + fmt.prefix.length + text.length;
    } else {
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineEnd = ta.value.indexOf('\n', end);
      const lineAfter = lineEnd === -1 ? '' : ta.value.substring(lineEnd);

      if (sel && sel.includes('\n')) {
        const lines = sel.split('\n').map(l => fmt.prefix + l);
        const insert = lines.join('\n');
        ta.value = before + insert + after;
        ta.selectionStart = start;
        ta.selectionEnd = start + insert.length;
      } else {
        const lineContent = ta.value.substring(lineStart, lineEnd === -1 ? ta.value.length : lineEnd);
        const newLine = fmt.prefix + lineContent;
        const remaining = ta.value.substring(0, lineStart) + newLine + lineAfter;
        ta.value = remaining;
        const cursorPos = lineStart + newLine.length;
        ta.selectionStart = cursorPos;
        ta.selectionEnd = cursorPos;
      }
    }
  } else if (action === 'link') {
    const text = sel || '链接文本';
    const insert = `[${text}](url)`;
    ta.value = before + insert + after;
    const urlStart = start + text.length + 3;
    ta.selectionStart = urlStart;
    ta.selectionEnd = urlStart + 3;
  } else if (action === 'hr') {
    const needNewline = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    const insert = needNewline + '---\n';
    ta.value = before + insert + after;
    const cursorPos = start + insert.length;
    ta.selectionStart = cursorPos;
    ta.selectionEnd = cursorPos;
  }

  ta.focus();
  autoSave();
  if (editorTab !== 'write') renderPreview();
}

$('#editorToolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  e.preventDefault();
  insertMarkdown(btn.dataset.action);
});

// Template insertion and management
const TEMPLATE_STORAGE_KEY = 'workLogTemplates';
const defaultTemplates = [
  { id: 'daily', name: '每日站会', title: '日报 {{today:MM月DD日}}', content: `## {{today}} 今日完成\n- \n\n## {{tomorrow}} 明日计划\n- \n\n## 遇到的问题\n- ` },
  { id: 'weekly', name: '周复盘', title: '周复盘 {{today:MM月DD日}}', content: `## 本周完成（{{today:MM-DD dddd}}）\n- \n\n## 下周计划\n- \n\n## 收获与反思\n- \n\n## 工时统计\n| 类别 | 小时 |\n|------|------|\n| 开发 | |\n| 会议 | |\n| 文档 | |\n| 其他 | |` },
  { id: 'meeting', name: '会议纪要', title: '会议纪要 {{today:MM月DD日}}', content: `## 会议主题\n\n- 日期：{{today}}\n\n## 参会人\n\n## 讨论内容\n- \n\n## 决议\n- \n\n## 待办事项\n- [ ] ` },
  { id: 'diary', name: '日记', title: '日记 {{today:MM月DD日}}', content: `# {{today:YYYY年MM月DD日 dddd}}\n\n## 今天的事\n\n\n## 心情/感受\n\n\n## 学到的东西\n` },
];
let templates = loadTemplates();
let selectedTemplateId = templates[0]?.id || null;

function renderTemplateContent(content) {
  const baseDate = editDate.value || businessDateString();
  return content.replace(/\{\{\s*([a-zA-Z]+)(?::([+-]?\d+))?(?::([^}]+))?\s*\}\}/g, (match, key, offsetText, formatText) => {
    const normalizedKey = key.toLowerCase();
    const namedOffsets = {
      today: 0,
      date: 0,
      tomorrow: 1,
      nextday: 1,
      yesterday: -1,
    };
    if (!Object.prototype.hasOwnProperty.call(namedOffsets, normalizedKey)) return match;

    const explicitOffset = offsetText === undefined ? null : Number(offsetText);
    const offset = Number.isFinite(explicitOffset) ? explicitOffset : namedOffsets[normalizedKey];
    return formatTemplateDate(shiftBusinessDate(baseDate, offset), (formatText || 'YYYY-MM-DD').trim());
  });
}

function cloneDefaultTemplates() {
  return defaultTemplates.map(t => ({ ...t }));
}

function loadTemplates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY));
    if (Array.isArray(parsed)) {
      return parsed
        .filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.content === 'string')
        .map(t => ({
          id: t.id,
          name: t.name,
          title: typeof t.title === 'string' ? t.title : t.name,
          content: t.content,
        }));
    }
  } catch {
    // Fall back to defaults below.
  }
  return cloneDefaultTemplates();
}

function saveTemplates() {
  localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

function populateTemplateSelect() {
  const sel = $('#templateSelect');
  sel.innerHTML = '<option value="">模板</option>' +
    templates.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name)}</option>`).join('');
}

function insertTemplateContent(content) {
  const renderedContent = renderTemplateContent(content);
  const ta = editContent;
  const hasContent = ta.value.trim().length > 0;
  const prefix = hasContent ? '\n\n' : '';
  const start = ta.selectionStart;
  const before = ta.value.substring(0, start);
  const after = ta.value.substring(start);
  ta.value = before + prefix + renderedContent + after;
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + prefix.length + renderedContent.length;
  autoSave();
  if (editorTab !== 'write') renderPreview();
}

function applyTemplate(template) {
  if (template.id === 'diary' && $('#btnDiaryLock').style.display !== 'none' &&
      [...editCategory.options].some(option => option.value === '日记')) {
    editCategory.value = '日记';
    populateEditorSubCategory('日记');
    editSubcategory.value = '';
  }
  if (!editTitle.value.trim()) {
    editTitle.value = renderTemplateContent(template.title || template.name);
  }
  insertTemplateContent(template.content);
}

function renderTemplateManager() {
  const list = $('#templateList');
  if (!templates.length) {
    list.innerHTML = '<div class="template-empty">暂无模板</div>';
    selectedTemplateId = null;
    $('#templateNameInput').value = '';
    $('#templateTitleInput').value = '';
    $('#templateContentInput').value = '';
    return;
  }
  if (!templates.some(t => t.id === selectedTemplateId)) selectedTemplateId = templates[0].id;
  list.innerHTML = templates.map(t => `
    <button class="template-list-item ${t.id === selectedTemplateId ? 'active' : ''}" data-id="${escHtml(t.id)}">
      ${escHtml(t.name)}
    </button>
  `).join('');
  const selected = templates.find(t => t.id === selectedTemplateId);
  $('#templateNameInput').value = selected?.name || '';
  $('#templateTitleInput').value = selected?.title || selected?.name || '';
  $('#templateContentInput').value = selected?.content || '';
}

function openTemplateManager() {
  renderTemplateManager();
  openModal($('#templateModalOverlay'), '#templateNameInput');
}

function closeTemplateManager() {
  closeModal($('#templateModalOverlay'));
  populateTemplateSelect();
}

populateTemplateSelect();

$('#templateSelect').addEventListener('change', () => {
  const sel = $('#templateSelect');
  const val = sel.value;
  if (!val) return;
  const template = templates.find(t => t.id === val);
  if (!template) return;
  applyTemplate(template);
  sel.value = '';
});

$('#btnManageTemplates').addEventListener('click', openTemplateManager);
$('#templateModalClose').addEventListener('click', closeTemplateManager);
$('#templateModalDone').addEventListener('click', closeTemplateManager);
$('#templateModalOverlay').addEventListener('click', (e) => {
  if (e.target === $('#templateModalOverlay')) closeTemplateManager();
});

$('#templateList').addEventListener('click', (e) => {
  const item = e.target.closest('.template-list-item');
  if (!item) return;
  selectedTemplateId = item.dataset.id;
  renderTemplateManager();
});

$('#btnTemplateNew').addEventListener('click', () => {
  const id = 'tpl-' + Date.now().toString(36);
  templates.push({ id, name: '新模板', title: '新日志 {{today:MM月DD日}}', content: '' });
  selectedTemplateId = id;
  saveTemplates();
  populateTemplateSelect();
  renderTemplateManager();
});

$('#btnTemplateSave').addEventListener('click', () => {
  const name = $('#templateNameInput').value.trim();
  const title = $('#templateTitleInput').value.trim();
  const content = $('#templateContentInput').value;
  if (!name) { showToast('请输入模板名称', 'error'); return; }
  if (!selectedTemplateId) {
    selectedTemplateId = 'tpl-' + Date.now().toString(36);
    templates.push({ id: selectedTemplateId, name, title: title || name, content });
  } else {
    const tpl = templates.find(t => t.id === selectedTemplateId);
    if (tpl) {
      tpl.name = name;
      tpl.title = title || name;
      tpl.content = content;
    }
  }
  saveTemplates();
  populateTemplateSelect();
  renderTemplateManager();
  showToast('模板已保存', 'success');
});

$('#btnTemplateDelete').addEventListener('click', async () => {
  if (!selectedTemplateId) return;
  const selected = templates.find(t => t.id === selectedTemplateId);
  const confirmed = await confirmDialog({
    title: '删除模板',
    message: `删除模板「${selected?.name || ''}」？`,
    confirmText: '删除',
  });
  if (!confirmed) return;
  templates = templates.filter(t => t.id !== selectedTemplateId);
  selectedTemplateId = templates[0]?.id || null;
  saveTemplates();
  populateTemplateSelect();
  renderTemplateManager();
});

$('#btnTemplateReset').addEventListener('click', async () => {
  const confirmed = await confirmDialog({
    title: '恢复默认模板',
    message: '恢复默认模板会覆盖当前模板列表。',
    confirmText: '恢复',
    danger: false,
  });
  if (!confirmed) return;
  templates = cloneDefaultTemplates();
  selectedTemplateId = templates[0]?.id || null;
  saveTemplates();
  populateTemplateSelect();
  renderTemplateManager();
});

// Input listeners
editTitle.addEventListener('input', autoSave);
editContent.addEventListener('input', () => {
  autoSave();
  if (editorTab !== 'write') renderPreview();
});
editDate.addEventListener('change', autoSave);
editHours.addEventListener('change', autoSave);
editCategory.addEventListener('change', () => {
  populateEditorSubCategory(editCategory.value);
  editSubcategory.value = '';
  autoSave();
});
editSubcategory.addEventListener('change', autoSave);

// Tab switching
function nextEditorTab() {
  if (editorTab === 'write') return 'preview';
  if (editorTab === 'preview') return 'split';
  return 'write';
}

export function switchTab(tab) {
  if (!['write', 'preview', 'split'].includes(tab)) tab = 'write';
  editorTab = tab;
  localStorage.setItem(EDITOR_TAB_STORAGE_KEY, tab);
  $$('.editor-tab').forEach(t => {
    const selected = t.dataset.tab === tab;
    t.classList.toggle('active', selected);
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    if (selected) editorContentArea.setAttribute('aria-labelledby', t.id);
  });
  editorContentArea.classList.toggle('split', tab === 'split');
  if (tab === 'write') {
    editContent.style.display = 'block';
    editPreview.style.display = 'none';
    $('#editorToolbar').style.display = 'flex';
  } else if (tab === 'preview') {
    renderPreview();
    editContent.style.display = 'none';
    editPreview.style.display = 'block';
    $('#editorToolbar').style.display = 'none';
  } else {
    renderPreview();
    editContent.style.display = 'block';
    editPreview.style.display = 'block';
    $('#editorToolbar').style.display = 'flex';
  }
}

document.querySelector('.editor-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.editor-tab');
  if (!tab) return;
  switchTab(tab.dataset.tab);
});

document.querySelector('.editor-tabs').addEventListener('keydown', (e) => {
  const tab = e.target.closest('.editor-tab');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...$$('.editor-tab')];
  const index = tabs.indexOf(tab);
  let targetIndex = index;
  if (e.key === 'ArrowLeft') targetIndex = (index - 1 + tabs.length) % tabs.length;
  if (e.key === 'ArrowRight') targetIndex = (index + 1) % tabs.length;
  if (e.key === 'Home') targetIndex = 0;
  if (e.key === 'End') targetIndex = tabs.length - 1;
  e.preventDefault();
  switchTab(tabs[targetIndex].dataset.tab);
  tabs[targetIndex].focus();
});

// Image upload
$('#btnUploadImg').addEventListener('click', () => {
  $('#imgFileInput').click();
});

$('#imgFileInput').addEventListener('change', () => {
  const fileInput = $('#imgFileInput');
  const file = fileInput.files[0];
  if (!file) return;

  const status = $('#uploadStatus');
  status.innerHTML = '<span class="upload-progress-bar"><span class="upload-progress-fill" id="uploadProgressFill"></span></span> 上传中...';

  const formData = new FormData();
  formData.append('image', file);
  formData.append('private', String(getCategoryValue() === '日记' || getCategoryValue().startsWith('日记/')));

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  const authToken = getAuthToken();
  if (authToken) xhr.setRequestHeader('Authorization', 'Bearer ' + authToken);

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      const fill = document.getElementById('uploadProgressFill');
      if (fill) fill.style.width = pct + '%';
      status.childNodes[status.childNodes.length - 1].textContent = ' ' + pct + '%';
    }
  });

  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      const data = JSON.parse(xhr.responseText);
      const textarea = editContent;
      const imgMd = `![image](${data.url})`;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = textarea.value.substring(0, start);
      const after = textarea.value.substring(end);
      textarea.value = before + imgMd + after;
      textarea.selectionStart = textarea.selectionEnd = start + imgMd.length;
      textarea.focus();
      autoSave();
      if (editorTab !== 'write') renderPreview();
      status.textContent = '已插入';
      setTimeout(() => { if (status.textContent === '已插入') status.textContent = ''; }, SAVE_STATUS_DURATION);
    } else {
      throw new Error('上传失败: ' + xhr.status);
    }
  });

  xhr.addEventListener('error', () => {
    status.textContent = '上传失败';
    showToast('上传失败: 网络错误', 'error');
  });

  xhr.addEventListener('abort', () => {
    status.textContent = '已取消';
  });

  xhr.send(formData);
});

function renderPreview() {
  editPreview.innerHTML = renderToHtmlUncached(editContent.value);
}

function copyTextFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('复制失败');
}

async function copyMarkdownText() {
  const content = editContent.value;
  if (!content.trim()) {
    showToast('没有可复制的 Markdown 内容', 'error');
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
    } else {
      copyTextFallback(content);
    }
    showToast('Markdown 已复制', 'success');
  } catch (err) {
    showToast('复制失败: ' + err.message, 'error');
  }
}

$('#btnCopyMarkdown').addEventListener('click', copyMarkdownText);

function exportMarkdownText() {
  const content = editContent.value;
  if (!content.trim()) {
    showToast('没有可导出的 Markdown 内容', 'error');
    return;
  }

  const title = (editTitle.value.trim() || '未命名日志')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80) || '未命名日志';
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('Markdown 已导出', 'success');
}

$('#btnExportMarkdown').addEventListener('click', exportMarkdownText);

// Delete
$('#btnDeleteEditor').addEventListener('click', async () => {
  if (!state.editingId) return;
  const deleteId = state.editingId;
  const confirmed = await confirmDialog({
    title: '确认删除',
    message: '确定要删除这条日志吗？此操作不可撤销。',
    confirmText: '确认删除',
  });
  if (!confirmed) return;
  try {
    await apiFetch(`/api/logs/${deleteId}`, { method: 'DELETE' });
    state.editingId = null;
    showListView();
    await loadStats();
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
});

// Table grid popup
(function initTableGrid() {
  const btnTable = $('#btnTable');
  const popup = $('#tableGridPopup');
  const grid = $('#tableGrid');
  const dimLabel = $('#tableGridDim');
  const COLS = 7, ROWS = 5;
  let open = false;

  // Build grid cells
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'table-grid-cell';
      cell.dataset.row = r + 1;
      cell.dataset.col = c + 1;
      grid.appendChild(cell);
    }
  }

  function highlightCells(col, row) {
    grid.querySelectorAll('.table-grid-cell').forEach(cell => {
      cell.classList.toggle('highlight',
        parseInt(cell.dataset.col) <= col && parseInt(cell.dataset.row) <= row);
    });
  }

  function clearHighlight() {
    grid.querySelectorAll('.table-grid-cell').forEach(c => c.classList.remove('highlight'));
  }

  function insertTable(rows, cols) {
    const ta = editContent;
    const start = ta.selectionStart;
    const before = ta.value.substring(0, start);
    const after = ta.value.substring(start);
    const needNewline = before.length > 0 && !before.endsWith('\n') ? '\n' : '';

    let table = '\n|';
    for (let c = 0; c < cols; c++) table += ` 列${c + 1} |`;
    table += '\n|';
    for (let c = 0; c < cols; c++) table += '-----|';
    for (let r = 0; r < rows - 1; r++) {
      table += '\n|';
      for (let c = 0; c < cols; c++) table += '     |';
    }
    table += '\n';

    ta.value = before + needNewline + table + after;
    const cursorPos = start + needNewline.length + 2;
    ta.selectionStart = cursorPos;
    ta.selectionEnd = cursorPos;
    ta.focus();
    autoSave();
    if (editorTab !== 'write') renderPreview();
  }

  grid.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.table-grid-cell');
    if (!cell) return;
    highlightCells(parseInt(cell.dataset.col), parseInt(cell.dataset.row));
    dimLabel.textContent = `${cell.dataset.row} × ${cell.dataset.col}`;
  });

  grid.addEventListener('mouseleave', () => {
    clearHighlight();
    dimLabel.textContent = '';
  });

  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.table-grid-cell');
    if (!cell) return;
    insertTable(parseInt(cell.dataset.row), parseInt(cell.dataset.col));
    popup.style.display = 'none';
    open = false;
  });

  btnTable.addEventListener('click', (e) => {
    e.stopPropagation();
    open = !open;
    popup.style.display = open ? 'block' : 'none';
    clearHighlight();
    dimLabel.textContent = '';
  });

  document.addEventListener('click', (e) => {
    if (open && !popup.contains(e.target) && e.target !== btnTable) {
      popup.style.display = 'none';
      open = false;
    }
  });
})();
