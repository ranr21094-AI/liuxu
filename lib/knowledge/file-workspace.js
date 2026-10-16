const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ALL_TYPES, TEXT_TYPES, MAX_FILE_BYTES } = require('./file-formats');
const { parseFrontMatter, sanitizeSegment, markdownImageTokens } = require('./folder-sync');

const FORMAT = 'liuxu-file-workspace';
const VERSION = 1;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const fail = (status, message, current) => Object.assign(new Error(message), { status, current });
const missing = error => error.code === 'ENOENT';
const sameStat = (a, b) => ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].every(key => a[key] === b[key]);
const observedFileState = stat => ({ size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
  ino: stat.ino, dev: stat.dev });
const recordName = id => {
  const hash = crypto.createHash('sha256').update(`liuxu-document:${id}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}.json`;
};

function relativePath(value, { internal = false } = {}) {
  const input = String(value || '');
  const normalized = input.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (!normalized || path.isAbsolute(input) || /^[a-z]:/i.test(normalized)
    || parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f:*?"<>|]/.test(part) || /[. ]$/.test(part))
    || (!internal && parts[0].toLowerCase() === '.liuxu')) throw fail(400, '文件路径无效或越界');
  return parts.join('/');
}

// Keep the existing header byte-for-byte. The UI edits the body, not unknown YAML.
function decodeMarkdown(bytes, filename) {
  const bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes); }
  catch { throw fail(415, '文件不是有效 UTF-8'); }
  const match = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)(?:\r?\n)?)/.exec(text);
  return { bom, header: match?.[1] || '', content: match ? text.slice(match[1].length) : text,
    metadata: parseFrontMatter(text, path.basename(filename, '.md')).metadata,
    newline: text.includes('\r\n') ? '\r\n' : '\n' };
}
function metadataFields(metadata = {}) {
  return {
    title: typeof metadata.title === 'string' ? metadata.title.slice(0, 200) : '',
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter(tag => typeof tag === 'string').map(tag => tag.slice(0, 40)).slice(0, 20) : [],
    documentDate: typeof metadata.date === 'string' ? metadata.date.slice(0, 40) : '',
    documentRole: ['normal', 'annotation', 'mindmap'].includes(metadata.document_role) ? metadata.document_role : 'normal',
    parentDocumentId: typeof metadata.parent_document_id === 'string' && /^(note|file):[a-zA-Z0-9_-]+$/.test(metadata.parent_document_id) ? metadata.parent_document_id : null,
  };
}

