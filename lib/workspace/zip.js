const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const Database = require('better-sqlite3');
const { atomicWriteJson } = require('../util/json-file');
const { accountDbPath, closeAccountDatabase, openAccountDatabase, ACCOUNT_DB_NAME } = require('../db/connection');
const { importJsonAccount } = require('../db/import-json');
const { hasActiveAgentRuns } = require('../agent/active-runs');
const { createKnowledgeService } = require('../knowledge/documents');
const { createAgentStore } = require('../agent/store');
const { readMeta, parseJson } = require('../db/helpers');

function addDirToZip(zip, dir, prefix) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const dest = `${prefix}/${name}`.replace(/\\/g, '/');
    const info = fs.lstatSync(full);
    if (info.isSymbolicLink()) throw new Error('Cannot export symlink attachments');
    if (info.isDirectory()) addDirToZip(zip, full, dest);
    else {
      if (info.size > MAX_BINARY_BYTES) throw new Error(`${dest} is too large`);
      zip.file(dest, fs.readFileSync(full));
    }
  }
}

function addFileToZip(zip, file, name) {
  if (fs.existsSync(file) && fs.statSync(file).isFile()) zip.file(name, fs.readFileSync(file));
}

function exportKnowledgeJson(db) {
  const knowledge = createKnowledgeService(db);
  const documents = knowledge.nativeDocuments();
  const sqlite = db.sqlite || openAccountDatabase(db.dataDir);
  const nextNoteId = Math.max(1, Number(readMeta(sqlite, 'next_note_id', '1')) || 1);
  const nextFileId = Math.max(1, Number(readMeta(sqlite, 'next_file_id', '1')) || 1);
  return { documents, nextNoteId, nextFileId };
}

function exportAgentJson(db) {
  const store = createAgentStore(db);
  const sessions = store.listSessions({ includeArchived: true });
  const activeSessionId = readMeta(db.sqlite, 'active_session_id', '');
  const runs = db.sqlite.prepare('SELECT body FROM agent_runs ORDER BY created_at ASC').all()
    .map(row => parseJson(row.body, {}));
  const memories = store.readMemories();
  return {
    'agent-sessions.json': { sessions, activeSessionId },
    'agent-runs.json': { runs },
    'agent-memories.json': memories,
  };
}

