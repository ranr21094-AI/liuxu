const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decryptSecret, encryptSecret, isEncryptedSecret } = require('../secret-store');

const DESKTOP_CONFIG_VERSION = 1;
const DEFAULT_WINDOWS_DATA_DIR_NAME = 'Work Log Data';
const DEFAULT_WINDOWS_LEGACY_PROJECT_PARTS = ['OneDrive', 'Desktop', 'schedule'];
const AI_SECRET_FIELDS = Object.freeze([
  'apiKey', 'moonshotApiKey', 'openrouterApiKey', 'tavilyApiKey', 'perplexityApiKey',
  'seedreamApiKey', 'getokenApiKey', 'getokenGrokImagineApiKey', 'getokenNanoBananaApiKey',
]);

function shouldMigrateWindowsLegacyData(platform = process.platform) {
  return platform === 'win32';
}

function shouldQuitAfterAllWindowsClosed(platform = process.platform) {
  return platform !== 'darwin';
}

function desktopSecretKeyPath(userDataDir, platform = process.platform) {
  if (platform !== 'darwin') return '';
  if (!userDataDir || !path.isAbsolute(userDataDir)) {
    throw new Error('userDataDir 必须是绝对路径');
  }
  return path.join(userDataDir, 'ai-secrets.key');
}

function macApplicationMenuTemplate(appName = '留序 LiuXu') {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
}

function errorText(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function readDesktopConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`桌面客户端配置无法读取：${configPath}\n${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`桌面客户端配置格式无效：${configPath}`);
  }
  if (parsed.dataDir != null && (typeof parsed.dataDir !== 'string' || !path.isAbsolute(parsed.dataDir.trim()))) {
    throw new Error(`桌面客户端 dataDir 必须是绝对路径：${configPath}`);
  }
  return parsed;
}

function defaultWindowsDataDir(env = process.env, userDataDir = '') {
  const localAppData = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : '';
  if (localAppData && path.isAbsolute(localAppData)) {
    return path.join(path.resolve(localAppData), DEFAULT_WINDOWS_DATA_DIR_NAME);
  }
  if (userDataDir && path.isAbsolute(userDataDir)) {
    return path.join(path.dirname(path.resolve(userDataDir)), DEFAULT_WINDOWS_DATA_DIR_NAME);
  }
  return path.join(os.homedir(), 'AppData', 'Local', DEFAULT_WINDOWS_DATA_DIR_NAME);
}

function defaultWindowsLegacyProjectDir(env = process.env) {
  const userProfile = typeof env.USERPROFILE === 'string' ? env.USERPROFILE.trim() : '';
  return path.join(path.resolve(userProfile || os.homedir()), ...DEFAULT_WINDOWS_LEGACY_PROJECT_PARTS);
}

function resolveDesktopDataDir({
  env = process.env,
  userDataDir,
  platform = process.platform,
  defaultWindowsDataDir: windowsDataDir,
}) {
  if (!userDataDir || !path.isAbsolute(userDataDir)) {
    throw new Error('userDataDir 必须是绝对路径');
  }
  const configPath = path.join(userDataDir, 'desktop-config.json');
  const explicit = typeof env.DATA_DIR === 'string' ? env.DATA_DIR.trim() : '';
  if (explicit) {
    return {
      configPath,
      dataDir: path.resolve(explicit),
      source: 'environment',
    };
  }
  const config = readDesktopConfig(configPath);
  if (typeof config.dataDir === 'string' && config.dataDir.trim()) {
    return {
      configPath,
      dataDir: path.resolve(config.dataDir.trim()),
      source: 'config',
    };
  }
  return {
    configPath,
    dataDir: platform === 'win32'
      ? path.resolve(windowsDataDir || defaultWindowsDataDir(env, userDataDir))
      : path.join(userDataDir, 'data'),
    source: 'default',
  };
}

function persistDesktopConfig(configPath, dataDir) {
  atomicWriteJson(configPath, {
    version: DESKTOP_CONFIG_VERSION,
    dataDir: path.resolve(dataDir),
  });
}

function ensureWritableDirectory(directory) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const probe = path.join(absolute, `.desktop-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'ok', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new Error(`数据目录不可写：${absolute}\n${error.message}`);
  } finally {
    try { fs.unlinkSync(probe); } catch {}
  }
  return absolute;
}

