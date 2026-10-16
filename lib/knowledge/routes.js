const { nextPinTime, pinValue, comparePins, normalDirectory } = require('./pins');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const crypto = require('node:crypto');
const multer = require('multer');
const yauzl = require('yauzl');
const { createKnowledgeService } = require('./documents');
const { isExcludedSyncPath } = require('./folder-sync');
const { ensureLogsMigrated } = require('./migrate-logs');
const { createSearchIndex } = require('./search');
const { filterDocuments, filtersFromQuery } = require('./filters');
const { parseSearchOptions } = require('./search-options');
const { extractText, inferPreviewKind, MAX_FILE_BYTES, MAX_PARSE_BYTES, sniffKind, validateOfficeArchive } = require('./import');
const { decodeUploadedFilename, contentDisposition } = require('../util/filename');

const knowledgeCache = new Map();

function invalidateKnowledgeCache(dataDir) {
  const cached = knowledgeCache.get(dataDir);
  cached?.search?.dispose?.();
  cached?.knowledge?.folderSync?.stop?.();
  knowledgeCache.delete(dataDir);
}

async function pauseKnowledgeSync(dataDir) {
  const sync = knowledgeCache.get(dataDir)?.knowledge?.folderSync;
  if (!sync) return;
  const running = sync.running;
  await sync.stop();
  await running?.catch(() => {});
}

async function shutdownKnowledgeServices() {
  const errors = [];
  for (const [dataDir, cached] of knowledgeCache) {
    try { await cached.knowledge.folderSync.shutdown(); }
    catch (error) { errors.push(error); }
    finally { cached.search.dispose(); knowledgeCache.delete(dataDir); }
  }
  if (errors.length) throw new AggregateError(errors, '知识库清单落盘失败');
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
    pinnedAt: pinValue(document.pinnedAt),
    title: document.title,
    knowledgeBase: document.knowledgeBase || '',
    folderPath: document.folderPath || '',
    collectionPath: document.collectionPath,
    tags: document.tags || [],
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
    baseFingerprint: document.baseFingerprint,
    relativePath: document.relativePath,
    indexState: document.indexState,
    storageMode: document.storageMode,
    parentDocumentId: document.parentDocumentId || null,
    documentRole: document.documentRole || 'normal',
    snippet: String(document.content || '').replace(/\s+/g, ' ').trim().slice(0, 180),
  };
}

