const BLOCKED = /^(chrome|edge|devtools|chrome-extension|file):/i;
const LOGIN_PAGE = /(?:^|[\/#._-])(login|signin|sign-in|authorize|oauth)(?:[\/#?._-]|$)/i;
const APP_ORIGINS = new Set(['http://127.0.0.1:3000', 'http://localhost:3000', 'http://127.0.0.1', 'http://localhost']);

let attached = new Map();
let pairing = null;

function isAppSender(sender) {
  const origin = sender.origin || '';
  return [...APP_ORIGINS].some(allowed => origin.startsWith(allowed));
}

async function attachTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (BLOCKED.test(tab.url || '') || LOGIN_PAGE.test(tab.url || '')) throw new Error('This page cannot be controlled');
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.set(tabId, tab.url);
  await chrome.action.setBadgeText({ tabId, text: 'ON' });
  await chrome.debugger.sendCommand({ tabId }, 'Overlay.setShowViewportSizeOnResize', { show: false });
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === 'string') return value.replace(/(value\s*=\s*["'])[^"']*(["'])/gi, '$1[redacted]$2');
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|cookie|localstorage|authorization|token|secret/i.test(key)) continue;
    output[key] = scrub(item);
  }
  return output;
}

async function detachTab(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch {}
  attached.delete(tabId);
  await chrome.action.setBadgeText({ tabId, text: '' });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attached.delete(source.tabId);
    chrome.action.setBadgeText({ tabId: source.tabId, text: '' });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'pair.start') {
      pairing = { code: Math.random().toString(16).slice(2, 8), key: crypto.getRandomValues(new Uint8Array(16)) };
      sendResponse({ pairingCode: pairing.code });
      return;
    }
    if (message.type === 'tabs.scan') {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      sendResponse({
          tabs: tabs.filter(tab => !BLOCKED.test(tab.url || '') && !LOGIN_PAGE.test(tab.url || '')).map(tab => ({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          attached: attached.has(tab.id),
        })),
      });
      return;
    }
    if (message.type === 'tabs.attach') {
      await attachTab(message.tabId);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'tabs.detach') {
      await detachTab(message.tabId);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'agent.command') {
      const { tabId, method, params } = message;
      if (!attached.has(tabId)) throw new Error('Tab is not attached');
      const allowedMethods = new Set(['Page.captureScreenshot', 'Runtime.evaluate', 'DOM.getDocument', 'DOM.querySelector', 'DOM.getOuterHTML', 'Input.dispatchMouseEvent', 'Input.insertText', 'Page.navigate']);
      if (!allowedMethods.has(method)) throw new Error('Browser command is not allowed');
      if (method === 'Runtime.evaluate' && /cookie|localstorage|sessionstorage|authorization|password/i.test(String(params?.expression || ''))) throw new Error('Sensitive browser state is blocked');
      const result = await chrome.debugger.sendCommand({ tabId }, method, params || {});
      sendResponse({ ok: true, result: scrub(result) });
    }
  })().catch(err => sendResponse({ ok: false, error: err.message }));
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isAppSender(sender)) {
    sendResponse({ ok: false, error: 'Origin is not allowed' });
    return false;
  }
  chrome.runtime.sendMessage(message, sendResponse);
  return true;
});
