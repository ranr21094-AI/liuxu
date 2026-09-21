const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson } = require('../util/json-file');

const CONFIG_NAME = '.knowledge-folder.json';
const INTERNAL_DIR = '.liuxu';
const ARCHIVE_DIR = '.archive';
const MANIFEST_NAME = 'manifest.json';
const JOURNAL_NAME = 'journal.json';
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const NOTE_EXT = '.md';
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

function isInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

function ensureSafeDirectory(root, directory) {
  if (!isInside(root, directory)) throw new Error('知识库路径越界');
  let current = path.resolve(directory);
  const stop = path.resolve(root);
  while (current !== stop) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('知识库目录不能经过符号链接');
    current = path.dirname(current);
  }
  fs.mkdirSync(directory, { recursive: true });
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
    `visibility: ${frontMatterValue(document.visibility || 'standard')}`,
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
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${path.basename(file)} 超过 30 MiB`);
  const bytes = fs.readFileSync(file);
  return { sha256: sha256(bytes), size: bytes.length, mtimeMs: Math.round(stat.mtimeMs) };
}

function sameFingerprint(left, right) {
  return Boolean(left && right && left.sha256 && left.sha256 === right.sha256 && Number(left.size) === Number(right.size));
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
    const expression = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    let match;
    while ((match = expression.exec(line))) tokens.push({ lineIndex, raw: match[0], alt: match[1], source: match[2] });
  });
  return { lines, tokens };
}

class KnowledgeFolderSync {
  constructor({ db, adapter }) {
    this.db = db;
    this.adapter = adapter;
    this.configPath = path.join(db.dataDir, CONFIG_NAME);
    this.config = this.readConfig();
    this.manifest = {};
    this.managedAssets = new Set();
    this.running = null;
    this.watcher = null;
    this.timer = null;
    this.debounceTimer = null;
    this.state = { status: this.config.enabled ? 'idle' : 'disabled', generation: 0, lastSyncAt: '', error: '', report: null };
    this.loadManifest();
    if (this.config.enabled) this.start();
  }

  readConfig() {
    const stored = readJson(this.configPath, {});
    return {
      version: 1,
      enabled: stored.enabled === true,
      rootPath: path.resolve(String(stored.rootPath || defaultRootPath())),
      scanIntervalMs: Math.max(5000, Number(stored.scanIntervalMs) || 30000),
    };
  }

  paths(root = this.config.rootPath) {
    const internal = path.join(root, INTERNAL_DIR);
    return {
      root,
      internal,
      manifest: path.join(internal, MANIFEST_NAME),
      journal: path.join(internal, JOURNAL_NAME),
      conflicts: path.join(internal, 'conflicts'),
      trash: path.join(internal, 'trash'),
    };
  }

  loadManifest() {
    const file = this.paths().manifest;
    const stored = readJson(file, { documents: {} });
    this.manifest = stored.documents && typeof stored.documents === 'object' ? stored.documents : {};
    this.managedAssets = new Set(Array.isArray(stored.assets) ? stored.assets.map(safeRelative).filter(Boolean) : []);
  }

  persistManifest() {
    const paths = this.paths();
    ensureSafeDirectory(paths.root, paths.internal);
    atomicWriteJson(paths.manifest, {
      version: 1,
      updatedAt: nowIso(),
      documents: this.manifest,
      assets: [...this.managedAssets].sort(),
    });
  }

  writeJournal(operation) {
    const paths = this.paths();
    ensureSafeDirectory(paths.root, paths.internal);
    atomicWriteJson(paths.journal, { version: 1, updatedAt: nowIso(), operation });
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
      desktopConfigurable: process.env.LIUXU_DESKTOP === '1',
      pendingJournal: fs.existsSync(this.paths().journal),
      drafts: this.listDrafts(),
    };
  }

  configure({ enabled, rootPath }) {
    const nextRoot = path.resolve(String(rootPath || this.config.rootPath || defaultRootPath()));
    if (!path.isAbsolute(nextRoot)) throw new Error('知识库根目录必须是绝对路径');
    if (isInside(nextRoot, this.db.dataDir) || isInside(this.db.dataDir, nextRoot)) throw new Error('知识库根目录不能与应用数据目录互相包含');
    this.stop();
    this.config = { ...this.config, enabled: enabled === true, rootPath: nextRoot };
    atomicWriteJson(this.configPath, this.config);
    this.loadManifest();
    this.state.status = this.config.enabled ? 'idle' : 'disabled';
    this.state.error = '';
    if (this.config.enabled) this.start();
    return this.snapshot();
  }

  start({ skipInitialSync = false } = {}) {
    if (!this.config.enabled) return;
    this.stop();
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
    if (!skipInitialSync) this.syncNow({ reason: 'startup' }).catch(() => {});
    this.restartWatcher();
  }

  restartWatcher() {
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
    if (!this.config.enabled || !fs.existsSync(this.config.rootPath)) return;
    try {
      this.watcher = fs.watch(this.config.rootPath, { recursive: true }, (_event, filename) => {
        const relative = String(filename || '').replace(/\\/g, '/');
        if (!relative || relative.startsWith(`${INTERNAL_DIR}/`) || relative.includes('.liuxu-')) return;
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.syncNow({ reason: 'watch' }).catch(() => {}), 650);
        this.debounceTimer.unref?.();
      });
      this.watcher.on('error', error => {
        this.state.status = 'error';
        this.state.error = error.message;
      });
    } catch { /* periodic scan remains active */ }
  }

  stop() {
    clearInterval(this.timer); this.timer = null;
    clearTimeout(this.debounceTimer); this.debounceTimer = null;
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
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
      this.managedAssets.add(path.relative(this.config.rootPath, destination).replace(/\\/g, '/'));
      parsed.lines[token.lineIndex] = parsed.lines[token.lineIndex].replace(token.raw, `![${token.alt}](./${encodeURI(destinationName)})`);
    }
    return parsed.lines.join('\n');
  }

  prepareWrite(document, previous = null) {
    if (!this.config.enabled) return document;
    const root = this.ensureRoot();
    const oldEntry = this.manifest[document.id] || previous?.fileSync || null;
    const oldRelative = safeRelative(oldEntry?.relativePath || '');
    if (oldRelative) {
      const oldPath = path.join(root, ...oldRelative.split('/'));
      if (fs.existsSync(oldPath)) {
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
    this.writeJournal({ type: 'write', documentId: document.id, from: oldRelative, to: relativePath });
    let nextDocument = { ...document };
    if (document.sourceType === 'note') {
      ensureSafeDirectory(root, path.dirname(target));
      nextDocument.content = this.copyLegacyImages(document, document.content, path.dirname(target), oldDocumentPath);
      atomicWriteFile(root, target, Buffer.from(serializeMarkdown(nextDocument), 'utf8'));
    } else {
      const source = this.adapter.sourceFilePath(document);
      if (!source || !fs.existsSync(source)) throw new Error('原始档案不存在，无法同步到知识库目录');
      atomicWriteFile(root, target, fs.readFileSync(source));
    }
    if (oldRelative && oldRelative !== relativePath) this.moveToTrash(oldRelative, 'moved');
    const fingerprint = fileFingerprint(target);
    const entry = { relativePath, fingerprint, sourceType: document.sourceType, parentDocumentId: document.parentDocumentId || null };
    this.manifest[document.id] = entry;
    this.persistManifest();
    this.clearJournal();
    return { ...nextDocument, fileSync: entry };
  }

  removeDocument(document) {
    if (!this.config.enabled || !document?.id) return;
    const entry = this.manifest[document.id] || document.fileSync;
    if (entry?.relativePath) this.moveToTrash(entry.relativePath, 'deleted');
    delete this.manifest[document.id];
    this.persistManifest();
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
    const visit = (directory, relative = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === INTERNAL_DIR || (entry.name.startsWith('.') && entry.name !== ARCHIVE_DIR)) continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          directories.push(childRelative);
          visit(full, childRelative);
        } else if (entry.isFile() && !entry.name.includes('.liuxu-') && entry.name !== '.DS_Store'
          && !entry.name.endsWith('~') && !/\.(?:tmp|swp|swo|part)$/i.test(entry.name)) {
          files.push({ relativePath: childRelative, fullPath: full, archived: childRelative.startsWith(`${ARCHIVE_DIR}/`) });
        }
      }
    };
    visit(root);
    return { files, directories };
  }

  syncCategories(directories) {
    const paths = new Set(directories
      .filter(value => value !== ARCHIVE_DIR && !value.startsWith(`${ARCHIVE_DIR}/`))
      .map(value => value.split('/').map(part => sanitizeSegment(part)).join('/')));
    for (const document of this.adapter.listDocuments()) {
      const value = [document.knowledgeBase, document.folderPath].filter(Boolean).join('/');
      if (value) paths.add(value);
    }
    const ordered = [...paths].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const value of ordered) this.adapter.ensureCategory(value);
    this.adapter.removeMissingCategories(paths);
  }

  async syncNow({ reason = 'manual' } = {}) {
    if (!this.config.enabled) return this.snapshot();
    if (this.running) return this.running;
    this.running = this.performSync(reason).finally(() => { this.running = null; });
    return this.running;
  }

  async performSync(reason) {
    this.state.status = 'syncing';
    this.state.error = '';
    const report = { reason, added: 0, updated: 0, moved: 0, deleted: 0, errors: [] };
    try {
      const root = this.ensureRoot();
      if (!fs.accessSync) throw new Error('当前运行环境不支持文件访问');
      fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
      const scan = this.scanFiles();
      const assetPaths = new Set();
      for (const file of scan.files.filter(item => path.extname(item.relativePath).toLowerCase() === NOTE_EXT)) {
        try {
          const parsed = parseFrontMatter(fs.readFileSync(file.fullPath, 'utf8'));
          const images = markdownImageTokens(parsed.content);
          for (const token of images.tokens) {
            let decoded = '';
            try { decoded = decodeURIComponent(token.source.split(/[?#]/)[0]); } catch { continue; }
            if (!decoded || /^(?:https?:|data:|\/)/i.test(decoded)) continue;
            const absolute = path.resolve(path.dirname(file.fullPath), decoded);
            if (!isInside(root, absolute)) continue;
            const relativeAsset = path.relative(root, absolute).replace(/\\/g, '/');
            this.managedAssets.add(relativeAsset);
            assetPaths.add(relativeAsset.toLocaleLowerCase('en-US'));
          }
        } catch { /* malformed notes are reported during the main pass */ }
      }
      const presentPaths = new Set(scan.files.map(file => file.relativePath.toLocaleLowerCase('en-US')));
      for (const relative of [...this.managedAssets]) {
        if (presentPaths.has(relative.toLocaleLowerCase('en-US'))) {
          assetPaths.add(relative.toLocaleLowerCase('en-US'));
        } else {
          this.managedAssets.delete(relative);
        }
      }
      const seenIds = new Set();
      const manifestByPath = new Map(Object.entries(this.manifest).map(([id, entry]) => [String(entry.relativePath || '').toLocaleLowerCase('en-US'), id]));
      for (const file of scan.files) {
        try {
          const extension = path.extname(file.relativePath).toLowerCase();
          const relativeLower = file.relativePath.toLocaleLowerCase('en-US');
          const fingerprint = fileFingerprint(file.fullPath);
          if (extension === NOTE_EXT) {
            const parsed = parseFrontMatter(fs.readFileSync(file.fullPath, 'utf8'), path.basename(file.relativePath, NOTE_EXT));
            let id = typeof parsed.metadata.liuxu_id === 'string' ? parsed.metadata.liuxu_id : '';
            if (id && seenIds.has(id)) id = '';
            if (id && this.manifest[id]?.relativePath !== file.relativePath) {
              const canonicalRelative = safeRelative(this.manifest[id].relativePath || '');
              const canonical = canonicalRelative ? path.join(root, ...canonicalRelative.split('/')) : '';
              if (canonical && fs.existsSync(canonical)) id = '';
            }
            const location = splitDocumentLocation(file.relativePath, file.archived);
            let existing = id ? this.adapter.readDocument(id) : null;
            if (existing && existing.sourceType !== 'note') { id = ''; existing = null; }
            const input = {
              id,
              title: parsed.title || path.basename(file.relativePath, NOTE_EXT).replace(/ 留序批注$/, ''),
              content: parsed.content,
              tags: Array.isArray(parsed.metadata.tags) ? parsed.metadata.tags.map(String) : [],
              documentDate: String(parsed.metadata.date || ''),
              visibility: existing?.visibility === 'diary' || parsed.metadata.visibility === 'diary' || location.knowledgeBase === '日记' ? 'diary' : 'standard',
              parentDocumentId: typeof parsed.metadata.parent_document_id === 'string' ? parsed.metadata.parent_document_id : null,
              documentRole: parsed.metadata.document_role === 'annotation' ? 'annotation' : 'normal',
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
                input.visibility = parent.visibility === 'diary' ? 'diary' : input.visibility;
              }
            }
            if (!existing) {
              const created = this.adapter.importMarkdown(input);
              id = created.id;
              input.id = id;
              report.added += 1;
              if (parsed.metadata.liuxu_id !== id) atomicWriteFile(root, file.fullPath, Buffer.from(serializeMarkdown({ ...created, ...input }), 'utf8'));
            } else if (!sameFingerprint(this.manifest[id]?.fingerprint, fingerprint)
              || this.manifest[id]?.relativePath !== file.relativePath) {
              this.adapter.upsertFromDisk(id, input);
              report.updated += 1;
              if (this.manifest[id]?.relativePath && this.manifest[id].relativePath !== file.relativePath) report.moved += 1;
            }
            seenIds.add(id);
            this.manifest[id] = { ...input.fileSync, fingerprint: fileFingerprint(file.fullPath) };
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
            });
            id = imported.id;
            seenIds.add(id);
            this.manifest[id] = { relativePath: file.relativePath, fingerprint, sourceType: 'file', parentDocumentId: null };
            if (existing) report.updated += 1; else report.added += 1;
          }
        } catch (error) {
          report.errors.push({ path: file.relativePath, error: error.message });
        }
      }
      for (const [id, entry] of Object.entries({ ...this.manifest })) {
        if (seenIds.has(id)) continue;
        const relative = safeRelative(entry.relativePath || '');
        if (!relative) continue;
        const target = path.join(root, ...relative.split('/'));
        if (fs.existsSync(target)) continue;
        this.adapter.deleteFromDisk(id);
        delete this.manifest[id];
        report.deleted += 1;
      }
      this.syncCategories(scan.directories);
      this.persistManifest();
      this.clearJournal();
      this.state.status = report.errors.length ? 'warning' : 'idle';
      this.state.error = report.errors.length ? `${report.errors.length} 个文件同步失败` : '';
      this.state.lastSyncAt = nowIso();
      if (report.added || report.updated || report.moved || report.deleted) this.state.generation += 1;
      this.state.report = report;
      this.restartWatcher();
      return this.snapshot();
    } catch (error) {
      this.state.status = 'error';
      this.state.error = error.message;
      this.state.report = report;
      throw error;
    }
  }

  ensureDirectoryTree() {
    if (!this.config.enabled) return;
    const root = this.ensureRoot();
    for (const category of this.db.getAllCategories(true, true)) {
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
    if (!this.config.enabled) return null;
    const paths = this.paths();
    ensureSafeDirectory(paths.root, paths.conflicts);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${sanitizeSegment(documentId, 'document')}.json`;
    const payload = { id: name, documentId, reason, createdAt: nowIso(), draft };
    atomicWriteJson(path.join(paths.conflicts, name), payload);
    return payload;
  }

  listDrafts() {
    const directory = this.paths().conflicts;
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().reverse().slice(0, 50).map(name => {
      const value = readJson(path.join(directory, name), {});
      return { id: name, documentId: value.documentId || '', reason: value.reason || '', createdAt: value.createdAt || '', title: value.draft?.title || '' };
    });
  }

  readDraft(id) {
    const name = path.basename(String(id || ''));
    if (!name || name !== id || !name.endsWith('.json')) return null;
    return readJson(path.join(this.paths().conflicts, name), null);
  }
}

module.exports = {
  KnowledgeFolderSync,
  defaultRootPath,
  sanitizeSegment,
  safeRelative,
  serializeMarkdown,
  parseFrontMatter,
  fileFingerprint,
  sameFingerprint,
  INTERNAL_DIR,
  ARCHIVE_DIR,
};
