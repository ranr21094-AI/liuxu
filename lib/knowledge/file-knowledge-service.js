const fs = require('node:fs/promises');
const path = require('node:path');
const { FileWorkspace, decodeMarkdown, recordName } = require('./file-workspace');
const { TEXT_TYPES } = require('./file-formats');
const revisionStorage = require('./revision-storage');
const { nextPinTime } = require('./pins');
const { markdownImageTokens, sanitizeSegment } = require('./folder-sync');

function createFileKnowledgeService(db, { root, startFolderSync }, createLegacyService) {
  const FILE_INDEX_VERSION = 1;
  const legacy = createLegacyService(db, { indexOnly: true, startFolderSync: false });
  const sqlite = db.sqlite;
  const indexed = new Map();
  const extractionWorker = new (require('./sync-worker-client').SyncWorker)('file-index-worker.js');
  const observationRows = sqlite.prepare('SELECT document_id, relative_path, fingerprint, file_state, checked_at FROM knowledge_file_observations');
  const saveObservation = sqlite.prepare(`INSERT INTO knowledge_file_observations (document_id, relative_path, fingerprint, file_state, checked_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET relative_path = excluded.relative_path,
    fingerprint = excluded.fingerprint, file_state = excluded.file_state, checked_at = excluded.checked_at`);
  const removeObservation = sqlite.prepare('DELETE FROM knowledge_file_observations WHERE document_id = ?');
  const indexNeedsExtraction = document => {
    const previewKind = require('./import').inferPreviewKind(document.fileMeta?.mimeType, document.fileMeta?.filename);
    return document.sourceType === 'file' && document.fileMeta?.bytes <= 30 * 1024 * 1024
      && ['pdf', 'docx', 'spreadsheet', 'presentation'].includes(previewKind);
  };
  const cachedLegacyDocuments = () => sqlite.prepare("SELECT id FROM knowledge_documents WHERE COALESCE(json_extract(body, '$.storageMode'), '') != 'files'")
    .all().map(row => legacy.getDocument(row.id)).filter(Boolean);
  const documentsWithLegacyReadingData = () => sqlite.prepare("SELECT id FROM knowledge_documents WHERE json_type(body, '$.readingData') = 'object'")
    .all().map(row => legacy.getDocument(row.id)).filter(Boolean);
  const workspace = new FileWorkspace({ root, asyncIndex: true,
    loadObservations() {
      return observationRows.all().flatMap(row => {
        try { return [{ documentId: row.document_id, relativePath: row.relative_path, fingerprint: row.fingerprint,
          fileState: JSON.parse(row.file_state), checkedAt: row.checked_at }]; }
        catch { return []; }
      });
    },
    saveObservation(observation) {
      saveObservation.run(observation.documentId, observation.relativePath, observation.fingerprint,
        JSON.stringify(observation.fileState), observation.checkedAt);
    },
    removeObservation(id) { removeObservation.run(id); },
    isIndexCurrent(document) {
      const previous = legacy.getDocument(document.id);
      return Boolean(previous?.storageMode === 'files' && previous.status !== 'deleted' && previous.version === document.version
        && previous.baseFingerprint === document.baseFingerprint && previous.relativePath === document.relativePath
        && (previous.indexFormatVersion ?? FILE_INDEX_VERSION) === FILE_INDEX_VERSION
        && (!indexNeedsExtraction(previous) || previous.extractionFingerprint === document.baseFingerprint));
    },
    async loadIndexDocument(token) {
      const current = await workspace.observe(token.id, { index: false });
      return current && current.version === token.version && current.relativePath === token.relativePath
        && current.baseFingerprint === token.baseFingerprint ? current : null;
    },
    async indexDocument(document) {
      const previous = legacy.getDocument(document.id);
      const previewKind = require('./import').inferPreviewKind(document.fileMeta?.mimeType, document.fileMeta?.filename);
      if (document.sourceType === 'file' && document.rawContent === undefined
        && ['pdf', 'docx', 'spreadsheet', 'presentation'].includes(previewKind) && document.fileMeta.bytes <= 30 * 1024 * 1024
        && previous?.extractionFingerprint !== document.baseFingerprint) {
        const observed = await workspace.readBytes(document.relativePath, 30 * 1024 * 1024);
        if (observed.fingerprint !== document.baseFingerprint) throw new Error('索引任务已过期');
        const parsed = await extractionWorker.request('extract', { bytes: observed.bytes, filename: document.fileMeta.filename, mimeType: document.fileMeta.mimeType });
        const currentRecord = workspace.records.get(document.id);
        const currentStat = await fs.stat(await workspace.safe(document.relativePath));
        if (currentRecord?.version !== document.version || currentRecord?.relativePath !== document.relativePath
          || currentStat.size !== currentRecord.fileState?.size || currentStat.mtimeMs !== currentRecord.fileState?.mtimeMs
          || currentStat.ctimeMs !== currentRecord.fileState?.ctimeMs || currentStat.ino !== currentRecord.fileState?.ino
          || currentStat.dev !== currentRecord.fileState?.dev) throw new Error('索引任务已过期');
        Object.assign(document, { content: parsed.text || '', previewHtml: parsed.previewHtml || '', extractionFingerprint: document.baseFingerprint });
        Object.assign(document.fileMeta, { previewKind: parsed.previewKind, previewLimited: Boolean(parsed.previewLimited) });
      }
      const record = workspace.records.get(document.id);
      if (!record || record.status === 'deleted' || record.version !== document.version || record.relativePath !== document.relativePath
        || record.fingerprint !== document.baseFingerprint) throw new Error('索引任务已过期');
      const currentStat = await fs.stat(await workspace.safe(document.relativePath));
      if (record.fileState && (currentStat.size !== record.fileState.size || currentStat.mtimeMs !== record.fileState.mtimeMs
        || currentStat.ctimeMs !== record.fileState.ctimeMs || currentStat.ino !== record.fileState.ino || currentStat.dev !== record.fileState.dev)) {
        throw new Error('索引任务已过期');
      }
      const next = { ...previous, ...document, indexFormatVersion: FILE_INDEX_VERSION, indexState: 'ready', content: document.content ?? (previous?.baseFingerprint === document.baseFingerprint ? previous?.content || '' : ''),
        fileMeta: document.fileMeta ? { ...previous?.fileMeta, ...document.fileMeta } : null };
      // Reading entries are authoritative in .liuxu/reading/<document-id>.json;
      // keep only searchable document/index data in SQLite.
      delete next.readingData;
      const signature = JSON.stringify(next);
      if (indexed.get(document.id) === signature) return;
      legacy.cacheFileDocument(next); indexed.set(document.id, signature);
    },
    removeIndex(id) { legacy.removeFileIndex(id); indexed.delete(id); },
  });
  async function adoptLegacyDocuments() {
    // Old JSON/ZIP restores and the compatibility log importer can introduce
    // legacy rows. Convert those explicitly; file-mode cache rows never restore
    // missing originals from a database copy.
    for (const doc of cachedLegacyDocuments()) {
      if (doc.storageMode === 'files' || workspace.records.has(doc.id)) continue;
      const relative = doc.fileSync?.relativePath;
      let observed;
      if (relative) {
        try { observed = await workspace.fingerprint(relative); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (observed && ![...workspace.records.values()].some(record => record.relativePath === relative)) {
        if (doc.sourceType === 'note') {
          const disk = decodeMarkdown((await workspace.readBytes(relative)).bytes, relative).content;
          if (disk !== doc.content) {
            const recovery = await workspace.safe(`.liuxu/recovery/${doc.id.replace(':', '-')}-legacy-database.md`, { createParents: true });
            try { await fs.writeFile(recovery, doc.content || '', { flag: 'wx', mode: 0o600 }); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
          }
        }
        await workspace.persist({ id: doc.id, relativePath: relative, sourceType: doc.sourceType, documentRole: doc.documentRole || 'normal',
          parentDocumentId: doc.parentDocumentId || null, title: doc.title || '', tags: doc.tags || [], documentDate: doc.documentDate || '',
          status: doc.status || 'active', version: doc.version || 1, fingerprint: observed.fingerprint,
          createdAt: doc.createdAt, updatedAt: doc.updatedAt });
      } else {
        const filename = doc.sourceType === 'file' ? doc.fileMeta.filename : `${sanitizeSegment(doc.title || '未命名笔记')}.md`;
        const target = [doc.status === 'archived' ? '.archive' : '', doc.knowledgeBase, doc.folderPath, filename].filter(Boolean).join('/');
        await workspace.create({ ...doc, id: doc.id, relativePath: target,
          ...(doc.sourceType === 'file' ? { sourceFilePath: legacy.filePathFor(doc), sourceSha256: doc.fileMeta.sha256 } : {}) });
        await workspace.persist({ ...workspace.records.get(doc.id), status: doc.status || 'active', version: doc.version || 1,
          createdAt: doc.createdAt || workspace.records.get(doc.id).createdAt, updatedAt: doc.updatedAt || workspace.records.get(doc.id).updatedAt });
      }
    }
  }
  let stopping = false, shutdownPromise = null;
  const ready = workspace.open().then(adoptLegacyDocuments).then(async () => {
    for (const doc of documentsWithLegacyReadingData()) if (doc.sourceType === 'file' && workspace.records.has(doc.id)) await readReadingSidecar(doc.id);
  });
  const backgroundReady = ready.then(async () => {
    if (stopping) return;
    if (startFolderSync) workspace.start();
    await workspace.scan();
    await workspace.flushIndex();
    if (!stopping && !workspace.lastDeepScanAt) {
      void workspace.scan({ deep: true }).catch(error => { workspace.error = error.message; });
    }
    if (stopping) return;
    const drafts = [];
    try {
      for (const name of await fs.readdir(await workspace.safe('.liuxu/conflicts'))) {
        if (!name.endsWith('.json')) continue;
        const value = JSON.parse((await workspace.readBytes(`.liuxu/conflicts/${name}`, 2 * 1024 * 1024)).bytes);
        drafts.push({ id: name, documentId: value.documentId, reason: value.reason, createdAt: value.createdAt, title: value.draft?.title || '' });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    workspace.drafts = drafts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50);
  });
  backgroundReady.catch(error => { workspace.error = error.message; });
  // Keep failures observable by requests without an unhandled rejection at startup.
  ready.catch(error => { workspace.error = error.message; });
  const result = operation => async (...args) => {
    await ready;
    try { return await operation(...args); }
    catch (error) { if (error.status) return { error: error.message, status: error.status, current: error.current }; throw error; }
  };
  const getDocument = async id => {
    await ready;
    const document = await workspace.read(id);
    const cached = document?.sourceType === 'file' && document.content === undefined ? legacy.getDocument(id) : null;
    if (cached?.baseFingerprint === document?.baseFingerprint) {
      document.content = cached.content || ''; document.previewHtml = cached.previewHtml || ''; document.extractionFingerprint = cached.extractionFingerprint;
      document.fileMeta = { ...cached.fileMeta, ...document.fileMeta };
    }
    return document;
  };
  const location = (doc, patch) => {
    let base = patch.knowledgeBase ?? doc.knowledgeBase;
    if (base === ':root:') base = '';
    const folder = patch.folderPath ?? doc.folderPath;
    return [base, folder, path.basename(doc.relativePath)].filter(Boolean).join('/');
  };
  async function updateDocument(id, patch) {
    const current = await getDocument(id);
    if (!current) return { error: 'Document not found', status: 404 };
    let document = current;
    if (patch.relativePath || (patch.knowledgeBase !== undefined && patch.knowledgeBase !== current.knowledgeBase)
      || (patch.folderPath !== undefined && patch.folderPath !== current.folderPath)) {
      const moved = await workspace.move(id, { ...patch, relativePath: patch.relativePath || location(current, patch) });
      document = moved.document;
      patch = { ...patch, baseVersion: document.version, baseFingerprint: document.baseFingerprint };
    }
    if (patch.content === undefined) return workspace.updateMetadata(id, patch);
    if (current.documentRole === 'mindmap') {
      const validated = require('./documents').validateMindmapContent(patch.content);
      if (validated.error) return { error: validated.error, status: 400 };
      patch = { ...patch, content: validated.content };
    }
    if (current.sourceType === 'note' && current.documentRole !== 'mindmap') {
      const parsed = markdownImageTokens(patch.content);
      for (const token of parsed.tokens) {
        const match = /^\/uploads\/([^/?#]+)(?:[?#].*)?$/.exec(token.source);
        if (!match) continue;
        let name; try { name = decodeURIComponent(match[1]); } catch { continue; }
        if (path.basename(name) !== name || name.includes('\\')) continue;
        const source = path.join(db.dataDir, 'uploads', name);
        if ((await fs.lstat(path.dirname(source))).isSymbolicLink() || (await fs.lstat(source)).isSymbolicLink()) throw Object.assign(new Error('图片路径不能经过符号链接'), { status: 400 });
        const relative = path.posix.join(path.posix.dirname(document.relativePath), sanitizeSegment(name));
        const target = await workspace.safe(relative, { createParents: true });
        try { await fs.copyFile(source, target, require('node:fs').constants.COPYFILE_EXCL); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const [left, right] = await Promise.all([fs.readFile(source), fs.readFile(target)]);
          if (!left.equals(right)) throw Object.assign(new Error('目标图片与现有文件冲突'), { status: 409 });
        }
        const imageSource = `./${encodeURI(path.posix.basename(relative))}`;
        const replacement = /^<img\b/i.test(token.raw)
          ? token.raw.replace(/(\ssrc\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i, (_match, prefix) => `${prefix}"${imageSource.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
          : `![${token.alt}](${imageSource})`;
        parsed.lines[token.lineIndex] = parsed.lines[token.lineIndex].replace(token.raw, replacement);
      }
      patch = { ...patch, content: parsed.lines.join('\n') };
    }
    return workspace.save(id, patch);
  }
  async function getAnnotation(parentId) {
    const parent = await getDocument(parentId);
    if (!parent) return null;
    const record = [...workspace.records.values()].find(record => record.parentDocumentId === parentId && record.documentRole === 'annotation' && record.status !== 'deleted');
    return record ? getDocument(record.id) : null;
  }
  async function createNote(input) {
    if (input.documentRole === 'mindmap') {
      const validated = require('./documents').validateMindmapContent(input.content);
      if (validated.error) return { error: validated.error, status: 400 };
      input = { ...input, content: validated.content };
    }
    let relative = input.relativePath;
    if (input.parentDocumentId) {
      const parent = await getDocument(input.parentDocumentId);
      if (!parent || parent.sourceType !== 'file') return { error: 'Only files can have an annotation', status: 400 };
      relative = path.posix.join(path.posix.dirname(parent.relativePath), `${path.posix.basename(parent.relativePath)}.annotation.md`);
    }
    // Only import endpoints may supply a local source path; note creation must
    // not turn arbitrary extra JSON/tool arguments into filesystem reads.
    return workspace.create({ sourceType: 'note', title: String(input.title || '').slice(0, 200), content: String(input.content || ''),
      knowledgeBase: input.knowledgeBase, folderPath: input.folderPath, relativePath: relative,
      tags: input.tags || [], documentDate: input.documentDate || input.date || '', parentDocumentId: input.parentDocumentId || null,
      documentRole: input.parentDocumentId ? 'annotation' : input.documentRole === 'mindmap' ? 'mindmap' : 'normal' });
  }
  async function upsertAnnotation(id, input) {
    const annotation = await getAnnotation(id);
    if (input.personalContent) {
      const existing = annotation?.content || '';
      const start = existing.indexOf('<!-- liuxu-reading:start -->'), end = existing.indexOf('<!-- liuxu-reading:end -->');
      if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) return { error: '自动摘录区标记损坏', status: 409 };
      const reading = await readReadingSidecar(id);
      input = { ...input, content: require('./reading-data').readingNote(input.content || '', id, reading.entries) };
    }
    if (annotation) return updateDocument(annotation.id, input);
    const parent = await getDocument(id);
    if (!parent || parent.status === 'archived') return { error: 'File not available', status: 404 };
    return createNote({ ...input, parentDocumentId: id, title: input.title || `${parent.title} 批注` });
  }
  async function getTextFile(id) {
    const doc = await getDocument(id);
    if (!doc || doc.sourceType !== 'file') return { error: 'File not found', status: 404 };
    if (!TEXT_TYPES[path.extname(doc.relativePath).toLowerCase()]) return { error: '此格式不支持原文编辑', status: 400 };
    const data = await workspace.readBytes(doc.relativePath, 2 * 1024 * 1024);
    const decoded = decodeMarkdown(data.bytes, doc.relativePath);
    return { content: decoded.header + decoded.content, bom: decoded.bom, bytes: data.bytes.length,
      baseFingerprint: data.fingerprint, baseVersion: doc.version, editable: doc.status !== 'archived', supportsHistory: true };
  }
  async function saveImportedFile(input) {
    return workspace.create({ ...input, bytes: input.buffer, sourceType: 'file' });
  }
  async function createNamedRevision(id, input) {
    await ready;
    return workspace.exclusive(async () => {
      const doc = await workspace.guard(id, input, { archived: true });
      if (!String(input.name || '').trim()) return { error: 'Version name is required', status: 400 };
      // History needs a durable identity row even while the derived index is queued.
      if (!legacy.getDocument(id)) legacy.cacheFileDocument(doc);
      const snapshot = legacy.editableSnapshot(doc);
      if (doc.sourceType === 'file') {
        if (!doc.textFileSupported) return { error: '此格式不支持版本历史', status: 400 };
        snapshot.content = doc.rawContent;
        snapshot.snapshotKind = 'text_file';
        snapshot.file = { bom: doc.textFileBom, filename: doc.fileMeta.filename, mimeType: doc.fileMeta.mimeType,
          sha256: doc.baseFingerprint, bytes: doc.fileMeta.bytes };
      } else if (doc.documentRole === 'mindmap') snapshot.snapshotKind = 'mindmap';
      const previousRow = sqlite.prepare('SELECT * FROM knowledge_revisions WHERE document_id = ? AND name IS NOT NULL ORDER BY id DESC LIMIT 1').get(id);
      const previous = previousRow ? { row: previousRow, snapshot: revisionStorage.decode(sqlite, id, previousRow) } : null;
      const stored = revisionStorage.encode(snapshot, previous);
      const row = sqlite.prepare(`INSERT INTO knowledge_revisions
        (document_id, document_version, captured_at, reason, snapshot, name, storage_format, base_revision_id,
          delta_depth, snapshot_hash, base_hash, content_length, summary) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, doc.version, new Date().toISOString(), stored.snapshot, String(input.name).trim().slice(0, 100),
        stored.storage_format, stored.base_revision_id, stored.delta_depth, stored.snapshot_hash, stored.base_hash, stored.content_length,
        JSON.stringify({ title: doc.title, tags: doc.tags }));
      return legacy.getRevision(id, row.lastInsertRowid);
    });
  }
  async function restoreRevision(id, revisionId, input) {
    const value = legacy.getRevision(id, revisionId);
    if (value.error) return value;
    const snapshot = value.revision.snapshot;
    const patch = { ...input, content: snapshot.content, title: snapshot.title, tags: snapshot.tags,
      documentDate: snapshot.documentDate, ...(snapshot.file ? { bom: snapshot.file.bom } : {}) };
    if (input.restoreLocation) Object.assign(patch, { knowledgeBase: snapshot.knowledgeBase, folderPath: snapshot.folderPath });
    const restored = await updateDocument(id, patch);
    return { ...restored, restoredRevisionId: Number(revisionId) };
  }
  const readingQueues = new Map();
  async function readReadingSidecar(id) {
    const relative = `.liuxu/reading/${recordName(id)}`;
    try {
      const value = JSON.parse((await workspace.readBytes(relative, 3 * 1024 * 1024)).bytes);
      if (value.documentId !== id || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('阅读旁路记录损坏');
      return { ...require('./reading-data').normalizeReadingData(value), revision: value.revision };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const old = legacy.getDocument(id)?.readingData;
      const data = old ? { ...require('./reading-data').normalizeReadingData(old), revision: old.revision || 0 } : { schemaVersion: 1, entries: [], revision: 0 };
      await workspace.json(relative, { ...data, documentId: id });
      return data;
    }
  }
  async function getReadingData(id) {
    const doc = await getDocument(id);
    if (!doc || doc.sourceType !== 'file') return null;
    return { ...await readReadingSidecar(id), fingerprint: doc.baseFingerprint, documentVersion: doc.version };
  }
  async function updateReadingData(id, input, options = {}) {
    const previous = readingQueues.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => updateReadingDataLocked(id, input, options));
    readingQueues.set(id, task);
    try { return await task; } finally { if (readingQueues.get(id) === task) readingQueues.delete(id); }
  }
  async function updateReadingDataLocked(id, input, { restoringReading = false, merge = false } = {}) {
    const current = await getReadingData(id);
    if (!current) return { error: 'File not found', status: 404 };
    if (input.baseRevision !== current.revision || input.fingerprint !== current.fingerprint || input.documentVersion !== current.documentVersion) return { error: '阅读数据或文件已变化', status: 409 };
    let data; try { data = require('./reading-data').normalizeReadingData(input); } catch (error) { return { error: error.message, status: 400 }; }
    const oldEntries = current.entries || [];
    if (!restoringReading && data.entries.some(item => item.fingerprint !== current.fingerprint && !oldEntries.some(old => old.id === item.id && old.anchor === item.anchor && old.fingerprint === item.fingerprint))) return { error: '摘录与当前文件不匹配', status: 409 };
    const annotation = await getAnnotation(id);
    const content = require('./reading-data').readingNote(annotation?.content || '', id, data.entries);
    const changed = await upsertAnnotation(id, { content, ...(annotation ? { baseVersion: annotation.version, baseFingerprint: annotation.baseFingerprint } : {}) });
    if (changed.error) return changed;
    const fresh = await getDocument(id);
    if (!fresh || (!restoringReading && (fresh.baseFingerprint !== current.fingerprint || fresh.version !== current.documentVersion))) return { error: '源文件已变化', status: 409 };
    const nextRevision = !restoringReading ? current.revision + 1
      : merge ? Math.max(current.revision, Number(input.revision) || 0) + 1
        : Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : current.revision + 1;
    const next = { ...data, revision: nextRevision };
    await workspace.json(`.liuxu/reading/${recordName(id)}`, { ...next, documentId: id });
    const cached = legacy.getDocument(id);
    if (cached) { const { readingData: _oldReadingData, ...indexDocument } = cached; legacy.cacheFileDocument(indexDocument); }
    return { readingData: await getReadingData(id) };
  }
  const sync = {
    config: { enabled: true, rootPath: path.resolve(root) },
    snapshot: () => ({ ...workspace.snapshot(), drafts: workspace.drafts || [], status: workspace.error ? 'error' : workspace.scanStatus }),
    syncNow: async () => {
      await ready;
      if (!workspace.scanning) void workspace.scan().catch(error => { workspace.error = error.message; });
      return sync.snapshot();
    },
    verifyNow: async () => {
      await ready;
      void workspace.scan({ deep: true }).catch(error => { workspace.error = error.message; });
      return sync.snapshot();
    },
    listNameOnlyEntries: async () => [],
    stop: async () => shutdown(), shutdown: async () => shutdown(),
    localPathFor(doc) { const record = workspace.records.get(doc.id); return record && record.status !== 'deleted' ? path.join(workspace.root, record.relativePath) : null; },
    configure() { throw new Error('文件工作区目录切换请使用离线迁移，避免丢失文档身份'); },
    migrateAll() { throw new Error('此工作区已使用本地文件模式'); },
    async saveDraft(documentId, draft, reason) {
      await ready;
      const id = `${require('node:crypto').randomUUID()}.json`;
      const payload = { id, documentId, draft, reason, createdAt: new Date().toISOString() };
      await workspace.json(`.liuxu/conflicts/${id}`, payload);
      workspace.drafts = [{ id, documentId, reason, createdAt: payload.createdAt, title: draft.title || '' }, ...(workspace.drafts || [])].slice(0, 50);
      return payload;
    },
    async readDraft(id) {
      await ready;
      if (!id || path.basename(id) !== id || !id.endsWith('.json')) return null;
      try { return JSON.parse((await workspace.readBytes(`.liuxu/conflicts/${id}`, 2 * 1024 * 1024)).bytes); }
      catch (error) { if (error.code === 'ENOENT') return legacy.folderSync.readDraft(id); throw error; }
    },
    async resolveAsset(document, requested) {
      await ready;
      let decoded; try { decoded = decodeURIComponent(requested); } catch { return null; }
      if (!decoded || path.isAbsolute(decoded) || /^[a-z]:/i.test(decoded)) return null;
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(document.relativePath), decoded.replace(/\\/g, '/')));
      if (relative === '.liuxu' || relative.startsWith('.liuxu/') || relative.startsWith('../')) return null;
      try { const target = await workspace.safe(relative); return (await fs.stat(target)).isFile() ? target : null; }
      catch (error) { if (error.code === 'ENOENT' || error.status === 400) return null; throw error; }
    },
    async ensureDirectoryTree() { await ready; },
    async removeCollectionDirectory(relative) {
      await ready;
      try { await fs.rmdir(await workspace.safe(relative)); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
    },
  };
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      await ready.catch(() => {});
      await workspace.close();
      await backgroundReady.catch(() => {});
      await extractionWorker.stop();
    })();
    return shutdownPromise;
  }
  return { ...legacy, storageMode: 'files', workspace, ready, backgroundReady, folderSync: sync,
    getIndexedDocument: legacy.getDocument,
    finishRevisionCleanup() { return { cleaned: false, storageMode: 'files' }; },
    nativeDocuments() {
      return [...workspace.records.values()].filter(record => record.status !== 'deleted').map(record => {
        const cached = legacy.getDocument(record.id);
        return { ...cached, ...workspace.metadataDocument(record, { fingerprint: record.fingerprint, stat: { size: cached?.fileMeta?.bytes || 0 } }),
          content: cached?.content || '', previewHtml: cached?.previewHtml || '' };
      });
    },
    allDocuments({ includeArchived = false } = {}) { return this.nativeDocuments().filter(doc => (includeArchived || doc.status !== 'archived')
      && (!doc.parentDocumentId || workspace.records.get(doc.parentDocumentId)?.status === 'active' || (includeArchived && workspace.records.get(doc.parentDocumentId)?.status === 'archived'))); },
    listDocumentTreeLocations() {
      // The tree needs membership only. Reading the derived SQLite bodies here
      // made entering a tiny folder proportional to the entire library's text.
      return [...workspace.records.values()]
        .filter(record => record.status !== 'deleted' && record.status !== 'archived' && record.documentRole !== 'annotation')
        .map(record => {
          const parts = record.relativePath.replace(/^\.archive\//, '').split('/');
          parts.pop();
          const knowledgeBase = parts.shift() || ':root:';
          return { knowledgeBase, folderPath: parts.join('/'), collectionPath: [knowledgeBase, ...parts].join('/'),
            fileSync: { relativePath: record.relativePath } };
        });
    },
    async hydrateFilePreview(document) {
      if (!document || document.sourceType !== 'file' || document.rawContent !== undefined) return document;
      if (document.fileMeta.bytes > 30 * 1024 * 1024 || document.extractionFingerprint === document.baseFingerprint) return document;
      try {
        const fingerprint = document.baseFingerprint;
        const observed = await workspace.readBytes(document.relativePath, 30 * 1024 * 1024);
        if (observed.fingerprint !== fingerprint) return getDocument(document.id);
        const parsed = await extractionWorker.request('extract', { bytes: observed.bytes, filename: document.fileMeta.filename, mimeType: document.fileMeta.mimeType });
        const current = await workspace.read(document.id);
        if (!current || current.baseFingerprint !== fingerprint) return current;
        const next = { ...current, content: parsed.text || '', previewHtml: parsed.html || '',
          fileMeta: { ...current.fileMeta, previewKind: parsed.previewKind, previewLimited: Boolean(parsed.previewLimited) } };
        await workspace.tryIndex(next);
        return next;
      } catch (error) { if (error.status === 409) throw error; return { ...document, previewError: error.message }; }
    },
    getDocument, createNote: result(createNote), updateDocument: result(updateDocument),
    directoryCategories() {
      const categories = [{ name: ':root:', displayName: '根目录', sub: [] }];
      for (const directory of workspace.directories || []) {
        if (directory.startsWith('.archive')) continue;
        let level = categories;
        for (const part of directory.split('/')) {
          let item = level.find(node => node.name === part);
          if (!item) { item = { name: part, sub: [] }; level.push(item); }
          level = item.sub;
        }
      }
      return categories;
    },
    getTextFile: result(getTextFile), updateTextFile: result(async (id, input) => {
      const saved = await updateDocument(id, input);
      if (saved.error) return saved;
      const raw = await getTextFile(id);
      return { ...saved, ...raw };
    }),
    filePathFor(doc) { return doc && sync.localPathFor(doc); },
    getAnnotation, upsertAnnotation: result(upsertAnnotation), saveImportedFile: result(saveImportedFile),
    archiveDocument: result((id, input) => workspace.move(id, input, 'archive')),
    restoreDocument: result((id, input) => workspace.move(id, input, 'restore')),
    deleteDocument: result((id, input) => workspace.move(id, input, 'delete')),
    renameDocument: result((id, input) => workspace.move(id, input)),
    rebuildIndex: result(async () => {
      await workspace.exclusive(async () => {
        for (const row of sqlite.prepare('SELECT id FROM knowledge_documents').all()) legacy.removeFileIndex(row.id);
        indexed.clear(); workspace.indexedBaselines.clear();
        for (const record of workspace.records.values()) if (record.status !== 'deleted') await workspace.observe(record.id);
      });
      await workspace.flushIndex();
      return workspace.snapshot();
    }),
    createDirectory: result(relative => workspace.createDirectory(relative)),
    moveDirectory: result((from, to) => workspace.moveDirectory(from, to)),
    setDocumentPinned: result(async (id, pinned, input) => {
      const doc = await getDocument(id);
      if (!doc || doc.documentRole === 'annotation') return { error: '此文件不能置顶', status: 403 };
      const saved = await workspace.updateMetadata(id, { ...input, pinnedAt: pinned ? doc.pinnedAt || nextPinTime() : '' });
      return { id, pinnedAt: saved.document.pinnedAt, version: saved.document.version, baseFingerprint: saved.document.baseFingerprint };
    }),
    getReadingData, updateReadingData: result(updateReadingData),
    createNamedRevision: result(createNamedRevision), restoreRevision: result(restoreRevision),
    checkpointRevision: result(async (id, input) => {
      const doc = await workspace.exclusive(() => workspace.guard(id, input));
      return { checkpointed: false, documentVersion: doc.version };
    }),
    async prepareMentionContext(messages) {
      await ready;
      if (!messages.some(message => message.role === 'user' && String(message.content || '').includes('@'))) return legacy;
      const documents = [];
      for (const doc of legacy.allDocuments()) { const current = await getDocument(doc.id); if (current) documents.push(current); }
      return { ...legacy, allDocuments: () => documents };
    },
    rewriteCollectionPath: result(async (oldPath, newPath) => {
      const records = [...workspace.records.values()].filter(record => record.status === 'active' && record.relativePath.startsWith(`${oldPath}/`));
      for (const record of records.filter(record => !record.parentDocumentId)) {
        const doc = await getDocument(record.id);
        await workspace.move(record.id, { baseVersion: doc.version, baseFingerprint: doc.baseFingerprint,
          relativePath: `${newPath}${record.relativePath.slice(oldPath.length)}` });
      }
      return { updated: records.length };
    }),
    reassignCollectionPath: result(async (oldPath, targetPath = '其他') => {
      return workspace.moveDirectory(oldPath, `${targetPath}/${path.posix.basename(oldPath)}`);
    }),
  };
}
module.exports = { createFileKnowledgeService };
