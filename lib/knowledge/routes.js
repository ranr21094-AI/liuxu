const fs = require('fs');
const os = require('node:os');
const path = require('path');
const crypto = require('node:crypto');
const multer = require('multer');
const yauzl = require('yauzl');
const { createKnowledgeService } = require('./documents');
const { ensureLogsMigrated } = require('./migrate-logs');
const { createSearchIndex } = require('./search');
const { filterDocuments, filtersFromQuery } = require('./filters');
const { parseSearchOptions } = require('./search-options');
const { extractText, inferPreviewKind, MAX_FILE_BYTES, MAX_PARSE_BYTES, sniffKind, validateOfficeArchive } = require('./import');
const { decodeUploadedFilename, contentDisposition } = require('../util/filename');

const knowledgeCache = new Map();

function invalidateKnowledgeCache(dataDir) {
  knowledgeCache.get(dataDir)?.knowledge?.folderSync?.stop?.();
  knowledgeCache.delete(dataDir);
}

const uploadDirectory = path.join(os.tmpdir(), 'liuxu-knowledge-uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename(_req, _file, callback) { callback(null, `${crypto.randomUUID()}.upload`); },
  }),
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function listZipEntries(filePath, cursor, limit) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const entries = [];
      let offset = 0;
      let totalSize = 0;
      let count = 0;
      let settled = false;
      const fail = error => { if (!settled) { settled = true; zip.close(); reject(error); } };
      zip.on('error', fail);
      zip.on('entry', entry => {
        count += 1;
        totalSize += Number(entry.uncompressedSize) || 0;
        if (count > 20000 || totalSize > 4 * 1024 * 1024 * 1024) return fail(new Error('ZIP 内容超出预览限制'));
        const name = String(entry.fileName || '').replace(/\\/g, '/');
        const unixMode = (Number(entry.externalFileAttributes) >>> 16) & 0xf000;
        if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..') || unixMode === 0xa000 || (entry.generalPurposeBitFlag & 1)) {
          return fail(new Error('ZIP 包含不安全或加密条目'));
        }
        if (!entry.fileName.endsWith('/') && offset++ >= cursor && entries.length < limit) {
          entries.push({ name, compressedBytes: entry.compressedSize, bytes: entry.uncompressedSize, directory: false });
        }
        zip.readEntry();
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entries, nextCursor: offset > cursor + entries.length ? String(cursor + entries.length) : null, total: offset });
      });
      zip.readEntry();
    });
  });
}

function sendKnowledgeFile(req, res, document, filePath) {
  const stat = fs.statSync(filePath);
  const filename = document.fileMeta?.filename || document.title || path.basename(filePath);
  const mimeType = String(document.fileMeta?.mimeType || 'application/octet-stream').toLowerCase();
  const etag = `"${document.fileMeta?.sha256 || `${stat.size}-${Math.round(stat.mtimeMs)}`}"`;
  res.setHeader('Content-Type', mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('ETag', etag);
  const forceDownload = req.query.download === '1'
    || ['text/html', 'application/xhtml+xml', 'application/javascript', 'text/javascript'].includes(mimeType);
  const disposition = contentDisposition(filename);
  res.setHeader('Content-Disposition', forceDownload ? disposition.replace(/^inline;/, 'attachment;') : disposition);
  if (mimeType === 'image/svg+xml') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  if (req.headers['if-none-match'] === etag && !req.headers.range) return res.status(304).end();
  const range = req.headers.range;
  if (!range || (req.headers['if-range'] && req.headers['if-range'] !== etag)) {
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') return res.status(200).end();
    return fs.createReadStream(filePath).on('error', error => { if (!res.headersSent) res.status(500).end(error.message); }).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
  if (!match || range.includes(',')) {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }
  let start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0));
  let end = match[2] && match[1] ? Number(match[2]) : stat.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }
  end = Math.min(end, stat.size - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath, { start, end }).on('error', error => { if (!res.headersSent) res.status(500).end(error.message); }).pipe(res);
}

