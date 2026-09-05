const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const {
  createFileLogger,
  defaultWindowsLegacyProjectDir,
  desktopSecretKeyPath,
  ensureWritableDirectory,
  isAllowedAppNavigation,
  isExternalHttpUrl,
  migrateLegacyData,
  macApplicationMenuTemplate,
  persistDesktopConfig,
  resolveDesktopDataDir,
  restoreAndFocusWindow,
  shouldMigrateWindowsLegacyData,
  shouldQuitAfterAllWindowsClosed,
} = require('./runtime');
const { createUpdateService } = require('./update-service');

let mainWindow = null;
let httpServer = null;
let startupPromise = null;
let shutdownPromise = null;
let quitAllowed = false;
let appOrigin = '';
let updateService = null;
let macUpdateOpened = false;
let log = () => {};
const startupStartedAt = performance.now();

function logStartupPhase(phase) {
  log('info', 'startup performance', {
    phase,
    elapsedMs: Number((performance.now() - startupStartedAt).toFixed(2)),
  });
}

function showStartupError(error) {
  log('error', 'desktop startup failed', error);
  dialog.showErrorBox('留序 LiuXu 启动失败', error?.message || String(error));
}

function loadLegacySecretKeySetting(envPath) {
  if (process.env.AI_SECRETS_KEY_FILE || !fs.existsSync(envPath)) return;
  const parsed = require('dotenv').parse(fs.readFileSync(envPath));
  const configured = typeof parsed.AI_SECRETS_KEY_FILE === 'string'
    ? parsed.AI_SECRETS_KEY_FILE.trim()
    : '';
  if (!configured) return;
  process.env.AI_SECRETS_KEY_FILE = path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(path.dirname(envPath), configured);
}

function prepareRuntimeEnvironment() {
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';
  if (!app.isPackaged) return { dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data') };

  const userDataDir = app.getPath('userData');
  const resolved = resolveDesktopDataDir({ userDataDir });
  let migration = { migrated: false, reason: 'not-windows' };
  if (shouldMigrateWindowsLegacyData()) {
    const legacyProjectDir = path.resolve(
      process.env.WORK_LOG_LEGACY_PROJECT_DIR || defaultWindowsLegacyProjectDir(),
    );
    const legacyEnvPath = path.join(legacyProjectDir, '.env');
    loadLegacySecretKeySetting(legacyEnvPath);
    migration = migrateLegacyData({
      sourceDir: path.join(legacyProjectDir, 'data'),
      targetDir: resolved.dataDir,
      legacyEnvPath,
    });
  } else if (!process.env.AI_SECRETS_KEY_FILE) {
    process.env.AI_SECRETS_KEY_FILE = desktopSecretKeyPath(userDataDir);
  }
  const dataDir = ensureWritableDirectory(resolved.dataDir);
  if (resolved.source !== 'environment') persistDesktopConfig(resolved.configPath, dataDir);

  process.env.DATA_DIR = dataDir;
  const envPath = path.join(dataDir, '.env');
  if (fs.existsSync(envPath)) process.env.DOTENV_PATH = envPath;
  log = createFileLogger(path.join(dataDir, 'logs', 'desktop-main.log'));
  log('info', 'desktop data directory ready', {
    dataDir,
    source: resolved.source,
    migration: migration.reason || (migration.migrated ? 'completed' : 'not-required'),
  });
  return { dataDir, migration };
}

function openExternal(url) {
  if (!isExternalHttpUrl(url)) return;
  shell.openExternal(url).catch((error) => log('error', `failed to open external URL: ${url}`, error));
}

function installNavigationGuards(webContents, appOrigin) {
  const guardNavigation = (event, url) => {
    if (isAllowedAppNavigation(url, appOrigin)) return;
    event.preventDefault();
    openExternal(url);
  };
  webContents.on('will-navigate', guardNavigation);
  webContents.on('will-redirect', guardNavigation);
  webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
}

function focusMainWindow() {
  return restoreAndFocusWindow(mainWindow);
}

function assertTrustedIpcSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
  let senderOrigin = '';
  try { senderOrigin = new URL(senderUrl).origin; } catch {}
  if (!appOrigin || !senderOrigin || senderOrigin !== appOrigin) {
    throw new Error('拒绝来自非应用页面的更新请求');
  }
}

function configureUpdateIpc() {
  ipcMain.removeHandler('liuxu:update:current-info');
  ipcMain.removeHandler('liuxu:update:check');
  ipcMain.removeHandler('liuxu:update:download');
  ipcMain.removeHandler('liuxu:update:cancel-download');
  ipcMain.removeHandler('liuxu:update:open-installer');
  ipcMain.removeHandler('liuxu:update:quit-for-update');
  ipcMain.handle('liuxu:update:current-info', (event) => {
    assertTrustedIpcSender(event);
    return updateService?.getCurrentInfo() || { version: app.getVersion(), platform: process.platform, arch: process.arch };
  });
  ipcMain.handle('liuxu:update:check', async (event) => {
    assertTrustedIpcSender(event);
    if (!updateService) throw new Error('桌面更新服务尚未就绪');
    return updateService.check();
  });
  ipcMain.handle('liuxu:update:download', async (event) => {
    assertTrustedIpcSender(event);
    if (!updateService) throw new Error('桌面更新服务尚未就绪');
    return updateService.download();
  });
  ipcMain.handle('liuxu:update:cancel-download', (event) => {
    assertTrustedIpcSender(event);
    updateService?.cancelDownload();
    return { cancelled: true };
  });
  ipcMain.handle('liuxu:update:open-installer', async (event) => {
    assertTrustedIpcSender(event);
    if (!updateService) throw new Error('桌面更新服务尚未就绪');
    const result = await updateService.openInstaller(shell);
    if (process.platform === 'darwin') macUpdateOpened = true;
    if (process.platform === 'win32') setImmediate(() => beginShutdown());
    return result;
  });
  ipcMain.handle('liuxu:update:quit-for-update', (event) => {
    assertTrustedIpcSender(event);
    if (process.platform !== 'darwin' || !macUpdateOpened) throw new Error('当前没有待完成的 Mac 更新');
    return beginShutdown().then(() => ({ quitting: true }));
  });
}

