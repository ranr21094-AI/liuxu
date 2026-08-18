// Main entry point — imports all modules and initializes the app
import { state, DIARY_MAGIC_PHRASE } from './state.js';
import { apiFetch, checkAuth, getDiaryStatus, unlockDiary, lockDiary } from './auth.js';
import { showToast, confirmDialog, $ } from './helpers.js';
import { clearMdCache } from './markdown.js';
import { populateCalendarSelects, renderCalendar } from './calendar.js';
import { loadLogs, populateMonthFilter, syncArchiveFilterControls } from './logList.js';
import { showListView, leaveEditorSafely, clearEditorForDiaryLock } from './editor.js';
import { initAiChat, showAiChatView, clearAiStateForDiaryLock, reloadAiChatHistory } from './aiChat.js';
import { showPhotoWallView } from './photoWall.js';
import { loadStats } from './stats.js';
import { loadCategories, openCategoryManager } from './categories.js';
import { loadTodos, showTodoView } from './todos.js';
import { businessDateString } from './businessDate.js';
import { initAccounts } from './accounts.js';
import { initKnowledgeImport } from './knowledge/import.js';

// Theme
function initTheme() {
  const saved = localStorage.getItem('theme');
  let theme = saved;
  if (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
  if (theme) document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem('theme')) {
    document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
  }
});

$('#btnThemeToggle').addEventListener('click', toggleTheme);

// Sidebar mode: default log tools, todo panel, category manager, or AI history
const SIDEBAR_MODE_KEY = 'sidebarMode';
const MOBILE_SIDEBAR_QUERY = '(max-width: 768px)';
const COMPACT_DESKTOP_SIDEBAR_QUERY = '(max-width: 1100px)';
const DESKTOP_POINTER_QUERY = '(hover: hover) and (pointer: fine)';
const mobileSidebarMedia = window.matchMedia(MOBILE_SIDEBAR_QUERY);
const compactDesktopSidebarMedia = window.matchMedia(COMPACT_DESKTOP_SIDEBAR_QUERY);
const desktopPointerMedia = window.matchMedia(DESKTOP_POINTER_QUERY);

function isCompactDesktopSidebar() {
  return !mobileSidebarMedia.matches && compactDesktopSidebarMedia.matches && desktopPointerMedia.matches;
}

function setSidebarTitle(mode) {
  const title = $('#sidebarTitle');
  if (mode === 'todo') {
    title.textContent = '待办事项';
    $('#sidebarModeTrigger').title = '当前为待办事项';
  } else if (mode === 'ai') {
    title.textContent = 'AI 对话';
    $('#sidebarModeTrigger').title = '当前为 AI 历史对话';
  } else if (mode === 'categories') {
    title.textContent = '管理分类';
    $('#sidebarModeTrigger').title = '当前为分类管理';
  } else if (mode === 'photo-wall') {
    title.textContent = '照片墙';
    $('#sidebarModeTrigger').title = '当前为照片墙';
  } else if (mode === 'tools') {
    title.textContent = '更多工具';
    $('#sidebarModeTrigger').title = '当前为统计与数据工具';
  } else {
    title.textContent = '工作日志';
    $('#sidebarModeTrigger').title = '切换侧边栏模式';
  }
}

function closeSidebarModeMenu() {
  $('#sidebarModeMenu').style.display = 'none';
  $('#sidebarModeTrigger').setAttribute('aria-expanded', 'false');
}

function toggleSidebarModeMenu() {
  const menu = $('#sidebarModeMenu');
  const open = menu.style.display !== 'none';
  menu.style.display = open ? 'none' : 'block';
  $('#sidebarModeTrigger').setAttribute('aria-expanded', String(!open));
}

function syncToolsShortcut(active) {
  $('#btnSidebarTools').classList.toggle('active', active);
  $('#btnSidebarTools').setAttribute('aria-pressed', String(active));
  $('#btnSidebarTools').title = active ? '切换回常规侧边栏' : '切换更多工具';
}

function activeSidebarMode() {
  if (document.body.classList.contains('sidebar-ai-mode')) return 'ai';
  if (document.body.classList.contains('sidebar-category-mode')) return 'categories';
  if (document.body.classList.contains('sidebar-photo-wall-mode')) return 'photo-wall';
  if (document.body.classList.contains('sidebar-todo-mode')) return 'todo';
  if (document.body.classList.contains('sidebar-tools-mode')) return 'tools';
  return 'normal';
}

function closeMobileCalendar() {
  $('#calendarWidget').classList.remove('mobile-show');
}

function syncSidebarViewportMode() {
  const compactDesktop = isCompactDesktopSidebar();
  document.body.classList.toggle('desktop-narrow-sidebar', compactDesktop);
  if (compactDesktop) closeMobileCalendar();
}

