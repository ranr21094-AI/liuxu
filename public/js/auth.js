import { showToast, openModal, closeModal, $ } from './helpers.js';

export function getAuthToken() {
  return sessionStorage.getItem('auth_token') || '';
}

export async function apiFetch(url, options = {}) {
  const token = getAuthToken();
  if (token) {
    options.headers = options.headers || {};
    options.headers['Authorization'] = 'Bearer ' + token;
  }
  const res = await fetch(url, options);
  if (res.status === 401) {
    showLoginOverlay();
    throw new Error('Unauthorized');
  }
  return res;
}

function showLoginOverlay() {
  let overlay = $('#loginOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loginOverlay';
    overlay.className = 'login-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'loginTitle');
    overlay.innerHTML = `
      <div class="login-box">
        <h2 id="loginTitle">工作日志</h2>
        <p>请输入访问密码</p>
        <label class="sr-only" for="loginTokenInput">访问密码</label>
        <input type="password" id="loginTokenInput" placeholder="密码" autocomplete="current-password">
        <button class="btn-primary" id="loginSubmitBtn">登录</button>
        <div class="login-error" id="loginError" role="alert" aria-live="assertive"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    $('#loginSubmitBtn').addEventListener('click', attemptLogin);
    $('#loginTokenInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptLogin();
    });
  }
  openModal(overlay, '#loginTokenInput');
}

async function attemptLogin() {
  const input = $('#loginTokenInput');
  const token = input.value.trim();
  if (!token) return;

  try {
    const res = await fetch('/api/auth/check', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (data.authenticated) {
      sessionStorage.setItem('auth_token', token);
      closeModal($('#loginOverlay'));
      input.value = '';
      $('#loginError').textContent = '';
      window.dispatchEvent(new CustomEvent('auth-success'));
    } else {
      $('#loginError').textContent = '密码错误';
    }
  } catch {
    $('#loginError').textContent = '连接失败';
  }
}

export async function checkAuth() {
  try {
    const token = getAuthToken();
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const res = await fetch('/api/auth/check', { headers });
    const data = await res.json();
    if (!data.authenticated) {
      showLoginOverlay();
      return false;
    }
    return true;
  } catch {
    // Server might not require auth
    return true;
  }
}

export async function checkDiaryStatus() {
  const data = await getDiaryStatus();
  return data.enabled !== false && !data.locked;
}

export async function getDiaryStatus() {
  try {
    const res = await apiFetch('/api/auth/diary/status');
    return await res.json();
  } catch {
    return { enabled: true, locked: true };
  }
}

export async function unlockDiary(password) {
  try {
    const res = await apiFetch('/api/auth/diary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    return Boolean(data.unlocked);
  } catch {
    return false;
  }
}

export async function lockDiary() {
  await apiFetch('/api/auth/diary/lock', { method: 'POST' });
}