async function createMainWindow(appUrl) {
  if (focusMainWindow()) return mainWindow;
  appOrigin = new URL(appUrl).origin;
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: '留序 LiuXu',
    autoHideMenuBar: process.platform !== 'darwin',
    show: false,
    backgroundColor: '#f5f2ea',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = window;
  installNavigationGuards(window.webContents, appOrigin);
  window.once('ready-to-show', () => {
    logStartupPhase('window-ready-to-show');
    if (!window.isDestroyed()) window.show();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    log('error', `renderer process exited: ${details.reason}`, details);
    if (details.reason === 'clean-exit' || window.isDestroyed()) return;
    dialog.showMessageBox(window, {
      type: 'error',
      title: '留序 LiuXu 页面异常退出',
      message: '客户端页面发生异常，可以尝试重新载入。',
      detail: `原因：${details.reason}`,
      buttons: ['重新载入', '退出'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !window.isDestroyed()) window.reload();
      else app.quit();
    });
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  await window.loadURL(appUrl);
  return window;
}

async function startDesktop() {
  prepareRuntimeEnvironment();
  logStartupPhase('runtime-ready');
  updateService = createUpdateService({
    userDataPath: app.getPath('userData'),
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    onProgress: payload => mainWindow?.webContents.send('liuxu:update:progress', payload),
  });
  await updateService.cleanup();
  logStartupPhase('update-cache-cleaned');
  log('info', 'desktop startup began');
  const { startServer } = require('../server.js');
  httpServer = await startServer(0, '127.0.0.1');
  const address = httpServer.address();
  if (!address || typeof address !== 'object') throw new Error('本地服务未返回有效端口');
  const appUrl = `http://127.0.0.1:${address.port}/`;
  logStartupPhase('local-server-ready');
  log('info', `local server ready at ${appUrl}`);
  await createMainWindow(appUrl);
  logStartupPhase('window-loaded');
  return appUrl;
}

function closeServer() {
  if (!httpServer) return Promise.resolve();
  const server = httpServer;
  httpServer = null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      log('warn', 'local server close timed out; closing active connections');
      server.closeAllConnections?.();
      finish();
    }, 4000);
    timer.unref?.();
    try {
      server.close(() => {
        clearTimeout(timer);
        finish();
      });
    } catch (error) {
      clearTimeout(timer);
      log('error', 'local server close failed', error);
      finish();
    }
  });
}

function beginShutdown() {
  if (!shutdownPromise) {
    shutdownPromise = closeServer().finally(() => {
      log('info', 'desktop shutdown complete');
      quitAllowed = true;
      app.quit();
    });
  }
  return shutdownPromise;
}

function configurePackagedUserDataPath() {
  if (!app.isPackaged || process.platform !== 'darwin') return;
  app.setPath('userData', path.join(app.getPath('appData'), 'work-log'));
}

configurePackagedUserDataPath();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  process.on('uncaughtException', (error) => {
    showStartupError(error);
    app.quit();
  });
  process.on('unhandledRejection', (error) => {
    showStartupError(error);
    app.quit();
  });

  app.on('second-instance', () => {
    // A rejected startupPromise was already reported via whenReady().catch;
    // re-observing it here must not raise a second unhandledRejection.
    Promise.resolve(startupPromise).then(() => {
      if (!focusMainWindow() && app.isReady() && httpServer) {
        const address = httpServer.address();
        if (address && typeof address === 'object') {
          createMainWindow(`http://127.0.0.1:${address.port}/`).catch(showStartupError);
        }
      }
    }).catch(() => {});
  });

  app.on('before-quit', (event) => {
    if (quitAllowed) return;
    event.preventDefault();
    beginShutdown();
  });

  app.on('window-all-closed', () => {
    if (shouldQuitAfterAllWindowsClosed()) app.quit();
  });
  app.on('activate', () => {
    if (!focusMainWindow() && startupPromise) {
      startupPromise.then((appUrl) => {
        if (!focusMainWindow()) return createMainWindow(appUrl);
        return mainWindow;
      }).catch(showStartupError);
    }
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    log = createFileLogger(path.join(app.getPath('userData'), 'logs', 'desktop-bootstrap.log'));
    Menu.setApplicationMenu(process.platform === 'darwin'
      ? Menu.buildFromTemplate(macApplicationMenuTemplate(app.getName()))
      : null);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    configureUpdateIpc();
    startupPromise = startDesktop();
    return startupPromise;
  }).catch((error) => {
    showStartupError(error);
    app.quit();
  });
}