async function setSidebarMode(mode, { updateMain = true } = {}) {
  if (!['normal', 'todo', 'categories', 'photo-wall', 'ai', 'tools'].includes(mode)) mode = 'normal';
  // The legacy sidebar remains available for old deep links, but the workbench
  // navigation owns the default product surface.
  document.body.classList.add('workbench-legacy');
  document.body.classList.remove('workbench-default');
  if (updateMain && !(await leaveEditorSafely())) return;
  document.body.classList.toggle('sidebar-todo-mode', mode === 'todo');
  document.body.classList.toggle('sidebar-category-mode', mode === 'categories');
  document.body.classList.toggle('sidebar-photo-wall-mode', mode === 'photo-wall');
  document.body.classList.toggle('sidebar-ai-mode', mode === 'ai');
  document.body.classList.toggle('sidebar-tools-mode', mode === 'tools');
  syncToolsShortcut(mode === 'tools');
  closeMobileCalendar();
  setSidebarTitle(mode);
  $('#sidebarModeMenu').querySelectorAll('[data-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
  closeSidebarModeMenu();
  localStorage.setItem(SIDEBAR_MODE_KEY, mode);

  if (!updateMain) return;
  if (mode === 'ai') {
    showAiChatView();
  } else if (mode === 'categories') {
    openCategoryManager();
  } else if (mode === 'photo-wall') {
    showPhotoWallView();
  } else if (mode === 'todo') {
    showTodoView();
  } else {
    showListView();
  }
}

async function setSidebarToolsMode(enabled) {
  await setSidebarMode(enabled ? 'tools' : 'normal');
}

setSidebarMode(localStorage.getItem(SIDEBAR_MODE_KEY) || 'normal', { updateMain: false });

$('#sidebarModeTrigger').addEventListener('click', toggleSidebarModeMenu);
$('#sidebarModeTrigger').addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown') return;
  event.preventDefault();
  const menu = $('#sidebarModeMenu');
  if (menu.style.display === 'none') toggleSidebarModeMenu();
  menu.querySelector('[role="menuitem"]')?.focus();
});
$('#sidebarModeMenu').addEventListener('click', (event) => {
  const item = event.target.closest('[data-mode]');
  if (!item) return;
  setSidebarMode(item.dataset.mode);
});
$('#sidebarModeMenu').addEventListener('keydown', (event) => {
  const items = [...$('#sidebarModeMenu').querySelectorAll('[role="menuitem"]')];
  const currentIndex = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSidebarModeMenu();
    $('#sidebarModeTrigger').focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !items.length) return;
  event.preventDefault();
  let nextIndex = currentIndex;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = items.length - 1;
  else if (event.key === 'ArrowDown') nextIndex = (Math.max(currentIndex, -1) + 1) % items.length;
  else nextIndex = (currentIndex <= 0 ? items.length : currentIndex) - 1;
  items[nextIndex]?.focus();
});

window.addEventListener('category-manager-closed', () => {
  if (activeSidebarMode() === 'categories') setSidebarMode('normal', { updateMain: false });
});

window.addEventListener('category-log-opened', () => {
  if (activeSidebarMode() === 'categories') setSidebarMode('normal', { updateMain: false });
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.sidebar-title-menu')) closeSidebarModeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSidebarModeMenu();
});

$('#btnSidebarTools').addEventListener('click', () => {
  setSidebarToolsMode(!document.body.classList.contains('sidebar-tools-mode'));
});

mobileSidebarMedia.addEventListener('change', (event) => {
  if (!event.matches || isCompactDesktopSidebar()) closeMobileCalendar();
  syncSidebarViewportMode();
});

compactDesktopSidebarMedia.addEventListener('change', syncSidebarViewportMode);
desktopPointerMedia.addEventListener('change', syncSidebarViewportMode);

syncSidebarViewportMode();

// Sidebar collapse
function collapseSidebar() {
  document.body.classList.toggle('sidebar-collapsed');
}

$('#btnToggleSidebar').addEventListener('click', collapseSidebar);
$('#btnSidebarExpand').addEventListener('click', collapseSidebar);

// Diary lock
function syncDiaryLockState(status) {
  state.diaryLockEnabled = status.enabled !== false;
  state.diaryUnlocked = !state.diaryLockEnabled || !status.locked;
  const button = $('#workbenchDiaryToggle');
  if (button) button.textContent = state.diaryUnlocked ? '私密知识：已解锁' : '私密知识：锁定';
}

window.addEventListener('request-diary-unlock', () => promptDiaryUnlock());

// Toggle the hidden diary lock when the magic phrase is typed in the search box.
async function handleDiaryMagicPhrase() {
  if (state.diaryUnlocked) {
    // Currently unlocked → lock again.
    if (!(await leaveEditorSafely({ showList: true }))) return;
    clearEditorForDiaryLock();
    clearAiStateForDiaryLock();
    await lockDiary();
    syncDiaryLockState({ enabled: true, locked: true });
    await reloadAiChatHistory();
    showToast('日记已锁定', 'info');
    state.search = '';
    $('#searchInput').value = '';
    $('#btnSearchClear')?.classList.remove('visible');
    if (state.category === '日记' || state.category.startsWith('日记/')) {
      state.category = '';
      state.currentPage = 1;
      $('#filterCategory').value = '';
    }
    await refreshAll();
  } else {
    // Currently locked → unlock and jump straight to the diary list.
    const ok = await unlockDiary(DIARY_MAGIC_PHRASE);
    if (ok) {
      syncDiaryLockState({ enabled: true, locked: false });
      showToast('日记已解锁', 'success');
      await loadCategories();
      selectDiaryLogs();
      await Promise.all([loadLogs(), loadStats(), loadTodos(), reloadAiChatHistory()]);
    } else {
      showToast('解锁失败', 'error');
    }
  }
}

