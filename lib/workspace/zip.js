const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Transform, Writable } = require('node:stream');
const { pipeline, finished } = require('node:stream/promises');
const { once } = require('node:events');
const JSZip = require('jszip');
const yazl = require('yazl');
const yauzl = require('yauzl');
const Database = require('better-sqlite3');
const { atomicWriteJson } = require('../util/json-file');
const { accountDbPath, closeAccountDatabase, openAccountDatabase, ACCOUNT_DB_NAME } = require('../db/connection');
const { importJsonAccount } = require('../db/import-json');
const { hasActiveAgentRuns } = require('../agent/active-runs');
const { createKnowledgeService } = require('../knowledge/documents');
const { createAgentStore } = require('../agent/store');
const { readMeta, parseJson } = require('../db/helpers');

function collectExportTree(root, prefix, entries, budget) {
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    const relative = `${prefix}/${name}`.replace(/\\/g, '/');
    const info = fs.lstatSync(full);
    if (info.isSymbolicLink()) throw new Error('Cannot export symlink attachments');
    if (info.isDirectory()) {
      entries.push({ path: full, name: `${relative}/`, directory: true, size: 0 });
      budget.entries += 1;
      collectExportTree(full, relative, entries, budget);
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MAX_BINARY_BYTES) throw new Error(`${relative} exceeds the 250 MiB file limit`);
    entries.push({ path: full, name: relative, size: info.size, directory: false });
    budget.entries += 1;
    budget.uncompressed += info.size;
  }
}

function addJsonEntry(zip, name, value, budget) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8');
  budget.entries += 1;
  budget.uncompressed += bytes.length;
  zip.addBuffer(bytes, name, { compress: true });
}

async function exportKnowledgeJsonFile(db, destination) {
  const knowledge = createKnowledgeService(db);
  const sqlite = db.sqlite || openAccountDatabase(db.dataDir);
  const nextNoteId = Math.max(1, Number(readMeta(sqlite, 'next_note_id', '1')) || 1);
  const nextFileId = Math.max(1, Number(readMeta(sqlite, 'next_file_id', '1')) || 1);
  const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const complete = finished(output);
  complete.catch(() => {});
  let size = 0;
  const write = async value => {
    const bytes = Buffer.from(value, 'utf8');
    size += bytes.length;
    if (size > MAX_TOTAL_UNCOMPRESSED) throw new Error('ZIP exceeds the 4 GiB uncompressed limit');
    if (!output.write(bytes)) await once(output, 'drain');
  };
  try {
    await write('{"documents":[');
    let first = true;
    for (const row of sqlite.prepare('SELECT body FROM knowledge_documents ORDER BY id').iterate()) {
      let document;
      try { document = JSON.parse(row.body); }
      catch { throw new Error('Cannot export invalid knowledge document JSON'); }
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Cannot export invalid knowledge document');
      await write(`${first ? '' : ','}${JSON.stringify(document)}`);
      first = false;
    }
    await write(`],"nextNoteId":${nextNoteId},"nextFileId":${nextFileId}}`);
    output.end();
    await complete;
    return { path: destination, size };
  } catch (error) {
    output.destroy(error);
    await complete.catch(() => {});
    try { fs.unlinkSync(destination); } catch {}
    throw error;
  } finally {
    knowledge.folderSync.stop();
  }
}

