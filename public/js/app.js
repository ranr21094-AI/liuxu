// Main entry point — imports all modules and initializes the app
import { state } from './state.js';
import { apiFetch, checkAuth, checkDiaryStatus, unlockDiary, lockDiary } from './auth.js';
import { showToast, confirmDialog, openModal, closeModal, $ } from './helpers.js';
import { clearMdCache } from './markdown.js';
import { populateCalendarSelects, renderCalendar } from './calendar.js';
import { loadLogs, populateMonthFilter } from './logList.js';
import { showListView } from './editor.js';
import { initAiChat, showAiChatView } from './aiChat.js';
import { loadStats } from './stats.js';
import { loadCategories } from './categories.js';
import { loadTodos } from './todos.js';
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

// Sidebar mode: normal tools or current-card navigation
const SIDEBAR_NAV_MODE_KEY = 'sidebarNavMode';
const SIDEBAR_TODO_MODE_KEY = 'sidebarTodoMode';
const MOBILE_SIDEBAR_QUERY = '(max-width: 768px)';
const mobileSidebarMedia = window.matchMedia(MOBILE_SIDEBAR_QUERY);

function setSidebarTitle(mode) {
  if (mode === 'nav') {
    $('#sidebarTitle').textContent = '日志导航';
    $('#sidebarTitle').title = '当前为日志导航栏';
  } else if (mode === 'todo') {
    $('#sidebarTitle').textContent = '待办面板';
    $('#sidebarTitle').title = '当前为待办面板';
  } else if (mode === 'tools') {
    $('#sidebarTitle').textContent = '更多工具';
    $('#sidebarTitle').title = '当前为统计与数据工具';
  } else {
    $('#sidebarTitle').textContent = '工作日志';
    $('#sidebarTitle').title = '点击切换日历显示';
  }
}

function resetToolsMode() {
  document.body.classList.remove('sidebar-tools-mode');
  $('#btnSidebarTools').classList.remove('active');
  $('#btnSidebarTools').setAttribute('aria-pressed', 'false');
  $('#btnSidebarTools').title = '切换更多工具';
}

function activeSidebarMode() {
  if (document.body.classList.contains('sidebar-nav-mode')) return 'nav';
  if (document.body.classList.contains('sidebar-todo-mode')) return 'todo';
  if (document.body.classList.contains('sidebar-tools-mode')) return 'tools';
  return 'normal';
}

function closeMobileCalendar() {
  $('#calendarWidget').classList.remove('mobile-show');
}

function setSidebarNavMode(enabled) {
  document.body.classList.toggle('sidebar-nav-mode', enabled);
  if (enabled) {
    document.body.classList.remove('sidebar-todo-mode');
    resetToolsMode();
    closeMobileCalendar();
    $('#btnTodoMode').classList.remove('active');
    $('#btnTodoMode').setAttribute('aria-pressed', 'false');
    $('#btnTodoMode').title = '切换待办面板';
    localStorage.setItem(SIDEBAR_TODO_MODE_KEY, 'false');
  }
  $('#btnSidebarMode').classList.toggle('active', enabled);
  $('#btnSidebarMode').setAttribute('aria-pressed', String(enabled));
  $('#btnSidebarMode').title = enabled ? '切换回常规侧边栏' : '切换日志导航栏';
  setSidebarTitle(activeSidebarMode());
  if (enabled) {
    $('#cardNavPanel').classList.remove('collapsed');
    $('#cardNavToggle').setAttribute('aria-expanded', 'true');
    localStorage.setItem('cardNavCollapsed', 'false');
  }
}

function setSidebarTodoMode(enabled) {
  document.body.classList.toggle('sidebar-todo-mode', enabled);
  if (enabled) {
    document.body.classList.remove('sidebar-nav-mode');
    resetToolsMode();
    closeMobileCalendar();
    $('#btnSidebarMode').classList.remove('active');
    $('#btnSidebarMode').setAttribute('aria-pressed', 'false');
    $('#btnSidebarMode').title = '切换日志导航栏';
    localStorage.setItem(SIDEBAR_NAV_MODE_KEY, 'false');
  }
  $('#btnTodoMode').classList.toggle('active', enabled);
  $('#btnTodoMode').setAttribute('aria-pressed', String(enabled));
  $('#btnTodoMode').title = enabled ? '切换回常规侧边栏' : '切换待办面板';
  setSidebarTitle(activeSidebarMode());
}

