const $ = selector => document.querySelector(selector);

function safeNextPath() {
  const raw = new URLSearchParams(window.location.search).get('next') || '/';
  try {
    const target = new URL(raw, window.location.origin);
    if (target.origin !== window.location.origin || target.pathname === '/login') return '/';
    return `${target.pathname}${target.search}${target.hash}` || '/';
  } catch {
    return '/';
  }
}

function setError(message = '') {
  $('#loginError').textContent = message;
}

function setBusy(button, busy, busyText) {
  button.disabled = busy;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = busy ? busyText : button.dataset.label;
}

function showPasswordChange(username = '') {
  $('#loginForm').hidden = true;
  $('#passwordChangeForm').hidden = false;
  $('#passwordChangeUsername').value = username;
  $('#loginSubtitle').textContent = '首次登录需要修改临时密码';
  $('#currentPassword').focus();
}

async function readAuthState() {
  try {
    const res = await fetch('/api/auth/check');
    const data = await res.json();
    if (data.authenticated && data.must_change_password) showPasswordChange(data.user?.username || '');
    else if (data.authenticated) window.location.replace(safeNextPath());
  } catch {
    setError('无法连接服务器');
  }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  setError();
  const username = $('#loginUsername').value.trim();
  const password = $('#loginPassword').value;
  if (!username) return setError('请输入用户名');
  const button = $('#loginSubmit');
  setBusy(button, true, '登录中…');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '登录失败');
    $('#loginPassword').value = '';
    if (data.must_change_password) showPasswordChange(username);
    else window.location.replace(safeNextPath());
  } catch (err) {
    setError(err.message || '登录失败');
  } finally {
    setBusy(button, false, '登录中…');
  }
});

$('#passwordChangeForm').addEventListener('submit', async event => {
  event.preventDefault();
  setError();
  const currentPassword = $('#currentPassword').value;
  const newPassword = $('#newPassword').value;
  if (newPassword !== $('#confirmPassword').value) return setError('两次输入的新密码不一致');
  const button = $('#passwordChangeSubmit');
  setBusy(button, true, '保存中…');
  try {
    const res = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '密码修改失败');
    window.location.replace(safeNextPath());
  } catch (err) {
    setError(err.message || '密码修改失败');
  } finally {
    setBusy(button, false, '保存中…');
  }
});

$('#loginSignOut').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.replace('/login');
});

$('#loginThemeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

readAuthState();