function exportKnowledgeJson(db) {
  const knowledge = createKnowledgeService(db);
  try {
    const sqlite = db.sqlite || openAccountDatabase(db.dataDir);
    return {
      documents: knowledge.nativeDocuments(),
      nextNoteId: Math.max(1, Number(readMeta(sqlite, 'next_note_id', '1')) || 1),
      nextFileId: Math.max(1, Number(readMeta(sqlite, 'next_file_id', '1')) || 1),
    };
  } finally { knowledge.folderSync.stop(); }
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

async function exportWorkspace(db, { fileResult = false } = {}) {
  const sqlite = db.sqlite || openAccountDatabase(db.dataDir);
  const checkpoint = sqlite.pragma('wal_checkpoint(TRUNCATE)');
  if (checkpoint.some(row => row.busy)) throw new Error('Database is busy; retry the export');
  if (fs.statSync(accountDbPath(db.dataDir)).size > MAX_DATABASE_BYTES) throw new Error('schedule.db is too large');
  assertSqliteReadable(accountDbPath(db.dataDir));
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-workspace-export-'));
  const archivePath = path.join(tempDirectory, 'liuxu-workspace.zip');
  try {
    const zip = new yazl.ZipFile();
    const knowledgeRoot = configuredKnowledgeRoot(db.dataDir);
    const manifest = {
      format: 'workspace-zip', includesBinaries: true, storage: 'sqlite',
      knowledgeFolder: { included: Boolean(knowledgeRoot && fs.existsSync(knowledgeRoot)), portable: true },
    };
    const entries = [
      { name: 'workspace.json', value: manifest, json: true },
      { path: accountDbPath(db.dataDir), name: ACCOUNT_DB_NAME, size: fs.statSync(accountDbPath(db.dataDir)).size },
    ];
    const knowledgeJsonPath = path.join(tempDirectory, 'knowledge-documents.json');
    const knowledgeJson = await exportKnowledgeJsonFile(db, knowledgeJsonPath);
    entries.push({ path: knowledgeJson.path, name: 'knowledge-documents.json', size: knowledgeJson.size, jsonFile: true });
    const agentJson = exportAgentJson(db);
    for (const [name, value] of Object.entries(agentJson)) {
      const bytes = Buffer.from(JSON.stringify(value), 'utf8');
      entries.push({ name, value: bytes, json: true, size: bytes.length });
    }
    const budget = { entries: 0, uncompressed: 0 };
    collectExportTree(path.join(db.dataDir, 'uploads'), 'uploads', entries, budget);
    collectExportTree(path.join(db.dataDir, 'knowledge-files'), 'knowledge-files', entries, budget);
    collectExportTree(path.join(db.dataDir, 'agent-assets'), 'agent-assets', entries, budget);
    if (knowledgeRoot && fs.existsSync(knowledgeRoot)) collectExportTree(knowledgeRoot, 'knowledge-folder', entries, budget);
    budget.entries = entries.length;
    budget.uncompressed = 0;
    for (const entry of entries) {
      const size = entry.size || (entry.json ? Buffer.byteLength(JSON.stringify(entry.value), 'utf8') : 0);
      if (size > MAX_BINARY_BYTES && !entry.json && !entry.jsonFile && entry.name !== ACCOUNT_DB_NAME) throw new Error(`${entry.name} exceeds the 250 MiB file limit`);
      budget.uncompressed += size;
    }
    if (budget.entries > MAX_ZIP_ENTRIES) throw new Error('ZIP contains too many entries');
    if (budget.uncompressed > MAX_TOTAL_UNCOMPRESSED) throw new Error('ZIP exceeds the 4 GiB uncompressed limit');
    for (const entry of entries) {
      if (entry.directory) zip.addEmptyDirectory(entry.name.replace(/\/$/, ''));
      else if (entry.json) addJsonEntry(zip, entry.name, entry.value, { entries: 0, uncompressed: 0 });
      else if (entry.jsonFile) zip.addFile(entry.path, entry.name, { compress: true });
      else zip.addFile(entry.path, entry.name, { compress: false });
    }
    zip.end({ forceZip64Format: true });
    let size = 0;
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(size > MAX_ZIP_BYTES ? new Error('ZIP exceeds the 2 GiB compressed limit') : null, chunk);
    } });
    await pipeline(zip.outputStream, limit, fs.createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
    if (fileResult || size > 128 * 1024 * 1024) return { path: archivePath, size, cleanupPath: tempDirectory };
    const buffer = fs.readFileSync(archivePath);
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    return buffer;
  } catch (error) {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DATABASE_BYTES = 120 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20000;
const MAX_TOTAL_UNCOMPRESSED = 4 * 1024 * 1024 * 1024;
const MAX_BINARY_BYTES = 250 * 1024 * 1024;
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

function openZipFile(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip));
  });
}

