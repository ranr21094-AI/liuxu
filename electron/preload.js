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
