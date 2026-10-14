const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson } = require('../util/json-file');
const { SyncWorker } = require('./sync-worker-client');
const { performance } = require('node:perf_hooks');

const CONFIG_NAME = '.knowledge-folder.json';
const INTERNAL_DIR = '.liuxu';
const ARCHIVE_DIR = '.archive';
const MANIFEST_NAME = 'manifest.json';
const DELTAS_NAME = 'manifest-deltas.jsonl';
const JOURNAL_NAME = 'journal.json';
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const NOTE_EXT = '.md';
const { EBOOK_TYPES, IMAGE_TYPES, TEXT_TYPES, OFFICE_TYPES, MEDIA_TYPES, ALL_TYPES } = require('./file-formats');
const DEFAULT_SYNC_EXTENSIONS = Object.freeze(Object.keys({ ...EBOOK_TYPES, ...IMAGE_TYPES, ...TEXT_TYPES, ...OFFICE_TYPES, ...MEDIA_TYPES }).sort());

function normalizeSyncExtensions(value) {
  if (value === undefined) return [...DEFAULT_SYNC_EXTENSIONS];
  if (!Array.isArray(value) || value.length > 200) throw new Error('同步后缀必须为列表');
  const extensions = value.map(ext => String(ext).trim().toLowerCase());
  if (extensions.some(ext => !ALL_TYPES[ext])) throw new Error('同步后缀包含不支持的格式');
  // Native notes always remain synchronized; this setting filters attachments.
  return [...new Set(['.md', ...extensions])].sort();
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function nowIso() { return new Date().toISOString(); }

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function defaultRootPath() {
  const explicit = String(process.env.LIUXU_KNOWLEDGE_ROOT || '').trim();
  if (explicit) return path.resolve(explicit);
  const desktopDocuments = String(process.env.LIUXU_DOCUMENTS_DIR || '').trim();
  if (desktopDocuments) return path.join(path.resolve(desktopDocuments), '留序知识库');
  return path.join(os.homedir(), 'Documents', '留序知识库');
}

function sanitizeSegment(value, fallback = '未命名') {
  let text = String(value || '').normalize('NFC').trim()
    .replace(/[\x00-\x1f\\/:*?"<>|]/g, '＿')
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  if (!text) text = fallback;
  if (WINDOWS_RESERVED.test(text)) text = `_${text}`;
  return text;
}

function safeRelative(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) return '';
  if (normalized.split('/').some(part => part === INTERNAL_DIR)) return '';
  return normalized;
}

// The last component can be an ordinary file named *.app; only directories
// and their descendants are excluded from folder synchronization.
function isExcludedSyncPath(value, directory = false) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return (directory ? parts : parts.slice(0, -1)).some(part => /\.app$/i.test(part));
}

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

function isInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

function ensureSafeDirectory(root, directory) {
  if (!isInside(root, directory)) throw new Error('知识库路径越界');
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('知识库根目录不能经过符号链接');
  let current = path.resolve(directory);
  const stop = path.resolve(root);
  while (current !== stop) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('知识库目录不能经过符号链接');
    current = path.dirname(current);
  }
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

function assertSafeExistingPath(root, target) {
  if (!isInside(root, target)) throw new Error('知识库路径越界');
  let current = path.resolve(target);
  const stop = path.resolve(root);
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('知识库路径不能经过符号链接');
    if (current === stop) break;
    current = path.dirname(current);
  }
}

function atomicWriteFile(root, target, bytes) {
  ensureSafeDirectory(root, path.dirname(target));
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('拒绝写入符号链接');
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.liuxu-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(temporary, bytes);
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    if (process.platform !== 'win32' || !fs.existsSync(target)) throw error;
    const previous = `${target}.liuxu-previous-${process.pid}-${Date.now()}`;
    fs.renameSync(target, previous);
    try {
      fs.renameSync(temporary, target);
      fs.unlinkSync(previous);
    } catch (replaceError) {
      if (!fs.existsSync(target) && fs.existsSync(previous)) fs.renameSync(previous, target);
      throw replaceError;
    }
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}

function frontMatterValue(value) {
  return JSON.stringify(value == null ? '' : value);
}

function serializeMarkdown(document) {
  const lines = [
    '---',
    `liuxu_id: ${frontMatterValue(document.id)}`,
    `title: ${frontMatterValue(document.title || '')}`,
    `date: ${frontMatterValue(document.documentDate || '')}`,
    `tags: ${frontMatterValue(Array.isArray(document.tags) ? document.tags : [])}`,
  ];
  if (document.parentDocumentId) lines.push(`parent_document_id: ${frontMatterValue(document.parentDocumentId)}`);
  if (document.documentRole && document.documentRole !== 'normal') lines.push(`document_role: ${frontMatterValue(document.documentRole)}`);
  lines.push('---', '', String(document.content || ''));
  return lines.join('\n');
}

function parseFrontMatter(source, fallbackTitle = '') {
  const text = String(source || '').replace(/^\uFEFF/, '');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { metadata: {}, content: text, title: fallbackTitle };
  }
  const normalized = text.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return { metadata: {}, content: text, title: fallbackTitle };
  const metadata = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const split = line.indexOf(':');
    if (split < 1) continue;
    const key = line.slice(0, split).trim();
    const raw = line.slice(split + 1).trim();
    try { metadata[key] = JSON.parse(raw); } catch { metadata[key] = raw; }
  }
  return {
    metadata,
    content: normalized.slice(end + 5).replace(/^\n/, ''),
    title: String(metadata.title || fallbackTitle || ''),
  };
}

function fileFingerprint(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('知识库条目不是文件');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${path.basename(file)} 超过 250 MiB`);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, stat.size)));
  try {
    let offset = 0;
    while (offset < stat.size) {
      const length = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (!length) break;
      hash.update(chunk.subarray(0, length));
      offset += length;
    }
  } finally { fs.closeSync(fd); }
  return { sha256: hash.digest('hex'), size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

function fastFileFingerprint(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('知识库条目不是文件');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${path.basename(file)} 超过 250 MiB`);
  return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

function fingerprintBuffer(buffer, stat) {
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
  };
}

function sameFastFingerprint(left, right) {
  return Boolean(left && right && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs));
}

function sameFingerprint(left, right) {
  return Boolean(left && right && left.sha256 && left.sha256 === right.sha256 && Number(left.size) === Number(right.size));
}

function validManifestDelta(delta) {
  if (!delta || !Number.isSafeInteger(delta.sequence) || delta.sequence < 1) return false;
  if (delta.operation === 'verified') return typeof delta.verifiedAt === 'string';
  if (delta.operation === 'asset') return typeof delta.relativePath === 'string' && safeRelative(delta.relativePath) === delta.relativePath && typeof delta.present === 'boolean';
  if (!/^(note|file):[1-9]\d*$/.test(delta.id)) return false;
  return delta.operation === 'delete' || (delta.operation === 'upsert' && typeof delta.entry?.relativePath === 'string'
    && safeRelative(delta.entry.relativePath) === delta.entry.relativePath);
}

function splitDocumentLocation(relativePath, archived = false) {
  const parts = safeRelative(relativePath).split('/').filter(Boolean);
  if (archived && parts[0] === ARCHIVE_DIR) parts.shift();
  const knowledgeBase = parts.shift() || '其他';
  parts.pop();
  return { knowledgeBase, folderPath: parts.join('/'), collectionPath: [knowledgeBase, ...parts].join('/') };
}

function uniqueRelativePath(root, desired, current = '') {
  const safe = safeRelative(desired);
  if (!safe) throw new Error('无法生成安全的知识库路径');
  const currentLower = String(current || '').toLocaleLowerCase('en-US');
  const ext = path.posix.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = safe;
  let index = 2;
  while (candidate.toLocaleLowerCase('en-US') !== currentLower && fs.existsSync(path.join(root, ...candidate.split('/')))) {
    candidate = `${base} (${index})${ext}`;
    index += 1;
  }
  return candidate;
}