window.addEventListener('diary-magic-phrase', handleDiaryMagicPhrase);
window.addEventListener('workbench-diary-toggle', handleDiaryMagicPhrase);

function selectDiaryLogs() {
  state.category = '日记';
  state.currentPage = 1;
  state.selectedDate = null;
  state.month = '';
  state.search = '';
  $('#filterCategory').value = '日记';
  $('#filterSubcategory').value = '';
  $('#filterMonth').value = '';
  $('#searchInput').value = '';
  $('#btnSearchClear').classList.remove('visible');
  syncArchiveFilterControls();
  renderCalendar();
}

// Check diary status on init
async function initDiaryLock() {
  const status = await getDiaryStatus();
  syncDiaryLockState(status);
  if (state.diaryLockEnabled && state.diaryUnlocked) {
    await loadCategories();
    selectDiaryLogs();
    await Promise.all([loadLogs(), loadStats(), loadTodos()]);
    return true;
  }
  return false;
}

function promptDiaryUnlock() {
  showToast('请先在搜索框输入「如意如意」解锁日记', 'error');
  const input = $('#searchInput');
  input?.focus();
  input?.select?.();
}

async function ensureFullDataDiaryAccess() {
  const res = await apiFetch('/api/auth/diary/status');
  const data = await res.json();
  if (data.locked) {
    promptDiaryUnlock();
    return null;
  }
  return true;
}

// Backup / Restore
$('#btnBackup').addEventListener('click', async () => {
  try {
    const diaryUnlocked = await ensureFullDataDiaryAccess();
    if (diaryUnlocked === null) return;

    const res = await apiFetch('/api/backup');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '备份失败');
    }

    const disposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    const filename = filenameMatch?.[1] ||
      `work-log-backup-${businessDateString()}.json`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('备份已下载', 'success');
  } catch (err) {
    showToast('备份失败：' + err.message, 'error');
  }
});

$('#btnRestore').addEventListener('click', async () => {
  const diaryUnlocked = await ensureFullDataDiaryAccess();
  if (diaryUnlocked === null) return;
  $('#restoreFileInput').click();
});

$('#restoreFileInput').addEventListener('change', async () => {
  const input = $('#restoreFileInput');
  const file = input.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.logs || !data.todos || !data.categories) {
      showToast('无效的备份文件：缺少 logs、todos 或 categories 数据', 'error');
      return;
    }

    const confirmed = await confirmDialog({
      title: '确认导入',
      message: '导入将覆盖当前所有数据（日志、待办、倒数日、分类、照片墙、AI 对话历史），此操作不可撤销。\n建议先「备份数据 JSON」保存当前数据。',
      confirmText: '确认导入',
    });
    if (!confirmed) return;

    const diaryUnlocked = await ensureFullDataDiaryAccess();
    if (diaryUnlocked === null) return;
    const res = await apiFetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '导入失败');
    }
    const result = await res.json();
    clearMdCache();
    await refreshAll();
    showToast(`导入成功！${result.logs} 条日志，${result.todos} 条待办，${result.countdowns || 0} 个倒数日，${result.categories} 个分类已恢复。${result.includesBinaries === false ? ' 当前备份仅含结构数据，未包含上传文件或 AI 媒体。' : ''}`, 'success');
  } catch (err) {
    showToast('导入失败：' + err.message, 'error');
  } finally {
    input.value = '';
  }
});

async function refreshAll() {
  await Promise.all([loadLogs(), loadStats(), loadTodos(), loadCategories(), reloadAiChatHistory()]);
}

function syncMainViewWithSidebarMode() {
  if (activeSidebarMode() === 'ai') {
    showAiChatView();
  } else if (activeSidebarMode() === 'categories') {
    openCategoryManager();
  } else if (activeSidebarMode() === 'photo-wall') {
    showPhotoWallView();
  } else if (activeSidebarMode() === 'todo') {
    showTodoView();
  } else {
    showListView();
  }
}

// Global error boundary
window.addEventListener('error', (e) => {
  showToast('应用遇到错误: ' + e.message, 'error');
  console.error('Global error:', e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  showToast('操作失败: ' + (e.reason?.message || '未知错误'), 'error');
  console.error('Unhandled rejection:', e.reason);
});

// Init
async function initializeApp() {
  initTheme();
  populateMonthFilter();
  populateCalendarSelects();
  const authenticated = await checkAuth();
  if (!authenticated) return;
  await initAccounts();
  await initAiChat();
  initKnowledgeImport();
  const diarySelected = await initDiaryLock();
  if (!diarySelected) await refreshAll();
  syncMainViewWithSidebarMode();
}

initializeApp();