function streamZipEntry(zip, entry, destination, maxBytes, onBuffer) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (openError, input) => {
      if (openError) return reject(openError);
      let size = 0;
      const chunks = onBuffer ? [] : null;
      if (destination) {
        try { fs.mkdirSync(path.dirname(destination), { recursive: true }); }
        catch (error) { input.destroy(); reject(error); return; }
      }
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > maxBytes) return callback(new Error(`${entry.fileName} exceeds its size limit`));
          if (chunks) chunks.push(Buffer.from(chunk));
          callback(null, chunk);
        },
      });
      const output = destination
        ? fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })
        : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      pipeline(input, counter, output).then(() => {
        if (size !== Number(entry.uncompressedSize)) throw new Error(`ZIP entry size mismatch: ${entry.fileName}`);
        resolve({ size, buffer: chunks ? Buffer.concat(chunks, size) : null });
      }, reject);
    });
  });
}

async function inspectArchiveFile(filePath) {
  const fileSize = fs.statSync(filePath).size;
  if (fileSize > MAX_ZIP_BYTES) throw new Error('ZIP is too large');
  const zip = await openZipFile(filePath);
  const entries = [];
  let declared = 0;
  let hasDatabase = false;
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('entry', entry => {
      const name = String(entry.fileName || '').replace(/\\/g, '/');
      const unixMode = (Number(entry.externalFileAttributes) >>> 16) & 0xf000;
      if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..') || unixMode === 0xa000) {
        zip.close();
        reject(new Error('Unsafe ZIP entry'));
        return;
      }
      entries.push({ ...entry, normalizedName: name });
      declared += Number(entry.uncompressedSize) || 0;
      if (name === ACCOUNT_DB_NAME) hasDatabase = true;
      if (entries.length > MAX_ZIP_ENTRIES || declared > MAX_TOTAL_UNCOMPRESSED) {
        zip.close();
        reject(new Error(entries.length > MAX_ZIP_ENTRIES ? 'ZIP contains too many entries' : 'ZIP exceeds the 4 GiB uncompressed limit'));
        return;
      }
      zip.readEntry();
    });
    zip.on('end', resolve);
    zip.readEntry();
  });
  if (!entries.some(entry => entry.normalizedName === 'workspace.json')) throw new Error('ZIP is missing workspace.json');
  zip.close();

  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-zip-inspect-'));
  const result = { database: null, databasePath: '', data: null, json: {}, binaries: new Map(), knowledgeFolder: new Map(), knowledgeDirectories: [], archiveDir };
  const reader = await openZipFile(filePath);
  let actualTotal = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reader.close();
      reject(error);
    };
    reader.on('error', fail);
    reader.on('end', () => { if (!settled) { settled = true; resolve(); } });
    reader.on('entry', async entry => {
      const name = String(entry.fileName || '').replace(/\\/g, '/');
      if (entry.fileName.endsWith('/')) {
        if (name.startsWith('knowledge-folder/')) result.knowledgeDirectories.push(name.slice('knowledge-folder/'.length).replace(/\/$/, ''));
        reader.readEntry();
        return;
      }
      const isNativeDatabase = name === ACCOUNT_DB_NAME;
      const isWorkspace = name === 'workspace.json';
      const parseWorkspace = isWorkspace && !hasDatabase;
      const isLegacyJson = !hasDatabase && ['knowledge-documents.json', 'agent-sessions.json', 'agent-runs.json', 'agent-memories.json'].includes(name);
      const binaryAttachment = /^(uploads|knowledge-files|agent-assets)\//.test(name);
      const folderEntry = name.startsWith('knowledge-folder/');
      const selected = isNativeDatabase || parseWorkspace || isLegacyJson || binaryAttachment || folderEntry;
      const maxEntry = isNativeDatabase ? MAX_DATABASE_BYTES
        : parseWorkspace || isLegacyJson ? MAX_JSON_BYTES
          : selected ? MAX_BINARY_BYTES : MAX_TOTAL_UNCOMPRESSED;
      if ((Number(entry.uncompressedSize) || 0) > maxEntry) return fail(new Error(`${name} exceeds its size limit`));
      const destination = selected && !parseWorkspace && !isLegacyJson
        ? path.join(archiveDir, ...name.split('/')) : '';
      try {
        const parsed = await streamZipEntry(reader, entry, destination, maxEntry, parseWorkspace || isLegacyJson);
        actualTotal += parsed.size;
        if (actualTotal > MAX_TOTAL_UNCOMPRESSED) return fail(new Error('ZIP exceeds the 4 GiB uncompressed limit'));
        if (isNativeDatabase) result.databasePath = destination;
        else if (parseWorkspace) result.data = JSON.parse(parsed.buffer.toString('utf8'));
        else if (isLegacyJson) {
          const value = JSON.parse(parsed.buffer.toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(new Error(`Invalid ${name}`));
          result.json[name] = value;
        } else if (binaryAttachment) result.binaries.set(name, destination);
        else if (folderEntry) result.knowledgeFolder.set(name.slice('knowledge-folder/'.length), destination);
        reader.readEntry();
      } catch (error) { fail(error); }
    });
    reader.readEntry();
  }).catch(error => { fs.rmSync(archiveDir, { recursive: true, force: true }); throw error; });
  if (hasDatabase && !result.data) result.data = {};
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
    fs.rmSync(archiveDir, { recursive: true, force: true });
    throw new Error('Invalid workspace.json');
  }
  if (!hasDatabase) {
    for (const [name, field] of [['knowledge-documents.json', 'documents'], ['agent-sessions.json', 'sessions'], ['agent-runs.json', 'runs'], ['agent-memories.json', 'items']]) {
      if (result.json[name] && !Array.isArray(result.json[name][field])) {
        fs.rmSync(archiveDir, { recursive: true, force: true });
        throw new Error(`Invalid ${name}`);
      }
    }
  }
  return result;
}