function directoryHasEntries(directory) {
  if (!fs.existsSync(directory)) return false;
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error(`数据目录不是文件夹：${directory}`);
  }
  return fs.readdirSync(directory).length > 0;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function assertLegacySourceIdle(sourceDir) {
  const lockPath = path.join(sourceDir, '.schedule.lock');
  if (!fs.existsSync(lockPath)) return;
  const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
  if (isPidAlive(pid)) {
    throw new Error(`旧数据仍被进程 ${pid} 使用。请先关闭留序（旧称 Work Log）或开发服务器，再重新启动客户端。`);
  }
}

function normalizeRelative(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function treeStats(rootDir, { ignored = new Set() } = {}) {
  const stats = { files: 0, bytes: 0 };
  function visit(directory, relativeBase = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
      if (ignored.has(normalizeRelative(relative))) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`数据目录不允许包含符号链接：${absolute}`);
      }
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const fileStat = fs.statSync(absolute);
        stats.files += 1;
        stats.bytes += fileStat.size;
      } else {
        throw new Error(`数据目录包含不支持的条目：${absolute}`);
      }
    }
  }
  visit(rootDir);
  return stats;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function quickCheckSqlite(filePath, Database = require('better-sqlite3')) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`迁移数据缺少数据库：${filePath}`);
  }
  const database = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const result = database.pragma('quick_check', { simple: true });
    if (result !== 'ok') {
      throw new Error(`SQLite quick_check 未通过：${filePath}（${String(result)}）`);
    }
  } finally {
    database.close();
  }
}

function pathsOverlap(first, second) {
  const a = `${path.resolve(first).toLowerCase()}${path.sep}`;
  const b = `${path.resolve(second).toLowerCase()}${path.sep}`;
  return a.startsWith(b) || b.startsWith(a);
}

function copyLegacyEnv(legacyEnvPath, targetDir) {
  if (!legacyEnvPath || !fs.existsSync(legacyEnvPath)) return false;
  const targetEnvPath = path.join(targetDir, '.env');
  if (fs.existsSync(targetEnvPath)) return false;
  fs.copyFileSync(legacyEnvPath, targetEnvPath, fs.constants.COPYFILE_EXCL);
  return true;
}

// The legacy install encrypted AI secrets with its resolved DATA_DIR as the
// scope. When the old .env pointed DATA_DIR somewhere else than <project>/data,
// that path — not the default source directory — is the scope the ciphertexts
// are bound to.
function resolveLegacySecretScope(sourceDir, legacyEnvPath) {
  if (legacyEnvPath && fs.existsSync(legacyEnvPath)) {
    try {
      const parsed = require('dotenv').parse(fs.readFileSync(legacyEnvPath));
      const configured = typeof parsed.DATA_DIR === 'string' ? parsed.DATA_DIR.trim() : '';
      if (configured) {
        const projectRoot = path.dirname(path.resolve(legacyEnvPath));
        return path.isAbsolute(configured)
          ? path.resolve(configured)
          : path.resolve(projectRoot, configured);
      }
    } catch { /* fall through to the default scope */ }
  }
  return path.resolve(sourceDir);
}

function aiSecretAad(scope, field) {
  return `work-log-ai-settings:v1:${scope}:${field}`;
}

function customProviderSecretAad(scope, providerId) {
  return `work-log-ai-settings:v1:${scope}:customProvider:${providerId}`;
}

function imageProviderSecretAad(scope, providerId) {
  return `work-log-ai-settings:v1:${scope}:imageProvider:${providerId}`;
}

// Reads every encrypted AI secret under the given scope. Any value that fails
// to decrypt is a hard error — the caller must not commit a database whose
// secrets the target installation would be unable to read.
function assertAiSettingsDecodable(settings, scope) {
  const problems = [];
  for (const field of AI_SECRET_FIELDS) {
    const value = settings?.[field];
    if (!isEncryptedSecret(value)) continue;
    try {
      decryptSecret(value, aiSecretAad(scope, field));
    } catch {
      problems.push(field);
    }
  }
  const providerLists = [
    ['customProviders', customProviderSecretAad],
    ['imageProviders', imageProviderSecretAad],
  ];
  for (const [listKey, aadFor] of providerLists) {
    (Array.isArray(settings?.[listKey]) ? settings[listKey] : []).forEach((provider, index) => {
      if (!provider || typeof provider !== 'object' || !isEncryptedSecret(provider.apiKey)) return;
      try {
        decryptSecret(provider.apiKey, aadFor(scope, provider.id || 'unknown'));
      } catch {
        problems.push(`${listKey}[${index}]`);
      }
    });
  }
  if (problems.length) {
    throw new Error(`AI 密钥无法用目标 scope 解密：${problems.join(', ')}`);
  }
}