async function exportWorkspace(db) {
  const sqlite = db.sqlite || openAccountDatabase(db.dataDir);
  const checkpoint = sqlite.pragma('wal_checkpoint(TRUNCATE)');
  if (checkpoint.some(row => row.busy)) throw new Error('Database is busy; retry the export');
  if (fs.statSync(accountDbPath(db.dataDir)).size > MAX_DATABASE_BYTES) throw new Error('schedule.db is too large');
  assertSqliteReadable(accountDbPath(db.dataDir));
  const zip = new JSZip();
  const backup = db.backup();
  zip.file('workspace.json', JSON.stringify({
    ...backup,
    format: 'workspace-zip',
    includesBinaries: true,
    storage: 'sqlite',
  }, null, 2));
  addFileToZip(zip, accountDbPath(db.dataDir), ACCOUNT_DB_NAME);
  addDirToZip(zip, path.join(db.dataDir, 'uploads'), 'uploads');
  addDirToZip(zip, path.join(db.dataDir, 'knowledge-files'), 'knowledge-files');
  addDirToZip(zip, path.join(db.dataDir, 'agent-assets'), 'agent-assets');

  const knowledgeStore = exportKnowledgeJson(db);
  zip.file('knowledge-documents.json', JSON.stringify(knowledgeStore, null, 2));

  const agentJson = exportAgentJson(db);
  for (const [name, payload] of Object.entries(agentJson)) {
    zip.file(name, JSON.stringify(payload, null, 2));
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (buffer.length > MAX_ZIP_BYTES) throw new Error('ZIP is too large');
  // Validate the same limits used by restore before offering a download.
  const inspected = await inspectArchive(buffer);
  validateKnowledgeAttachments(knowledgeStore.documents, inspected.binaries);
  return buffer;
}

const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const MAX_DATABASE_BYTES = 120 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20000;
const MAX_TOTAL_UNCOMPRESSED = 1024 * 1024 * 1024;
const MAX_BINARY_BYTES = 30 * 1024 * 1024;
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const AI_SETTINGS_SECRET_FIELDS = [
  'apiKey',
  'moonshotApiKey',
  'openrouterApiKey',
  'tavilyApiKey',
  'perplexityApiKey',
  'seedreamApiKey',
  'getokenApiKey',
  'getokenGrokImagineApiKey',
  'getokenNanoBananaApiKey',
];

function entryUncompressedSize(entry) {
  return Number(entry?._data?.uncompressedSize) || 0;
}

// Stream-decompress with hard byte accounting. The central directory's
// declared sizes are attacker-controlled, so the only trustworthy limit is
// the number of bytes that actually come out of the inflater.
function readEntryBuffer(entry, name, maxBytes, budget = null) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let stream;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { stream?.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    try {
      stream = entry.nodeStream();
    } catch (err) {
      fail(err);
      return;
    }
    stream.on('data', chunk => {
      if (settled) return;
      total += chunk.length;
      if (budget) budget.remaining -= chunk.length;
      if (total > maxBytes) {
        fail(new Error(`${name} is too large`));
        return;
      }
      if (budget && budget.remaining < 0) {
        fail(new Error('ZIP is too large'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', fail);
  });
}

async function readZipJson(zip, name, maxBytes, budget = null) {
  const entry = zip.file(name);
  if (!entry) return null;
  const bytes = await readEntryBuffer(entry, name, maxBytes, budget);
  return JSON.parse(bytes.toString('utf8'));
}

function restoreBakDir(dataDir) {
  return path.join(path.dirname(dataDir), `${path.basename(dataDir)}.restore-bak`);
}

function rollbackDataDir(dataDir) {
  const backupDir = restoreBakDir(dataDir);
  if (!fs.existsSync(backupDir)) return false;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.cpSync(backupDir, dataDir, { recursive: true, force: true });
  return true;
}

function reopenAccount(db) {
  if (typeof db.reopen === 'function') db.reopen();
  else {
    db.resetCache();
    openAccountDatabase(db.dataDir);
  }
}

function assertSqliteReadable(filePath) {
  let conn;
  try {
    conn = new Database(filePath, { readonly: true, fileMustExist: true });
    const check = conn.pragma('integrity_check', { simple: true });
    if (String(check).toLowerCase() !== 'ok') throw new Error('Backup database is corrupted');
    conn.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
  } catch {
    throw new Error('Backup database is corrupted');
  } finally {
    try { conn?.close(); } catch { /* ignore */ }
  }
}

function installValidatedDatabase(dataDir, validatedPath) {
  const dbPath = accountDbPath(dataDir);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* not present */ }
  }
  const tmpPath = `${dbPath}.restore-tmp`;
  fs.copyFileSync(validatedPath, tmpPath);
  fs.renameSync(tmpPath, dbPath);
}

function mergeKnowledgeInto(db, store) {
  if (!store) return;
  createKnowledgeService(db).mergeNativeDocuments(store.documents || [], store);
}

function resetUnusableAiSecrets(db) {
  try {
    db.getAiSettings();
    return false;
  } catch (error) {
    if (!['AI_SECRET_KEY_MISSING', 'AI_SECRET_KEY_INVALID', 'AI_SECRET_DECRYPT_FAILED'].includes(error?.code)) {
      throw error;
    }
  }

  const sqlite = db.sqlite || openAccountDatabase(db.dataDir);
  const row = sqlite.prepare('SELECT body FROM ai_settings WHERE id = 1').get();
  if (!row) return false;
  const settings = JSON.parse(row.body);
  for (const field of AI_SETTINGS_SECRET_FIELDS) settings[field] = '';
  if (Array.isArray(settings.customProviders)) {
    settings.customProviders = settings.customProviders.map(provider => (
      provider && typeof provider === 'object' ? { ...provider, apiKey: '' } : provider
    ));
  }
  if (Array.isArray(settings.imageProviders)) {
    settings.imageProviders = settings.imageProviders.map(provider => (
      provider && typeof provider === 'object' ? { ...provider, apiKey: '' } : provider
    ));
  }
  sqlite.prepare('UPDATE ai_settings SET body = ? WHERE id = 1').run(JSON.stringify(settings));
  db.resetCache();
  return true;
}

// Inspect everything before touching live state. SQLite is authoritative when present;
// compatibility JSON is only parsed for legacy archives.
async function inspectArchive(buffer) {
  if (buffer.length > MAX_ZIP_BYTES) throw new Error('ZIP is too large');
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  if (names.length > MAX_ZIP_ENTRIES) throw new Error('ZIP contains too many entries');
  const budget = { remaining: MAX_TOTAL_UNCOMPRESSED };
  let declared = 0;
  for (const name of names) {
    const entry = zip.files[name];
    const original = String(entry.unsafeOriginalName || name).replace(/\\/g, '/');
    if (original.startsWith('/') || /^[a-z]:/i.test(original) || original.split('/').includes('..')
      || (Number(entry.unixPermissions) & 0xf000) === 0xa000) throw new Error('Unsafe ZIP entry');
    declared += entryUncompressedSize(entry);
  }
  if (declared > MAX_TOTAL_UNCOMPRESSED) throw new Error('ZIP is too large');
  if (!zip.file('workspace.json')) throw new Error('ZIP is missing workspace.json');
  const database = zip.file(ACCOUNT_DB_NAME)
    ? await readEntryBuffer(zip.file(ACCOUNT_DB_NAME), ACCOUNT_DB_NAME, MAX_DATABASE_BYTES, budget) : null;
  const data = database ? null : await readZipJson(zip, 'workspace.json', MAX_JSON_BYTES, budget);
  const json = {};
  if (!database) {
    for (const name of ['knowledge-documents.json', 'agent-sessions.json', 'agent-runs.json', 'agent-memories.json']) {
      if (!zip.file(name)) continue;
      json[name] = await readZipJson(zip, name, MAX_JSON_BYTES, budget);
      if (!json[name] || typeof json[name] !== 'object' || Array.isArray(json[name])) throw new Error(`Invalid ${name}`);
    }
    for (const [name, field] of [['knowledge-documents.json', 'documents'], ['agent-sessions.json', 'sessions'], ['agent-runs.json', 'runs'], ['agent-memories.json', 'items']]) {
      if (json[name] && !Array.isArray(json[name][field])) throw new Error(`Invalid ${name}`);
    }
  }
  const binaries = new Map();
  for (const name of names) {
    if (zip.files[name].dir || !/^(uploads|knowledge-files|agent-assets)\//.test(name)) continue;
    binaries.set(name, await readEntryBuffer(zip.files[name], name, MAX_BINARY_BYTES, budget));
  }
  return { database, data, json, binaries };
}

function validateKnowledgeAttachments(documents, binaries) {
  for (const doc of documents) {
    if (!doc || typeof doc.id !== 'string' || !['note', 'file'].includes(doc.sourceType)
      || typeof doc.content !== 'string' || doc.content.length > 500000) throw new Error('Invalid knowledge document');
    const name = doc.fileMeta?.storedName;
    if (name === undefined) continue;
    if (!name || path.basename(name) !== name || /[\\/]/.test(name)) throw new Error('Invalid knowledge file reference');
    const bytes = binaries.get(`knowledge-files/${name}`);
    if (!bytes) throw new Error('Knowledge file attachment is missing');
    if (doc.fileMeta.sha256 && crypto.createHash('sha256').update(bytes).digest('hex') !== doc.fileMeta.sha256) throw new Error('Knowledge file checksum mismatch');
    if (doc.fileMeta.bytes !== undefined && Number(doc.fileMeta.bytes) !== bytes.length) throw new Error('Knowledge file size mismatch');
  }
}

async function restoreWorkspace(db, buffer, mode = 'replace') {
  const archive = await inspectArchive(buffer);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-restore-'));
  let staged;
  try {
    const stagedPath = accountDbPath(staging);
    if (archive.database) {
      fs.writeFileSync(stagedPath, archive.database);
      assertSqliteReadable(stagedPath);
    }
    const { createDatabase } = require('../../database');
    staged = createDatabase(staging, { secretScope: db.dataDir });
    if (!archive.database) {
      const validation = staged.restore(archive.data, 'replace');
      if (validation.error) throw new Error(validation.error);
      // Write a complete, normalized legacy source set in an isolated directory.
      const normalized = staged.backup();
      for (const [name, value] of Object.entries({
        'logs.json': normalized.logs, 'todos.json': normalized.todos,
        'countdowns.json': normalized.countdowns, 'categories.json': normalized.categories,
        'todo-categories.json': normalized.todoCategories, 'private-uploads.json': normalized.privateUploads,
        ...archive.json,
      })) atomicWriteJson(path.join(staging, name), value);
      importJsonAccount(staging, staged.sqlite);
    }
    const knowledgeStore = exportKnowledgeJson(staged);
    validateKnowledgeAttachments(knowledgeStore.documents, archive.binaries);
    const structure = staged.backup();
    staged.close(); staged = null;
    if (hasActiveAgentRuns(db)) throw new Error('Agent run in progress — stop it before restoring');
    db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    // A failed snapshot must never be silently ignored before destructive work.
    const backupDir = restoreBakDir(db.dataDir);
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.cpSync(db.dataDir, backupDir, { recursive: true });
    let result;
    let secretsReset = false;
    try {
      const indexPath = path.join(db.dataDir, 'knowledge-index.json');
      if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
      if (mode === 'merge') {
        db.sqlite.transaction(() => {
          result = db.restore(structure, 'merge');
          if (result.error) throw new Error(result.error);
          mergeKnowledgeInto(db, knowledgeStore);
        })();
      } else {
        if (!closeAccountDatabase(db.dataDir)) throw new Error('Failed to close the account database before restore');
        installValidatedDatabase(db.dataDir, stagedPath);
        reopenAccount(db);
        secretsReset = resetUnusableAiSecrets(db);
        result = { success: true, format: 'sqlite', logs: structure.logs.length, todos: structure.todos.length };
      }
      for (const [name, bytes] of archive.binaries) {
        const target = path.resolve(db.dataDir, name);
        if (!target.startsWith(path.resolve(db.dataDir) + path.sep)) throw new Error('Unsafe ZIP entry');
        // Never follow an existing destination symlink outside the data directory.
        let current = path.dirname(target);
        while (current !== path.resolve(db.dataDir)) {
          if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe attachment directory');
          current = path.dirname(current);
        }
        if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Unsafe attachment path');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
      }
    } catch (error) {
      closeAccountDatabase(db.dataDir);
      for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(accountDbPath(db.dataDir) + suffix); } catch {} }
      rollbackDataDir(db.dataDir);
      reopenAccount(db);
      throw error;
    } finally {
      require('../knowledge/routes').invalidateKnowledgeCache(db.dataDir);
      require('../agent/routes').invalidateAgentRuntime(db.dataDir);
    }
    return { ...result, format: 'workspace-zip', includesBinaries: true, secretsReset };
  } finally {
    staged?.close();
    closeAccountDatabase(staging);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { exportWorkspace, restoreWorkspace, MAX_ZIP_BYTES, inspectArchive };
