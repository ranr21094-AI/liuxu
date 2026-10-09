export async function apiFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('liuxu_remote_csrf='));
    if (csrf) headers.set('X-LiuXu-CSRF', decodeURIComponent(csrf.slice(csrf.indexOf('=') + 1)));
  }
  return fetch(url, { ...options, method, headers, credentials: 'same-origin' });
}
