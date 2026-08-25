const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  decryptSecret,
  encryptSecret,
  resetSecretStoreForTests,
} = require('../secret-store');
const {
  defaultWindowsDataDir,
  defaultWindowsLegacyProjectDir,
  ensureWritableDirectory,
  isAllowedAppNavigation,
  isExternalHttpUrl,
  migrateLegacyData,
  persistDesktopConfig,
  readDesktopConfig,
  restoreAndFocusWindow,
  resolveDesktopDataDir,
} = require('../electron/runtime');

function makeTempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-log-electron-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createDatabase(filePath, tableName) {
  const database = new Database(filePath);
  database.exec(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO ${tableName} (value) VALUES ('ok')`);
  database.close();
}

test('desktop data directory precedence is environment, config, then default', (t) => {
  const root = makeTempDir(t);
  const userDataDir = path.join(root, 'user-data');
  fs.mkdirSync(userDataDir, { recursive: true });
  const configured = path.join(root, 'configured');
  const defaultDir = path.join(root, 'default');
  const explicit = path.join(root, 'explicit');

  persistDesktopConfig(path.join(userDataDir, 'desktop-config.json'), configured);
  assert.equal(resolveDesktopDataDir({ env: { DATA_DIR: explicit }, userDataDir, defaultWindowsDataDir: defaultDir }).dataDir, explicit);
  assert.equal(resolveDesktopDataDir({ env: {}, userDataDir, defaultWindowsDataDir: defaultDir }).dataDir, configured);

  fs.unlinkSync(path.join(userDataDir, 'desktop-config.json'));
  assert.equal(resolveDesktopDataDir({ env: {}, userDataDir, platform: 'win32', defaultWindowsDataDir: defaultDir }).dataDir, defaultDir);
});

test('desktop config rejects a relative data directory', (t) => {
  const root = makeTempDir(t);
  const configPath = path.join(root, 'desktop-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ dataDir: 'relative-data' }));
  assert.throws(() => readDesktopConfig(configPath), /绝对路径/);
});

test('Windows defaults keep installed data on C and discover the C workspace', (t) => {
  const root = makeTempDir(t);
  const env = {
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    USERPROFILE: root,
  };
  assert.equal(defaultWindowsDataDir(env), path.join(env.LOCALAPPDATA, 'Work Log Data'));
  assert.equal(
    defaultWindowsLegacyProjectDir(env),
    path.join(root, 'OneDrive', 'Desktop', 'schedule'),
  );
});

test('legacy data migration copies and verifies data without changing the source', (t) => {
  const root = makeTempDir(t);
  const source = path.join(root, 'legacy', 'data');
  const target = path.join(root, 'new-data');
  const legacyEnv = path.join(root, 'legacy', '.env');
  fs.mkdirSync(path.join(source, 'uploads'), { recursive: true });
  createDatabase(path.join(source, 'schedule.db'), 'schedule_check');
  createDatabase(path.join(source, 'users.db'), 'users_check');
  fs.writeFileSync(path.join(source, 'uploads', 'asset.txt'), 'attachment');
  fs.writeFileSync(path.join(source, '.schedule.lock'), '99999999');
  fs.writeFileSync(legacyEnv, 'PORT=3000\n');

  const result = migrateLegacyData({ sourceDir: source, targetDir: target, legacyEnvPath: legacyEnv, Database });
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(path.join(target, 'uploads', 'asset.txt'), 'utf8'), 'attachment');
  assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'PORT=3000\n');
  assert.equal(fs.existsSync(path.join(target, '.schedule.lock')), false);
  assert.equal(fs.existsSync(path.join(target, '.desktop-data-migrated.json')), true);
  assert.equal(fs.existsSync(path.join(source, 'schedule.db')), true);
  assert.equal(fs.existsSync(path.join(source, 'uploads', 'asset.txt')), true);
});

test('legacy migration re-encrypts AI secrets for the new data directory', (t) => {
  const root = makeTempDir(t);
  const source = path.join(root, 'legacy-data');
  const target = path.join(root, 'installed-data');
  fs.mkdirSync(source, { recursive: true });
  const previousKeyFile = process.env.AI_SECRETS_KEY_FILE;
  process.env.AI_SECRETS_KEY_FILE = path.join(root, 'ai-secrets.key');
  resetSecretStoreForTests();
  t.after(() => {
    if (previousKeyFile === undefined) delete process.env.AI_SECRETS_KEY_FILE;
    else process.env.AI_SECRETS_KEY_FILE = previousKeyFile;
    resetSecretStoreForTests();
  });

  const sourceAad = (field) => `work-log-ai-settings:v1:${path.resolve(source)}:${field}`;
  const targetAad = (field) => `work-log-ai-settings:v1:${path.resolve(target)}:${field}`;
  const schedule = new Database(path.join(source, 'schedule.db'));
  schedule.exec('CREATE TABLE ai_settings (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const sourceSettings = {
    apiKey: encryptSecret('primary-secret', sourceAad('apiKey')),
    customProviders: [{
      id: 'provider-1',
      apiKey: encryptSecret('provider-secret', sourceAad('customProvider:provider-1')),
    }],
  };
  schedule.prepare('INSERT INTO ai_settings (id, body) VALUES (1, ?)').run(JSON.stringify(sourceSettings));
  schedule.close();
  createDatabase(path.join(source, 'users.db'), 'users_check');

  const result = migrateLegacyData({ sourceDir: source, targetDir: target, Database });
  assert.equal(result.secretsReencrypted, 2);
  const installed = new Database(path.join(target, 'schedule.db'), { readonly: true });
  const installedSettings = JSON.parse(installed.prepare('SELECT body FROM ai_settings WHERE id = 1').get().body);
  installed.close();
  assert.equal(decryptSecret(installedSettings.apiKey, targetAad('apiKey')), 'primary-secret');
  assert.equal(
    decryptSecret(installedSettings.customProviders[0].apiKey, targetAad('customProvider:provider-1')),
    'provider-secret',
  );
  assert.throws(() => decryptSecret(installedSettings.apiKey, sourceAad('apiKey')), /Failed to decrypt/);

  const original = new Database(path.join(source, 'schedule.db'), { readonly: true });
  const originalSettings = JSON.parse(original.prepare('SELECT body FROM ai_settings WHERE id = 1').get().body);
  original.close();
  assert.equal(decryptSecret(originalSettings.apiKey, sourceAad('apiKey')), 'primary-secret');
});

test('legacy migration never overwrites a non-empty target', (t) => {
  const root = makeTempDir(t);
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  const result = migrateLegacyData({ sourceDir: source, targetDir: target });
  assert.equal(result.reason, 'target-not-empty');
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
});

test('legacy migration refuses an active source lock', (t) => {
  const root = makeTempDir(t);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '.schedule.lock'), String(process.pid));
  assert.throws(() => migrateLegacyData({ sourceDir: source, targetDir: path.join(root, 'target') }), /仍被进程/);
});

test('writable directory probe leaves no temporary file behind', (t) => {
  const root = makeTempDir(t);
  const target = path.join(root, 'writable');
  assert.equal(ensureWritableDirectory(target), target);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('navigation guards only allow the local application origin', () => {
  const origin = 'http://127.0.0.1:43210';
  assert.equal(isAllowedAppNavigation(`${origin}/#agent`, origin), true);
  assert.equal(isAllowedAppNavigation('https://example.com/', origin), false);
  assert.equal(isAllowedAppNavigation('not a url', origin), false);
  assert.equal(isExternalHttpUrl('https://example.com/'), true);
  assert.equal(isExternalHttpUrl('file:///C:/secret.txt'), false);
});

