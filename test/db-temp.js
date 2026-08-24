const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ACCOUNT_DB_NAME, AUTH_DB_NAME, accountDbPath, authDbPath } = require('../lib/db/connection');

function closeAllDatabases() {
  return require('../lib/db/connection').closeAllDatabases();
}

function openAuthDatabase(dataDir) {
  return require('../lib/db/connection').openAuthDatabase(dataDir);
}

function cleanupTempDataDir(dir) {
  try { closeAllDatabases(); } catch { /* ignore */ }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch { /* ignore Windows file lock races during test cleanup */ }
}

function createTempDatabase(t, prefix = 'schedule-test-') {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), prefix));
  process.env.AI_SECRETS_KEY_FILE = path.join(dir, 'ai-secrets.key');
  const { createDatabase } = require('../database.js');
  const db = createDatabase(dir);
  t.after(() => {
    db.close();
    cleanupTempDataDir(dir);
  });
  return { db, dir };
}

function readAuthUsers(dataDir) {
  const db = new Database(authDbPath(dataDir), { readonly: true });
  try {
    return db.prepare('SELECT * FROM auth_users ORDER BY username ASC').all();
  } finally {
    db.close();
  }
}

function readAuthSessions(dataDir) {
  const db = new Database(authDbPath(dataDir), { readonly: true });
  try {
    return db.prepare('SELECT * FROM auth_sessions ORDER BY created_at ASC').all();
  } finally {
    db.close();
  }
}

function readAiSettingsRaw(dataDir) {
  const db = new Database(accountDbPath(dataDir), { readonly: true });
  try {
    const row = db.prepare('SELECT body FROM ai_settings WHERE id = 1').get();
    return row ? JSON.parse(row.body) : null;
  } finally {
    db.close();
  }
}

function corruptAccountDatabase(dataDir) {
  closeAllDatabases();
  const db = new Database(accountDbPath(dataDir));
  try {
    db.exec('DROP TABLE logs');
  } finally {
    db.close();
  }
}

function corruptAuthDatabase(dataDir) {
  closeAllDatabases();
  const db = new Database(authDbPath(dataDir));
  try {
    db.exec('DROP TABLE auth_users');
  } finally {
    db.close();
  }
}

module.exports = {
  ACCOUNT_DB_NAME,
  AUTH_DB_NAME,
  accountDbPath,
  authDbPath,
  cleanupTempDataDir,
  createTempDatabase,
  readAuthUsers,
  readAuthSessions,
  readAiSettingsRaw,
  corruptAccountDatabase,
  corruptAuthDatabase,
  closeAllDatabases,
  openAuthDatabase,
};