function markdownImageTokens(content) {
  const tokens = [];
  let fenced = false;
  const lines = String(content || '').split('\n');
  lines.forEach((line, lineIndex) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const scanLine = line.replace(/(`+)[\s\S]*?\1/g, match => ' '.repeat(match.length));
    const expression = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    let match;
    while ((match = expression.exec(scanLine))) tokens.push({ lineIndex, raw: match[0], alt: match[1], source: match[2] });
    const htmlExpression = /<img\b[^>]*\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
    while ((match = htmlExpression.exec(scanLine))) {
      const tag = match[0];
      const source = match[1] ?? match[2] ?? match[3] ?? '';
      const alt = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      tokens.push({ lineIndex, raw: tag, alt: alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? 'image', source });
    }
  });
  return { lines, tokens };
}

class KnowledgeFolderSync {
  constructor({ db, adapter, autoStart = true, indexOnly = false }) {
    this.db = db;
    this.adapter = adapter;
    this.autoStart = autoStart;
    this.configPath = path.join(db.dataDir, CONFIG_NAME);
    this.config = this.readConfig();
    if (indexOnly) this.config.enabled = false;
    this.manifest = {};
    this.managedAssets = new Set();
    this.pendingAssets = new Map();
    this.lastDeepVerificationAt = 0;
    this.running = null;
    this.nameOnlySignature = '';
    this.watcher = null;
    this.timer = null;
    this.debounceTimer = null;
    this.maxDebounceTimer = null;
    this.compactTimer = null;
    this.compacting = null;
    this.worker = new SyncWorker();
    this.generation = 0;
    this.pendingPaths = new Set();
    this.forceReconcile = false;
    this.pathIndex = new Map();
    this.knownDirectories = new Set();
    this.assetReferences = new Map();
    this.assetFingerprints = new Map();
    this.dirtyIds = new Set();
    this.pendingOperations = [];
    this.sequence = 0;
    this.deltaCount = 0;
    this.localWriteEpoch = 0;
    this.state = { status: this.config.enabled ? 'idle' : 'disabled', generation: 0, lastSyncAt: '', error: '', report: null };
    if (!indexOnly) this.loadManifest();
    if (this.config.enabled && autoStart) this.start();
  }

  readConfig() {
    const stored = readJson(this.configPath, {});
    return {
      version: 2,
      enabled: stored.enabled === true,
      rootPath: path.resolve(String(stored.rootPath || defaultRootPath())),
      scanIntervalMs: Number(stored.version || 1) < 2 && Number(stored.scanIntervalMs) === 30000
        ? 300000 : Math.max(5000, Number(stored.scanIntervalMs) || 300000),
      syncExtensions: normalizeSyncExtensions(Array.isArray(stored.syncExtensions) && DEFAULT_SYNC_EXTENSIONS.filter(ext => !EBOOK_TYPES[ext]).every(ext => stored.syncExtensions.includes(ext)) ? [...new Set([...stored.syncExtensions, ...Object.keys(EBOOK_TYPES)])] : stored.syncExtensions),
    };
  }

  paths(root = this.config.rootPath) {
    const internal = path.join(root, INTERNAL_DIR);
    return {
      root,
      internal,
      manifest: path.join(internal, MANIFEST_NAME),
      deltas: path.join(internal, DELTAS_NAME),
      operations: path.join(internal, 'operations'),
      journal: path.join(internal, JOURNAL_NAME),
      conflicts: path.join(internal, 'conflicts'),
      trash: path.join(internal, 'trash'),
    };
  }

  loadManifest() {
    this.pendingOperations = [];
    this.pendingAssets.clear(); this.dirtyIds.clear();
    this.assetFingerprints.clear();
    this.knownDirectories.clear();
    if (!this.config.enabled) {
      this.manifest = {}; this.managedAssets.clear(); this.rebuildPathIndexes();
      this.sequence = 0; this.deltaCount = 0; this.lastDeepVerificationAt = 0; this.persistedVerifiedAt = 0;
      return;
    }
    const file = this.paths().manifest;
    if (fs.existsSync(this.config.rootPath)) assertSafeExistingPath(this.config.rootPath, this.config.rootPath);
    if (fs.existsSync(this.paths().internal)) assertSafeExistingPath(this.config.rootPath, this.paths().internal);
    for (const target of [file, this.paths().deltas, this.paths().journal]) {
      if (fs.existsSync(target)) assertSafeExistingPath(this.config.rootPath, target);
    }
    const stored = readJson(file, { documents: {} });
    this.manifest = stored.documents && typeof stored.documents === 'object' ? stored.documents : {};
    this.managedAssets = new Set(Array.isArray(stored.assets) ? stored.assets.map(safeRelative).filter(Boolean) : []);
    this.lastDeepVerificationAt = Date.parse(stored.verifiedAt || '') || 0;
    this.sequence = Number(stored.sequence) || 0;
    this.deltaCount = 0;
    this.dirtyIds.clear();
    const deltaFile = this.paths().deltas;
    if (fs.existsSync(deltaFile)) {
      const text = fs.readFileSync(deltaFile, 'utf8');
      const lastNewline = text.lastIndexOf('\n');
      const complete = text.slice(0, lastNewline + 1);
      try {
        let previous = 0;
        for (const line of complete.split('\n').filter(Boolean)) {
          const delta = JSON.parse(line);
          if (!validManifestDelta(delta) || delta.sequence <= previous) throw new Error('清单增量记录损坏');
          previous = delta.sequence;
          if (delta.sequence <= this.sequence) continue;
          if (delta.sequence !== this.sequence + 1) throw new Error('清单增量记录不连续');
          if (delta.operation === 'upsert') this.manifest[delta.id] = delta.entry;
          else if (delta.operation === 'delete') delete this.manifest[delta.id];
          else if (delta.operation === 'verified') this.lastDeepVerificationAt = Date.parse(delta.verifiedAt) || 0;
          else if (delta.present) this.managedAssets.add(delta.relativePath);
          else this.managedAssets.delete(delta.relativePath);
          this.sequence = delta.sequence;
          this.deltaCount += 1;
        }
        if (this.autoStart && complete.length !== text.length) fs.truncateSync(deltaFile, Buffer.byteLength(complete));
      } catch { this.forceReconcile = true; this.manifestCorrupt = true; }
    }
    this.rebuildPathIndexes();
    this.persistedVerifiedAt = this.lastDeepVerificationAt;
    this.pendingAssets.clear();
    if (this.autoStart && fs.existsSync(this.paths().journal)) this.recoverJournal();
  }

  persistManifest() {
    const paths = this.paths();
    if (this.manifestCorrupt) throw new Error('清单增量记录损坏，需完成目录复核');
    const records = [...this.dirtyIds].map(id => this.manifest[id]
      ? { operation: 'upsert', id, entry: this.manifest[id] } : { operation: 'delete', id });
    if (this.persistedVerifiedAt !== this.lastDeepVerificationAt) records.push({ operation: 'verified', verifiedAt: this.lastDeepVerificationAt ? new Date(this.lastDeepVerificationAt).toISOString() : '' });
    for (const [relativePath, present] of this.pendingAssets) records.push({ operation: 'asset', relativePath, present });
    if (!records.length) return;
    ensureSafeDirectory(paths.root, paths.internal);
    const fd = fs.openSync(paths.deltas, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    const originalSize = fs.fstatSync(fd).size;
    try {
      // A terminated line is the commit boundary; flush before clearing the operation journal.
      const text = records.map((record, offset) => JSON.stringify({ ...record, sequence: this.sequence + offset + 1 })).join('\n') + '\n';
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } catch (error) {
      try { fs.ftruncateSync(fd, originalSize); fs.fsyncSync(fd); } catch {}
      throw error;
    } finally { fs.closeSync(fd); }
    this.sequence += records.length;
    this.deltaCount += records.length;
    this.persistedVerifiedAt = this.lastDeepVerificationAt;
    this.dirtyIds.clear(); this.pendingAssets.clear();
    clearTimeout(this.compactTimer);
    this.compactTimer = setTimeout(() => { void this.compactManifest().catch(error => { this.state.error = error.message; }); }, this.deltaCount >= 100 ? 0 : 2000);
    this.compactTimer.unref?.();
  }

  async compactManifest() {
    if (this.compacting) { await this.compacting; if (!this.deltaCount) return; }
    if (!this.deltaCount || this.pendingOperations.length) return;
    const paths = this.paths();
    const generation = this.generation;
    const temporary = `${paths.manifest}.liuxu-${crypto.randomUUID()}.tmp`;
    const task = this.worker.request('compact', { ...paths, temporary });
    this.compacting = task;
    try {
      const { sequence } = await task;
      if (generation !== this.generation) return;
      // Keep writes that arrived while the worker was serializing its snapshot.
      // No await between the final read and replacement: foreground appends cannot interleave.
      const latest = fs.readFileSync(paths.deltas, 'utf8').split('\n').filter(Boolean)
        .filter(line => JSON.parse(line).sequence > sequence);
      atomicWriteFile(paths.root, paths.deltas, Buffer.from(latest.length ? latest.join('\n') + '\n' : ''));
      this.deltaCount = latest.length;
    } finally {
      await this.stoppingWorker;
      try { assertSafeExistingPath(paths.root, paths.internal); await fs.promises.unlink(temporary); } catch {}
      if (this.compacting === task) this.compacting = null;
    }
  }

  rememberAsset(relative) {
    if (!this.managedAssets.has(relative)) this.pendingAssets.set(relative, true);
    this.managedAssets.add(relative);
  }

  forgetAsset(relative) {
    if (this.managedAssets.delete(relative)) this.pendingAssets.set(relative, false);
  }

  rebuildPathIndexes() {
    this.pathIndex.clear(); this.assetReferences.clear();
    for (const [id, entry] of Object.entries(this.manifest)) this.indexEntry(id, entry);
  }

  indexEntry(id, entry) {
    if (entry?.relativePath) this.pathIndex.set(entry.relativePath.toLocaleLowerCase('en-US'), id);
    let directory = entry?.relativePath ? path.posix.dirname(entry.relativePath) : '';
    while (directory && directory !== '.') {
      this.knownDirectories.add(directory);
      directory = path.posix.dirname(directory);
    }
    for (const asset of entry?.assets || []) {
      const key = asset.toLocaleLowerCase('en-US');
      const refs = this.assetReferences.get(key) || new Set();
      refs.add(id); this.assetReferences.set(key, refs); this.rememberAsset(asset);
    }
  }

  setEntry(id, entry) {
    const previous = this.manifest[id];
    if (previous?.relativePath) this.pathIndex.delete(previous.relativePath.toLocaleLowerCase('en-US'));
    for (const asset of previous?.assets || []) {
      const key = asset.toLocaleLowerCase('en-US');
      const refs = this.assetReferences.get(key); refs?.delete(id);
      if (!refs?.size) this.assetReferences.delete(key);
    }
    if (entry) { this.manifest[id] = entry; this.indexEntry(id, entry); }
    else delete this.manifest[id];
    if (JSON.stringify(previous) !== JSON.stringify(entry)) this.dirtyIds.add(id);
  }

  writeJournal(operation) {
    const paths = this.paths();
    ensureSafeDirectory(paths.root, paths.internal);
    atomicWriteJson(paths.journal, { version: 1, updatedAt: nowIso(), operation });
  }

  beginOperation(document, previous, from, to, expectedSha256 = '') {
    const paths = this.paths();
    ensureSafeDirectory(paths.root, paths.operations);
    const backup = from && fs.existsSync(path.join(paths.root, from)) ? `${crypto.randomUUID()}.bak` : '';
    if (backup) fs.copyFileSync(path.join(paths.root, from), path.join(paths.operations, backup));
    const operation = { documentId: document.id, version: document.version, from, to, backup,
      previousEntry: this.manifest[document.id] || previous?.fileSync || null, expectedSha256, entry: null };
    this.pendingOperations.push(operation);
    this.saveOperationJournal();
    return operation;
  }

  saveOperationJournal() {
    const paths = this.paths();
    ensureSafeDirectory(paths.root, paths.internal);
    atomicWriteJson(paths.journal, { version: 2, operations: this.pendingOperations,
      operation: this.pendingOperations.at(-1) ? { type: 'write', ...this.pendingOperations.at(-1) } : null });
  }

  persistPrepared() {
    if (this.pendingOperations.length) this.persistManifest();
  }

  completePrepared() {
    if (!this.pendingOperations.length) return;
    const operations = this.pendingOperations;
    this.pendingOperations = [];
    this.clearJournal();
    for (const operation of operations) {
      if (operation.backup) { try { fs.unlinkSync(path.join(this.paths().operations, path.basename(operation.backup))); } catch {} }
    }
  }

  rollbackPrepared() {
    if (!this.pendingOperations.length) return;
    const paths = this.paths();
    for (const operation of [...this.pendingOperations].reverse()) {
      const from = safeRelative(operation.from || '');
      const to = safeRelative(operation.to || '');
      const target = to ? path.join(paths.root, to) : '';
      if (target && fs.existsSync(target)) assertSafeExistingPath(paths.root, target);
      if (operation.backup) assertSafeExistingPath(paths.root, path.join(paths.operations, path.basename(operation.backup)));
      const targetHash = target && fs.existsSync(target) ? fileFingerprint(target).sha256 : '';
      const untouched = from === to && targetHash && targetHash === operation.previousEntry?.fingerprint?.sha256;
      if (targetHash && targetHash !== operation.expectedSha256 && !untouched) {
        this.saveDraft(operation.documentId, { rawText: operation.backup ? fs.readFileSync(path.join(paths.operations, path.basename(operation.backup)), 'utf8') : '' }, '事务回滚时发现外部修改');
        throw new Error('同步回滚遇到外部修改，已保留恢复记录');
      }
      if (from && operation.backup) {
        const original = path.join(paths.root, from);
        if (from !== to && fs.existsSync(original)) {
          assertSafeExistingPath(paths.root, original);
          if (fileFingerprint(original).sha256 !== operation.previousEntry?.fingerprint?.sha256) throw new Error('原路径已出现外部文件，拒绝覆盖');
        }
        atomicWriteFile(paths.root, original, fs.readFileSync(path.join(paths.operations, path.basename(operation.backup))));
      }
      if (target && to !== from && fs.existsSync(target)) this.moveToTrash(to, 'transaction-rollback');
      this.setEntry(operation.documentId, operation.previousEntry);
    }
    this.persistManifest();
    this.completePrepared();
  }

  recoverJournal() {
    const journal = readJson(this.paths().journal, {});
    this.forceReconcile = true;
    if (journal.version !== 2 || !Array.isArray(journal.operations)) return;
    if (journal.operations.some(operation => !/^(note|file):\d+$/.test(operation.documentId)
      || (operation.from && safeRelative(operation.from) !== operation.from)
      || (operation.to && safeRelative(operation.to) !== operation.to)
      || (operation.backup && !/^[\da-f-]+\.bak$/i.test(operation.backup)))) {
      this.state.status = 'warning'; this.state.error = '同步恢复记录无效'; return;
    }
    this.pendingOperations = journal.operations;
    const committed = this.pendingOperations.every(operation => {
      const doc = this.adapter.readDocument(operation.documentId);
      return operation.to ? doc && doc.version === operation.version
        && doc.fileSync?.relativePath === operation.to
        && doc.fileSync?.fingerprint?.sha256 === operation.expectedSha256 : !doc;
    });
    try {
      if (committed) {
        for (const operation of this.pendingOperations) this.setEntry(operation.documentId,
          operation.to ? this.adapter.readDocument(operation.documentId).fileSync : null);
        this.persistPrepared(); this.completePrepared();
      } else this.rollbackPrepared();
    } catch (error) { this.state.status = 'warning'; this.state.error = error.message; }
  }

  clearJournal() {
    const file = this.paths().journal;
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* recovered by next scan */ }
  }

  snapshot() {
    return {
      ...this.state,
      enabled: this.config.enabled,
      rootPath: this.config.rootPath,
      defaultRootPath: defaultRootPath(),
      syncExtensions: [...this.config.syncExtensions],
      desktopConfigurable: process.env.LIUXU_DESKTOP === '1',
      pendingJournal: this.config.enabled && fs.existsSync(this.paths().journal),
      drafts: this.listDrafts(),
    };
  }

  configure({ enabled, rootPath, syncExtensions }) {
    const previousRoot = this.config.rootPath;
    const previouslyEnabled = this.config.enabled;
    const extensions = normalizeSyncExtensions(syncExtensions ?? this.config.syncExtensions);
    const nextRoot = path.resolve(String(rootPath || this.config.rootPath || defaultRootPath()));
    if (!path.isAbsolute(nextRoot)) throw new Error('知识库根目录必须是绝对路径');
    if (isInside(nextRoot, this.db.dataDir) || isInside(this.db.dataDir, nextRoot)) throw new Error('知识库根目录不能与应用数据目录互相包含');
    this.stop();
    this.config = { ...this.config, enabled: enabled === true, rootPath: nextRoot, syncExtensions: extensions };
    atomicWriteJson(this.configPath, this.config);
    if (!(previouslyEnabled && !this.config.enabled && nextRoot === previousRoot)) this.loadManifest();
    this.state.status = this.config.enabled ? 'idle' : 'disabled';
    this.state.error = '';
    if (this.config.enabled) this.start();
    return this.snapshot();
  }

  start({ skipInitialSync = false } = {}) {
    if (!this.config.enabled) return;
    this.stop();
    atomicWriteJson(this.configPath, this.config);
    const rootEntries = fs.existsSync(this.config.rootPath)
      ? fs.readdirSync(this.config.rootPath).filter(name => name !== INTERNAL_DIR)
      : [];
    if (!Object.keys(this.manifest).length && this.adapter.listDocuments().length && !rootEntries.length) {
      this.state.status = 'needs_migration';
      this.state.error = '现有知识尚未迁移到本地文件夹';
      return;
    }
    this.timer = setInterval(() => this.syncNow({ reason: 'interval' }).catch(() => {}), this.config.scanIntervalMs);
    this.timer.unref?.();
    if (!skipInitialSync) {
      const generation = this.generation;
      const begin = () => { if (generation === this.generation && this.config.enabled) return this.syncNow({ reason: 'startup' }).catch(() => {}); };
      if (this.running) void this.running.catch(() => {}).then(begin);
      else void begin();
    }
    this.restartWatcher();
  }

  restartWatcher() {
    if (this.watcher) return;
    if (!this.config.enabled || !fs.existsSync(this.config.rootPath)) return;
    try {
      this.watcher = fs.watch(this.config.rootPath, { recursive: true }, (_event, filename) => {
        const relative = String(filename || '').replace(/\\/g, '/');
        if (!relative) { this.enqueuePath(null); return; }
        if (relative === INTERNAL_DIR || relative.startsWith(`${INTERNAL_DIR}/`) || relative.includes('.liuxu-')) return;
        let directory = false;
        if (/\.app$/i.test(relative)) {
          try { directory = fs.lstatSync(path.join(this.config.rootPath, relative)).isDirectory(); }
          catch { directory = true; } // A removed bundle has no stat to inspect.
        }
        if (isExcludedSyncPath(relative, directory)) return;
        this.enqueuePath(relative);
      });
      this.watcher.on('error', error => {
        this.state.status = 'error';
        this.state.error = error.message;
        try { this.watcher?.close(); } catch {}
        this.watcher = null;
        this.watchRetryAt = Date.now() + this.config.scanIntervalMs;
        this.enqueuePath(null);
      });
    } catch { this.watchRetryAt = Date.now() + this.config.scanIntervalMs; /* periodic scan remains active */ }
  }

  stop() {
    this.generation += 1;
    clearInterval(this.timer); this.timer = null;
    clearTimeout(this.debounceTimer); this.debounceTimer = null;
    clearTimeout(this.maxDebounceTimer); this.maxDebounceTimer = null;
    clearTimeout(this.compactTimer); this.compactTimer = null;
    this.pendingPaths.clear();
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
    this.stoppingWorker = this.worker.stop();
    return this.stoppingWorker;
  }

  async shutdown() {
    const running = this.running;
    await this.stop();
    await running?.catch(() => {});
    await this.compacting?.catch(() => {});
    this.compacting = null;
    this.persistManifest();
    clearTimeout(this.compactTimer); this.compactTimer = null;
    await this.compactManifest();
    await this.worker.stop();
  }

  enqueuePath(relative) {
    const safe = relative && safeRelative(relative);
    if (!safe || this.pendingPaths.size >= 1000) { this.forceReconcile = true; this.pendingPaths.clear(); }
    else this.pendingPaths.add(safe);
    const run = () => {
      clearTimeout(this.debounceTimer); this.debounceTimer = null;
      clearTimeout(this.maxDebounceTimer); this.maxDebounceTimer = null;
      void this.syncNow({ reason: 'watch' }).catch(() => {});
    };
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(run, 650); this.debounceTimer.unref?.();
    if (!this.maxDebounceTimer) { this.maxDebounceTimer = setTimeout(run, 2000); this.maxDebounceTimer.unref?.(); }
  }

  ensureRoot({ requireEmpty = false } = {}) {
    const root = this.config.rootPath;
    if (fs.existsSync(root)) {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('知识库根目录无效或为符号链接');
      if (requireEmpty && fs.readdirSync(root).length) throw new Error('目标知识库目录不是空目录');
    } else {
      fs.mkdirSync(root, { recursive: true });
    }
    ensureSafeDirectory(root, this.paths().internal);
    return root;
  }

  directoryFor(document) {
    const segments = [sanitizeSegment(document.knowledgeBase || '其他')]
      .concat(String(document.folderPath || '').split('/').filter(Boolean).map(value => sanitizeSegment(value)));
    if (document.status === 'archived') segments.unshift(ARCHIVE_DIR);
    return segments.join('/');
  }

  desiredRelativePath(document, previousEntry = null) {
    const directory = this.directoryFor(document);
    if (document.sourceType === 'file') {
      const filename = sanitizeSegment(document.fileMeta?.filename || document.title || '档案');
      return uniqueRelativePath(this.config.rootPath, `${directory}/${filename}`, previousEntry?.relativePath);
    }
    const suffix = document.documentRole === 'annotation' ? ' 留序批注' : '';
    const filename = `${sanitizeSegment(document.title || '未命名笔记')}${suffix}${NOTE_EXT}`;
    return uniqueRelativePath(this.config.rootPath, `${directory}/${filename}`, previousEntry?.relativePath);
  }

  copyLegacyImages(document, content, targetDirectory, oldDocumentPath = '') {
    const parsed = markdownImageTokens(content);
    for (const token of parsed.tokens) {
      let legacyName = '';
      let relativeSource = '';
      try {
        const source = decodeURIComponent(token.source);
        const match = source.match(/^(?:https?:\/\/[^/]+)?\/uploads\/([^/?#]+)(?:[?#].*)?$/i);
        if (match) legacyName = path.basename(match[1]);
        else if (oldDocumentPath && !/^(?:https?:|data:|\/)/i.test(source)) {
          const candidate = path.resolve(path.dirname(oldDocumentPath), source.split(/[?#]/)[0]);
          if (isInside(this.config.rootPath, candidate)) relativeSource = candidate;
        }
      } catch { /* invalid URL remains unchanged */ }
      const legacyPath = legacyName ? path.join(this.db.dataDir, 'uploads', legacyName) : relativeSource;
      if (!legacyPath || !fs.existsSync(legacyPath) || fs.lstatSync(legacyPath).isSymbolicLink()) continue;
      const destinationName = sanitizeSegment(path.basename(legacyPath), 'image');
      const destination = path.join(targetDirectory, destinationName);
      if (path.resolve(destination) !== path.resolve(legacyPath) && !fs.existsSync(destination)) fs.copyFileSync(legacyPath, destination);
      this.rememberAsset(path.relative(this.config.rootPath, destination).replace(/\\/g, '/'));
      const imageSource = `./${encodeURI(destinationName)}`;
      const replacement = /^<img\b/i.test(token.raw)
        ? token.raw.replace(/(\ssrc\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i, (_match, prefix) => `${prefix}"${imageSource.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
        : `![${token.alt}](${imageSource})`;
      parsed.lines[token.lineIndex] = parsed.lines[token.lineIndex].replace(token.raw, replacement);
    }
    return parsed.lines.join('\n');
  }

  copyMovedImageDependencies(content, documentPath, previousRelativePath = '') {
    const previousRelative = safeRelative(previousRelativePath);
    if (!previousRelative) return;
    const root = this.config.rootPath;
    const previousDirectory = path.dirname(path.join(root, ...previousRelative.split('/')));
    const targetDirectory = path.dirname(documentPath);
    if (path.resolve(previousDirectory) === path.resolve(targetDirectory)) return;
    const { tokens } = markdownImageTokens(content);
    for (const token of tokens) {
      let requested;
      try { requested = decodeURIComponent(token.source.split(/[?#]/)[0]); } catch { continue; }
      if (!requested || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(requested)) continue;
      const source = path.resolve(previousDirectory, requested);
      const target = path.resolve(targetDirectory, requested);
      if (!isInside(root, source) || !isInside(root, target) || fs.existsSync(target) || !fs.existsSync(source)) continue;
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      ensureSafeDirectory(root, path.dirname(target));
      fs.copyFileSync(source, target);
      this.rememberAsset(path.relative(root, target).replace(/\\/g, '/'));
    }
  }

  prepareWrite(document, previous = null) {
    if (!this.config.enabled) return document;
    this.localWriteEpoch += 1;
    const root = this.ensureRoot();
    const oldEntry = this.manifest[document.id] || previous?.fileSync || null;
    const oldRelative = safeRelative(oldEntry?.relativePath || '');
    if (oldRelative) {
      const oldPath = path.join(root, ...oldRelative.split('/'));
      if (fs.existsSync(oldPath)) {
        assertSafeExistingPath(root, oldPath);
        const actual = fileFingerprint(oldPath);
        const known = oldEntry?.fingerprint;
        if (known && !sameFingerprint(actual, known)) {
          this.saveDraft(document.id, document, '应用保存遇到外部修改');
          const error = new Error('本地文件已更新，当前草稿已保留');
          error.code = 'FILE_SYNC_CONFLICT';
          throw error;
        }
      }
    }
    const relativePath = this.desiredRelativePath(document, oldEntry);
    const target = path.join(root, ...relativePath.split('/'));
    const oldDocumentPath = oldRelative ? path.join(root, ...oldRelative.split('/')) : '';
    let nextDocument = { ...document };
    let bytes;
    if (document.sourceType === 'note') {
      ensureSafeDirectory(root, path.dirname(target));
      nextDocument.content = this.copyLegacyImages(document, document.content, path.dirname(target), oldDocumentPath);
      bytes = Buffer.from(serializeMarkdown(nextDocument), 'utf8');
    } else {
      const source = this.adapter.sourceFilePath(document);
      if (!source || !fs.existsSync(source)) throw new Error('原始档案不存在，无法同步到知识库目录');
      bytes = fs.readFileSync(source);
    }
    const operation = this.beginOperation(document, previous, oldRelative, relativePath, sha256(bytes));
    atomicWriteFile(root, target, bytes);
    if (oldRelative && oldRelative !== relativePath) this.moveToTrash(oldRelative, 'moved');
    const fingerprint = fingerprintBuffer(bytes, fs.statSync(target));
    const entry = {
      relativePath,
      fingerprint,
      sourceType: document.sourceType,
      parentDocumentId: document.parentDocumentId || null,
      ...(document.sourceType === 'note' ? { assets: this.imageDependencies(nextDocument.content, target) } : {}),
    };
    operation.entry = entry;
    this.setEntry(document.id, entry);
    // The initial journal already durably identifies the old bytes and expected
    // new hash. After commit, SQLite supplies the complete entry during recovery.
    return { ...nextDocument, fileSync: entry };
  }

  imageDependencies(content, file) {
    const result = new Set();
    for (const token of markdownImageTokens(content).tokens) {
      try {
        const source = decodeURIComponent(token.source.split(/[?#]/)[0]);
        if (!source || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(source)) continue;
        const absolute = path.resolve(path.dirname(file), source);
        if (isInside(this.config.rootPath, absolute)) result.add(path.relative(this.config.rootPath, absolute).replace(/\\/g, '/'));
      } catch {}
    }
    return [...result];
  }

  removeDocument(document) {
    if (!this.config.enabled || !document?.id) return;
    const entry = this.manifest[document.id] || document.fileSync;
    this.beginOperation(document, document, entry?.relativePath || '', '');
    if (entry?.relativePath) this.moveToTrash(entry.relativePath, 'deleted');
    this.setEntry(document.id, null);
  }

  moveToTrash(relativePath, reason) {
    const safe = safeRelative(relativePath);
    if (!safe) return;
    const root = this.config.rootPath;
    const source = path.join(root, ...safe.split('/'));
    if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink()) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.paths().trash, `${stamp}-${reason}`, ...safe.split('/'));
    ensureSafeDirectory(root, path.dirname(target));
    fs.renameSync(source, target);
  }

  localPathFor(document) {
    if (!this.config.enabled) return null;
    const relative = safeRelative(this.manifest[document?.id]?.relativePath || document?.fileSync?.relativePath || '');
    if (!relative) return null;
    const target = path.join(this.config.rootPath, ...relative.split('/'));
    return isInside(this.config.rootPath, target) ? target : null;
  }

  resolveAsset(document, requested) {
    const documentPath = this.localPathFor(document);
    if (!documentPath || !requested) return null;
    let decoded;
    try { decoded = decodeURIComponent(String(requested)); } catch { return null; }
    if (!decoded || path.isAbsolute(decoded) || decoded.includes('\0')) return null;
    const target = path.resolve(path.dirname(documentPath), decoded);
    if (!isInside(this.config.rootPath, target) || !fs.existsSync(target)) return null;
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    let realRoot;
    let realTarget;
    try {
      realRoot = fs.realpathSync(this.config.rootPath);
      realTarget = fs.realpathSync(target);
    } catch { return null; }
    return isInside(realRoot, realTarget) ? realTarget : null;
  }

  scanFiles() {
    const root = this.config.rootPath;
    const files = [];
    const directories = [];
    const nameOnlyEntries = [];
    const visit = (directory, relative = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === INTERNAL_DIR || (entry.name.startsWith('.') && entry.name !== ARCHIVE_DIR)) continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (isExcludedSyncPath(childRelative, true)) {
            nameOnlyEntries.push({ name: entry.name, relativePath: childRelative, isDirectory: true });
            continue;
          }
          directories.push(childRelative);
          visit(full, childRelative);
        } else if (entry.isFile() && !entry.name.includes('.liuxu-') && entry.name !== '.DS_Store'
          && !entry.name.endsWith('~') && !/\.(?:tmp|swp|swo|part)$/i.test(entry.name)) {
          if (this.config.syncExtensions.includes(path.extname(entry.name).toLowerCase())) {
            files.push({ relativePath: childRelative, fullPath: full, archived: childRelative.startsWith(`${ARCHIVE_DIR}/`) });
          } else {
            nameOnlyEntries.push({ name: entry.name, relativePath: childRelative, isDirectory: false });
          }
        }
      }
    };
    visit(root);
    return { files, directories, nameOnlyEntries };
  }

  async scanFilesAsync({ paths = null } = {}) {
    const root = this.config.rootPath;
    const files = [], directories = [], nameOnlyEntries = [];
    const deletionScopes = new Set();
    let visited = 0;
    const inspect = async (relative, entry) => {
      if (++visited % 200 === 0) await yieldToEventLoop();
      const name = path.posix.basename(relative);
      if (name === INTERNAL_DIR || (name.startsWith('.') && name !== ARCHIVE_DIR) || entry.isSymbolicLink()) return;
      const full = path.join(root, ...relative.split('/'));
      if (entry.isDirectory()) {
        if (isExcludedSyncPath(relative, true)) { nameOnlyEntries.push({ name, relativePath: relative, isDirectory: true }); return; }
        directories.push(relative);
        await visit(full, relative);
      } else if (entry.isFile() && !name.includes('.liuxu-') && name !== '.DS_Store'
        && !name.endsWith('~') && !/\.(?:tmp|swp|swo|part)$/i.test(name)) {
        if (this.config.syncExtensions.includes(path.extname(name).toLowerCase())) files.push({ relativePath: relative, fullPath: full, archived: relative.startsWith(`${ARCHIVE_DIR}/`) });
        else nameOnlyEntries.push({ name, relativePath: relative, isDirectory: false });
      }
    };
    const visit = async (directory, relative = '') => {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) await inspect(relative ? `${relative}/${entry.name}` : entry.name, entry);
    };
    if (!paths) await visit(root);
    else {
      const scopes = [...paths].filter(relative => ![...paths].some(parent => parent !== relative && relative.startsWith(`${parent}/`)));
      for (const relative of scopes) {
        const safe = safeRelative(relative);
        if (!safe || isExcludedSyncPath(safe)) continue;
        const full = path.join(root, ...safe.split('/'));
        try {
          assertSafeExistingPath(root, full);
          const stat = await fs.promises.lstat(full);
          if (stat.isDirectory()) deletionScopes.add(safe);
          await inspect(safe, stat);
        } catch (error) { if (error.code !== 'ENOENT') throw error; deletionScopes.add(safe); }
      }
    }
    return { files, directories, nameOnlyEntries, scopes: paths, deletionScopes };
  }

  async listNameOnlyEntries({ knowledgeBase, folderPath = '' }) {
    if (!this.config.enabled || !knowledgeBase) return [];
    this.ensureRoot();
    const existingPaths = new Set(this.adapter.listSyncedPaths());
    const scan = await this.scanFilesAsync();
    return scan.nameOnlyEntries.filter(entry => {
      if (entry.relativePath.startsWith(`${ARCHIVE_DIR}/`) || existingPaths.has(entry.relativePath)) return false;
      const location = splitDocumentLocation(entry.relativePath, false);
      return location.knowledgeBase === knowledgeBase && location.folderPath === folderPath;
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  syncCategories(directories, scopes = null) {
    const paths = new Set(directories
      .filter(value => value !== ARCHIVE_DIR && !value.startsWith(`${ARCHIVE_DIR}/`))
      .map(value => value.split('/').map(part => sanitizeSegment(part)).join('/')));
    const documents = this.adapter.listLocations ? this.adapter.listLocations() : this.adapter.listDocuments();
    for (const document of documents) {
      const value = [document.knowledgeBase, document.folderPath].filter(Boolean).join('/');
      if (value) paths.add(value);
    }
    const ordered = [...paths].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const value of ordered) this.adapter.ensureCategory(value);
    this.adapter.removeMissingCategories(paths, scopes);
  }

  async syncNow({ reason = 'manual' } = {}) {
    if (!this.config.enabled) return this.snapshot();
    if (this.running) {
      if (reason !== 'watch' && (this.followUpReason !== 'manual' || reason === 'manual')) this.followUpReason = reason;
      return this.running;
    }
    const run = async () => {
      let nextReason = reason;
      const totals = { reason, added: 0, updated: 0, moved: 0, deleted: 0, assetsChanged: 0, errors: [] };
      do {
        const full = nextReason !== 'watch' || this.forceReconcile;
        const paths = full ? null : new Set(this.pendingPaths);
        this.pendingPaths.clear(); this.forceReconcile = false; this.followUpReason = null;
        if (full || paths.size) {
          const result = await this.performSync(nextReason, { paths });
          for (const key of ['added', 'updated', 'moved', 'deleted', 'assetsChanged']) totals[key] += result.report[key] || 0;
          totals.errors.push(...result.report.errors);
        }
        nextReason = this.followUpReason || 'watch';
      } while (this.config.enabled && (this.followUpReason || this.forceReconcile || this.pendingPaths.size));
      this.state.report = totals;
      return this.snapshot();
    };
    this.running = run().finally(() => { this.running = null; });
    return this.running;
  }

  async inspectFile(file, trackedInfo, generation) {
    const writeEpoch = this.localWriteEpoch;
    const result = await this.worker.request('inspect', { root: this.config.rootPath,
      file: file.fullPath, note: path.extname(file.relativePath).toLowerCase() === NOTE_EXT,
      generation, documentVersion: trackedInfo?.version });
    result.relativePath = file.relativePath;
    result.fullPath = file.fullPath;
    result.writeEpoch = writeEpoch;
    return result;
  }

  resultCurrent(result, document = null) {
    if (!result || result.stale || result.generation !== this.generation
      || (result.documentVersion == null && result.writeEpoch !== this.localWriteEpoch)
      || (result.documentVersion != null && document?.version !== result.documentVersion)) return false;
    try {
      assertSafeExistingPath(this.config.rootPath, result.fullPath);
      const stat = fs.statSync(result.fullPath);
      return ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].every(key => stat[key] === result.state[key]);
    } catch { return false; }
  }

  async performSync(reason, { paths = null } = {}) {
    const generation = this.generation;
    const incremental = paths !== null;
    let batchStarted = performance.now(), batchCount = 0;
    const checkpoint = async () => {
      if (generation !== this.generation) throw Object.assign(new Error('同步任务已取消'), { code: 'SYNC_CANCELLED' });
      if (++batchCount < 25 && performance.now() - batchStarted < 8) return;
      await yieldToEventLoop(); batchCount = 0; batchStarted = performance.now();
      if (!incremental && this.pendingPaths.size && !this.forceReconcile) {
        const urgent = new Set(this.pendingPaths); this.pendingPaths.clear();
        const result = await this.performSync('watch', { paths: urgent });
        for (const key of ['added', 'updated', 'moved', 'deleted', 'assetsChanged']) report[key] += result.report[key] || 0;
        report.errors.push(...result.report.errors);
      }
    };
    this.state.status = 'syncing';
    this.state.error = '';
    const report = { reason, added: 0, updated: 0, moved: 0, deleted: 0, assetsChanged: 0, errors: [] };
    try {
      const root = this.ensureRoot();
      if (!fs.accessSync) throw new Error('当前运行环境不支持文件访问');
      fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
      if (this.manifestCorrupt) {
        ensureSafeDirectory(root, this.paths().conflicts);
        fs.renameSync(this.paths().deltas, path.join(this.paths().conflicts, `manifest-corrupt-${crypto.randomUUID()}.jsonl`));
        this.manifestCorrupt = false;
        Object.keys(this.manifest).forEach(id => this.dirtyIds.add(id));
        this.lastDeepVerificationAt = 0;
      }
      const scan = await this.scanFilesAsync({ paths });
      await checkpoint();
      if (!incremental) this.rebuildPathIndexes();
      const assetPaths = new Set(this.assetReferences.keys());
      const manifestByPath = this.pathIndex;
      const trackedIds = [...new Set(scan.files
        .map(file => manifestByPath.get(file.relativePath.toLocaleLowerCase('en-US')))
        .filter(Boolean))];
      const syncMetadata = this.adapter.readSyncMetadata
        ? await this.adapter.readSyncMetadata(trackedIds)
        : new Map();
      const deepVerify = !incremental && (reason === 'manual' || !this.lastDeepVerificationAt
        || Date.now() - this.lastDeepVerificationAt >= 15 * 60 * 1000);
      const parsedNotes = new Map();
      let parsedNoteBytes = 0;
      for (const file of scan.files.filter(item => path.extname(item.relativePath).toLowerCase() === NOTE_EXT)) {
        await checkpoint();
        try {
          const relativeLower = file.relativePath.toLocaleLowerCase('en-US');
          const trackedId = manifestByPath.get(relativeLower);
          const tracked = trackedId ? this.manifest[trackedId] : null;
          const fast = fastFileFingerprint(file.fullPath);
          if (!deepVerify && !incremental && Array.isArray(tracked?.assets) && sameFastFingerprint(tracked.fingerprint, fast)) {
            tracked.assets.forEach(relative => assetPaths.add(String(relative).toLocaleLowerCase('en-US')));
            continue;
          }
          const result = await this.inspectFile(file, syncMetadata.get(trackedId), generation);
          if (!this.resultCurrent(result, trackedId ? this.adapter.readDocument(trackedId) : null)) { this.enqueuePath(file.relativePath); continue; }
          const { fingerprint, parsed } = result;
          const dependencies = [];
          for (const source of result.images) {
            let decoded = '';
            try { decoded = decodeURIComponent(source.split(/[?#]/)[0]); } catch { continue; }
            if (!decoded || /^(?:https?:|data:|\/)/i.test(decoded)) continue;
            const absolute = path.resolve(path.dirname(file.fullPath), decoded);
            if (!isInside(root, absolute)) continue;
            const relativeAsset = path.relative(root, absolute).replace(/\\/g, '/');
            this.rememberAsset(relativeAsset);
            dependencies.push(relativeAsset);
            assetPaths.add(relativeAsset.toLocaleLowerCase('en-US'));
          }
          const unchanged = trackedId && sameFingerprint(tracked?.fingerprint, fingerprint);
          parsedNoteBytes += unchanged ? 0 : parsed.content.length * 2;
          const needsRead = !unchanged && parsedNoteBytes > 16 * 1024 * 1024;
          parsedNotes.set(relativeLower, { result: unchanged || needsRead ? { ...result, parsed: null, images: null } : result,
            fingerprint, unchanged, needsRead, assets: [...new Set(dependencies)] });
        } catch { /* malformed notes are reported during the main pass */ }
      }
      const presentPaths = new Set(scan.files.map(file => file.relativePath.toLocaleLowerCase('en-US')));
      for (const relative of (incremental ? [] : [...this.managedAssets])) {
        if (isExcludedSyncPath(relative)) continue;
        if (presentPaths.has(relative.toLocaleLowerCase('en-US'))) {
          assetPaths.add(relative.toLocaleLowerCase('en-US'));
        } else {
          this.forgetAsset(relative);
        }
      }
      const seenIds = new Set();
      for (const file of scan.files) {
        await checkpoint();
        try {
          const extension = path.extname(file.relativePath).toLowerCase();
          const relativeLower = file.relativePath.toLocaleLowerCase('en-US');
          const fast = fastFileFingerprint(file.fullPath);
          const trackedFileId = manifestByPath.get(relativeLower);
          const trackedInfo = trackedFileId
            ? (syncMetadata.get(trackedFileId) || (this.adapter.readSyncMetadata ? null : this.adapter.readDocument(trackedFileId)))
            : null;
          const knownFingerprint = trackedFileId ? this.manifest[trackedFileId]?.fingerprint : null;
          const unchanged = !deepVerify && !incremental && trackedInfo && sameFastFingerprint(knownFingerprint, fast)
            && ((extension === NOTE_EXT && trackedInfo.sourceType !== 'file')
              || (extension !== NOTE_EXT && trackedInfo.sourceType === 'file'));
          if (unchanged) {
            seenIds.add(trackedFileId);
            continue;
          }
          const noteCache = extension === NOTE_EXT ? parsedNotes.get(relativeLower) : null;
          if (assetPaths.has(relativeLower) && extension !== NOTE_EXT) {
            const previous = this.assetFingerprints.get(relativeLower);
            if (!deepVerify && !incremental && sameFastFingerprint(previous, fast)) continue;
            const asset = await this.inspectFile(file, null, generation);
            if (!this.resultCurrent(asset)) { this.enqueuePath(file.relativePath); continue; }
            if (!sameFingerprint(previous, asset.fingerprint)) report.assetsChanged += 1;
            this.assetFingerprints.set(relativeLower, asset.fingerprint);
            continue;
          }
          const result = (noteCache && !noteCache.needsRead ? noteCache.result : null) || await this.inspectFile(file, trackedInfo, generation);
          const trackedFile = trackedFileId ? this.adapter.readDocument(trackedFileId) : null;
          if (!this.resultCurrent(result, trackedFile)) { this.enqueuePath(file.relativePath); continue; }
          const fingerprint = result.fingerprint;
          if (noteCache?.needsRead && !sameFingerprint(noteCache.fingerprint, fingerprint)) { this.enqueuePath(file.relativePath); continue; }
          if (noteCache?.unchanged && trackedFileId) {
            seenIds.add(trackedFileId);
            this.setEntry(trackedFileId, { ...this.manifest[trackedFileId], fingerprint, assets: noteCache.assets });
            parsedNotes.delete(relativeLower);
            continue;
          }
          if (extension === NOTE_EXT && trackedFile?.sourceType !== 'file') {
            const parsed = result.parsed;
            let id = typeof parsed.metadata.liuxu_id === 'string' ? parsed.metadata.liuxu_id : '';
            if (id && seenIds.has(id)) id = '';
            if (id && this.manifest[id]?.relativePath !== file.relativePath) {
              const canonicalRelative = safeRelative(this.manifest[id]?.relativePath || '');
              const canonical = canonicalRelative ? path.join(root, ...canonicalRelative.split('/')) : '';
              if (canonical && fs.existsSync(canonical)) id = '';
            }
            const location = splitDocumentLocation(file.relativePath, file.archived);
            let existing = id ? this.adapter.readDocument(id) : null;
            if (existing && existing.sourceType !== 'note') { id = ''; existing = null; }
            if (existing && this.manifest[id]?.relativePath !== file.relativePath) {
              this.copyMovedImageDependencies(parsed.content, file.fullPath, this.manifest[id]?.relativePath);
            }
            const input = {
              id,
              title: parsed.title || path.basename(file.relativePath, NOTE_EXT).replace(/ 留序批注$/, ''),
              content: parsed.content,
              tags: Array.isArray(parsed.metadata.tags) ? parsed.metadata.tags.map(String) : [],
              documentDate: String(parsed.metadata.date || ''),
              parentDocumentId: typeof parsed.metadata.parent_document_id === 'string' ? parsed.metadata.parent_document_id : null,
              documentRole: ['annotation', 'mindmap'].includes(parsed.metadata.document_role) ? parsed.metadata.document_role : 'normal',
              status: file.archived ? 'archived' : 'active',
              ...location,
              fileSync: { relativePath: file.relativePath, fingerprint, sourceType: 'note', parentDocumentId: parsed.metadata.parent_document_id || null },
            };
            if (input.parentDocumentId) {
              const parent = this.adapter.readDocument(input.parentDocumentId);
              if (parent) {
                input.knowledgeBase = parent.knowledgeBase;
                input.folderPath = parent.folderPath;
                input.collectionPath = parent.collectionPath;
              }
            }
            let finalFingerprint = fingerprint;
            if (!existing) {
              const created = this.adapter.importMarkdown(input);
              id = created.id;
              input.id = id;
              report.added += 1;
              if (parsed.metadata.liuxu_id !== id) {
                atomicWriteFile(root, file.fullPath, Buffer.from(serializeMarkdown({ ...created, ...input }), 'utf8'));
                finalFingerprint = fileFingerprint(file.fullPath);
              }
            } else if (!sameFingerprint(this.manifest[id]?.fingerprint, fingerprint)
              || this.manifest[id]?.relativePath !== file.relativePath) {
              this.adapter.upsertFromDisk(id, input);
              report.updated += 1;
              if (this.manifest[id]?.relativePath && this.manifest[id].relativePath !== file.relativePath) report.moved += 1;
            }
            seenIds.add(id);
            this.setEntry(id, { ...input.fileSync, fingerprint: finalFingerprint, assets: noteCache?.assets || this.imageDependencies(parsed.content, file.fullPath) });
            parsedNotes.delete(relativeLower);
          } else {
            if (assetPaths.has(relativeLower)) continue;
            let id = manifestByPath.get(relativeLower) || '';
            const existing = id ? this.adapter.readDocument(id) : null;
            if (existing && sameFingerprint(this.manifest[id]?.fingerprint, fingerprint)) { seenIds.add(id); continue; }
            const location = splitDocumentLocation(file.relativePath, file.archived);
            const imported = await this.adapter.importBinary({
              existing,
              fullPath: file.fullPath,
              relativePath: file.relativePath,
              filename: path.basename(file.relativePath),
              status: file.archived ? 'archived' : 'active',
              ...location,
              fingerprint,
              isCurrent: () => this.resultCurrent(result, existing ? this.adapter.readDocument(existing.id) : null),
            });
            id = imported.id;
            seenIds.add(id);
            this.setEntry(id, { relativePath: file.relativePath, fingerprint, sourceType: 'file', parentDocumentId: null });
            if (existing) report.updated += 1; else report.added += 1;
          }
        } catch (error) {
          if (error.code === 'SYNC_STALE') { this.enqueuePath(file.relativePath); continue; }
          report.errors.push({ path: file.relativePath, error: error.message });
        }
      }
      const removalCandidates = incremental ? [...scan.deletionScopes].flatMap(scope => [...this.pathIndex.entries()]
        .filter(([value]) => value === scope.toLocaleLowerCase('en-US') || value.startsWith(`${scope.toLocaleLowerCase('en-US')}/`))
        .map(([, id]) => [id, this.manifest[id]])) : Object.entries({ ...this.manifest });
      for (const [id, entry] of removalCandidates) {
        if (!entry) continue;
        await checkpoint();
        if (seenIds.has(id)) continue;
        const relative = safeRelative(entry.relativePath || '');
        if (!relative || isExcludedSyncPath(relative) || !this.config.syncExtensions.includes(path.extname(relative).toLowerCase())) continue;
        const target = path.join(root, ...relative.split('/'));
        if (fs.existsSync(target)) continue;
        this.adapter.deleteFromDisk(id);
        this.setEntry(id, null);
        report.deleted += 1;
      }
      // Notes created by an older app version can exist in SQLite without a
      // folder-sync mapping. Once the root is active, materialize those rows so
      // the database and the user's local folder converge again.
      const unmappedDocuments = incremental ? [] : this.adapter.listUnmappedDocuments
        ? this.adapter.listUnmappedDocuments()
        : this.adapter.listDocuments();
      for (const document of unmappedDocuments) {
        await checkpoint();
        if (isExcludedSyncPath(document.fileSync?.relativePath)) continue;
        if (seenIds.has(document.id) || this.manifest[document.id] || document.fileSync?.relativePath) continue;
        try {
          const prepared = this.prepareWrite(document, null);
          this.adapter.recordPreparedDocument(prepared, document);
          report.added += 1;
          const entry = prepared.fileSync || {};
          if (entry.relativePath) this.setEntry(document.id, { ...entry });
        } catch (error) {
          report.errors.push({ path: document.title || document.id, error: error.message });
        }
      }
      const directorySignature = !incremental ? JSON.stringify(scan.directories.slice().sort()) : '';
      if (!incremental && (directorySignature !== this.directorySignature || report.added || report.moved || report.deleted)) {
        this.syncCategories(scan.directories); this.directorySignature = directorySignature;
      }
      else if (incremental) {
        for (const directory of scan.directories) {
          if (directory !== ARCHIVE_DIR && !directory.startsWith(`${ARCHIVE_DIR}/`)) this.adapter.ensureCategory(directory.split('/').map(part => sanitizeSegment(part)).join('/'));
        }
        for (const file of scan.files) {
          const location = splitDocumentLocation(file.relativePath, file.archived);
          this.adapter.ensureCategory(location.collectionPath);
        }
        const removedScopes = [...scan.deletionScopes].filter(scope => !this.pathIndex.has(scope.toLocaleLowerCase('en-US'))
          && this.knownDirectories.has(scope) && !fs.existsSync(path.join(root, scope)));
        if (removedScopes.length) this.syncCategories(scan.directories, removedScopes);
        for (const removed of removedScopes) for (const directory of this.knownDirectories) {
          if (directory === removed || directory.startsWith(`${removed}/`)) this.knownDirectories.delete(directory);
        }
      }
      if (!incremental) this.knownDirectories = new Set(scan.directories);
      else scan.directories.forEach(directory => this.knownDirectories.add(directory));
      if (deepVerify && !report.errors.length && !this.pendingPaths.size) this.lastDeepVerificationAt = Date.now();
      this.persistManifest();
      if (!this.pendingOperations.length) this.clearJournal();
      this.state.status = report.errors.length ? 'warning' : 'idle';
      this.state.error = report.errors.length ? `${report.errors.length} 个文件同步失败` : '';
      this.state.lastSyncAt = nowIso();
      const namesSignature = incremental ? this.nameOnlySignature : JSON.stringify(scan.nameOnlyEntries.map(entry => entry.relativePath).sort());
      const changedNames = incremental ? Boolean(scan.nameOnlyEntries.length || scan.deletionScopes.size || scan.directories.length) : namesSignature !== this.nameOnlySignature;
      if (report.added || report.updated || report.moved || report.deleted || report.assetsChanged || changedNames) this.state.generation += 1;
      this.nameOnlySignature = namesSignature;
      this.state.report = report;
      if (!this.watcher && this.timer && Date.now() >= (this.watchRetryAt || 0)) this.restartWatcher();
      return this.snapshot();
    } catch (error) {
      if (generation !== this.generation) throw error;
      this.state.status = 'error';
      this.state.error = error.message;
      this.state.report = report;
      throw error;
    }
  }

  ensureDirectoryTree() {
    if (!this.config.enabled) return;
    const root = this.ensureRoot();
    for (const category of this.db.getAllCategories()) {
      const visit = (nodes, prefix) => nodes.forEach(node => {
        const relative = [prefix, sanitizeSegment(node.name)].filter(Boolean).join('/');
        ensureSafeDirectory(root, path.join(root, ...relative.split('/')));
        visit(Array.isArray(node.sub) ? node.sub : [], relative);
      });
      const base = sanitizeSegment(category.name);
      ensureSafeDirectory(root, path.join(root, base));
      visit(Array.isArray(category.sub) ? category.sub : [], base);
    }
  }

  removeCollectionDirectory(collectionPath, reason = 'folder-deleted') {
    if (!this.config.enabled) return;
    const relative = safeRelative(String(collectionPath || '').split('/').map(value => sanitizeSegment(value)).join('/'));
    if (!relative) return;
    this.moveToTrash(relative, reason);
  }

  migrateAll({ rootPath }) {
    const documents = this.adapter.listDocuments();
    const missingDependencies = [];
    for (const document of documents) {
      if (document.sourceType !== 'note') continue;
      const { tokens } = markdownImageTokens(document.content);
      for (const token of tokens) {
        let source = '';
        try { source = decodeURIComponent(token.source.split(/[?#]/)[0]); } catch { continue; }
        if (!source || /^(?:https?:|data:)/i.test(source)) continue;
        const legacy = source.match(/^\/?uploads\/(.+)$/i);
        if (legacy) {
          const relative = safeRelative(legacy[1]);
          const candidate = relative ? path.resolve(this.db.dataDir, 'uploads', ...relative.split('/')) : '';
          const uploadsRoot = path.resolve(this.db.dataDir, 'uploads');
          if (!candidate || !isInside(uploadsRoot, candidate) || !fs.existsSync(candidate)
            || fs.lstatSync(candidate).isSymbolicLink() || !fs.statSync(candidate).isFile()) {
            missingDependencies.push({ documentId: document.id, title: document.title, source: token.source });
          }
          continue;
        }
        if (path.isAbsolute(source)) continue;
        const entry = this.manifest[document.id] || document.fileSync;
        const existingNotePath = safeRelative(entry?.relativePath || '');
        const candidate = existingNotePath
          ? path.resolve(this.config.rootPath, path.dirname(existingNotePath), source)
          : path.resolve(this.config.rootPath, source);
        if (!isInside(this.config.rootPath, candidate) || !fs.existsSync(candidate)
          || fs.lstatSync(candidate).isSymbolicLink() || !fs.statSync(candidate).isFile()) {
          missingDependencies.push({ documentId: document.id, title: document.title, source: token.source });
        }
      }
    }
    if (missingDependencies.length) {
      const report = { rootPath: path.resolve(rootPath), documents: documents.length, notes: 0, files: 0, errors: [], missingDependencies };
      throw Object.assign(new Error(`知识库迁移发现 ${missingDependencies.length} 个缺失图片依赖`), { report });
    }
    this.configure({ enabled: false, rootPath });
    this.ensureRoot({ requireEmpty: true });
    this.config.enabled = true;
    atomicWriteJson(this.configPath, this.config);
    this.ensureDirectoryTree();
    const report = { rootPath: this.config.rootPath, documents: 0, notes: 0, files: 0, errors: [], missingDependencies: [] };
    for (const document of documents) {
      try {
        const prepared = this.prepareWrite(document, null);
        this.adapter.recordPreparedDocument(prepared, document);
        report.documents += 1;
        if (document.sourceType === 'file') report.files += 1; else report.notes += 1;
      } catch (error) { report.errors.push({ id: document.id, title: document.title, error: error.message }); }
    }
    if (report.errors.length) throw Object.assign(new Error('知识库迁移存在未解决错误'), { report });
    this.state.status = 'idle';
    this.state.lastSyncAt = nowIso();
    this.state.generation += 1;
    this.state.report = { reason: 'migration', added: report.documents, updated: 0, moved: 0, deleted: 0, errors: [] };
    this.start({ skipInitialSync: true });
    return report;
  }

  saveDraft(documentId, draft, reason = '同步冲突') {
    if (!this.config.enabled && !draft?.rawText) return null;
    const paths = this.config.enabled ? this.paths() : this.paths(this.db.dataDir);
    ensureSafeDirectory(paths.root, paths.conflicts);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${sanitizeSegment(documentId, 'document')}.json`;
    const payload = { id: name, documentId, reason, createdAt: nowIso(), draft };
    atomicWriteJson(path.join(paths.conflicts, name), payload);
    return payload;
  }

  draftRoots() {
    return [...new Set([...(this.config.enabled ? [this.config.rootPath] : []), this.db.dataDir])];
  }

  safeDraftPath(root, name) {
    const target = path.join(this.paths(root).conflicts, name);
    try {
      if (fs.lstatSync(target).isSymbolicLink() || !isInside(fs.realpathSync(root), fs.realpathSync(target))) return null;
      return target;
    } catch { return null; }
  }

  listDrafts() {
    const drafts = [];
    for (const root of this.draftRoots()) {
      const directory = this.paths(root).conflicts;
      if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) continue;
      for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
        const target = this.safeDraftPath(root, name);
        if (!target) continue;
        const value = readJson(target, {});
        drafts.push({ id: name, documentId: value.documentId || '', reason: value.reason || '', createdAt: value.createdAt || '', title: value.draft?.title || '' });
      }
    }
    return drafts.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 50);
  }

  readDraft(id) {
    const name = path.basename(String(id || ''));
    if (!name || name !== id || !name.endsWith('.json')) return null;
    for (const root of this.draftRoots()) {
      const target = this.safeDraftPath(root, name);
      if (target) return readJson(target, null);
    }
    return null;
  }

}

module.exports = {
  KnowledgeFolderSync,
  defaultRootPath,
  sanitizeSegment,
  safeRelative,
  isExcludedSyncPath,
  normalizeSyncExtensions,
  DEFAULT_SYNC_EXTENSIONS,
  serializeMarkdown,
  parseFrontMatter,
  markdownImageTokens,
  validManifestDelta,
  fileFingerprint,
  sameFingerprint,
  atomicWriteFile,
  INTERNAL_DIR,
  ARCHIVE_DIR,
};
