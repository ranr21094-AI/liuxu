// Main entry point — imports all modules and initializes the app
import { state } from './state.js';
import { apiFetch, checkAuth, getDiaryStatus, unlockDiary, lockDiary } from './auth.js';
import { showToast, confirmDialog, openModal, closeModal, $ } from './helpers.js';
import { clearMdCache } from './markdown.js';
import { populateCalendarSelects, renderCalendar } from './calendar.js';
import { loadLogs, populateMonthFilter, syncArchiveFilterControls } from './logList.js';
import { showListView } from './editor.js';
import { initAiChat, showAiChatView } from './aiChat.js';
import { loadStats } from './stats.js';
import { loadCategories, openCategoryManager } from './categories.js';
import { loadTodos, showTodoView } from './todos.js';
import { businessDateString } from './businessDate.js';

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
  return compactDesktopSidebarMedia.matches && desktopPointerMedia.matches;
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

function resetToolsMode() {
  document.body.classList.remove('sidebar-tools-mode');
  $('#btnSidebarTools').classList.remove('active');
  $('#btnSidebarTools').setAttribute('aria-pressed', 'false');
  $('#btnSidebarTools').title = '切换更多工具';
}

function activeSidebarMode() {
  if (document.body.classList.contains('sidebar-ai-mode')) return 'ai';
  if (document.body.classList.contains('sidebar-category-mode')) return 'categories';
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
  if (!compactDesktop && !mobileSidebarMedia.matches && document.body.classList.contains('sidebar-tools-mode')) {
    setSidebarToolsMode(false);
  }
}

function setSidebarMode(mode, { updateMain = true } = {}) {
  if (!['normal', 'todo', 'categories', 'ai'].includes(mode)) mode = 'normal';
  document.body.classList.toggle('sidebar-todo-mode', mode === 'todo');
  document.body.classList.toggle('sidebar-category-mode', mode === 'categories');
  document.body.classList.toggle('sidebar-ai-mode', mode === 'ai');
  resetToolsMode();
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
  } else if (mode === 'todo') {
    showTodoView();
  } else {
    showListView();
  }
}

function setSidebarToolsMode(enabled) {
  document.body.classList.toggle('sidebar-tools-mode', enabled);
  if (enabled) {
    document.body.classList.remove('sidebar-todo-mode', 'sidebar-ai-mode');
    document.body.classList.remove('sidebar-category-mode');
    closeMobileCalendar();
    localStorage.setItem(SIDEBAR_MODE_KEY, 'normal');
    showListView();
  }
  $('#btnSidebarTools').classList.toggle('active', enabled);
  $('#btnSidebarTools').setAttribute('aria-pressed', String(enabled));
  $('#btnSidebarTools').title = enabled ? '切换回常规侧边栏' : '切换更多工具';
  setSidebarTitle(activeSidebarMode());
}

setSidebarMode(localStorage.getItem(SIDEBAR_MODE_KEY) || 'normal', { updateMain: false });

$('#sidebarModeTrigger').addEventListener('click', toggleSidebarModeMenu);
$('#sidebarModeMenu').addEventListener('click', (event) => {
  const item = event.target.closest('[data-mode]');
  if (!item) return;
  setSidebarMode(item.dataset.mode);
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
  if (!event.matches && !isCompactDesktopSidebar() && document.body.classList.contains('sidebar-tools-mode')) {
    setSidebarToolsMode(false);
  }
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
}

function openDiaryUnlockModal() {
  openModal($('#diaryUnlockOverlay'), '#diaryPasswordInput');
}

$('#btnDiaryUnlock').addEventListener('click', openDiaryUnlockModal);

window.addEventListener('request-diary-unlock', openDiaryUnlockModal);

$('#btnDiaryLock').addEventListener('click', async () => {
  await lockDiary();
  syncDiaryLockState({ enabled: true, locked: true });
  $('#btnDiaryUnlock').style.display = '';
  $('#btnDiaryLock').style.display = 'none';
  showToast('日记已锁定', 'info');
  if (state.category === '日记') {
    state.category = '';
    state.currentPage = 1;
    $('#filterCategory').value = '';
  }
  await refreshAll();
});

$('#diaryUnlockOverlay').addEventListener('click', (e) => {
  if (e.target === $('#diaryUnlockOverlay')) {
    closeModal($('#diaryUnlockOverlay'));
  }
});

$('#btnDiaryUnlockCancel').addEventListener('click', () => {
  closeModal($('#diaryUnlockOverlay'));
});

$('#btnDiaryUnlockSubmit').addEventListener('click', async () => {
  const password = $('#diaryPasswordInput').value;
  if (!password) return;
  const preserveCurrentDiaryFilter = state.category === '日记' || state.category.startsWith('日记/');
  const ok = await unlockDiary(password);
  if (ok) {
    syncDiaryLockState({ enabled: true, locked: false });
    closeModal($('#diaryUnlockOverlay'));
    $('#diaryPasswordInput').value = '';
    $('#btnDiaryUnlock').style.display = 'none';
    $('#btnDiaryLock').style.display = '';
    showToast('日记已解锁', 'success');
    await loadCategories();
    if (!preserveCurrentDiaryFilter) selectDiaryLogs();
    await Promise.all([loadLogs(), loadStats(), loadTodos()]);
  } else {
    showToast('密码错误', 'error');
  }
});

$('#diaryPasswordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnDiaryUnlockSubmit').click();
});

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
    $('#btnDiaryUnlock').style.display = 'none';
    $('#btnDiaryLock').style.display = '';
    await loadCategories();
    selectDiaryLogs();
    await Promise.all([loadLogs(), loadStats(), loadTodos()]);
    return true;
  }
  return false;
}

function promptDiaryUnlock() {
  showToast('请先解锁日记再执行此操作', 'error');
  openModal($('#diaryUnlockOverlay'), '#diaryPasswordInput');
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
      message: '导入将覆盖当前所有数据（日志、待办、分类），此操作不可撤销。\n建议先「备份数据 JSON」保存当前数据。',
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
    showToast(`导入成功！${result.logs} 条日志，${result.todos} 条待办，${result.categories} 个分类已恢复。`, 'success');
  } catch (err) {
    showToast('导入失败：' + err.message, 'error');
  } finally {
    input.value = '';
  }
});

async function refreshAll() {
  await Promise.all([loadLogs(), loadStats(), loadTodos(), loadCategories()]);
}

function syncMainViewWithSidebarMode() {
  if (activeSidebarMode() === 'ai') {
    showAiChatView();
  } else if (activeSidebarMode() === 'categories') {
    openCategoryManager();
  } else if (activeSidebarMode() === 'todo') {
    showTodoView();
  } else {
    showListView();
  }
}

// Re-login after auth success
window.addEventListener('auth-success', async () => {
  await initAiChat();
  const diarySelected = await initDiaryLock();
  if (!diarySelected) await refreshAll();
  syncMainViewWithSidebarMode();
});

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
  await initAiChat();
  const diarySelected = await initDiaryLock();
  if (!diarySelected) await refreshAll();
  syncMainViewWithSidebarMode();
}

initializeApp();
