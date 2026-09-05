const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { readJsonIfExists, atomicWriteJson } = require('../util/json-file');
const { accountDbPath, closeAccountDatabase, openAccountDatabase, ACCOUNT_DB_NAME } = require('../db/connection');
const { importJsonAccount } = require('../db/import-json');
const { createKnowledgeService } = require('../knowledge/documents');
const { createAgentStore } = require('../agent/store');
const { readMeta, parseJson } = require('../db/helpers');

function addDirToZip(zip, dir, prefix) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const dest = `${prefix}/${name}`.replace(/\\/g, '/');
    if (fs.statSync(full).isDirectory()) addDirToZip(zip, full, dest);
    else zip.file(dest, fs.readFileSync(full));
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
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
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
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

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

function backupDataDir(dataDir) {
  if (!fs.existsSync(dataDir)) return;
  const parent = path.dirname(dataDir);
  const base = path.basename(dataDir);
  const backupDir = path.join(parent, `${base}.restore-bak`);
  try {
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    fs.cpSync(dataDir, backupDir, { recursive: true });
  } catch {
    /* ignore backup failures */
  }
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

async function restoreWorkspace(db, buffer, mode = 'replace') {
  const zip = await JSZip.loadAsync(buffer);
  const budget = { remaining: MAX_TOTAL_UNCOMPRESSED };

  const names = Object.keys(zip.files);
  if (names.length > MAX_ZIP_ENTRIES) throw new Error('ZIP contains too many entries');
  let totalUncompressed = 0;
  for (const name of names) {
    const normalized = name.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error('Unsafe ZIP entry');
    }
    totalUncompressed += entryUncompressedSize(zip.files[name]);
  }
  if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new Error('ZIP is too large');

  const data = await readZipJson(zip, 'workspace.json', MAX_JSON_BYTES, budget);
  if (!data) throw new Error('ZIP is missing workspace.json');

  const knowledgeFile = zip.file('knowledge-documents.json');
  let knowledgeStore = null;
  if (knowledgeFile) {
    knowledgeStore = await readZipJson(zip, 'knowledge-documents.json', MAX_JSON_BYTES, budget);
    if (!knowledgeStore || !Array.isArray(knowledgeStore.documents)) {
      throw new Error('Invalid knowledge-documents.json');
    }
    for (const document of knowledgeStore.documents) {
      if (!document || typeof document.id !== 'string' || !['note', 'file'].includes(document.sourceType)) {
        throw new Error('Invalid knowledge document');
      }
      if (typeof document.content !== 'string' || document.content.length > 500000) {
        throw new Error('Knowledge document content is invalid');
      }
      const storedName = document.fileMeta?.storedName;
      if (storedName !== undefined && (!storedName || path.basename(storedName) !== storedName)) {
        throw new Error('Invalid knowledge file reference');
      }
      if (storedName) {
        const binary = zip.file(`knowledge-files/${storedName}`);
        if (!binary) throw new Error('Knowledge file attachment is missing');
        if (entryUncompressedSize(binary) > MAX_BINARY_BYTES) throw new Error('Knowledge file is too large');
        const bytes = await readEntryBuffer(binary, `knowledge-files/${storedName}`, MAX_BINARY_BYTES, budget);
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        if (document.fileMeta.sha256 && document.fileMeta.sha256 !== hash) throw new Error('Knowledge file checksum mismatch');
        if (document.fileMeta.bytes !== undefined && Number(document.fileMeta.bytes) !== bytes.length) throw new Error('Knowledge file size mismatch');
      }
    }
  }

  const agentJson = {};
  for (const name of ['agent-sessions.json', 'agent-runs.json', 'agent-memories.json']) {
    const entry = zip.file(name);
    if (entry) {
      const parsed = await readZipJson(zip, name, MAX_JSON_BYTES, budget);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid ${name}`);
      agentJson[name] = parsed;
    }
  }

  backupDataDir(db.dataDir);
  if (!closeAccountDatabase(db.dataDir)) {
    throw new Error('Failed to close the account database before restore');
  }

  const scheduleEntry = zip.file(ACCOUNT_DB_NAME);
  if (scheduleEntry) {
    const dbBytes = await readEntryBuffer(scheduleEntry, ACCOUNT_DB_NAME, MAX_BINARY_BYTES * 4, budget);
    const dbPath = accountDbPath(db.dataDir);
    // Replace atomically and drop stale WAL/SHM sidecars so the freshly
    // written database cannot be replayed into by the old log file.
    const tmpPath = `${dbPath}.restore-tmp`;
    try {
      fs.writeFileSync(tmpPath, dbBytes);
      for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* not present */ }
      }
      fs.renameSync(tmpPath, dbPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  if (typeof db.reopen === 'function') db.reopen();
  else {
    db.resetCache();
    openAccountDatabase(db.dataDir);
  }

  // A replace-mode workspace exported by current versions already contains the
  // complete SQLite account database. Replaying workspace.json after installing
  // that database is both redundant and unsafe: the JSON compatibility shape
  // can lag behind native SQLite category structures (for example nested diary
  // subcategories), causing the restore to abort before attachments are copied.
  const result = scheduleEntry && mode === 'replace'
    ? { success: true, format: 'sqlite', includesBinaries: false }
    : db.restore(data, mode);
  if (result.error) return result;
  const secretsReset = scheduleEntry && mode === 'replace'
    ? resetUnusableAiSecrets(db)
    : false;

  async function extractDir(prefix, dest) {
    const files = Object.keys(zip.files).filter(name => name.startsWith(prefix) && !zip.files[name].dir);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of files) {
      const rel = name.slice(prefix.length).replace(/^\/+/, '');
      if (!rel || rel.includes('..')) continue;
      const target = path.resolve(dest, rel);
      if (!target.startsWith(path.resolve(dest) + path.sep) && target !== path.resolve(dest)) continue;
      if (entryUncompressedSize(zip.files[name]) > MAX_BINARY_BYTES) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await readEntryBuffer(zip.files[name], name, MAX_BINARY_BYTES, budget));
    }
  }

  await extractDir('uploads/', path.join(db.dataDir, 'uploads'));
  await extractDir('knowledge-files/', path.join(db.dataDir, 'knowledge-files'));
  await extractDir('agent-assets/', path.join(db.dataDir, 'agent-assets'));

  if (!scheduleEntry) {
    if (knowledgeStore) atomicWriteJson(path.join(db.dataDir, 'knowledge-documents.json'), knowledgeStore);
    for (const [name, parsed] of Object.entries(agentJson)) {
      atomicWriteJson(path.join(db.dataDir, name), parsed);
    }
    if (!closeAccountDatabase(db.dataDir)) {
      throw new Error('Failed to close the account database before rebuild');
    }
    fs.unlinkSync(accountDbPath(db.dataDir));
    importJsonAccount(db.dataDir, openAccountDatabase(db.dataDir));
    if (typeof db.reopen === 'function') db.reopen();
  }

  return { ...result, format: 'workspace-zip', includesBinaries: true, secretsReset };
}

module.exports = { exportWorkspace, restoreWorkspace };