function treeForDocuments(categories, documents, db, { hideAppBundles = false } = {}) {
  if (hideAppBundles) {
    const visibleCategories = nodes => (nodes || []).filter(node => !isExcludedSyncPath(node.name, true))
      .map(node => ({ ...node, sub: visibleCategories(node.sub) }));
    categories = visibleCategories(categories);
    // Retain historical notes in storage, without recreating expandable bundle folders.
    documents = documents.filter(doc => !isExcludedSyncPath(doc.fileSync?.relativePath)
      && !isExcludedSyncPath(doc.collectionPath, true));
  }
  const byBase = new Map();
  const ensureBase = name => {
    if (!name || byBase.has(name)) return byBase.get(name);
    const value = { name, documentCount: 0, folders: [], _folderMap: new Map() };
    byBase.set(name, value);
    return value;
  };

  const buildFolder = (node, base, prefix) => {
    const pathValue = prefix ? `${prefix}/${node.name}` : node.name;
    const entry = { pinnedAt: pinValue(node.pinnedAt), name: node.name, path: pathValue, children: [], documentCount: 0, totalCount: 0 };
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
    const base = ensureBase(category.name);
    base.pinnedAt = pinValue(category.pinnedAt);
    if (category.displayName) base.displayName = category.displayName;
    base.folders = (category.sub || []).map(node => buildFolder(node, base, ''));
  });
  documents.forEach(document => {
    const base = ensureBase(document.knowledgeBase || '其他');
    base.documentCount += 1;
    if (document.folderPath) ensureDocumentFolders(base, document.folderPath);
  });
  // Count direct memberships once, then roll them up bottom-up. The previous
  // implementation rescanned every document for every folder (O(D × F)).
  const directCounts = new Map();
  documents.forEach(document => {
    const baseName = document.knowledgeBase || '其他';
    const directPath = String(document.folderPath || '');
    let folderPath = directPath;
    while (folderPath) {
      const key = `${baseName}\0${folderPath}`;
      directCounts.set(key, (directCounts.get(key) || 0) + (folderPath === directPath ? 1 : 0));
      const slash = folderPath.lastIndexOf('/');
      folderPath = slash < 0 ? '' : folderPath.slice(0, slash);
    }
  });
  for (const base of byBase.values()) {
    const countFolder = entry => {
      entry.children.forEach(countFolder);
      entry.documentCount = directCounts.get(`${base.name}\0${entry.path}`) || 0;
      entry.totalCount = entry.documentCount + entry.children.reduce((sum, child) => sum + child.totalCount, 0);
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

function registerKnowledgeRoutes(app, { db }) {
  app.post('/api/knowledge/index/rebuild', async (_req, res) => {
    try {
      const { knowledge, search } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      if (knowledge.rebuildIndex) return res.json(await knowledge.rebuildIndex());
      search.dispose();
      await fs.promises.unlink(path.join(db.dataDir, 'knowledge-index.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      invalidateKnowledgeCache(db.dataDir);
      serviceFor(db).search.rebuild();
      res.json({ rebuilt: true });
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });
  app.post('/api/knowledge/documents/:id/rename', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (!knowledge.renameDocument) return res.status(409).json({ error: '请先迁移到文件工作区' });
      const result = await knowledge.renameDocument(req.params.id, req.body || {});
      res.status(result.error ? result.status || 400 : 200).json(result.error ? result : result.document);
    } catch (error) { res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });
  app.get('/api/knowledge/sync/status', async (req, res) => {
    try {
      res.json(serviceFor(db).knowledge.folderSync.snapshot());
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.get('/api/knowledge/local-entries', async (req, res) => {
    try {
      if (req.isRemoteClient) return res.json({ entries: [] });
      const entries = await serviceFor(db).knowledge.folderSync.listNameOnlyEntries({
        knowledgeBase: String(req.query.knowledgeBase || ''),
        folderPath: String(req.query.folder || ''),
      });
      res.json({ entries });
    } catch (error) { res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });

  app.post('/api/knowledge/sync', async (req, res) => {
    try {
      const snapshot = await serviceFor(db).knowledge.folderSync.syncNow({ reason: 'manual' });
      res.json(snapshot);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/sync/verify', async (_req, res) => {
    try {
      const snapshot = await serviceFor(db).knowledge.folderSync.verifyNow();
      res.json(snapshot);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/sync/config', async (req, res) => {
    try {
      if (req.isRemoteClient || process.env.LIUXU_DESKTOP !== '1') return res.status(403).json({ error: '知识库目录只能在桌面端修改' });
      const snapshot = serviceFor(db).knowledge.folderSync.configure({
        enabled: req.body?.enabled === true,
        rootPath: req.body?.rootPath,
        syncExtensions: req.body?.syncExtensions,
      });
      res.json(snapshot);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/sync/migrate', async (req, res) => {
    try {
      if (req.isRemoteClient || process.env.LIUXU_DESKTOP !== '1') return res.status(403).json({ error: '知识迁移只能在桌面端执行' });
      const { preflightFileWorkspace, migrateFileWorkspace } = require('./file-workspace-migration');
      const root = req.body?.rootPath || serviceFor(db).knowledge.folderSync.config.rootPath;
      if (typeof root !== 'string' || !path.isAbsolute(root)) return res.status(400).json({ error: '请选择有效的文件工作区目录' });
      if (req.body?.preflight === true) return res.json(await preflightFileWorkspace(db, root));
      const report = await require('./workspace-operation-lock').withWorkspaceOperation(db.dataDir, '迁移文件工作区', async () => {
        if (require('../agent/active-runs').hasActiveAgentRuns(db)) throw Object.assign(new Error('请先结束 Agent 运行再迁移'), { status: 409 });
        await pauseKnowledgeSync(db.dataDir);
        invalidateKnowledgeCache(db.dataDir);
        try { return await migrateFileWorkspace(db, { root }); }
        finally { invalidateKnowledgeCache(db.dataDir); require('../agent/routes').invalidateAgentRuntime(db.dataDir); }
      });
      const knowledge = serviceFor(db).knowledge;
      await knowledge.ready;
      res.json({ success: true, report: { ...report, documents: report.completed.length }, status: knowledge.folderSync.snapshot() });
    } catch (err) {
      res.status(400).json({ error: err.message, report: err.report || null });
    }
  });

  app.get('/api/knowledge/sync/drafts/:draftId', async (req, res) => {
    try {
      const draft = await serviceFor(db).knowledge.folderSync.readDraft(req.params.draftId);
      if (!draft) return res.status(404).json({ error: '草稿不存在' });
      res.json(draft);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/sync/drafts', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const documentId = String(req.body?.documentId || '');
      const document = await knowledge.getDocument(documentId);
      if (!document) return res.status(404).json({ error: '文档不存在' });
      const draft = await knowledge.folderSync.saveDraft(
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

  app.put('/api/knowledge/pin', async (req, res) => {
    try {
      const { kind, id, path: categoryPath, pinned, collectionPath } = req.body || {};
      if (!['document', 'knowledgeBase', 'folder'].includes(kind) || typeof pinned !== 'boolean') return res.status(400).json({ error: '置顶参数无效' });
      let result;
      if (kind === 'document') {
        if (!/^(note|file):[a-zA-Z0-9_-]+$/.test(String(id || ''))) return res.status(400).json({ error: '文档标识无效' });
        result = await serviceFor(db).knowledge.setDocumentPinned(id, pinned, { ...req.body, pinnedAt: nextPinTime(), collectionPath });
      } else {
        const parts = typeof categoryPath === 'string' ? categoryPath.split('/') : [];
        if (!parts.length || parts.some(part => !part.trim() || part !== part.trim() || ['.', '..'].includes(part) || part.includes('\\')) || (kind === 'knowledgeBase' ? parts.length !== 1 : parts.length < 2)) return res.status(400).json({ error: '目录标识无效' });
        result = db.setCategoryPinned(categoryPath, pinned, nextPinTime());
      }
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json({ ...result, kind });
    } catch (error) { res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });

  app.get('/api/knowledge/tree', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const categories = knowledge.directoryCategories ? knowledge.directoryCategories() : db.getAllCategories();
      const documents = knowledge.listDocumentTreeLocations({ hideAppBundles: knowledge.folderSync.config.enabled });
      res.json({ knowledgeBases: treeForDocuments(categories, documents, db, { hideAppBundles: knowledge.folderSync.config.enabled }) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.get('/api/knowledge/quick-open', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const results = knowledge.quickOpen({ query, limit, categories: db.getAllCategories() });
      res.json({ results });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.get('/api/knowledge/documents', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const filters = filtersFromQuery(req.query);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 60));
      const offset = Math.max(0, Number(req.query.cursor) || 0);
      const result = knowledge.listDocumentPage(filters, {
        limit,
        offset,
        pinSort: normalDirectory(filters),
      });
      const page = result.documents.map(documentSummary);
      res.json({
        documents: page,
        total: result.total,
        nextCursor: offset + page.length < result.total ? String(offset + page.length) : null,
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.get('/api/knowledge/link-targets', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const targets = knowledge.linkTargets({
        query: typeof req.query.q === 'string' ? req.query.q : '',
        limit: Math.min(50, Math.max(1, Number(req.query.limit) || 20)),
        excludeId: typeof req.query.excludeId === 'string' ? req.query.excludeId : '',
      });
      res.json({ targets });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/documents', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = await knowledge.createNote(req.body || {});
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      const links = knowledge.outgoingLinks(result.document.id);
      res.status(201).json({ ...result.document, linkIssues: result.linkIssues || [], outgoingLinks: links.links || [] });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.get('/api/knowledge/documents/:id', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      let document = await knowledge.getDocument(req.params.id);
      if (!document) return res.status(404).json({ error: 'Document not found' });
      document = await knowledge.hydrateFilePreview(document);
      const links = knowledge.outgoingLinks(req.params.id);
      const linkIssues = knowledge.linkIssuesForDocument(req.params.id);
      res.json({ ...document, outgoingLinks: links.links || [], linkIssues: linkIssues.issues || [] });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.get('/api/knowledge/documents/:id/location', async (req, res) => {
    try {
      if (process.env.LIUXU_DESKTOP !== '1' || req.isRemoteClient) {
        return res.status(403).json({ error: '仅桌面端可打开本地文件夹' });
      }
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const document = await knowledge.getDocument(req.params.id);
      if (!document) return res.status(404).json({ error: '文档不存在或不可访问' });
      const root = knowledge.folderSync.config?.rootPath;
      const filePath = knowledge.folderSync.localPathFor(document);
      if (!root || !filePath || !fs.existsSync(root) || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: '此文档尚未同步到本地知识库文件夹' });
      }
      const rootInfo = fs.lstatSync(root);
      const fileInfo = fs.lstatSync(filePath);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
        return res.status(404).json({ error: '本地文档路径无效' });
      }
      const realRoot = fs.realpathSync(root);
      const realFile = fs.realpathSync(filePath);
      const relative = path.relative(realRoot, realFile);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return res.status(404).json({ error: '本地文档路径越界' });
      }
      return res.json({ path: path.dirname(realFile) });
    } catch (error) { return res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });

  app.get('/api/knowledge/documents/:id/backlinks', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = knowledge.backlinks(req.params.id, {
        cursor: req.query.cursor,
        limit: req.query.limit,
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/revisions/cleanup', async (req, res) => {
    try {
      const result = serviceFor(db).knowledge.finishRevisionCleanup(req.body || {});
      if (result.error) return res.status(result.status || 400).json({ error: result.error, current: result.current });
      res.json(result);
    } catch (error) { res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });

  app.get('/api/knowledge/documents/:id/revisions', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = knowledge.listRevisions(req.params.id, {
        cursor: req.query.cursor,
        limit: req.query.limit,
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.get('/api/knowledge/documents/:id/revisions/:revisionId', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = knowledge.getRevision(req.params.id, req.params.revisionId, {
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/documents/:id/revisions', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = await knowledge.createNamedRevision(req.params.id, {
        baseVersion: req.body?.baseVersion,
        baseFingerprint: req.body?.baseFingerprint,
        name: req.body?.name,
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error, current: result.current });
      res.status(201).json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/documents/:id/revisions/checkpoint', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = await knowledge.checkpointRevision(req.params.id, {
        baseVersion: req.body?.baseVersion,
        baseFingerprint: req.body?.baseFingerprint,
        source: 'assistant_edit',
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error, current: result.current });
      res.status(201).json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.patch('/api/knowledge/documents/:id/revisions/:revisionId', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = knowledge.renameRevision(req.params.id, req.params.revisionId, {
        name: req.body?.name,
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.delete('/api/knowledge/documents/:id/revisions/:revisionId', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = knowledge.deleteNamedRevision(req.params.id, req.params.revisionId, {
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/documents/:id/revisions/:revisionId/restore', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = await knowledge.restoreRevision(req.params.id, req.params.revisionId, {
        baseVersion: req.body?.baseVersion,
        baseFingerprint: req.body?.baseFingerprint,
        restoreLocation: req.body?.restoreLocation,
      });
      if (result.error) return res.status(result.status || 400).json({ error: result.error, current: result.current });
      const links = knowledge.outgoingLinks(result.document.id);
      const linkIssues = knowledge.linkIssuesForDocument(result.document.id);
      result.document = { ...result.document, outgoingLinks: links.links || [], linkIssues: linkIssues.issues || [] };
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.delete('/api/knowledge/reading-positions', (req, res) => {
    try { res.json(require('./reading-position-state').createReadingPositionStore(db.dataDir).clear()); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });
  app.post('/api/knowledge/reading-positions/migrate', (req, res) => {
    try {
      const result = require('./reading-position-state').createReadingPositionStore(db.dataDir)
        .migrateBrowserRecords(req.body?.records || {}, { complete: req.body?.complete !== false, totalCount: req.body?.totalCount ?? null });
      res.json(result);
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });
  app.delete('/api/knowledge/documents/:id/reading-position', async (req, res) => {
    try {
      if (!require('./reading-position-state').cleanDocumentId(req.params.id)) return res.status(400).json({ error: '文档标识无效' });
      res.json(require('./reading-position-state').createReadingPositionStore(db.dataDir).clear({ documentId: req.params.id }));
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });
  for (const resource of ['reading-position', 'reading-time']) {
    for (const method of ['get', 'put']) app[method](`/api/knowledge/documents/:id/${resource}`, async (req, res) => {
      try {
        // Reading state is keyed by stable document identity and remains valid
        // while the derived knowledge index is rebuilding or unavailable.
        if (!require('./reading-position-state').cleanDocumentId(req.params.id)) return res.status(400).json({ error: '文档标识无效' });
        if (resource === 'reading-time') return res.json(require('./reading-time').readingTime(db.sqlite, req.params.id, method === 'put' ? req.body : null));
        const store = require('./reading-position-state').createReadingPositionStore(db.dataDir);
        if (method === 'get') return res.json({ record: store.get({ documentId: req.params.id }) });
        // Browser migration never overwrites a newer database record.
        if (req.body.migrate && store.get({ documentId: req.params.id })) return res.json({ saved: true });
        return res.json(store.set({ documentId: req.params.id, record: req.body.record }));
      } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
    });
  }

  app.get('/api/knowledge/documents/:id/reading-data', async (req, res) => {
    try {
      const knowledge = serviceFor(db).knowledge;
      const value = await knowledge.getReadingData(req.params.id);
      if (value && await sha256File(knowledge.filePathFor(await knowledge.getDocument(req.params.id))) !== value.fingerprint) return res.status(409).json({ error: '源文件已变化，请同步知识库后重新打开' });
      return value ? res.json(value) : res.status(404).json({ error: 'File not found' });
    } catch (error) { return res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });
  app.put('/api/knowledge/documents/:id/reading-data', async (req, res) => {
    try {
      const result = await serviceFor(db).knowledge.updateReadingData(req.params.id, req.body || {});
      return res.status(result.error ? result.status || 400 : 200).json(result);
    } catch (error) { return res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });

  app.get('/api/knowledge/documents/:id/annotation', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const parent = await knowledge.getDocument(req.params.id);
      if (!parent) return res.status(404).json({ error: 'Document not found' });
      const annotation = await knowledge.getAnnotation(req.params.id);
      res.json({ annotation });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.put('/api/knowledge/documents/:id/annotation', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = await knowledge.upsertAnnotation(req.params.id, req.body || {});
      if (result.error) {
        return res.status(result.status || 400).json({ error: result.error, current: result.current });
      }
      const links = knowledge.outgoingLinks(result.document.id);
      res.status(result.document.version === 1 ? 201 : 200).json({ ...result.document, linkIssues: result.linkIssues || [], outgoingLinks: links.links || [] });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.patch('/api/knowledge/documents/:id', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = await knowledge.updateDocument(req.params.id, req.body || {});
      if (result.error) return res.status(result.status || 400).json({ error: result.error, current: result.current });
      const links = knowledge.outgoingLinks(result.document.id);
      res.json({ ...result.document, linkIssues: result.linkIssues || [], outgoingLinks: links.links || [] });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/documents/:id/archive', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = await knowledge.archiveDocument(req.params.id, req.body || {});
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result.document);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/documents/:id/restore', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = await knowledge.restoreDocument(req.params.id, req.body || {});
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json(result.document);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.delete('/api/knowledge/documents/:id', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const result = await knowledge.deleteDocument(req.params.id, req.body || {});
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.json({ ok: true, document: result.document });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.get('/api/knowledge/search', async (req, res) => {
    try {
      const { search, knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const filters = filtersFromQuery(req.query);
      const query = filters.search;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 60));
      delete filters.search;
      const searchOptions = parseSearchOptions(req.query);
      const documents = search.searchDocuments(query, filters, {
        limit,
        summarize: documentSummary,
        searchOptions,
      });
      res.json({ documents, total: documents.length });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.all('/api/knowledge/files/:id/content', async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(405);
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const document = await knowledge.getDocument(req.params.id);
      if (!document) return res.status(404).json({ error: 'Document not found' });
      const filePath = knowledge.filePathFor(document);
      if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
      return sendKnowledgeFile(req, res, document, filePath);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.get('/api/knowledge/files/:id/text', async (req, res) => {
    try {
      const result = await serviceFor(db).knowledge.getTextFile(req.params.id);
      if ([404, 409].includes(result.status)) return res.status(result.status).json(result);
      // Unsupported encodings/sizes are capabilities, not failed document reads.
      res.json(result);
    } catch (error) { res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });

  app.put('/api/knowledge/files/:id/text', async (req, res) => {
    try {
      const result = await serviceFor(db).knowledge.updateTextFile(req.params.id, req.body || {});
      if (result.error) return res.status(result.status || 400).json(result);
      res.json(result);
    } catch (error) { res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });

  app.get('/api/knowledge/files/:id/preview-meta', async (req, res) => {
    try {
      const knowledge = serviceFor(db).knowledge;
      const document = await knowledge.getDocument(req.params.id);
      if (!document || document.sourceType !== 'file') return res.status(404).json({ error: 'File not found' });
      const kind = inferPreviewKind(document.fileMeta?.mimeType, document.fileMeta?.filename, document.fileMeta?.previewKind);
      if (['.epub', '.cbz'].includes(path.extname(document.fileMeta?.filename || '').toLowerCase())) await validateOfficeArchive(knowledge.filePathFor(document), document.fileMeta.filename);
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
    } catch (error) { return res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });

  app.get('/api/knowledge/files/:id/location', async (req, res) => {
    try {
      if (process.env.LIUXU_DESKTOP !== '1' || req.isRemoteClient) return res.status(403).json({ error: '仅桌面端可使用系统打开' });
      const knowledge = serviceFor(db).knowledge;
      const document = await knowledge.getDocument(req.params.id);
      if (!document || document.sourceType !== 'file') return res.status(404).json({ error: 'File not found' });
      const filePath = knowledge.filePathFor(document);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).json({ error: 'File not found' });
      return res.json({ path: fs.realpathSync(filePath) });
    } catch (error) { return res.status(error.status || 500).json({ error: error.message, current: error.current }); }
  });

  app.get('/api/knowledge/files/:id/archive-entries', async (req, res) => {
    try {
      const knowledge = serviceFor(db).knowledge;
      const document = await knowledge.getDocument(req.params.id);
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

  app.get('/api/knowledge/assets/:id/*', async (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      if (knowledge.ready) await knowledge.ready;
      const document = await knowledge.getDocument(req.params.id);
      if (!document) return res.status(404).json({ error: 'Document not found' });
      const asset = await knowledge.folderSync.resolveAsset(document, req.params[0]);
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
      res.status(err.status || 500).json({ error: err.message, current: err.current });
    }
  });

  app.post('/api/knowledge/imports', async (req, res) => {
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
      if (knowledge.ready) await knowledge.ready;
        const result = await knowledge.saveImportedFile({
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
        });
        if (result.error) return res.status(result.status || 400).json({ error: result.error });
        if (!result.duplicate && result.document?.id) {
          const links = knowledge.outgoingLinks(result.document.id);
          result.outgoingLinks = links.links || [];
        }
        res.status(result.duplicate ? 200 : 201).json(result);
      } catch (error) {
        res.status(error.status || 500).json({ error: error.message, current: error.current });
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
  pauseKnowledgeSync,
  shutdownKnowledgeServices,
  treeForDocuments,
  documentSummary,
  filterDocuments,
  filtersFromQuery,
  sendKnowledgeFile,
  listZipEntries,
};
