const out = document.getElementById('out');

document.getElementById('scan').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'tabs.scan' }, (response) => {
    out.textContent = JSON.stringify(response, null, 2);
  });
});

const keyInput = document.getElementById('pairingKey');
const keyStatus = document.getElementById('keyStatus');

function setStatus(text) {
  keyStatus.textContent = text;
}

async function refreshKeyStatus() {
  const stored = (await chrome.storage.local.get('liuxuPairingKey')).liuxuPairingKey || '';
  setStatus(stored ? '已配对：仅接受有效签名命令' : '未配对：浏览器控制命令已禁用');
  if (stored) keyInput.value = '';
}

document.getElementById('saveKey').addEventListener('click', async () => {
  const key = keyInput.value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) {
    setStatus('密钥格式无效：应为配对返回的 64 位十六进制字符串');
    return;
  }
  await chrome.storage.local.set({ liuxuPairingKey: key });
  keyInput.value = '';
  await refreshKeyStatus();
});

document.getElementById('clearKey').addEventListener('click', async () => {
  await chrome.storage.local.remove('liuxuPairingKey');
  await refreshKeyStatus();
});

refreshKeyStatus();