function reencryptAiSettingsScope(databasePath, sourceScope, targetScope, Database = require('better-sqlite3')) {
  const source = path.resolve(sourceScope);
  const target = path.resolve(targetScope);
  if (source === target) return { changed: false, secrets: 0 };
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_settings'").get();
    if (!table) return { changed: false, secrets: 0 };
    const row = database.prepare('SELECT body FROM ai_settings WHERE id = 1').get();
    if (!row) return { changed: false, secrets: 0 };
    const settings = JSON.parse(row.body);
    let secrets = 0;
    for (const field of AI_SECRET_FIELDS) {
      const value = settings?.[field];
      if (!isEncryptedSecret(value)) continue;
      const plaintext = decryptSecret(value, aiSecretAad(source, field));
      settings[field] = encryptSecret(plaintext, aiSecretAad(target, field));
      secrets += 1;
    }
    if (Array.isArray(settings?.customProviders)) {
      settings.customProviders = settings.customProviders.map((provider) => {
        if (!provider || typeof provider !== 'object' || !isEncryptedSecret(provider.apiKey)) return provider;
        const providerId = provider.id || 'unknown';
        const plaintext = decryptSecret(provider.apiKey, customProviderSecretAad(source, providerId));
        secrets += 1;
        return {
          ...provider,
          apiKey: encryptSecret(plaintext, customProviderSecretAad(target, providerId)),
        };
      });
    }
    if (Array.isArray(settings?.imageProviders)) {
      settings.imageProviders = settings.imageProviders.map((provider) => {
        if (!provider || typeof provider !== 'object' || !isEncryptedSecret(provider.apiKey)) return provider;
        const providerId = provider.id || 'unknown';
        const plaintext = decryptSecret(provider.apiKey, imageProviderSecretAad(source, providerId));
        secrets += 1;
        return {
          ...provider,
          apiKey: encryptSecret(plaintext, imageProviderSecretAad(target, providerId)),
        };
      });
    }
    if (!secrets) return { changed: false, secrets: 0 };
    database.transaction(() => {
      database.prepare('UPDATE ai_settings SET body = ? WHERE id = 1').run(JSON.stringify(settings));
    })();
    // Read the row back from the database and decode every secret under the
    // target scope before the caller commits the migration.
    const stored = JSON.parse(database.prepare('SELECT body FROM ai_settings WHERE id = 1').get().body);
    assertAiSettingsDecodable(stored, target);
    return { changed: true, secrets };
  } finally {
    database.close();
  }
}

