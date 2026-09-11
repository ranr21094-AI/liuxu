import { apiFetch } from './auth.js';

let remoteSession = { remote: false, authenticated: true, device: null };

function el(id) { return document.getElementById(id); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function showPairingGate(message = '') {
  el('remotePairingGate').hidden = false;
  el('workspaceShell').setAttribute('aria-hidden', 'true');
  if (message) el('remotePairingStatus').textContent = message;
}

function enterRemoteApp(data) {
  remoteSession = data;
  document.body.classList.add('remote-client');
  document.body.dataset.remoteClient = 'true';
  el('remotePairingGate').hidden = true;
  el('workspaceShell').removeAttribute('aria-hidden');
  el('remoteSessionBanner').hidden = false;
  el('remoteDeviceLabel').textContent = data.device?.name || '已授权手机';
}

async function pollPairing(requestId, pollToken) {
  for (;;) {
    await wait(1400);
    const response = await fetch(`/api/remote/pair/${encodeURIComponent(requestId)}/status?token=${encodeURIComponent(pollToken)}`, { credentials: 'same-origin' });
    const data = await responseJson(response);
    if (data.state === 'pending') continue;
    if (data.state === 'approved') {
      const url = new URL(location.href);
      url.searchParams.delete('pair');
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      location.reload();
      return;
    }
    throw new Error(data.state === 'denied' ? '电脑端已拒绝配对请求' : '配对码已过期，请在电脑端重新生成');
  }
}

async function submitPairing() {
  const token = new URLSearchParams(location.search).get('pair') || '';
  if (!token) throw new Error('请在电脑端生成新的配对二维码后重新扫描');
  const name = el('remoteDeviceName').value.trim() || '我的手机';
  el('remotePairButton').disabled = true;
  el('remotePairingStatus').textContent = '正在向电脑发送确认请求…';
  try {
    const result = await responseJson(await fetch('/api/remote/pair/request', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name }),
    }));
    el('remotePairingStatus').textContent = '请在电脑端批准此设备，页面会自动继续。';
    await pollPairing(result.requestId, result.pollToken);
  } catch (error) {
    el('remotePairingStatus').textContent = error.message;
    el('remotePairButton').disabled = false;
  }
}

export async function initializeRemoteSession() {
  let response;
  try { response = await fetch('/api/remote/bootstrap', { credentials: 'same-origin', cache: 'no-store' }); }
  catch { return true; }
  if (response.ok) {
    const data = await response.json();
    if (data.remote) enterRemoteApp(data);
    return true;
  }
  if (response.status !== 401 && response.status !== 503) return true;
  showPairingGate(response.status === 503 ? '电脑端已关闭远程访问。' : '扫描电脑端配对二维码并等待确认。');
  el('remotePairButton').addEventListener('click', submitPairing);
  return false;
}

export function isRemoteClient() { return remoteSession.remote === true; }

export async function logoutRemoteSession() {
  await apiFetch('/api/remote/logout', { method: 'POST' });
  location.reload();
}