// Slot-based gate: release() hands the slot straight to the next waiter so
// active never double-counts.
function createGate(max) {
  let active = 0;
  const waiters = [];
  return {
    acquire() {
      if (active < max) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise(resolve => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    },
  };
}

const importGate = createGate(2);

function serviceFor(db) {
  const key = db.dataDir;
  let entry = knowledgeCache.get(key);
  if (!entry) {
    ensureLogsMigrated(db);
    const knowledge = createKnowledgeService(db);
    entry = { knowledge, search: createSearchIndex(knowledge) };
    knowledgeCache.set(key, entry);
  }
  return entry;
}

function documentSummary(document) {
  return {
    id: document.id,
    title: document.title,
    knowledgeBase: document.knowledgeBase || '',
    folderPath: document.folderPath || '',
    collectionPath: document.collectionPath,
    tags: document.tags || [],
    visibility: document.visibility,
    status: document.status,
    fileMeta: document.fileMeta ? {
      filename: document.fileMeta.filename,
      mimeType: document.fileMeta.mimeType,
      bytes: document.fileMeta.bytes,
      url: document.fileMeta.url,
      previewKind: inferPreviewKind(
        document.fileMeta.mimeType,
        document.fileMeta.filename || document.fileMeta.storedName,
        document.fileMeta.previewKind,
      ),
    } : null,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    documentDate: document.documentDate || '',
    version: document.version,
    parentDocumentId: document.parentDocumentId || null,
    documentRole: document.documentRole || 'normal',
    snippet: String(document.content || '').replace(/\s+/g, ' ').trim().slice(0, 180),
  };
}

function treeForDocuments(categories, documents, db) {
  const byBase = new Map();
  const ensureBase = (name, visibility = 'standard') => {
    if (!name || byBase.has(name)) return byBase.get(name);
    const value = { name, visibility, documentCount: 0, folders: [], _folderMap: new Map() };
    byBase.set(name, value);
    return value;
  };

  const buildFolder = (node, base, prefix) => {
    const pathValue = prefix ? `${prefix}/${node.name}` : node.name;
    const entry = { name: node.name, path: pathValue, children: [], documentCount: 0, totalCount: 0 };
    base._folderMap.set(pathValue, entry);
    entry.children = (node.sub || []).map(child => buildFolder(child, base, pathValue));
    return entry;
  };

  const ensureDocumentFolders = (base, folderPath) => {
    const segments = String(folderPath || '').split('/').filter(Boolean);
    let prefix = '';
    let parentList = base.folders;
    for (const segment of segments) {
      const full = prefix ? `${prefix}/${segment}` : segment;
      let entry = base._folderMap.get(full);
      if (!entry) {
        entry = { name: segment, path: full, children: [], documentCount: 0, totalCount: 0 };
        base._folderMap.set(full, entry);
        parentList.push(entry);
      }
      prefix = full;
      parentList = entry.children;
    }
  };

  (Array.isArray(categories) ? categories : []).forEach(category => {
    if (!category?.name) return;
    const base = ensureBase(category.name, db.isDiaryCategory(category.name) ? 'diary' : 'standard');
    base.folders = (category.sub || []).map(node => buildFolder(node, base, ''));
  });
  documents.forEach(document => {
    const base = ensureBase(document.knowledgeBase || '其他', document.visibility || 'standard');
    base.documentCount += 1;
    if (document.folderPath) ensureDocumentFolders(base, document.folderPath);
  });
  for (const base of byBase.values()) {
    const countFolder = entry => {
      let direct = 0;
      let total = 0;
      for (const document of documents) {
        if ((document.knowledgeBase || '其他') !== base.name) continue;
        const docPath = String(document.folderPath || '');
        if (docPath === entry.path) direct += 1;
        if (docPath === entry.path || docPath.startsWith(`${entry.path}/`)) total += 1;
      }
      entry.documentCount = direct;
      entry.totalCount = total;
      entry.children.forEach(countFolder);
    };
    base.folders.forEach(countFolder);
  }
  const sortFolders = list => {
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    list.forEach(folder => sortFolders(folder.children));
  };
  return [...byBase.values()].map(base => {
    const { _folderMap, ...result } = base;
    sortFolders(result.folders);
    return result;
  });
}

function registerKnowledgeRoutes(app, { db, hasDiaryAccess, rejectLockedDiary }) {
  app.get('/api/knowledge/sync/status', (req, res) => {
    try {
      const snapshot = serviceFor(db).knowledge.folderSync.snapshot();
      if (!hasDiaryAccess(req)) snapshot.drafts = [];
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/sync', async (req, res) => {
    try {
      const snapshot = await serviceFor(db).knowledge.folderSync.syncNow({ reason: 'manual' });
      if (!hasDiaryAccess(req)) snapshot.drafts = [];
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/sync/config', (req, res) => {
    try {
      if (req.isRemoteClient || process.env.LIUXU_DESKTOP !== '1') return res.status(403).json({ error: '知识库目录只能在桌面端修改' });
      const snapshot = serviceFor(db).knowledge.folderSync.configure({
        enabled: req.body?.enabled === true,
        rootPath: req.body?.rootPath,
      });
      res.json(snapshot);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/sync/migrate', (req, res) => {
    try {
      if (req.isRemoteClient || process.env.LIUXU_DESKTOP !== '1') return res.status(403).json({ error: '知识迁移只能在桌面端执行' });
      const report = serviceFor(db).knowledge.folderSync.migrateAll({ rootPath: req.body?.rootPath });
      res.json({ success: true, report, status: serviceFor(db).knowledge.folderSync.snapshot() });
    } catch (err) {
      res.status(400).json({ error: err.message, report: err.report || null });
    }
  });

  app.get('/api/knowledge/sync/drafts/:draftId', (req, res) => {
    try {
      if (!hasDiaryAccess(req)) return rejectLockedDiary(res);
      const draft = serviceFor(db).knowledge.folderSync.readDraft(req.params.draftId);
      if (!draft) return res.status(404).json({ error: '草稿不存在' });
      res.json(draft);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/sync/drafts', (req, res) => {
    try {
      if (!hasDiaryAccess(req)) return rejectLockedDiary(res);
      const { knowledge } = serviceFor(db);
      const documentId = String(req.body?.documentId || '');
      const document = knowledge.getDocument(documentId, { diaryUnlocked: true, includeArchived: true });
      if (!document) return res.status(404).json({ error: '文档不存在' });
      const draft = knowledge.folderSync.saveDraft(
        documentId,
        req.body?.draft || {},
        String(req.body?.reason || '本地文件已更新'),
      );
      if (!draft) return res.status(409).json({ error: '本地文件夹同步尚未启用' });
      return res.json(draft);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/knowledge/tree', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const diaryUnlocked = hasDiaryAccess(req);
      const categories = db.getAllCategories(diaryUnlocked, diaryUnlocked);
      const documents = knowledge.allDocuments({ diaryUnlocked })
        .filter(document => document.documentRole !== 'annotation');
      res.json({ knowledgeBases: treeForDocuments(categories, documents, db) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/knowledge/documents', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const diaryUnlocked = hasDiaryAccess(req);
      const filters = filtersFromQuery(req.query);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 60));
      const offset = Math.max(0, Number(req.query.cursor) || 0);
      let documents = knowledge.allDocuments({ diaryUnlocked, includeArchived: filters.status === 'archived' });
      documents = filterDocuments(documents, filters);
      documents.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
      const page = documents.slice(offset, offset + limit).map(documentSummary);
      res.json({
        documents: page,
        total: documents.length,
        nextCursor: offset + page.length < documents.length ? String(offset + page.length) : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/knowledge/link-targets', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const targets = knowledge.linkTargets({
        query: typeof req.query.q === 'string' ? req.query.q : '',
        limit: Math.min(50, Math.max(1, Number(req.query.limit) || 20)),
        excludeId: typeof req.query.excludeId === 'string' ? req.query.excludeId : '',
        diaryUnlocked: hasDiaryAccess(req),
      });
      res.json({ targets });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/documents', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.createNote(req.body || {}, { diaryUnlocked: hasDiaryAccess(req) });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      const links = knowledge.outgoingLinks(result.document.id, { diaryUnlocked: hasDiaryAccess(req) });
      res.status(201).json({ ...result.document, linkIssues: result.linkIssues || [], outgoingLinks: links.links || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/knowledge/documents/:id', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      let document = knowledge.getDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (!document) return res.status(404).json({ error: 'Document not found' });
      document = await knowledge.hydrateFilePreview(document);
      const links = knowledge.outgoingLinks(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      const linkIssues = knowledge.linkIssuesForDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      res.json({ ...document, outgoingLinks: links.links || [], linkIssues: linkIssues.issues || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/knowledge/documents/:id/backlinks', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.backlinks(req.params.id, {
        diaryUnlocked: hasDiaryAccess(req),
        cursor: req.query.cursor,
        limit: req.query.limit,
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/knowledge/documents/:id/revisions', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.listRevisions(req.params.id, {
        diaryUnlocked: hasDiaryAccess(req),
        cursor: req.query.cursor,
        limit: req.query.limit,
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/knowledge/documents/:id/revisions/:revisionId', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.getRevision(req.params.id, req.params.revisionId, {
        diaryUnlocked: hasDiaryAccess(req),
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/documents/:id/revisions/:revisionId/restore', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.restoreRevision(req.params.id, req.params.revisionId, {
        baseVersion: req.body?.baseVersion,
        diaryUnlocked: hasDiaryAccess(req),
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error, current: result.current });
      const links = knowledge.outgoingLinks(result.document.id, { diaryUnlocked: hasDiaryAccess(req) });
      const linkIssues = knowledge.linkIssuesForDocument(result.document.id, { diaryUnlocked: hasDiaryAccess(req) });
      result.document = { ...result.document, outgoingLinks: links.links || [], linkIssues: linkIssues.issues || [] };
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/knowledge/documents/:id/annotation', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const parent = knowledge.getDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (!parent) return res.status(404).json({ error: 'Document not found' });
      const annotation = knowledge.getAnnotation(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      res.json({ annotation });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/knowledge/documents/:id/annotation', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.upsertAnnotation(req.params.id, req.body || {}, { diaryUnlocked: hasDiaryAccess(req) });
      if (result.error) {
        return res.status(result.status || 400).json({ error: result.error, current: result.current });
      }
      const links = knowledge.outgoingLinks(result.document.id, { diaryUnlocked: hasDiaryAccess(req) });
      res.status(result.document.version === 1 ? 201 : 200).json({ ...result.document, linkIssues: result.linkIssues || [], outgoingLinks: links.links || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/knowledge/documents/:id', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.updateDocument(req.params.id, req.body || {}, { diaryUnlocked: hasDiaryAccess(req) });
      if (result.error) return res.status(result.status || 400).json({ error: result.error, current: result.current });
      const links = knowledge.outgoingLinks(result.document.id, { diaryUnlocked: hasDiaryAccess(req) });
      res.json({ ...result.document, linkIssues: result.linkIssues || [], outgoingLinks: links.links || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/documents/:id/archive', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.archiveDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result.document);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/documents/:id/restore', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.restoreDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result.document);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/knowledge/documents/:id', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.deleteDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json({ ok: true, document: result.document });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/knowledge/search', (req, res) => {
    try {
      const { search } = serviceFor(db);
      const diaryUnlocked = hasDiaryAccess(req);
      const filters = filtersFromQuery(req.query);
      const query = filters.search;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 60));
      delete filters.search;
      const searchOptions = parseSearchOptions(req.query);
      const documents = search.searchDocuments(query, filters, {
        diaryUnlocked,
        limit,
        summarize: documentSummary,
        searchOptions,
      });
      res.json({ documents, total: documents.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.all('/api/knowledge/files/:id/content', (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(405);
    try {
      const { knowledge } = serviceFor(db);
      const document = knowledge.getDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (!document) return res.status(404).json({ error: 'Document not found' });
      const filePath = knowledge.filePathFor(document);
      if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
      return sendKnowledgeFile(req, res, document, filePath);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/knowledge/files/:id/preview-meta', (req, res) => {
    try {
      const knowledge = serviceFor(db).knowledge;
      const document = knowledge.getDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (!document || document.sourceType !== 'file') return res.status(404).json({ error: 'File not found' });
      const kind = inferPreviewKind(document.fileMeta?.mimeType, document.fileMeta?.filename, document.fileMeta?.previewKind);
      return res.json({
        documentId: document.id,
        filename: document.fileMeta?.filename || document.title,
        mimeType: document.fileMeta?.mimeType || 'application/octet-stream',
        bytes: Number(document.fileMeta?.bytes) || 0,
        sha256: document.fileMeta?.sha256 || '',
        previewKind: kind,
        textAvailable: Boolean(document.content),
        parseLimited: Boolean(document.fileMeta?.previewLimited) || Number(document.fileMeta?.bytes) > MAX_PARSE_BYTES,
        status: document.status,
      });
    } catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.get('/api/knowledge/files/:id/location', (req, res) => {
    try {
      if (process.env.LIUXU_DESKTOP !== '1' || req.isRemoteClient) return res.status(403).json({ error: '仅桌面端可使用系统打开' });
      const knowledge = serviceFor(db).knowledge;
      const document = knowledge.getDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (!document || document.sourceType !== 'file') return res.status(404).json({ error: 'File not found' });
      const filePath = knowledge.filePathFor(document);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).json({ error: 'File not found' });
      return res.json({ path: fs.realpathSync(filePath) });
    } catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.get('/api/knowledge/files/:id/archive-entries', async (req, res) => {
    try {
      const knowledge = serviceFor(db).knowledge;
      const document = knowledge.getDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (!document || inferPreviewKind(document.fileMeta?.mimeType, document.fileMeta?.filename, document.fileMeta?.previewKind) !== 'archive') {
        return res.status(404).json({ error: 'ZIP file not found' });
      }
      const filePath = knowledge.filePathFor(document);
      if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
      const cursor = Math.max(0, Number.parseInt(String(req.query.cursor || '0'), 10) || 0);
      const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit || '100'), 10) || 100));
      return res.json(await listZipEntries(filePath, cursor, limit));
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });

  app.get('/api/knowledge/assets/:id/*', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const document = knowledge.getDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (!document) return res.status(404).json({ error: 'Document not found' });
      const asset = knowledge.folderSync.resolveAsset(document, req.params[0]);
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      const extension = path.extname(asset).toLowerCase();
      const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
      if (extension === '.svg') {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', contentDisposition(path.basename(asset)));
      } else {
        res.setHeader('Content-Type', mimeTypes[extension] || 'application/octet-stream');
      }
      fs.createReadStream(asset).pipe(res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/imports', (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      if (!req.file) return res.status(400).json({ error: 'File is required' });
      const temporaryPath = req.file.path;
      // Parsing stays bounded and serialized separately from the streamed upload/copy.
      await importGate.acquire();
      try {
        const filename = decodeUploadedFilename(req.file.originalname);
        const title = typeof req.body?.title === 'string'
          ? decodeUploadedFilename(req.body.title)
          : filename;
        const sourceBytes = Number(req.file.size) || 0;
        const sourceSha256 = await sha256File(temporaryPath);
        const detected = sniffKind(filename, req.file.mimetype);
        if (!detected) return res.status(400).json({ error: 'Unsupported file type' });
        if (['docx', 'spreadsheet', 'presentation'].includes(detected.previewKind)) {
          await validateOfficeArchive(temporaryPath, detected.ext || filename, { verifyData: sourceBytes <= MAX_PARSE_BYTES });
        }
        let extracted;
        if (sourceBytes <= MAX_PARSE_BYTES) {
          const buffer = fs.readFileSync(temporaryPath);
          extracted = await extractText(buffer, filename, req.file.mimetype);
        } else {
          extracted = {
            text: '', status: 'active', previewKind: detected.previewKind, mimeType: detected.mimeType,
            filename, previewLimited: true,
          };
        }
        if (extracted.error) return res.status(extracted.status || 400).json({ error: extracted.error });
        const { knowledge } = serviceFor(db);
        const result = knowledge.saveImportedFile({
          sourceFilePath: temporaryPath,
          sourceBytes,
          sourceSha256,
          filename,
          mimeType: extracted.mimeType,
          title,
          collectionPath: typeof req.body?.collectionPath === 'string' ? req.body.collectionPath : '',
          knowledgeBase: typeof req.body?.knowledgeBase === 'string' ? req.body.knowledgeBase : '',
          folderPath: typeof req.body?.folderPath === 'string' ? req.body.folderPath : '',
          text: extracted.text,
          status: extracted.status,
          previewHtml: extracted.previewHtml || '',
          previewKind: extracted.previewKind || '',
          previewLimited: Boolean(extracted.previewLimited),
          diaryUnlocked: hasDiaryAccess(req),
        });
        if (result.error) return res.status(result.status || 400).json({ error: result.error });
        if (!result.duplicate && result.document?.id) {
          const links = knowledge.outgoingLinks(result.document.id, { diaryUnlocked: hasDiaryAccess(req) });
          result.outgoingLinks = links.links || [];
        }
        res.status(result.duplicate ? 200 : 201).json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      } finally {
        importGate.release();
        try { fs.unlinkSync(temporaryPath); } catch {}
      }
    });
  });
}

module.exports = {
  registerKnowledgeRoutes,
  serviceFor,
  invalidateKnowledgeCache,
  treeForDocuments,
  documentSummary,
  filterDocuments,
  filtersFromQuery,
  sendKnowledgeFile,
  listZipEntries,
};
