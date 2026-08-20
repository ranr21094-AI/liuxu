import { apiFetch } from './auth.js';
import { showToast, escHtml, $ } from './helpers.js';

let currentUser = null;

function formatAccountTime(value) {
  if (!value) return '从未登录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN', { hour12: false });
}

function syncAccountPanel() {
  if (!currentUser) return;
  const name = currentUser.display_name || currentUser.username || '用户';
  const displayInput = $('#accountDisplayNameInput');
  if (displayInput) displayInput.value = currentUser.display_name || '';
  const meta = $('#accountMeta');
  if (meta) meta.textContent = `@${currentUser.username} · ${currentUser.role === 'admin' ? '管理员' : '成员'}`;
  const adminSection = $('#adminUsersSection');
  if (adminSection) adminSection.hidden = currentUser.role !== 'admin';
  const adminButton = $('#btnAdminUsers');
  if (adminButton) adminButton.hidden = currentUser.role !== 'admin';
  const accountName = $('#accountName');
  if (accountName) accountName.textContent = name;
  const initial = $('#accountInitial');
  if (initial) initial.textContent = [...name][0] || '用';
  const role = $('#accountRole');
  if (role) role.textContent = currentUser.role === 'admin' ? '管理员账户' : '普通账户';
  window.dispatchEvent(new CustomEvent('account-updated', { detail: currentUser }));
}

async function readJsonResponse(res, fallback) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || fallback);
  return data;
}

export async function loadCurrentAccount() {
  const res = await apiFetch('/api/auth/me');
  currentUser = await readJsonResponse(res, '账户信息加载失败');
  syncAccountPanel();
  return currentUser;
}

function clearPasswordInputs() {
  ['accountCurrentPassword', 'accountNewPassword', 'accountConfirmPassword']
    .forEach(id => {
      const field = $(`#${id}`);
      if (field) field.value = '';
    });
}

