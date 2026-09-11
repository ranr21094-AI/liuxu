export async function apiFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('liuxu_remote_csrf='));
    if (csrf) headers.set('X-LiuXu-CSRF', decodeURIComponent(csrf.slice(csrf.indexOf('=') + 1)));
  }
  return fetch(url, { ...options, method, headers, credentials: 'same-origin' });
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