// Inspect everything before touching live state. SQLite is authoritative when present;
// compatibility JSON is only parsed for legacy archives.
async function inspectArchive(buffer) {
  if (typeof buffer === 'string') return inspectArchiveFile(buffer);
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
  const knowledgeFolder = new Map();
  const knowledgeDirectories = [];
  for (const name of names) {
    if (zip.files[name].dir) {
      const relativeDirectory = name.startsWith('knowledge-folder/')
        ? name.slice('knowledge-folder/'.length).replace(/\/$/, '') : '';
      if (relativeDirectory) knowledgeDirectories.push(relativeDirectory);
      continue;
    }
    if (/^(uploads|knowledge-files|agent-assets)\//.test(name)) {
      binaries.set(name, await readEntryBuffer(zip.files[name], name, MAX_BINARY_BYTES, budget));
    } else if (name.startsWith('knowledge-folder/')) {
      knowledgeFolder.set(name.slice('knowledge-folder/'.length), await readEntryBuffer(zip.files[name], name, MAX_BINARY_BYTES, budget));
    }
  }
  return { database, data, json, binaries, knowledgeFolder, knowledgeDirectories };
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function validateKnowledgeAttachments(documents, binaries) {
  for (const doc of documents) {
    if (!doc || typeof doc.id !== 'string' || !['note', 'file'].includes(doc.sourceType)
      || typeof doc.content !== 'string' || doc.content.length > 500000) throw new Error('Invalid knowledge document');
    const name = doc.fileMeta?.storedName;
    if (name === undefined) continue;
    if (!name || path.basename(name) !== name || /[\\/]/.test(name)) throw new Error('Invalid knowledge file reference');
    const bytes = binaries.get(`knowledge-files/${name}`);
    if (!bytes) throw new Error('Knowledge file attachment is missing');
    const filePath = typeof bytes === 'string' ? bytes : '';
    const size = filePath ? fs.statSync(filePath).size : bytes.length;
    const digest = filePath ? await hashFile(filePath) : crypto.createHash('sha256').update(bytes).digest('hex');
    if (doc.fileMeta.sha256 && digest !== doc.fileMeta.sha256) throw new Error('Knowledge file checksum mismatch');
    if (doc.fileMeta.bytes !== undefined && Number(doc.fileMeta.bytes) !== size) throw new Error('Knowledge file size mismatch');
  }
}

function configuredKnowledgeRoot(dataDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, '.knowledge-folder.json'), 'utf8'));
    if (config?.enabled !== true || typeof config.rootPath !== 'string' || !path.isAbsolute(config.rootPath)) return '';
    return path.resolve(config.rootPath);
  } catch { return ''; }
}

function safeKnowledgeTarget(root, relative) {
  const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe knowledge folder entry');
  const target = path.resolve(root, ...normalized.split('/'));
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Unsafe knowledge folder entry');
  return target;
}

