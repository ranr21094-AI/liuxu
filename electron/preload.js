const { contextBridge, ipcRenderer } = require('electron');

const updateProgressListeners = new Map();

function invoke(channel, ...args) {
  return ipcRenderer.invoke(`liuxu:update:${channel}`, ...args);
}

const updates = {
  getCurrentInfo: () => invoke('current-info'),
  check: () => invoke('check'),
  download: () => invoke('download'),
  cancelDownload: () => invoke('cancel-download'),
  openInstaller: () => invoke('open-installer'),
  quitForUpdate: () => invoke('quit-for-update'),
  onProgress(callback) {
    if (typeof callback !== 'function') return () => {};
    // Re-registering the same callback replaces the entry; remove the old
    // listener first or it leaks on ipcRenderer forever.
    const existing = updateProgressListeners.get(callback);
    if (existing) ipcRenderer.removeListener('liuxu:update:progress', existing);
    const listener = (_event, payload) => callback(payload);
    updateProgressListeners.set(callback, listener);
    ipcRenderer.on('liuxu:update:progress', listener);
    return () => {
      const registered = updateProgressListeners.get(callback);
      if (!registered) return;
      updateProgressListeners.delete(callback);
      ipcRenderer.removeListener('liuxu:update:progress', registered);
    };
  },
};

const browserListeners = new Map();
function browserInvoke(channel, payload) {
  return ipcRenderer.invoke(`liuxu:browser:${channel}`, payload || {});
}
const browser = {
  available: true,
  open: payload => browserInvoke('open', payload),
  activate: payload => browserInvoke('activate', payload),
  command: payload => browserInvoke('command', payload),
  close: payload => browserInvoke('close', payload),
  executeTool: payload => browserInvoke('execute-tool', payload),
  loadState: () => browserInvoke('load-state'),
  saveState: payload => browserInvoke('save-state', payload),
  clearState: () => browserInvoke('clear-state'),
  onEvent(callback) {
    if (typeof callback !== 'function') return () => {};
    const existing = browserListeners.get(callback);
    if (existing) ipcRenderer.removeListener('liuxu:browser:event', existing);
    const listener = (_event, payload) => callback(payload);
    browserListeners.set(callback, listener);
    ipcRenderer.on('liuxu:browser:event', listener);
    return () => {
      const registered = browserListeners.get(callback);
      if (!registered) return;
      browserListeners.delete(callback);
      ipcRenderer.removeListener('liuxu:browser:event', registered);
    };
  },
};

contextBridge.exposeInMainWorld('liuxuDesktop', Object.freeze({ updates, browser: Object.freeze(browser) }));
