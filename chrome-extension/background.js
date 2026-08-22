const BLOCKED = /^(chrome|edge|devtools|chrome-extension|file):/i;
const LOGIN_PAGE = /(?:^|[\/#._-])(login|signin|sign-in|authorize|oauth)(?:[\/#?._-]|$)/i;
const SENSITIVE = /cookie|localstorage|sessionstorage|authorization|password/i;
const ALLOWED_CDP = new Set([
  'Page.captureScreenshot', 'Runtime.evaluate', 'DOM.getDocument', 'DOM.querySelector',
  'DOM.getOuterHTML', 'Input.dispatchMouseEvent', 'Input.insertText', 'Page.navigate',
]);

let attached = new Map();

function isAppSender(sender) {
  // Any port on a loopback hostname is allowed; origin must be exact.
  try {
    const origin = new URL(sender.origin || '');
    return origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname);
  } catch {
    return false;
  }
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

async function listTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter(tab => !BLOCKED.test(tab.url || '') && !LOGIN_PAGE.test(tab.url || ''))
    .map(tab => ({ id: tab.id, title: tab.title, url: tab.url, attached: attached.has(tab.id) }));
}

async function resolveTabId(message) {
  const requested = Number(message.tabId) || Number(message.args?.tabId);
  if (requested) {
    if (!attached.has(requested)) await attachTab(requested);
    return requested;
  }
  const first = [...attached.keys()][0];
  if (first) return first;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new Error('No browser tab is available');
  await attachTab(active.id);
  return active.id;
}

async function cdp(tabId, method, params) {
  if (!ALLOWED_CDP.has(method)) throw new Error('Browser command is not allowed');
  if (method === 'Runtime.evaluate' && SENSITIVE.test(String(params?.expression || ''))) {
    throw new Error('Sensitive browser state is blocked');
  }
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

async function executeAgentCommand(message) {
  const name = String(message.name || message.command || '');
  const args = message.args || {};
  if (name === 'browser.scan' || message.type === 'tabs.scan') return { tabs: await listTabs() };
  const tabId = await resolveTabId(message);
  switch (name) {
    case 'browser.screenshot': {
      const result = await cdp(tabId, 'Page.captureScreenshot', { format: 'png' });
      return { data: result?.data || '' };
    }
    case 'browser.navigate': {
      const url = String(args.url || args.target || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed');
      return cdp(tabId, 'Page.navigate', { url });
    }
    case 'browser.click': {
      const x = Number(args.x) || 0;
      const y = Number(args.y) || 0;
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      return cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    case 'browser.type': {
      return cdp(tabId, 'Input.insertText', { text: String(args.text || args.value || '') });
    }
    case 'browser.select':
    case 'browser.execute_js': {
      const expression = String(args.code || args.script || args.expression || args.value || '');
      if (!expression) throw new Error('code is required');
      return cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true });
    }
    default: {
      // Raw CDP passthrough (popup-style { method, params } commands).
      return cdp(tabId, name, message.params);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'tabs.scan') {
      sendResponse({ ok: true, tabs: await listTabs() });
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
      const result = await executeAgentCommand(message);
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