function writeKnowledgeFolderTree(root, archive, { merge = false } = {}) {
  if (!root || (!archive.knowledgeFolder.size && !archive.knowledgeDirectories.length)) return null;
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('Knowledge folder cannot be a symlink');
  if (merge) {
    fs.mkdirSync(root, { recursive: true });
    for (const relative of archive.knowledgeDirectories) fs.mkdirSync(safeKnowledgeTarget(root, relative), { recursive: true });
    for (const [relative, bytes] of archive.knowledgeFolder) {
      if (relative === '.liuxu/manifest.json' || relative === '.liuxu/journal.json') continue;
      const target = safeKnowledgeTarget(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) {
        if (typeof bytes === 'string') fs.copyFileSync(bytes, target);
        else fs.writeFileSync(target, bytes);
      }
    }
    return { mode: 'merge', backupPath: '' };
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(root), `.${path.basename(root)}.restore-`));
  try {
    for (const relative of archive.knowledgeDirectories) fs.mkdirSync(safeKnowledgeTarget(staging, relative), { recursive: true });
    for (const [relative, bytes] of archive.knowledgeFolder) {
      const target = safeKnowledgeTarget(staging, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (typeof bytes === 'string') fs.copyFileSync(bytes, target);
      else fs.writeFileSync(target, bytes);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${root}.restore-bak-${stamp}`;
    if (fs.existsSync(root)) fs.renameSync(root, backupPath);
    try {
      fs.renameSync(staging, root);
    } catch (error) {
      if (fs.existsSync(backupPath) && !fs.existsSync(root)) fs.renameSync(backupPath, root);
      throw error;
    }
    return { mode: 'replace', backupPath };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function rollbackKnowledgeFolder(root, installation) {
  if (!root || !installation || installation.mode !== 'replace') return;
  fs.rmSync(root, { recursive: true, force: true });
  if (installation.backupPath && fs.existsSync(installation.backupPath)) fs.renameSync(installation.backupPath, root);
}

async function restoreWorkspace(db, input, mode = 'replace') {
  const archive = await inspectArchive(input);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-restore-'));
  let staged;
  try {
    const stagedPath = accountDbPath(staging);
    if (archive.database || archive.databasePath) {
      if (archive.databasePath) fs.copyFileSync(archive.databasePath, stagedPath);
      else fs.writeFileSync(stagedPath, archive.database);
      assertSqliteReadable(stagedPath);
    }
    const { createDatabase } = require('../../database');
    staged = createDatabase(staging, { secretScope: db.dataDir });
    if (!archive.database && !archive.databasePath) {
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
    await validateKnowledgeAttachments(knowledgeStore.documents, archive.binaries);
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
    const knowledgeRoot = configuredKnowledgeRoot(db.dataDir);
    let knowledgeFolderInstallation = null;
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
        if (typeof bytes === 'string') fs.copyFileSync(bytes, target);
        else fs.writeFileSync(target, bytes);
      }
      if (knowledgeRoot && (archive.knowledgeFolder.size || archive.knowledgeDirectories.length)) {
        knowledgeFolderInstallation = writeKnowledgeFolderTree(knowledgeRoot, archive, { merge: mode === 'merge' });
      }
    } catch (error) {
      rollbackKnowledgeFolder(knowledgeRoot, knowledgeFolderInstallation);
      closeAccountDatabase(db.dataDir);
      for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(accountDbPath(db.dataDir) + suffix); } catch {} }
      rollbackDataDir(db.dataDir);
      reopenAccount(db);
      throw error;
    } finally {
      require('../knowledge/routes').invalidateKnowledgeCache(db.dataDir);
      require('../agent/routes').invalidateAgentRuntime(db.dataDir);
    }
    return {
      ...result,
      format: 'workspace-zip',
      includesBinaries: true,
      secretsReset,
      knowledgeFolderRestored: Boolean(knowledgeFolderInstallation),
      knowledgeFolderBackupPath: knowledgeFolderInstallation?.backupPath || '',
    };
  } finally {
    staged?.close();
    closeAccountDatabase(staging);
    fs.rmSync(staging, { recursive: true, force: true });
    if (archive?.archiveDir) fs.rmSync(archive.archiveDir, { recursive: true, force: true });
  }
}

module.exports = { exportWorkspace, restoreWorkspace, MAX_ZIP_BYTES, inspectArchive };