class FileWorkspace {
  constructor({ root, indexDocument = async () => {}, loadIndexDocument = null,
    isIndexCurrent = () => false, removeIndex = async () => {}, loadObservations = () => [],
    saveObservation = () => {}, removeObservation = () => {}, onChange = () => {}, asyncIndex = false }) {
    this.root = path.resolve(root);
    this.hashWorker = new (require('./sync-worker-client').SyncWorker)();
    this.indexDocument = indexDocument;
    this.loadIndexDocument = loadIndexDocument;
    this.queuedDocuments = new Map();
    this.preparedIndexDocuments = new Map();
    this.isIndexCurrent = isIndexCurrent;
    this.removeIndex = removeIndex;
    this.loadObservations = loadObservations;
    this.saveObservation = saveObservation;
    this.removeObservation = removeObservation;
    this.onChange = onChange;
    this.records = new Map();
    this.pathIds = new Map();
    this.pendingIndex = new Set();
    this.indexedBaselines = new Map();
    this.pendingMetadata = new Set();
    this.asyncIndex = asyncIndex; this.indexQueue = new Map(); this.indexRunner = null;
    this.indexRetryTimers = new Map(); this.indexRetryAttempts = new Map();
    this.indexDirty = false;
    this.tail = Promise.resolve();
    this.error = '';
    this.watcher = null;
    this.timer = null;
    this.closed = false;
    this.generation = 0;
    this.fileGeneration = 0;
    this.directoryGeneration = 0;
    this.indexGeneration = 0;
    this.dirtyPaths = new Set();
    this.scanning = null;
    this.lastScanAt = '';
    this.lastDeepScanAt = '';
    this.scanStatus = 'idle';
    this.initializationState = 'starting';
    this.scanProgress = { visited: 0, total: 0 };
    this.documentTails = new Map();
    this.structureTail = Promise.resolve();
    this.metrics = { contentReadCalls: 0, contentReadBytes: 0, fullHashCalls: 0, fullHashBytes: 0,
      scanPasses: 0, scanVisited: 0, scanSkipped: 0, documentQueueWaitMs: 0, documentQueueWaitCount: 0, indexedDocuments: 0 };
  }
  exclusive(callback) {
    const request = this.tail.then(callback);
    this.tail = request.catch(() => {});
    return request;
  }
  withDocument(id, callback) {
    return this.withDocuments([id], callback);
  }
  withDocuments(ids, callback) {
    const ordered = [...new Set(ids.map(String))].sort();
    const previous = ordered.map(id => this.documentTails.get(id) || Promise.resolve());
    const structure = this.structureTail;
    const queuedAt = performance.now();
    const task = Promise.all([...previous, structure].map(wait => wait.catch(() => {}))).then(() => {
      this.metrics.documentQueueWaitMs += performance.now() - queuedAt;
      this.metrics.documentQueueWaitCount += 1;
      return callback();
    });
    // Register the whole lock set before yielding; a later structure operation
    // must never become a dependency of an already-held document lock.
    for (const id of ordered) this.documentTails.set(id, task);
    return task.finally(() => {
      for (const id of ordered) if (this.documentTails.get(id) === task) this.documentTails.delete(id);
    });
  }
  withStructure(callback) {
    const previous = this.structureTail;
    let release;
    this.structureTail = new Promise(resolve => { release = resolve; });
    const active = [...this.documentTails.values()];
    return (async () => {
      await previous.catch(() => {});
      await Promise.all(active.map(task => task.catch(() => {})));
      try { return await callback(); }
      finally { release(); }
    })();
  }
  async safe(relative = '', { createParents = false } = {}) {
    const parts = relative ? relativePath(relative, { internal: true }).split('/') : [];
    let current = this.root;
    const rootStat = await fs.lstat(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail(400, '文件工作区根目录无效');
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw fail(400, '文件路径不能经过符号链接');
        if (index < parts.length - 1 && !stat.isDirectory()) throw fail(400, '父路径不是目录');
      } catch (error) {
        if (!missing(error)) throw error;
        if (createParents && index < parts.length - 1) {
          await fs.mkdir(current);
          await this.safe(parts.slice(0, index + 1).join('/'));
        }
      }
    }
    return current;
  }
  async atomic(relative, bytes) {
    const target = await this.safe(relative, { createParents: true });
    const temporaryRelative = `${relative}.liuxu-${crypto.randomUUID()}.tmp`;
    const temporary = await this.safe(temporaryRelative);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await this.safe(relative); await this.safe(temporaryRelative);
      await fs.rename(temporary, target);
    } finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }
  async json(relative, value) { await this.atomic(relative, Buffer.from(JSON.stringify(value))); }
  async readBytes(relative, limit = MAX_FILE_BYTES) {
    const target = await this.safe(relative);
    const handle = await fs.open(target, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > limit) throw fail(413, '文件超过大小限制或不是普通文件');
      const bytes = await handle.readFile();
      const after = await handle.stat();
      await this.safe(relative);
      const current = await fs.stat(target);
      if (!sameStat(before, after) || !sameStat(after, current)) throw fail(409, '读取期间文件发生变化');
      if (!relative.startsWith('.liuxu/')) { this.metrics.contentReadCalls += 1; this.metrics.contentReadBytes += bytes.length; }
      return { bytes, stat: after, fingerprint: digest(bytes) };
    } finally { await handle.close(); }
  }
  async fingerprint(relative, { includeBytes = false } = {}) {
    const target = await this.safe(relative);
    const handle = await fs.open(target, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_FILE_BYTES) throw fail(413, '文件超过大小限制');
      if (includeBytes && before.size <= MAX_TEXT_BYTES) {
        const bytes = await handle.readFile();
        const after = await handle.stat();
        await this.safe(relative);
        if (!sameStat(before, after) || !sameStat(after, await fs.stat(target))) throw fail(409, '读取期间文件发生变化');
        this.metrics.fullHashCalls += 1; this.metrics.fullHashBytes += bytes.length;
        return { fingerprint: digest(bytes), stat: after, bytes };
      }
      if (before.size >= 8 * 1024 * 1024) {
        const observed = await this.hashWorker.request('inspect', { root: this.root, file: target, note: false });
        const after = await handle.stat();
        if (observed.stale || !sameStat(before, after) || !sameStat(after, await fs.stat(target))
          || observed.state.ino !== after.ino || observed.state.dev !== after.dev || observed.state.mtimeMs !== after.mtimeMs || observed.state.ctimeMs !== after.ctimeMs) throw fail(409, '读取期间文件发生变化');
        this.metrics.fullHashCalls += 1; this.metrics.fullHashBytes += after.size;
        return { fingerprint: observed.fingerprint.sha256, stat: after };
      }
      const hash = crypto.createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await handle.stat();
      await this.safe(relative);
      if (!sameStat(before, after) || !sameStat(after, await fs.stat(target))) throw fail(409, '读取期间文件发生变化');
      this.metrics.fullHashCalls += 1; this.metrics.fullHashBytes += after.size;
      return { fingerprint: hash.digest('hex'), stat: after };
    } finally { await handle.close(); }
  }
  async open() {
    await this.safe();
    const recordsDirectory = await this.safe('.liuxu/documents/placeholder', { createParents: true });
    for (const filename of await fs.readdir(path.dirname(recordsDirectory))) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}\.json$/.test(filename)) continue;
      const record = JSON.parse((await this.readBytes(`.liuxu/documents/${filename}`, MAX_TEXT_BYTES)).bytes);
      this.validateRecord(record);
      if (recordName(record.id) !== filename || this.records.has(record.id)) throw fail(409, '文档身份记录重复或损坏');
      this.records.set(record.id, record);
      if (record.status !== 'deleted') this.pathIds.set(record.relativePath, record.id);
    }
    // SQLite holds this rebuildable cache so a sidecar stays focused on stable
    // document metadata. The sidecar copy remains a recovery fallback.
    try {
      for (const observation of this.loadObservations() || []) {
        const record = this.records.get(observation.documentId);
        if (!record || record.status === 'deleted' || record.relativePath !== observation.relativePath
          || record.fingerprint !== observation.fingerprint) continue;
        record.fileState = observation.fileState;
      }
    } catch (error) { this.error = `文件状态缓存不可用，将重新核对：${error.message}`; }
    this.directories = [...new Set([...this.records.values()].filter(record => record.status !== 'deleted')
      .flatMap(record => {
        const parts = record.relativePath.split('/'); parts.pop();
        return parts.map((_part, index) => parts.slice(0, index + 1).join('/'));
      }))];
    this.knownDirectories = new Set(this.directories);
    await this.recover();
    try {
      const state = JSON.parse((await this.readBytes('.liuxu/scan-state.json', 64 * 1024)).bytes);
      if (state.version === 1 && Number.isFinite(Date.parse(state.lastDeepScanAt || ''))) this.lastDeepScanAt = state.lastDeepScanAt;
    } catch (error) { if (!missing(error)) this.error = `深度校验状态不可用：${error.message}`; }
    this.initializationState = 'ready';
    return this;
  }
  async persistScanState() {
    await this.json('.liuxu/scan-state.json', { version: 1, lastDeepScanAt: this.lastDeepScanAt });
  }
  validateRecord(record) {
    if (!record || !/^(note|file):[a-zA-Z0-9_-]+$/.test(record.id) || !Number.isSafeInteger(record.version) || record.version < 1) throw fail(400, '文档身份记录无效');
    relativePath(record.relativePath, { internal: record.status === 'deleted' });
    if (!['active', 'archived', 'deleted'].includes(record.status)) throw fail(400, '文档状态无效');
    if (!['note', 'file'].includes(record.sourceType) || !['normal', 'annotation', 'mindmap'].includes(record.documentRole || 'normal')) throw fail(400, '文档类型无效');
    if (record.fingerprint && !/^[a-f0-9]{64}$/.test(record.fingerprint)) throw fail(400, '文档指纹无效');
    if (record.title !== undefined && (typeof record.title !== 'string' || record.title.length > 200)) throw fail(400, '标题无效');
    if (!Array.isArray(record.tags || []) || (record.tags || []).length > 20 || (record.tags || []).some(tag => typeof tag !== 'string' || tag.length > 40)) throw fail(400, '标签无效');
  }
  async persist(record) {
    this.validateRecord(record);
    await this.json(`.liuxu/documents/${recordName(record.id)}`, record);
    try {
      if (record.status === 'deleted' || !record.fileState) this.removeObservation(record.id);
      else this.saveObservation({ documentId: record.id, relativePath: record.relativePath, fingerprint: record.fingerprint,
        fileState: record.fileState, checkedAt: now() });
    } catch (error) { this.error = `文件状态缓存待重建：${error.message}`; }
    this.remember(record); this.pendingMetadata.delete(record.id);
  }
  remember(record) {
    const previous = this.records.get(record.id);
    if (previous && this.pathIds.get(previous.relativePath) === record.id) this.pathIds.delete(previous.relativePath);
    this.records.set(record.id, record);
    if (record.status !== 'deleted') this.pathIds.set(record.relativePath, record.id);
  }
  async updateMetadata(id, input) {
    return this.withDocument(id, async () => {
      await this.guard(id, input);
      const previous = this.records.get(id);
      const next = { ...previous, version: previous.version + 1, updatedAt: now() };
      for (const key of ['title', 'tags', 'documentDate', 'pinnedAt']) if (input[key] !== undefined) next[key] = input[key];
      await this.persist(next);
      this.generation += 1;
      this.fileGeneration += 1;
      this.onChange({ type: 'file.changed', documentId: id });
      return { document: await this.observe(id) };
    });
  }
  async journal(operation) { await this.json(`.liuxu/operations/${operation.key}.json`, operation); }
  async clearJournal(key) { await fs.unlink(await this.safe(`.liuxu/operations/${key}.json`)).catch(error => { if (!missing(error)) throw error; }); }
  async recover() {
    let files;
    try { files = await fs.readdir(await this.safe('.liuxu/operations')); }
    catch (error) { if (missing(error)) return; throw error; }
    for (const filename of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
      const operation = JSON.parse((await this.readBytes(`.liuxu/operations/${filename}`, MAX_TEXT_BYTES)).bytes);
      if (operation.key !== filename.slice(0, -5) || !Array.isArray(operation.records)) throw fail(409, '文件恢复记录损坏');
      if (operation.directory) {
        const source = await this.safe(relativePath(operation.directory.from));
        const target = await this.safe(relativePath(operation.directory.to), { createParents: true });
        let targetExists = false;
        try { targetExists = (await fs.stat(target)).isDirectory(); } catch (error) { if (!missing(error)) throw error; }
        if (!targetExists) await fs.rename(source, target);
      }
      for (const entry of operation.records) {
        this.validateRecord(entry.next);
        const loaded = this.records.get(entry.next.id);
        if (loaded && loaded.version > entry.next.version) continue;
        const moving = entry.previous && entry.previous.relativePath !== entry.next.relativePath;
        let installed = false;
        try {
          const actual = await this.fingerprint(entry.next.relativePath);
          installed = actual.fingerprint === entry.next.fingerprint
            && (!entry.next.fileIdentity?.ino || (actual.stat.ino === entry.next.fileIdentity.ino && actual.stat.dev === entry.next.fileIdentity.dev));
        }
        catch (error) { if (!missing(error)) throw error; }
        if (!installed && moving) {
          this.validateRecord(entry.previous);
          let previous;
          try { previous = await this.fingerprint(entry.previous.relativePath); }
          catch (error) {
            if (!missing(error)) throw error;
            const actual = await this.fingerprint(entry.next.relativePath);
            await this.persist({ ...entry.next, fingerprint: actual.fingerprint, version: entry.next.version + 1 });
            continue;
          }
          if (previous.fingerprint !== entry.next.fingerprint) throw fail(409, '待恢复移动的源文件已被外部修改，恢复日志已保留');
          const target = await this.safe(entry.next.relativePath, { createParents: true });
          await fs.link(await this.safe(entry.previous.relativePath), target);
          await fs.unlink(await this.safe(entry.previous.relativePath));
          installed = true;
        }
        if (installed && moving) {
          // A crash can occur after link installation but before source removal.
          try {
            const previousPath = await this.safe(entry.previous.relativePath);
            const nextPath = await this.safe(entry.next.relativePath);
            const [left, right] = await Promise.all([fs.stat(previousPath), fs.stat(nextPath)]);
            if (left.ino === right.ino && left.dev === right.dev) await fs.unlink(previousPath);
          } catch (error) { if (!missing(error)) throw error; }
        }
        if (installed) await this.persist(entry.next);
        else if (entry.previous) {
          // Never overwrite new external bytes during recovery. Reconcile the actual file.
          const old = entry.previous;
          this.validateRecord(old);
          let oldExists = false;
          try { await this.safe(old.relativePath); oldExists = (await fs.stat(path.join(this.root, old.relativePath))).isFile(); }
          catch (error) { if (!missing(error)) throw error; }
          if (!oldExists) {
            try {
              const actual = await this.fingerprint(entry.next.relativePath);
              await this.persist({ ...entry.next, fingerprint: actual.fingerprint, version: entry.next.version + 1 });
            } catch (error) { if (!missing(error)) throw error; throw fail(409, '文件操作恢复不完整，恢复日志已保留'); }
          }
        }
      }
      await this.clearJournal(operation.key);
    }
  }
  metadataDocument(record, observed) {
    const location = record.relativePath.replace(/^\.archive\//, '');
    const parts = location.split('/'); parts.pop();
    const knowledgeBase = parts.shift() || ':root:';
    const filename = path.basename(record.relativePath);
    return { id: record.id, storageMode: 'files', sourceType: record.sourceType, sourceRef: record.relativePath,
      title: record.title || path.basename(filename, record.sourceType === 'note' ? '.md' : undefined),
      tags: record.tags || [], documentDate: record.documentDate || '', pinnedAt: record.pinnedAt || '',
      documentRole: record.documentRole || 'normal', parentDocumentId: record.parentDocumentId || null,
      knowledgeBase, folderPath: parts.join('/'), collectionPath: [knowledgeBase, ...parts].filter(Boolean).join('/'),
      status: record.status, version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt,
      relativePath: record.relativePath, baseFingerprint: observed.fingerprint,
      indexState: this.pendingIndex.has(record.id) ? 'pending' : 'ready', fileSync: { relativePath: record.relativePath, fingerprint: { sha256: observed.fingerprint } },
      fileMeta: record.sourceType === 'file' ? { filename, storedName: record.relativePath,
        mimeType: ALL_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream',
        bytes: observed.stat.size, sha256: observed.fingerprint,
        url: `/api/knowledge/files/${encodeURIComponent(record.id)}/content` } : null };
  }
  async observe(id, { index = true } = {}) {
    let record = this.records.get(id);
    if (!record) return null;
    let diskRecord;
    try { diskRecord = JSON.parse((await this.readBytes(`.liuxu/documents/${recordName(id)}`, MAX_TEXT_BYTES)).bytes); }
    catch (error) { if (!missing(error) || !this.pendingMetadata.has(id)) throw error; diskRecord = record; }
    this.validateRecord(diskRecord);
    if (diskRecord.id !== id) throw fail(409, '文档元数据身份不一致');
    if (diskRecord.version > record.version) { this.remember(diskRecord); record = diskRecord; this.generation += 1; }
    if (record.status === 'deleted') return null;
    if (record.parentDocumentId && (!this.records.has(record.parentDocumentId) || this.records.get(record.parentDocumentId).status === 'deleted')) return null;
    let observed;
    try { observed = record.sourceType === 'note' ? await this.readBytes(record.relativePath, MAX_TEXT_BYTES) : await this.fingerprint(record.relativePath); }
    catch (error) { if (missing(error)) return null; throw error; }
    let next = record;
    let metadataState = this.pendingMetadata.has(id) ? 'pending' : 'ready';
    const contentChanged = record.fingerprint !== observed.fingerprint;
    if (contentChanged) {
      next = { ...record, fingerprint: observed.fingerprint, version: record.version + 1, updatedAt: now() };
    }
    const fileState = observedFileState(observed.stat);
    if (next !== record || JSON.stringify(record.fileState || null) !== JSON.stringify(fileState)) {
      next = { ...next, fileIdentity: { ino: observed.stat.ino, dev: observed.stat.dev }, fileState };
      try { await this.persist(next); }
      catch (error) {
        this.remember(next); this.pendingMetadata.add(id); metadataState = 'pending';
        this.error = `已读取最新文件，元数据待恢复：${error.message}`;
        try { await this.journal({ key: crypto.randomUUID(), records: [{ previous: record, next }] }); } catch {}
      }
      if (contentChanged) {
        this.generation += 1;
        this.fileGeneration += 1;
        this.onChange({ type: 'file.changed', documentId: id });
      }
    }
    const doc = this.metadataDocument(next, observed);
    doc.metadataState = metadataState;
    if (next.sourceType === 'note') doc.content = decodeMarkdown(observed.bytes, next.relativePath).content;
    else if (TEXT_TYPES[path.extname(next.relativePath).toLowerCase()] && observed.stat.size <= MAX_TEXT_BYTES) {
      const data = await this.readBytes(next.relativePath, MAX_TEXT_BYTES);
      const decoded = decodeMarkdown(data.bytes, next.relativePath);
      doc.rawContent = decoded.header + decoded.content; doc.textFileBom = decoded.bom;
      doc.content = doc.rawContent; doc.textFileSupported = true; doc.textFileEditable = next.status === 'active';
    }
    if (index) await this.tryIndex(doc);
    return doc;
  }
  async tryIndex(document) {
    const baseline = `${document.version}:${document.baseFingerprint}:${document.relativePath}`;
    if (this.indexedBaselines.get(document.id) === baseline) { document.indexState = 'ready'; return; }
    if (this.isIndexCurrent(document)) {
      this.indexedBaselines.set(document.id, baseline);
      this.pendingIndex.delete(document.id);
      document.indexState = 'ready';
      return;
    }
    if (this.asyncIndex) {
      const retry = this.indexRetryTimers.get(document.id);
      if (retry) clearTimeout(retry);
      this.indexRetryTimers.delete(document.id);
      this.indexRetryAttempts.delete(document.id);
      this.pendingIndex.add(document.id); document.indexState = 'pending';
      if (!this.loadIndexDocument) this.queuedDocuments.set(document.id, structuredClone(document));
      else if (this.preparedIndexDocuments.has(document.id) || this.preparedIndexDocuments.size < 8) {
        this.preparedIndexDocuments.set(document.id, structuredClone(document));
      }
      this.indexQueue.set(document.id, { id: document.id, version: document.version,
        relativePath: document.relativePath, baseFingerprint: document.baseFingerprint });
      this.startIndexRunner();
      return;
    }
    await this.indexOne(document);
  }
  startIndexRunner() {
    if (this.indexRunner || !this.indexQueue.size) return;
    this.indexRunner = new Promise(resolve => setImmediate(resolve)).then(async () => {
      while (this.indexQueue.size) {
        const [id, token] = this.indexQueue.entries().next().value;
        this.indexQueue.delete(id);
        const record = this.records.get(id);
        if (!record || record.status === 'deleted') { this.pendingIndex.delete(id); continue; }
        if (record.version !== token.version || record.relativePath !== token.relativePath || record.fingerprint !== token.baseFingerprint) {
          if (!this.indexQueue.has(id)) this.pendingIndex.delete(id);
          continue;
        }
        try {
          const prepared = this.preparedIndexDocuments.get(id);
          const document = prepared?.version === token.version ? prepared
            : this.loadIndexDocument ? await this.loadIndexDocument(token) : this.queuedDocuments.get(id);
          if (!document || document.version !== token.version || document.relativePath !== token.relativePath
            || document.baseFingerprint !== token.baseFingerprint) {
            if (!this.indexQueue.has(id)) this.pendingIndex.delete(id);
            continue;
          }
          if (this.queuedDocuments.get(id)?.version === token.version) this.queuedDocuments.delete(id);
          if (prepared?.version === token.version) this.preparedIndexDocuments.delete(id);
          await this.indexOne(document);
        } catch (error) {
          this.error = `索引待重试：${error.message}`;
          this.pendingIndex.add(id);
          this.scheduleIndexRetry(token);
        }
      }
    }).finally(() => {
      this.indexRunner = null;
      if (this.indexQueue.size) this.startIndexRunner();
      else this.publishIndexChange();
    });
  }
  async indexOne(document) {
    try {
      await this.indexDocument(document);
      this.indexedBaselines.set(document.id, `${document.version}:${document.baseFingerprint}:${document.relativePath}`);
      if (!this.indexQueue.has(document.id)) this.pendingIndex.delete(document.id);
      document.indexState = 'ready';
      this.metrics.indexedDocuments += 1;
      this.indexDirty = true;
    } catch (error) {
      this.pendingIndex.add(document.id); document.indexState = 'pending'; this.error = `索引待重试：${error.message}`;
      this.scheduleIndexRetry({ id: document.id, version: document.version, relativePath: document.relativePath, baseFingerprint: document.baseFingerprint });
    }
  }
  scheduleIndexRetry(token) {
    if (this.indexRetryTimers.has(token.id) || this.closed) return;
    const attempt = this.indexRetryAttempts.get(token.id) || 0;
    const delay = [5000, 30000, 120000][attempt] || 300000;
    this.indexRetryAttempts.set(token.id, attempt + 1);
    const timer = setTimeout(() => {
      this.indexRetryTimers.delete(token.id);
      const record = this.records.get(token.id);
      if (!record || record.status === 'deleted' || record.version !== token.version
        || record.relativePath !== token.relativePath || record.fingerprint !== token.baseFingerprint) {
        this.pendingIndex.delete(token.id);
        return;
      }
      this.indexQueue.set(token.id, token);
      this.startIndexRunner();
    }, delay);
    timer.unref?.();
    this.indexRetryTimers.set(token.id, timer);
  }
  publishIndexChange() {
    if (!this.indexDirty || this.indexRunner || this.indexQueue.size || this.scanStatus === 'scanning') return;
    this.indexDirty = false;
    this.indexGeneration += 1;
    this.onChange({ type: 'index.changed' });
  }
  async flushIndex() { while (this.indexRunner) await this.indexRunner; this.publishIndexChange(); }
  async read(id) { return this.withDocument(id, () => this.observe(String(id))); }
  async verifyMetadataBaseline(record) {
    const saved = JSON.parse((await this.readBytes(`.liuxu/documents/${recordName(record.id)}`, MAX_TEXT_BYTES)).bytes);
    if (saved.id !== record.id || saved.version !== record.version || saved.relativePath !== record.relativePath || saved.fingerprint !== record.fingerprint) throw fail(409, '文件元数据已变化或尚未恢复，草稿已保留');
  }
  async guard(id, input, { archived = false } = {}) {
    if (!Number.isSafeInteger(input?.baseVersion) || !/^[a-f0-9]{64}$/.test(input?.baseFingerprint || '')) throw fail(400, 'baseVersion 和 baseFingerprint 必填');
    const doc = await this.observe(id);
    if (!doc) throw fail(404, '文件不存在');
    if (!archived && doc.status === 'archived') throw fail(403, '文件已归档');
    if (doc.version !== input.baseVersion || doc.baseFingerprint !== input.baseFingerprint) throw fail(409, '文件已变化，草稿已保留', doc);
    await this.verifyMetadataBaseline(this.records.get(id));
    return doc;
  }
  async available(relative) {
    relativePath(relative);
    const extension = path.extname(relative); const base = relative.slice(0, relative.length - extension.length);
    let candidate = relative;
    for (let suffix = 1; ; suffix++) {
      try { await fs.lstat(await this.safe(candidate)); candidate = `${base} (${suffix})${extension}`; }
      catch (error) { if (missing(error)) return candidate; throw error; }
    }
  }
  async commit(operation, install) {
    for (const entry of operation.records) this.validateRecord(entry.next);
    await this.journal(operation);
    await install(); // This is the content commit point. Never roll it back for an index error.
    this.generation += 1;
    this.fileGeneration += 1;
    if (operation.records.some(entry => !entry.previous || entry.previous.relativePath !== entry.next.relativePath
      || entry.previous.status !== entry.next.status)) this.directoryGeneration += 1;
    this.onChange({ type: 'file.changed', documentId: operation.records[0]?.next?.id || '' });
    if (operation.records.some(entry => !entry.previous || entry.previous.relativePath !== entry.next.relativePath
      || entry.previous.status !== entry.next.status)) this.onChange({ type: 'directories.changed' });
    try {
      for (const entry of operation.records) await this.persist(entry.next);
      await this.clearJournal(operation.key);
    } catch (error) {
      for (const entry of operation.records) { this.remember(entry.next); this.pendingMetadata.add(entry.next.id); }
      this.error = `文件已保存，元数据待恢复：${error.message}`;
      return false;
    }
    return true;
  }
  async create(input = {}) {
    return this.exclusive(async () => {
      const sourceType = input.sourceType === 'file' ? 'file' : 'note';
      const filename = input.filename || `${sanitizeSegment(input.title || '未命名笔记')}.md`;
      const location = input.relativePath || [input.knowledgeBase === ':root:' ? '' : input.knowledgeBase, input.folderPath, filename].filter(Boolean).join('/');
      const relative = await this.available(location);
      const bytes = input.sourceFilePath ? null : input.bytes || Buffer.from(String(input.content || ''), 'utf8');
      if (bytes && (!Buffer.isBuffer(bytes) || bytes.length > (sourceType === 'note' ? MAX_TEXT_BYTES : MAX_FILE_BYTES))) throw fail(413, '文件超过大小限制');
      if (sourceType === 'note' && bytes) decodeMarkdown(bytes, relative);
      const id = input.id || `${sourceType}:${crypto.randomUUID().replace(/-/g, '')}`;
      if (this.records.has(id)) throw fail(409, '文档 ID 已存在');
      const record = { id, relativePath: relative, sourceType, documentRole: input.documentRole || 'normal',
        parentDocumentId: input.parentDocumentId || null, title: input.title || '', tags: input.tags || [],
        documentDate: input.documentDate || '', pinnedAt: input.pinnedAt || '', status: 'active', version: 1,
        fingerprint: bytes ? digest(bytes) : '', createdAt: now(), updatedAt: now() };
      this.validateRecord(record);
      const staging = `${relative}.liuxu-${crypto.randomUUID()}.tmp`;
      const staged = await this.safe(staging, { createParents: true });
      const handle = await fs.open(staged, 'wx', 0o600);
      let durable;
      try {
        if (input.sourceFilePath) {
          if ((await fs.lstat(input.sourceFilePath)).isSymbolicLink()) throw fail(400, '导入源不能是符号链接');
          const source = await fs.open(input.sourceFilePath, 'r');
          try {
            const before = await source.stat();
            if (!before.isFile() || before.size > MAX_FILE_BYTES) throw fail(413, '导入源无效或超过大小限制');
            const hash = crypto.createHash('sha256');
            for await (const chunk of source.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
              hash.update(chunk); await handle.writeFile(chunk);
            }
            if (!sameStat(before, await source.stat()) || !sameStat(before, await fs.stat(input.sourceFilePath))) throw fail(409, '导入期间源文件发生变化');
            record.fingerprint = hash.digest('hex');
            if (input.sourceSha256 && input.sourceSha256 !== record.fingerprint) throw fail(409, '导入源校验不匹配');
          } finally { await source.close(); }
        } else await handle.writeFile(bytes);
        const stat = await handle.stat(); record.fileIdentity = { ino: stat.ino, dev: stat.dev }; record.fileState = observedFileState(stat);
        await handle.sync(); await handle.close();
        durable = await this.commit({ key: crypto.randomUUID(), records: [{ next: record }] }, async () => {
          // Hard-link installation provides no-clobber semantics for a new path.
          await this.safe(relative); await this.safe(staging); await fs.link(staged, await this.safe(relative));
        });
      } finally { await handle.close().catch(() => {}); await fs.unlink(staged).catch(() => {}); }
      const document = await this.observe(id);
      return { document, metadataState: durable ? 'ready' : 'pending' };
    });
  }
  async save(id, input) {
    return this.withDocument(id, async () => {
      const current = await this.guard(id, input);
      const previous = this.records.get(id);
      const data = await this.readBytes(previous.relativePath, MAX_TEXT_BYTES);
      const decoded = decodeMarkdown(data.bytes, previous.relativePath);
      const body = input.content === undefined ? (previous.sourceType === 'note' ? decoded.content : decoded.header + decoded.content) : input.content;
      if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_TEXT_BYTES || /\u0000/.test(body)) throw fail(413, '文本内容无效或超过大小限制');
      const newlineBody = decoded.newline === '\r\n' ? body.replace(/\r?\n/g, '\r\n') : body;
      const text = (previous.sourceType === 'note' ? decoded.header : '') + newlineBody;
      const bytes = Buffer.from(`${input.bom === undefined ? (decoded.bom ? '\uFEFF' : '') : (input.bom ? '\uFEFF' : '')}${text}`);
      if (bytes.length > MAX_TEXT_BYTES) throw fail(413, '文本超过大小限制');
      const next = { ...previous, version: previous.version + 1, fingerprint: digest(bytes), updatedAt: now() };
      for (const key of ['title', 'tags', 'documentDate', 'pinnedAt']) if (input[key] !== undefined) next[key] = input[key];
      this.validateRecord(next);
      const temporaryRelative = `${previous.relativePath}.liuxu-${crypto.randomUUID()}.tmp`;
      const temporary = await this.safe(temporaryRelative);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.chmod(data.stat.mode & 0o777); await handle.writeFile(bytes); await handle.sync();
        const stat = await handle.stat(); next.fileIdentity = { ino: stat.ino, dev: stat.dev }; next.fileState = observedFileState(stat);
      } finally { await handle.close(); }
      let durable;
      try {
        durable = await this.commit({ key: crypto.randomUUID(), records: [{ previous, next }] }, async () => {
          const observed = await this.fingerprint(previous.relativePath);
          if (observed.fingerprint !== current.baseFingerprint) throw fail(409, '保存期间文件被外部修改', await this.observe(id));
          const target = await this.safe(previous.relativePath); await this.safe(temporaryRelative);
          await this.verifyMetadataBaseline(previous);
          await fs.rename(temporary, target);
        });
      } finally { await fs.unlink(temporary).catch(() => {}); }
      return { document: await this.observe(id), metadataState: durable ? 'ready' : 'pending' };
    });
  }
  async move(id, input, action = 'move') {
    const childIds = [...this.records.values()].filter(record => record.parentDocumentId === id && record.status !== 'deleted').map(record => record.id);
    return this.withDocuments([id, ...childIds], async () => {
      const current = await this.guard(id, input, { archived: action === 'restore' || action === 'delete' });
      const parent = this.records.get(id);
      let destination = input.relativePath;
      if (action === 'archive') destination = `.archive/${parent.relativePath}`;
      if (action === 'restore') destination = parent.relativePath.replace(/^\.archive\//, '');
      if (action === 'delete') destination = `.liuxu/trash/${crypto.randomUUID()}/${parent.relativePath.replace(/^\.archive\//, '')}`;
      destination = relativePath(destination, { internal: action === 'delete' });
      const entries = [];
      const children = [...this.records.values()].filter(record => record.parentDocumentId === id && record.status !== 'deleted');
      for (const previous of [parent, ...children]) {
        const target = previous === parent ? destination : path.posix.join(path.posix.dirname(destination), path.posix.basename(previous.relativePath));
        const old = await this.fingerprint(previous.relativePath);
        if (previous === parent && old.fingerprint !== current.baseFingerprint) throw fail(409, '文件已变化', current);
        const full = await this.safe(target, { createParents: true });
        if (target !== previous.relativePath) {
          try { await fs.lstat(full); throw fail(409, '目标路径已存在'); } catch (error) { if (!missing(error)) throw error; }
        }
        entries.push({ previous, next: { ...previous, relativePath: target, fingerprint: old.fingerprint,
          status: action === 'archive' ? 'archived' : action === 'delete' ? 'deleted' : 'active',
          version: previous.version + 1, updatedAt: now() } });
      }
      // Copy dependencies without modifying their source. Abort before moving documents on unsafe paths.
      for (const entry of entries.filter(entry => entry.previous.sourceType === 'note' && action !== 'delete')) {
        const data = await this.readBytes(entry.previous.relativePath, MAX_TEXT_BYTES);
        for (const token of markdownImageTokens(decodeMarkdown(data.bytes, entry.previous.relativePath).content).tokens) {
          let source; try { source = decodeURIComponent(token.source.split(/[?#]/)[0]); } catch { continue; }
          if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(source)) continue;
          const from = path.posix.normalize(path.posix.join(path.posix.dirname(entry.previous.relativePath), source));
          const to = path.posix.normalize(path.posix.join(path.posix.dirname(entry.next.relativePath), source));
          relativePath(from); relativePath(to);
          if (from === to) continue;
          const image = await this.readBytes(from);
          let existing;
          try { existing = await this.readBytes(to); } catch (error) { if (!missing(error)) throw error; }
          if (existing && existing.fingerprint !== image.fingerprint) throw fail(409, '目标图片与现有文件冲突');
          if (!existing) { const target = await this.safe(to, { createParents: true }); await fs.copyFile(await this.safe(from), target, require('node:fs').constants.COPYFILE_EXCL); }
        }
      }
      const durable = await this.commit({ key: crypto.randomUUID(), records: entries }, async () => {
        for (const entry of entries) {
          if ((await this.fingerprint(entry.previous.relativePath)).fingerprint !== entry.next.fingerprint) throw fail(409, '移动期间文件被外部修改');
          if (entry.previous.relativePath === entry.next.relativePath) continue;
          const source = await this.safe(entry.previous.relativePath), target = await this.safe(entry.next.relativePath);
          await fs.link(source, target); await fs.unlink(source);
        }
      });
      for (const entry of entries) {
        if (entry.next.status === 'deleted') { try { await this.removeIndex(entry.next.id); } catch { this.pendingIndex.add(entry.next.id); } }
        else await this.observe(entry.next.id);
      }
      return { document: action === 'delete' ? current : await this.observe(id), deleted: action === 'delete', metadataState: durable ? 'ready' : 'pending' };
    });
  }
  async createDirectory(relative) {
    return this.exclusive(async () => {
      relativePath(relative);
      const target = await this.safe(`${relative}/placeholder`, { createParents: true });
      this.directories ||= [];
      if (!this.directories.includes(relative)) this.directories.push(relative);
      this.generation += 1;
      this.directoryGeneration += 1;
      this.onChange({ type: 'directories.changed' });
      return { success: true, path: path.dirname(target) };
    });
  }
  async moveDirectory(from, to) {
    return this.withStructure(async () => {
      from = relativePath(from); to = relativePath(to);
      if (to === from || to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) throw fail(409, '目录不能移入自身或覆盖父目录');
      const source = await this.safe(from), target = await this.safe(to, { createParents: true });
      if (!(await fs.stat(source)).isDirectory()) throw fail(400, '源路径不是目录');
      try { await fs.lstat(target); throw fail(409, '目标目录已存在'); } catch (error) { if (!missing(error)) throw error; }
      const records = [...this.records.values()].filter(record => record.status !== 'deleted' && record.relativePath.startsWith(`${from}/`));
      const entries = [];
      for (const previous of records) {
        const observed = await this.fingerprint(previous.relativePath);
        entries.push({ previous, next: { ...previous, fingerprint: observed.fingerprint, relativePath: `${to}${previous.relativePath.slice(from.length)}`,
          version: previous.version + 1, updatedAt: now() } });
      }
      const dependencies = new Map();
      for (const entry of entries.filter(entry => entry.previous.sourceType === 'note')) {
        const data = await this.readBytes(entry.previous.relativePath, MAX_TEXT_BYTES);
        for (const token of markdownImageTokens(decodeMarkdown(data.bytes, entry.previous.relativePath).content).tokens) {
          let image; try { image = decodeURIComponent(token.source.split(/[?#]/)[0]); } catch { continue; }
          if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(image)) continue;
          const sourceRelative = path.posix.normalize(path.posix.join(path.posix.dirname(entry.previous.relativePath), image));
          const targetRelative = path.posix.normalize(path.posix.join(path.posix.dirname(entry.next.relativePath), image));
          if (sourceRelative.startsWith(`${from}/`) || sourceRelative === targetRelative) continue;
          relativePath(sourceRelative); relativePath(targetRelative);
          const bytes = await this.readBytes(sourceRelative);
          try {
            const existing = await this.readBytes(targetRelative);
            if (existing.fingerprint !== bytes.fingerprint) throw fail(409, '目标图片与现有文件冲突');
          } catch (error) { if (!missing(error)) throw error; dependencies.set(targetRelative, { sourceRelative, bytes }); }
        }
      }
      for (const [relative, dependency] of dependencies) {
        await fs.copyFile(await this.safe(dependency.sourceRelative), await this.safe(relative, { createParents: true }), require('node:fs').constants.COPYFILE_EXCL);
      }
      const durable = await this.commit({ key: crypto.randomUUID(), directory: { from, to }, records: entries }, async () => {
        await this.safe(from); await this.safe(to);
        await fs.rename(source, target);
      });
      for (const entry of entries) await this.observe(entry.next.id);
      this.directories = (this.directories || []).map(relative => relative === from || relative.startsWith(`${from}/`) ? `${to}${relative.slice(from.length)}` : relative);
      return { moved: true, oldPath: from, newPath: to, metadataState: durable ? 'ready' : 'pending' };
    });
  }
  async scan({ deep = false } = {}) {
    if (this.scanning) {
      if (deep) this.deepScanRequested = true;
      return this.scanning;
    }
    this.scanStatus = 'scanning';
    this.initializationState = 'checking';
    this.scanProgress = { visited: 0, total: 0 };
    this.scanning = (async () => {
      let result;
      do {
        const runDeep = deep || this.deepScanRequested;
        this.deepScanRequested = false;
        result = await this.scanPass({ deep: runDeep });
        if (runDeep) { this.lastDeepScanAt = now(); await this.persistScanState(); }
        deep = false;
      } while (this.deepScanRequested);
      this.lastScanAt = now();
      this.scanStatus = 'idle';
      this.initializationState = 'ready';
      this.publishIndexChange();
      return result;
    })();
    try { return await this.scanning; }
    catch (error) { this.scanStatus = 'error'; this.initializationState = 'error'; this.error = error.message; throw error; }
    finally { this.scanning = null; }
  }
  async refreshPaths(paths) {
    if (this.scanning) await this.scanning;
    const observed = new Map();
    for (const input of paths) {
      const relative = relativePath(input);
      this.dirtyPaths.add(relative);
      try {
        const file = await this.safe(relative);
        const stat = await fs.stat(file);
        if (stat.isDirectory()) return this.scan();
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_BYTES) {
          this.skippedFiles = [...new Set([...(this.skippedFiles || []), relative])];
          this.dirtyPaths.delete(relative);
          continue;
        }
        this.skippedFiles = (this.skippedFiles || []).filter(item => item !== relative);
        observed.set(relative, stat);
      } catch (error) {
        if (!missing(error)) throw error;
        if ((this.directories || []).includes(relative)) return this.scan();
        const parent = await this.safe(path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
        if (!(await fs.stat(parent)).isDirectory()) return this.scan();
        observed.set(relative, null);
      }
    }
    return this.exclusive(async () => {
      // Match additions before deletions so rename notifications retain identity.
      for (const [relative, stat] of observed) {
        if (!stat) continue;
        const knownId = this.pathIds.get(relative);
        if (knownId) { await this.withDocument(knownId, () => this.observe(knownId)); this.dirtyPaths.delete(relative); continue; }
        const data = await this.fingerprint(relative);
        const candidates = [...this.records.values()].filter(record => record.status !== 'deleted'
          && record.fileIdentity?.ino > 0 && record.fileIdentity?.ino === data.stat.ino && record.fileIdentity?.dev === data.stat.dev);
        let previous = null;
        if (candidates.length === 1) {
          try { await fs.stat(await this.safe(candidates[0].relativePath)); }
          catch (error) { if (!missing(error)) throw error; previous = candidates[0]; }
        }
        const decoded = path.extname(relative).toLowerCase() === '.md' && data.stat.size <= MAX_TEXT_BYTES
          ? decodeMarkdown((await this.readBytes(relative, MAX_TEXT_BYTES)).bytes, relative) : null;
        const record = { ...previous, id: previous?.id || `${decoded ? 'note' : 'file'}:${crypto.randomUUID().replace(/-/g, '')}`,
          relativePath: relative, sourceType: previous?.sourceType || (decoded ? 'note' : 'file'),
          ...metadataFields(decoded?.metadata), ...(previous ? { title: previous.title, tags: previous.tags, documentDate: previous.documentDate, documentRole: previous.documentRole, parentDocumentId: previous.parentDocumentId } : {}),
          status: relative.startsWith('.archive/') ? 'archived' : 'active', version: previous ? previous.version + 1 : 1,
          fingerprint: data.fingerprint, fileIdentity: { ino: data.stat.ino, dev: data.stat.dev }, fileState: observedFileState(data.stat), createdAt: previous?.createdAt || now(), updatedAt: now() };
        await this.persist(record); await this.observe(record.id); this.generation += 1; this.fileGeneration += 1;
        this.directoryGeneration += 1;
        this.onChange({ type: 'file.changed', documentId: record.id });
        this.onChange({ type: 'directories.changed' });
      }
      for (const [relative, stat] of observed) {
        if (stat) continue;
        const id = this.pathIds.get(relative);
        if (!id) continue;
        // Validate the exact missing path again after processing additions.
        try { await fs.stat(await this.safe(relative)); continue; } catch (error) { if (!missing(error)) throw error; }
        const previous = this.records.get(id);
        await this.persist({ ...previous, status: 'deleted', version: previous.version + 1, updatedAt: now() });
        try { await this.removeIndex(id); } catch { this.pendingIndex.add(id); }
        this.generation += 1; this.fileGeneration += 1;
        this.directoryGeneration += 1;
        this.onChange({ type: 'file.changed', documentId: id });
        this.onChange({ type: 'directories.changed' });
        this.dirtyPaths.delete(relative);
      }
      return this.snapshot();
    });
  }
  async scanPass({ deep = false } = {}) {
      this.metrics.scanPasses += 1;
      const initialGeneration = this.generation;
      const files = [];
      const directories = [];
      const walk = async relative => {
        const subdirectories = [];
        const directFiles = [];
        for (const entry of await fs.readdir(await this.safe(relative), { withFileTypes: true })) {
          if (entry.name === '.liuxu' || entry.name.includes('.liuxu-')) continue;
          if (entry.isSymbolicLink()) throw fail(400, '目录包含符号链接，索引核对已暂停');
          const child = [relative, entry.name].filter(Boolean).join('/');
          if (entry.isDirectory()) { directories.push(child); subdirectories.push(child); }
          else if (entry.isFile()) directFiles.push(child);
        }
        for (let offset = 0; offset < directFiles.length; offset += 8) {
          const batch = await Promise.all(directFiles.slice(offset, offset + 8).map(async child => ({ relative: child, stat: await fs.stat(await this.safe(child)) })));
          files.push(...batch);
        }
        for (const child of subdirectories) await walk(child);
      };
      await walk(''); // Do not infer deletions if enumeration fails.
      const oversized = new Set(files.filter(file => file.stat.size > MAX_FILE_BYTES).map(file => file.relative));
      const inspect = async (relative, options) => {
        if (oversized.has(relative)) return null;
        try { return await this.fingerprint(relative, options); }
        catch (error) {
          if (error.status !== 413) throw error;
          oversized.add(relative); this.skippedFiles = [...oversized]; return null;
        }
      };
      this.skippedFiles = [...oversized];
      const paths = new Map([...this.records.values()].filter(record => record.status !== 'deleted').map(record => [record.relativePath, record]));
      this.scanProgress = { visited: 0, total: files.length };
      const known = new Set(files.map(file => file.relative));
      const absent = [...paths.values()].filter(record => !known.has(record.relativePath));
      if (!this.records.size) {
        this.directories = directories;
        const oldDirectories = JSON.stringify([...(this.knownDirectories || [])].sort());
        const nextDirectories = JSON.stringify([...directories].sort());
        if (oldDirectories !== nextDirectories) {
          this.knownDirectories = new Set(directories);
          this.directoryGeneration += 1;
          this.onChange({ type: 'directories.changed' });
        }
        const claimed = new Set();
        const register = async ({ relative }) => {
          const extension = path.extname(relative).toLowerCase();
          const isText = extension === '.md' || TEXT_TYPES[extension];
          const observed = await inspect(relative, { includeBytes: Boolean(isText) });
          if (!observed) { this.scanProgress.visited += 1; return; }
          const decoded = observed.bytes && isText ? decodeMarkdown(observed.bytes, relative) : null;
          const note = extension === '.md' && decoded;
          const legacyId = String(note?.metadata.liuxu_id || '');
          const id = /^(note|file):(?:[1-9]\d*|[a-f0-9]{32})$/.test(legacyId) && !claimed.has(legacyId)
            ? legacyId : `${note ? 'note' : 'file'}:${crypto.randomUUID().replace(/-/g, '')}`;
          claimed.add(id);
          const record = { id, relativePath: relative, sourceType: extension === '.md' && decoded ? 'note' : 'file',
            ...metadataFields(note?.metadata),
            status: relative.startsWith('.archive/') ? 'archived' : 'active', version: 1, fingerprint: observed.fingerprint,
            fileIdentity: { ino: observed.stat.ino, dev: observed.stat.dev }, fileState: observedFileState(observed.stat), createdAt: now(), updatedAt: now() };
          await this.persist(record);
          const document = this.metadataDocument(record, observed);
          if (record.sourceType === 'note') document.content = decoded?.content || '';
          else if (decoded) {
            document.rawContent = decoded.header + decoded.content; document.content = document.rawContent;
            document.textFileSupported = true; document.textFileEditable = record.status === 'active'; document.textFileBom = decoded.bom;
          }
          await this.tryIndex(document);
          this.scanProgress.visited += 1;
          this.metrics.scanVisited += 1;
        };
        // Discovery writes independent identity files; bounded concurrency avoids
        // making the first open wait for one fsync per file in series.
        for (let offset = 0; offset < files.length; offset += 8) {
          const results = await Promise.allSettled(files.slice(offset, offset + 8).map(register));
          const failed = results.find(result => result.status === 'rejected');
          if (failed) throw failed.reason;
          this.generation += 1;
          this.fileGeneration += 1;
          this.onChange({ type: 'files.changed' });
          await new Promise(resolve => setImmediate(resolve));
        }
        this.lastDeepScanAt = now(); await this.persistScanState();
        return this.snapshot();
      }
      const unknown = new Map();
      const unknownCounts = new Map();
      const unknownPaths = files.filter(file => !paths.has(file.relative));
      for (let offset = 0; offset < unknownPaths.length; offset += 8) {
        const batch = await Promise.all(unknownPaths.slice(offset, offset + 8).map(async ({ relative }) => {
          const extension = path.extname(relative).toLowerCase();
          const includeBytes = extension === '.md' || (TEXT_TYPES[extension] && (await fs.stat(await this.safe(relative))).size <= MAX_TEXT_BYTES);
          return [relative, await inspect(relative, { includeBytes })];
        }));
        for (const [relative, observed] of batch) {
          unknown.set(relative, observed);
          if (!observed) continue;
          unknownCounts.set(observed.fingerprint, (unknownCounts.get(observed.fingerprint) || 0) + 1);
        }
      }
      let indexedBatch = 0;
      for (const file of files) {
        const { relative, stat } = file;
        this.scanProgress.visited += 1;
        this.metrics.scanVisited += 1;
        if (oversized.has(relative)) continue;
        if (this.closed) throw Object.assign(new Error('索引核对已取消'), { code: 'SYNC_CANCELLED' });
        const existing = paths.get(relative);
        const dirty = this.dirtyPaths.has(relative);
        const indexed = existing && (this.indexedBaselines.get(existing.id) === `${existing.version}:${existing.fingerprint}:${existing.relativePath}`
          || this.isIndexCurrent({ id: existing.id, version: existing.version, relativePath: existing.relativePath, baseFingerprint: existing.fingerprint }));
        if (existing && !deep && !dirty && JSON.stringify(existing.fileState || null) === JSON.stringify(observedFileState(stat)) && indexed) {
          this.metrics.scanSkipped += 1;
          continue;
        }
        if (existing) {
          await this.withDocument(existing.id, async () => {
            const record = this.records.get(existing.id);
            if (record && record.status !== 'deleted' && record.relativePath === relative) await this.observe(record.id);
          });
        } else await this.exclusive(async () => {
          let record;
          let observed; try { observed = unknown.get(relative) || await this.fingerprint(relative); } catch (error) { if (error.status === 413) return; throw error; }
          const decoded = observed.bytes && (path.extname(relative).toLowerCase() === '.md' || TEXT_TYPES[path.extname(relative).toLowerCase()])
            ? decodeMarkdown(observed.bytes, relative) : null;
          const note = path.extname(relative).toLowerCase() === '.md' && decoded;
          const candidates = absent.filter(item => item.fingerprint === observed.fingerprint);
          const legacyId = note?.metadata.liuxu_id;
          const identities = absent.filter(item => item.fileIdentity?.ino > 0 && item.fileIdentity?.ino === observed.stat.ino && item.fileIdentity?.dev === observed.stat.dev);
          const old = identities.length === 1 ? identities[0] : unknownCounts.get(observed.fingerprint) === 1
            ? absent.find(item => item.id === legacyId) || (candidates.length === 1 && files.filter(file => paths.get(file.relative)?.fingerprint === observed.fingerprint).length === 0 ? candidates[0] : null)
            : null;
          const id = old?.id || `${note ? 'note' : 'file'}:${crypto.randomUUID().replace(/-/g, '')}`;
          record = { ...old, id, relativePath: relative, sourceType: old?.sourceType || (note ? 'note' : 'file'),
            ...metadataFields(note?.metadata), ...(old ? { title: old.title, tags: old.tags, documentDate: old.documentDate, documentRole: old.documentRole, parentDocumentId: old.parentDocumentId } : {}),
            status: relative.startsWith('.archive/') ? 'archived' : 'active', version: old ? old.version + 1 : 1,
            fingerprint: observed.fingerprint, fileIdentity: { ino: observed.stat.ino, dev: observed.stat.dev }, fileState: observedFileState(observed.stat), createdAt: old?.createdAt || now(), updatedAt: now() };
          await this.persist(record); paths.set(relative, record);
          if (old) absent.splice(absent.indexOf(old), 1);
          const document = this.metadataDocument(record, observed);
          if (record.sourceType === 'note') document.content = decoded?.content || '';
          else if (decoded) {
            document.rawContent = decoded.header + decoded.content; document.content = document.rawContent;
            document.textFileSupported = true; document.textFileEditable = record.status === 'active'; document.textFileBom = decoded.bom;
          }
          await this.tryIndex(document);
          this.generation += 1; this.fileGeneration += 1;
          if (!old || old.relativePath !== relative) this.directoryGeneration += 1;
          this.onChange({ type: 'file.changed', documentId: record.id });
          if (!old || old.relativePath !== relative) this.onChange({ type: 'directories.changed' });
        });
        this.dirtyPaths.delete(relative);
        indexedBatch += 1;
        if (indexedBatch >= 8) { indexedBatch = 0; await new Promise(resolve => setImmediate(resolve)); }
      }
      await this.exclusive(async () => {
        // A save or move during enumeration invalidates negative evidence.
        if (this.generation !== initialGeneration) return;
      for (const record of absent) {
        await this.persist({ ...record, status: 'deleted', version: record.version + 1, updatedAt: now() });
        try { await this.removeIndex(record.id); this.pendingIndex.delete(record.id); } catch { this.pendingIndex.add(record.id); }
        this.generation += 1; this.fileGeneration += 1;
        this.directoryGeneration += 1;
        this.onChange({ type: 'file.changed', documentId: record.id });
        this.onChange({ type: 'directories.changed' });
      }
      });
      this.directories = directories;
      const oldDirectories = JSON.stringify([...(this.knownDirectories || [])].sort());
      const nextDirectories = JSON.stringify([...directories].sort());
      if (oldDirectories !== nextDirectories) {
        this.knownDirectories = new Set(directories);
        this.directoryGeneration += 1;
        this.onChange({ type: 'directories.changed' });
      }
      return this.snapshot();
  }
  snapshot() { return { storage: FORMAT, version: VERSION, generation: this.generation, fileGeneration: this.fileGeneration,
    directoryGeneration: this.directoryGeneration, indexGeneration: this.indexGeneration,
    rootPath: this.root, enabled: true, error: this.error, isScanning: this.scanStatus === 'scanning',
    initializationState: this.initializationState, scanStatus: this.scanStatus, scanProgress: this.scanProgress,
    lastScanAt: this.lastScanAt, lastDeepScanAt: this.lastDeepScanAt,
    metrics: { ...this.metrics },
    skippedFiles: (this.skippedFiles || []).slice(0, 50), skippedFileCount: (this.skippedFiles || []).length,
    pendingIndex: this.pendingIndex.size, pendingIndexCount: this.pendingIndex.size,
    documents: [...this.records.values()].filter(record => record.status !== 'deleted').length,
    directories: this.directories || [] }; }
  start() {
    if (this.watcher || this.timer || this.closed) return;
    let debounce, maximum;
    const pending = new Set(); let reconcile = false;
    const run = () => {
      clearTimeout(debounce); clearTimeout(maximum); debounce = null; maximum = null;
      const paths = [...pending]; pending.clear();
      const full = reconcile; reconcile = false;
      void (full ? this.scan() : this.refreshPaths(paths)).catch(error => { this.error = error.message; });
    };
    const refresh = filename => {
      if (!filename || pending.size >= 1000) { reconcile = true; pending.clear(); }
      else if (!reconcile) pending.add(String(filename).replace(/\\/g, '/'));
      clearTimeout(debounce); debounce = setTimeout(run, 650); debounce.unref?.();
      if (!maximum) { maximum = setTimeout(run, 2000); maximum.unref?.(); }
    };
    try {
      this.watcher = require('node:fs').watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename || (!String(filename).startsWith('.liuxu') && !String(filename).includes('.liuxu-'))) refresh(filename);
      });
      this.watcher.on('error', error => { this.error = error.message; this.watcher?.close(); this.watcher = null; });
    } catch (error) { this.error = error.message; }
    this.timer = setInterval(() => refresh(), 300000); this.timer.unref?.();
    this.deepTimer = setInterval(() => { void this.scan({ deep: true }).catch(error => { this.error = error.message; }); }, 24 * 60 * 60 * 1000);
    this.deepTimer.unref?.();
    this.stopDebounce = () => { clearTimeout(debounce); clearTimeout(maximum); };
  }
  async close() {
    this.closed = true; this.watcher?.close(); this.watcher = null;
    clearInterval(this.timer); clearInterval(this.deepTimer); this.timer = null; this.deepTimer = null; this.stopDebounce?.();
    for (const timer of this.indexRetryTimers.values()) clearTimeout(timer);
    this.indexRetryTimers.clear();
    this.queuedDocuments.clear();
    this.preparedIndexDocuments.clear();
    await this.scanning?.catch(() => {}); await this.tail;
    await Promise.all([...this.documentTails.values()].map(task => task.catch(() => {})));
    await this.flushIndex(); await this.hashWorker.stop();
  }
}
module.exports = { FileWorkspace, FORMAT, VERSION, relativePath, decodeMarkdown, digest, recordName };
