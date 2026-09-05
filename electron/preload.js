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

contextBridge.exposeInMainWorld('liuxuDesktop', Object.freeze({ updates }));