test('second instance restore shows and focuses an existing window', () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    isVisible: () => false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    setAlwaysOnTop: (value) => calls.push(`always-on-top:${value}`),
  };
  assert.equal(restoreAndFocusWindow(window), true);
  assert.deepEqual(calls, ['restore', 'show', 'always-on-top:true', 'focus', 'always-on-top:false']);
  assert.equal(restoreAndFocusWindow({ isDestroyed: () => true }), false);
});

test('desktop package includes every root-level runtime module', () => {
  const builderConfig = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  for (const runtimeFile of ['server.js', 'database.js', 'business-date.js', 'secret-store.js']) {
    assert.match(builderConfig, new RegExp(`^\\s*- ${runtimeFile.replace('.', '\\.')}$`, 'm'));
  }
});

test('NSIS uses the standard per-user installation directory', () => {
  const builderConfig = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.match(builderConfig, /^appId: com\.worklog\.desktop$/m);
  assert.match(builderConfig, /^productName: 留序 LiuXu$/m);
  assert.match(builderConfig, /^\s*executableName: LiuXu$/m);
  assert.match(builderConfig, /^\s*artifactName: "LiuXu-Setup-\$\{version\}-x64\.\$\{ext\}"$/m);
  assert.match(builderConfig, /^\s*shortcutName: 留序 LiuXu$/m);
  assert.match(builderConfig, /!node_modules\/pdfjs-dist\/node_modules\/canvas\/\*\*/);

  const buildScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'desktop-build.ps1'), 'utf8');
  assert.match(buildScript, /npm ci --ignore-scripts --omit=optional/);
  assert.match(buildScript, /artifact = \$artifactInfo\.Name/);
  assert.doesNotMatch(buildScript, /artifact = \$artifactInfo\.FullName/);
  assert.match(builderConfig, /^\s*oneClick: false$/m);
  assert.match(builderConfig, /^\s*perMachine: false$/m);
  assert.match(builderConfig, /^\s*allowToChangeInstallationDirectory: true$/m);
  assert.doesNotMatch(builderConfig, /^\s*include:.*installer\.nsh$/m);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'electron', 'installer.nsh')), false);
});