function setSidebarToolsMode(enabled) {
  document.body.classList.toggle('sidebar-tools-mode', enabled);
  if (enabled) {
    document.body.classList.remove('sidebar-nav-mode', 'sidebar-todo-mode');
    closeMobileCalendar();
    $('#btnSidebarMode').classList.remove('active');
    $('#btnSidebarMode').setAttribute('aria-pressed', 'false');
    $('#btnSidebarMode').title = '切换日志导航栏';
    $('#btnTodoMode').classList.remove('active');
    $('#btnTodoMode').setAttribute('aria-pressed', 'false');
    $('#btnTodoMode').title = '切换待办面板';
    localStorage.setItem(SIDEBAR_NAV_MODE_KEY, 'false');
    localStorage.setItem(SIDEBAR_TODO_MODE_KEY, 'false');
  }
  $('#btnSidebarTools').classList.toggle('active', enabled);
  $('#btnSidebarTools').setAttribute('aria-pressed', String(enabled));
  $('#btnSidebarTools').title = enabled ? '切换回常规侧边栏' : '切换更多工具';
  setSidebarTitle(activeSidebarMode());
}

if (localStorage.getItem(SIDEBAR_TODO_MODE_KEY) === 'true') {
  setSidebarTodoMode(true);
} else {
  setSidebarNavMode(localStorage.getItem(SIDEBAR_NAV_MODE_KEY) === 'true');
}

$('#btnSidebarMode').addEventListener('click', () => {
  const enabled = !document.body.classList.contains('sidebar-nav-mode');
  setSidebarNavMode(enabled);
  localStorage.setItem(SIDEBAR_NAV_MODE_KEY, String(enabled));
});

$('#btnTodoMode').addEventListener('click', () => {
  const enabled = !document.body.classList.contains('sidebar-todo-mode');
  setSidebarTodoMode(enabled);
  localStorage.setItem(SIDEBAR_TODO_MODE_KEY, String(enabled));
});

$('#btnSidebarTools').addEventListener('click', () => {
  setSidebarToolsMode(!document.body.classList.contains('sidebar-tools-mode'));
});

mobileSidebarMedia.addEventListener('change', (event) => {
  if (!event.matches && document.body.classList.contains('sidebar-tools-mode')) {
    setSidebarToolsMode(false);
  }
  if (!event.matches) closeMobileCalendar();
});

// Sidebar collapse
function collapseSidebar() {
  document.body.classList.toggle('sidebar-collapsed');
}

$('#btnToggleSidebar').addEventListener('click', collapseSidebar);
$('#btnSidebarExpand').addEventListener('click', collapseSidebar);

// FAB AI chat
$('#fabCapture').addEventListener('click', () => {
  if (!document.body.classList.contains('editor-fullscreen')) showAiChatView();
});

// Calendar toggle (mobile)
// Calendar toggle via title click
$('#sidebarTitle').addEventListener('click', () => {
  if (activeSidebarMode() !== 'normal') return;
  const widget = $('#calendarWidget');
  if (mobileSidebarMedia.matches) {
    widget.classList.toggle('mobile-show');
    return;
  }
  widget.style.display = widget.style.display === 'none' ? '' : 'none';
});

// Diary lock
$('#btnDiaryUnlock').addEventListener('click', () => {
  openModal($('#diaryUnlockOverlay'), '#diaryPasswordInput');
});

$('#btnDiaryLock').addEventListener('click', async () => {
  await lockDiary();
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
  const ok = await unlockDiary(password);
  if (ok) {
    closeModal($('#diaryUnlockOverlay'));
    $('#diaryPasswordInput').value = '';
    $('#btnDiaryUnlock').style.display = 'none';
    $('#btnDiaryLock').style.display = '';
    showToast('日记已解锁', 'success');
    await loadCategories();
    selectDiaryLogs();
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
  renderCalendar();
}

// Check diary status on init
async function initDiaryLock() {
  const unlocked = await checkDiaryStatus();
  if (unlocked) {
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

// Re-login after auth success
window.addEventListener('auth-success', async () => {
  const diarySelected = await initDiaryLock();
  if (!diarySelected) await refreshAll();
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
  initAiChat();
  populateMonthFilter();
  populateCalendarSelects();
  const authenticated = await checkAuth();
  if (!authenticated) return;
  const diarySelected = await initDiaryLock();
  if (!diarySelected) await refreshAll();
}

initializeApp();
