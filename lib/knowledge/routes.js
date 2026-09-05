const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { createKnowledgeService } = require('./documents');
const { ensureLogsMigrated } = require('./migrate-logs');
const { createSearchIndex } = require('./search');
const { filterDocuments, filtersFromQuery } = require('./filters');
const { parseSearchOptions } = require('./search-options');
const { extractText, inferPreviewKind } = require('./import');
const { decodeUploadedFilename, contentDisposition } = require('../util/filename');

const knowledgeCache = new Map();

function invalidateKnowledgeCache(dataDir) {
  knowledgeCache.delete(dataDir);
}

const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

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

  app.get('/api/knowledge/files/:id/content', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const document = knowledge.getDocument(req.params.id, { diaryUnlocked: hasDiaryAccess(req) });
      if (!document) return res.status(404).json({ error: 'Document not found' });
      const filePath = knowledge.filePathFor(document);
      if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
      const mimeType = String(document.fileMeta?.mimeType || '').toLowerCase();
      // SVG can carry scripts; serving it inline from the app origin would
      // give imported files same-origin XSS. Force a download instead.
      const isSvg = mimeType === 'image/svg+xml' || mimeType === 'image/svg';
      if (isSvg) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${(document.fileMeta?.filename || 'file.svg').replace(/["\\\r\n]/g, '_')}"`,
        );
      } else {
        res.setHeader('Content-Type', document.fileMeta?.mimeType || 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          contentDisposition(document.fileMeta?.filename || document.title || path.basename(filePath)),
        );
      }
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/imports', (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      if (!req.file) return res.status(400).json({ error: 'File is required' });
      // PDF/DOCX parsing is CPU- and memory-heavy; bound how many run at once.
      await importGate.acquire();
      try {
        const filename = decodeUploadedFilename(req.file.originalname);
        const title = typeof req.body?.title === 'string'
          ? decodeUploadedFilename(req.body.title)
          : filename;
        const extracted = await extractText(req.file.buffer, filename, req.file.mimetype);
        if (extracted.error) return res.status(extracted.status || 400).json({ error: extracted.error });
        const { knowledge } = serviceFor(db);
        const result = knowledge.saveImportedFile({
          buffer: req.file.buffer,
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
};