async function saveProfile() {
  try {
    const res = await apiFetch('/api/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: $('#accountDisplayNameInput').value.trim() }),
    });
    currentUser = await readJsonResponse(res, '资料保存失败');
    syncAccountPanel();
    showToast('个人资料已保存', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function changePassword() {
  const currentPassword = $('#accountCurrentPassword')?.value || '';
  const newPassword = $('#accountNewPassword')?.value || '';
  if (newPassword.length < 10) return showToast('新密码至少需要 10 个字符', 'error');
  if (newPassword !== $('#accountConfirmPassword')?.value) return showToast('两次输入的新密码不一致', 'error');
  try {
    const res = await apiFetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    const data = await readJsonResponse(res, '密码修改失败');
    currentUser = data.user;
    clearPasswordInputs();
    syncAccountPanel();
    showToast('登录密码已修改，其他会话已退出', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function userCard(user) {
  return `
    <article class="managed-user-card" data-user-id="${escHtml(user.id)}">
      <div class="managed-user-summary">
        <strong>${escHtml(user.display_name)}</strong>
        <span>@${escHtml(user.username)} · ${user.role === 'admin' ? '管理员' : '成员'} · ${user.status === 'active' ? '已启用' : '已停用'}${user.must_change_password ? ' · 待首次改密' : ''}</span>
        <small>创建：${escHtml(formatAccountTime(user.created_at))} · 最近登录：${escHtml(formatAccountTime(user.last_login_at))}</small>
      </div>
      <div class="managed-user-fields">
        <label>用户名<input data-field="username" type="text" maxlength="32" value="${escHtml(user.username)}"></label>
        <label>显示名称<input data-field="display_name" type="text" maxlength="50" value="${escHtml(user.display_name)}"></label>
        <label>角色<select data-field="role"><option value="member"${user.role === 'member' ? ' selected' : ''}>普通成员</option><option value="admin"${user.role === 'admin' ? ' selected' : ''}>管理员</option></select></label>
        <label>状态<select data-field="status"><option value="active"${user.status === 'active' ? ' selected' : ''}>启用</option><option value="disabled"${user.status === 'disabled' ? ' selected' : ''}>停用</option></select></label>
      </div>
      <div class="managed-user-actions">
        <button class="secondary-action compact" type="button" data-action="save-user">保存账户</button>
        <button class="secondary-action compact" type="button" data-action="toggle-reset">重置密码</button>
      </div>
      <div class="managed-user-reset" hidden>
        <label>新的临时密码<input data-field="temporary_password" type="password" minlength="10" maxlength="128" autocomplete="new-password"></label>
        <button class="primary-action compact" type="button" data-action="reset-password">确认重置并撤销旧会话</button>
      </div>
    </article>`;
}

async function loadUsers() {
  const list = $('#userManagerList');
  if (!list) return;
  try {
    const res = await apiFetch('/api/admin/users');
    const users = await readJsonResponse(res, '账户列表加载失败');
    const count = $('#userListCount');
    if (count) count.textContent = `${users.length} 个`;
    list.innerHTML = users.map(userCard).join('') || '<p class="empty-list">暂无账户</p>';
  } catch (err) {
    list.innerHTML = `<p class="empty-list">${escHtml(err.message)}</p>`;
  }
}

async function createUser(event) {
  event.preventDefault();
  try {
    const res = await apiFetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#newUserUsername').value.trim(),
        display_name: $('#newUserDisplayName').value.trim(),
        temporary_password: $('#newUserPassword').value,
        role: $('#newUserRole').value,
      }),
    });
    await readJsonResponse(res, '账户创建失败');
    event.target.reset();
    showToast('账户已创建', 'success');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveManagedUser(card) {
  const id = card.dataset.userId;
  const body = {};
  card.querySelectorAll('[data-field]:not([data-field="temporary_password"])').forEach(field => { body[field.dataset.field] = field.value; });
  const res = await apiFetch(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await readJsonResponse(res, '账户保存失败');
  showToast('账户设置已保存', 'success');
  await loadUsers();
  await loadCurrentAccount();
}

async function resetManagedPassword(card) {
  const password = card.querySelector('[data-field="temporary_password"]').value;
  if (password.length < 10) throw new Error('临时密码至少需要 10 个字符');
  const res = await apiFetch(`/api/admin/users/${encodeURIComponent(card.dataset.userId)}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ temporary_password: password }),
  });
  await readJsonResponse(res, '密码重置失败');
  showToast('临时密码已设置，旧会话已撤销', 'success');
  await loadUsers();
}

async function openUserManager() {
  const dialog = $('#userManagerDialog');
  if (!dialog) return;
  dialog.showModal();
  requestAnimationFrame(() => $('#newUserUsername')?.focus());
  await loadUsers();
}

export async function fillAccountSettings() {
  await loadCurrentAccount();
  clearPasswordInputs();
}

export async function initAccounts() {
  if (!$('#btnSaveAccountProfile')) return;
  $('#btnSaveAccountProfile').addEventListener('click', saveProfile);
  $('#btnChangeAccountPassword')?.addEventListener('click', changePassword);
  $('#btnAdminUsers')?.addEventListener('click', () => openUserManager().catch(err => showToast(err.message, 'error')));
  $('#userManagerClose')?.addEventListener('click', () => $('#userManagerDialog')?.close());
  $('#userCreateForm')?.addEventListener('submit', createUser);
  $('#userManagerDialog')?.addEventListener('click', event => {
    if (event.target === $('#userManagerDialog')) $('#userManagerDialog').close();
  });
  $('#accountDisplayNameInput')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveProfile();
    }
  });
  ['accountCurrentPassword', 'accountNewPassword', 'accountConfirmPassword'].forEach(id => {
    $(`#${id}`)?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        changePassword();
      }
    });
  });
  $('#userManagerList')?.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const card = event.target.closest('.managed-user-card');
    if (!action || !card) return;
    if (action === 'toggle-reset') {
      const reset = card.querySelector('.managed-user-reset');
      reset.hidden = !reset.hidden;
      if (!reset.hidden) reset.querySelector('input').focus();
      return;
    }
    try {
      if (action === 'save-user') await saveManagedUser(card);
      if (action === 'reset-password') await resetManagedPassword(card);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}
