const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { importJsonAccount, importJsonAuth, MIGRATION_MARKER } = require('./import-json');

const SCHEMA_VERSION = 3;
const ACCOUNT_DB_NAME = 'schedule.db';
const AUTH_DB_NAME = 'users.db';

const openDatabases = new Map();

function migrationSql() {
  return fs.readFileSync(path.join(__dirname, 'migrations', '001_initial.sql'), 'utf8');
}

function migrationSqlFor(version) {
  const suffix = Number(version) === 2 ? 'performance' : Number(version) === 3 ? 'knowledge_links_history' : '';
  if (!suffix) throw new Error(`Unknown schema migration ${version}`);
  return fs.readFileSync(path.join(__dirname, 'migrations', `${String(version).padStart(3, '0')}_${suffix}.sql`), 'utf8');
}

function applySchema(sqlite) {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(migrationSql());
    const row = sqlite.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    let current = Math.max(0, Number.parseInt(row?.value, 10) || 0);
    // Re-run the latest idempotent migration on already-versioned databases;
    // this repairs an interrupted/older v2 rollout without changing data.
    if (current >= SCHEMA_VERSION && SCHEMA_VERSION >= 2) sqlite.exec(migrationSqlFor(SCHEMA_VERSION));
    for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
      if (version > 1) sqlite.exec(migrationSqlFor(version));
      current = version;
      sqlite.prepare(`
        INSERT INTO meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(current));
    }
    if (current < 1) {
      sqlite.prepare(`
        INSERT INTO meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run('1');
      current = 1;
    }
    if (current < SCHEMA_VERSION) {
      sqlite.prepare(`
        INSERT INTO meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(SCHEMA_VERSION));
    }
  });
  migrate();
}

function configureConnection(sqlite) {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('wal_autocheckpoint = 1000');
}

function accountDbPath(dataDir) {
  return path.join(path.resolve(dataDir), ACCOUNT_DB_NAME);
}

function authDbPath(dataDir) {
  return path.join(path.resolve(dataDir), AUTH_DB_NAME);
}

function hasJsonSources(dataDir) {
  const names = [
    'todos.json',
    'agent-sessions.json',
    'knowledge-documents.json',
    'categories.json',
    'logs.json',
  ];
  return names.some(name => fs.existsSync(path.join(dataDir, name)));
}

function shouldImportAccount(dataDir) {
  const marker = path.join(dataDir, MIGRATION_MARKER);
  if (fs.existsSync(marker)) return false;
  if (fs.existsSync(accountDbPath(dataDir))) return false;
  return hasJsonSources(dataDir);
}

function failCorruptDbFile(label, dbFile, err) {
  let backup = '';
  try {
    if (fs.existsSync(dbFile)) {
      backup = `${dbFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
      fs.copyFileSync(dbFile, backup, fs.constants.COPYFILE_EXCL);
    }
  } catch { /* ignore backup failures */ }
  const suffix = backup ? `; preserved at ${backup}` : '';
  throw new Error(`Failed to read ${label}: ${err.message}${suffix}`);
}

function openAccountDatabase(dataDir) {
  const resolved = path.resolve(dataDir);
  if (openDatabases.has(resolved)) return openDatabases.get(resolved);

  fs.mkdirSync(resolved, { recursive: true });
  const dbFile = accountDbPath(resolved);
  const marker = path.join(resolved, MIGRATION_MARKER);
  const isNew = !fs.existsSync(dbFile);
  const needsImport = isNew && !fs.existsSync(marker) && hasJsonSources(resolved);

  let sqlite;
  try {
    sqlite = new Database(dbFile);
    configureConnection(sqlite);
  } catch (err) {
    try { sqlite?.close(); } catch { /* ignore */ }
    failCorruptDbFile('logs.json', dbFile, err);
  }

  if (!isNew) {
    try {
      sqlite.prepare('SELECT 1 FROM logs LIMIT 1').get();
    } catch (err) {
      try { sqlite.close(); } catch { /* ignore */ }
      openDatabases.delete(resolved);
      failCorruptDbFile('logs.json', dbFile, err);
    }
  }
  try {
    applySchema(sqlite);
  } catch (err) {
    try { sqlite.close(); } catch { /* ignore */ }
    openDatabases.delete(resolved);
    failCorruptDbFile('logs.json', dbFile, err);
  }
  if (needsImport) {
    try {
      importJsonAccount(resolved, sqlite);
    } catch (err) {
      try { sqlite.close(); } catch { /* ignore */ }
      openDatabases.delete(resolved);
      try { fs.unlinkSync(dbFile); } catch { /* ignore */ }
      throw err;
    }
  }

  openDatabases.set(resolved, sqlite);
  return sqlite;
}

function shouldImportAuth(dataDir) {
  const root = path.resolve(dataDir);
  const marker = path.join(root, MIGRATION_MARKER);
  if (fs.existsSync(marker)) return false;
  if (fs.existsSync(authDbPath(root))) return false;
  return fs.existsSync(path.join(root, 'users.json')) || fs.existsSync(path.join(root, 'auth-sessions.json'));
}

function hasAuthJsonSources(dataDir) {
  const root = path.resolve(dataDir);
  return fs.existsSync(path.join(root, 'users.json')) || fs.existsSync(path.join(root, 'auth-sessions.json'));
}

function authRegistryEmpty(sqlite) {
  try {
    return sqlite.prepare('SELECT COUNT(*) AS count FROM auth_users').get()?.count === 0;
  } catch {
    return false;
  }
}

function verifyAuthDatabase(sqlite, dbFile, key) {
  try {
    sqlite.prepare('SELECT 1 FROM auth_users LIMIT 1').get();
  } catch (err) {
    try { sqlite.close(); } catch { /* ignore */ }
    if (key) openDatabases.delete(key);
    failCorruptDbFile('users.json', dbFile, err);
  }
}

function openAuthDatabase(dataDir) {
  const resolved = path.resolve(dataDir);
  const key = `${resolved}:auth`;
  if (openDatabases.has(key)) {
    const cached = openDatabases.get(key);
    verifyAuthDatabase(cached, authDbPath(resolved), key);
    return cached;
  }

  fs.mkdirSync(resolved, { recursive: true });
  const dbFile = authDbPath(resolved);
  const marker = path.join(resolved, MIGRATION_MARKER);
  const isNew = !fs.existsSync(dbFile);
  const needsImport = isNew && !fs.existsSync(marker)
    && (fs.existsSync(path.join(resolved, 'users.json'))
      || fs.existsSync(path.join(resolved, 'auth-sessions.json')));

  let sqlite;
  try {
    sqlite = new Database(dbFile);
    configureConnection(sqlite);
  } catch (err) {
    try { sqlite?.close(); } catch { /* ignore */ }
    failCorruptDbFile('users.json', dbFile, err);
  }

  if (!isNew) verifyAuthDatabase(sqlite, dbFile);
  try {
    applySchema(sqlite);
  } catch (err) {
    try { sqlite.close(); } catch { /* ignore */ }
    openDatabases.delete(key);
    failCorruptDbFile('users.json', dbFile, err);
  }
  if (needsImport) {
    try {
      importJsonAuth(resolved, sqlite);
    } catch (err) {
      try { sqlite.close(); } catch { /* ignore */ }
      openDatabases.delete(key);
      try { fs.unlinkSync(dbFile); } catch { /* ignore */ }
      throw err;
    }
  } else if (!isNew) {
    if (authRegistryEmpty(sqlite) && hasAuthJsonSources(resolved)) {
      try {
        importJsonAuth(resolved, sqlite);
      } catch (err) {
        try { sqlite.close(); } catch { /* ignore */ }
        openDatabases.delete(key);
        failCorruptDbFile('users.json', dbFile, err);
      }
    }
  }

  openDatabases.set(key, sqlite);
  return sqlite;
}

function closeAllDatabases() {
  for (const sqlite of openDatabases.values()) {
    try {
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
      sqlite.close();
    } catch { /* ignore */ }
  }
  openDatabases.clear();
}

function closeAccountDatabase(dataDir) {
  const resolved = path.resolve(dataDir);
  const sqlite = openDatabases.get(resolved);
  if (!sqlite) return true;
  let closed = false;
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.close();
    closed = true;
  } catch { /* ignore */ }
  // Only drop the cached handle when the connection really closed: a failed
  // close leaves a live WAL that must not silently replay over a restored file.
  if (closed) openDatabases.delete(resolved);
  return closed;
}

module.exports = {
  SCHEMA_VERSION,
  ACCOUNT_DB_NAME,
  AUTH_DB_NAME,
  accountDbPath,
  authDbPath,
  applySchema,
  openAccountDatabase,
  openAuthDatabase,
  closeAccountDatabase,
  closeAllDatabases,
};
