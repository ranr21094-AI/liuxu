function currentReturnPath() {
  const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return path.startsWith('/login') ? '/' : path;
}

export function redirectToLogin({ passwordChange = false } = {}) {
  const params = new URLSearchParams();
  params.set('next', currentReturnPath());
  if (passwordChange) params.set('change', '1');
  window.location.assign(`/login?${params.toString()}`);
}

export async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    redirectToLogin();
    throw new Error('Unauthorized');
  }
  if (res.status === 403) {
    const data = await res.clone().json().catch(() => ({}));
    if (data.code === 'PASSWORD_CHANGE_REQUIRED') {
      redirectToLogin({ passwordChange: true });
      throw new Error('Password change required');
    }
  }
  return res;
}

export async function checkAuth() {
  try {
    const res = await fetch('/api/auth/check');
    const data = await res.json();
    if (!data.authenticated) {
      redirectToLogin();
      return false;
    }
    if (data.must_change_password) {
      redirectToLogin({ passwordChange: true });
      return false;
    }
    return true;
  } catch {
    redirectToLogin();
    return false;
  }
}

export async function logoutSite() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.assign('/login');
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