function migrateLegacyData({
  sourceDir,
  targetDir,
  legacyEnvPath,
  now = () => new Date(),
  Database,
}) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (pathsOverlap(source, target)) {
    throw new Error(`旧数据目录与新数据目录不能互相包含：${source} / ${target}`);
  }
  if (directoryHasEntries(target)) {
    return { migrated: false, reason: 'target-not-empty', targetDir: target };
  }
  if (!fs.existsSync(source)) {
    fs.mkdirSync(target, { recursive: true });
    const envCopied = copyLegacyEnv(legacyEnvPath, target);
    return { migrated: false, reason: 'source-missing', targetDir: target, envCopied };
  }
  if (!fs.statSync(source).isDirectory()) {
    throw new Error(`旧数据路径不是文件夹：${source}`);
  }
  assertLegacySourceIdle(source);

  const ignored = new Set(['.schedule.lock']);
  const sourceStats = treeStats(source, { ignored });
  const staging = `${target}.migrating-${Date.now()}-${process.pid}`;
  if (fs.existsSync(staging)) {
    throw new Error(`迁移暂存目录已存在：${staging}`);
  }

  try {
    fs.cpSync(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      filter: (entryPath) => normalizeRelative(path.relative(source, entryPath)) !== '.schedule.lock',
    });
    const stagingStats = treeStats(staging);
    if (stagingStats.files !== sourceStats.files || stagingStats.bytes !== sourceStats.bytes) {
      throw new Error(`迁移文件核对失败：源 ${sourceStats.files} 个/${sourceStats.bytes} 字节，暂存 ${stagingStats.files} 个/${stagingStats.bytes} 字节`);
    }

    const databaseNames = ['schedule.db', 'users.db'];
    for (const name of databaseNames) {
      const sourceDatabase = path.join(source, name);
      const stagingDatabase = path.join(staging, name);
      quickCheckSqlite(stagingDatabase, Database);
      if (sha256File(sourceDatabase) !== sha256File(stagingDatabase)) {
        throw new Error(`迁移数据库哈希不一致：${name}`);
      }
    }

    const secretMigration = reencryptAiSettingsScope(
      path.join(staging, 'schedule.db'),
      resolveLegacySecretScope(source, legacyEnvPath),
      target,
      Database,
    );
    if (secretMigration.changed) quickCheckSqlite(path.join(staging, 'schedule.db'), Database);

    const envCopied = copyLegacyEnv(legacyEnvPath, staging);
    if (fs.existsSync(target)) fs.rmdirSync(target);
    fs.renameSync(staging, target);
    const completedAt = now().toISOString();
    atomicWriteJson(path.join(target, '.desktop-data-migrated.json'), {
      version: 1,
      completedAt,
      sourceDir: source,
      files: sourceStats.files,
      bytes: sourceStats.bytes,
      envCopied,
      secretsReencrypted: secretMigration.secrets,
    });
    return {
      migrated: true,
      sourceDir: source,
      targetDir: target,
      files: sourceStats.files,
      bytes: sourceStats.bytes,
      envCopied,
      secretsReencrypted: secretMigration.secrets,
      completedAt,
    };
  } catch (error) {
    if (fs.existsSync(staging)) {
      try {
        atomicWriteJson(path.join(staging, '.desktop-migration-failed.json'), {
          failedAt: now().toISOString(),
          sourceDir: source,
          targetDir: target,
          error: errorText(error),
        });
      } catch {}
    }
    throw new Error(`旧数据迁移失败；原目录未修改。${error.message}\n暂存目录：${staging}`);
  }
}

function rotateLogIfNeeded(logPath, maxBytes) {
  if (!fs.existsSync(logPath) || fs.statSync(logPath).size < maxBytes) return;
  const previous = `${logPath}.1`;
  try { fs.unlinkSync(previous); } catch {}
  fs.renameSync(logPath, previous);
}

function createFileLogger(logPath, { maxBytes = 2 * 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return (level, message, error) => {
    try {
      rotateLogIfNeeded(logPath, maxBytes);
      const line = {
        time: new Date().toISOString(),
        level,
        message: String(message),
      };
      if (error instanceof Error) line.error = errorText(error);
      else if (error && typeof error === 'object') line.details = error;
      else if (error != null) line.error = String(error);
      fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`, 'utf8');
    } catch {}
  };
}

function isAllowedAppNavigation(targetUrl, appOrigin) {
  try {
    return new URL(targetUrl).origin === appOrigin;
  } catch {
    return false;
  }
}

function isExternalHttpUrl(targetUrl) {
  try {
    const protocol = new URL(targetUrl).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function restoreAndFocusWindow(window) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.setAlwaysOnTop(true);
  try {
    window.focus();
  } finally {
    window.setAlwaysOnTop(false);
  }
  return true;
}

module.exports = {
  assertLegacySourceIdle,
  createFileLogger,
  defaultWindowsDataDir,
  defaultWindowsLegacyProjectDir,
  directoryHasEntries,
  desktopSecretKeyPath,
  ensureWritableDirectory,
  isAllowedAppNavigation,
  isExternalHttpUrl,
  migrateLegacyData,
  macApplicationMenuTemplate,
  persistDesktopConfig,
  quickCheckSqlite,
  readDesktopConfig,
  reencryptAiSettingsScope,
  restoreAndFocusWindow,
  resolveDesktopDataDir,
  sha256File,
  shouldMigrateWindowsLegacyData,
  shouldQuitAfterAllWindowsClosed,
  treeStats,
};
