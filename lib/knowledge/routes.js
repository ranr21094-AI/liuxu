const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { createKnowledgeService } = require('./documents');
const { createSearchIndex } = require('./search');
const { extractText, inferPreviewKind } = require('./import');
const { decodeUploadedFilename, contentDisposition } = require('../util/filename');

const knowledgeCache = new Map();
const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

function serviceFor(db) {
  const key = db.dataDir;
  let entry = knowledgeCache.get(key);
  if (!entry) {
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
    documentDate: document.documentDate || document.logDate || '',
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
    const value = { name, visibility, documentCount: 0, folders: [], _folders: new Map() };
    byBase.set(name, value);
    return value;
  };
  (Array.isArray(categories) ? categories : []).forEach(category => {
    if (!category?.name) return;
    const base = ensureBase(category.name, db.isDiaryCategory(category.name) ? 'diary' : 'standard');
    (category.sub || []).forEach(folder => {
      if (!folder) return;
      const pathValue = String(folder);
      const item = { name: pathValue, path: pathValue, documentCount: 0 };
      base.folders.push(item);
      base._folders.set(pathValue, item);
    });
  });
  documents.forEach(document => {
    const base = ensureBase(document.knowledgeBase || '其他', document.visibility || 'standard');
    base.documentCount += 1;
    const folderPath = String(document.folderPath || '');
    if (!folderPath) return;
    let folder = base._folders.get(folderPath);
    if (!folder) {
      folder = { name: folderPath, path: folderPath, documentCount: 0 };
      base.folders.push(folder);
      base._folders.set(folderPath, folder);
    }
    folder.documentCount += 1;
  });
  return [...byBase.values()].map(base => {
    const { _folders, ...result } = base;
    result.folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
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
      const legacyCollectionPath = typeof (req.query.collectionPath || req.query.collection) === 'string'
        ? String(req.query.collectionPath || req.query.collection)
        : '';
      const knowledgeBase = typeof req.query.knowledgeBase === 'string' ? String(req.query.knowledgeBase).trim() : '';
      const folderPath = typeof req.query.folderPath === 'string' ? String(req.query.folderPath).trim() : '';
      const search = typeof (req.query.search || req.query.q) === 'string'
        ? String(req.query.search || req.query.q).trim()
        : '';
      const tag = typeof req.query.tag === 'string' ? req.query.tag.trim().toLowerCase() : '';
      const from = typeof req.query.from === 'string' ? req.query.from : '';
      const to = typeof req.query.to === 'string' ? req.query.to : '';
      const date = typeof req.query.date === 'string' ? req.query.date : '';
      const type = typeof req.query.type === 'string' ? req.query.type : '';
      const status = req.query.status === 'archived' ? 'archived' : 'active';
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 60));
      const offset = Math.max(0, Number(req.query.cursor) || 0);
      let documents = knowledge.allDocuments({ diaryUnlocked, includeArchived: status === 'archived' });
      documents = documents.filter(doc => (doc.status || 'active') === status);
      if (req.query.includeAnnotations !== '1') {
        documents = documents.filter(doc => doc.documentRole !== 'annotation');
      }
      if (type) documents = documents.filter(doc => doc.sourceType === type);
      if (knowledgeBase) documents = documents.filter(doc => doc.knowledgeBase === knowledgeBase);
      if (folderPath) {
        documents = documents.filter(doc => doc.folderPath === folderPath || String(doc.folderPath || '').startsWith(`${folderPath}/`));
      }
      if (!knowledgeBase && !folderPath && legacyCollectionPath) {
        documents = documents.filter(doc => doc.collectionPath === legacyCollectionPath || String(doc.collectionPath).startsWith(`${legacyCollectionPath}/`));
      }
      if (search) {
        const needle = search.toLowerCase();
        documents = documents.filter(doc => `${doc.title}\n${doc.content}`.toLowerCase().includes(needle));
      }
      if (tag) documents = documents.filter(doc => (doc.tags || []).some(item => String(item).toLowerCase() === tag));
      if (from) documents = documents.filter(doc => !doc.updatedAt || doc.updatedAt.slice(0, 10) >= from);
      if (to) documents = documents.filter(doc => !doc.updatedAt || doc.updatedAt.slice(0, 10) <= to);
      if (date) documents = documents.filter(doc => (doc.documentDate || doc.logDate || doc.updatedAt || doc.createdAt || '').slice(0, 10) === date);
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

  app.post('/api/knowledge/documents', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
       const result = knowledge.createNote(req.body || {}, { diaryUnlocked: hasDiaryAccess(req) });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      res.status(201).json(result.document);
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
      res.json(document);
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
      res.status(result.document.version === 1 ? 201 : 200).json(result.document);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/knowledge/documents/:id', (req, res) => {
    try {
      const { knowledge } = serviceFor(db);
      const result = knowledge.updateDocument(req.params.id, req.body || {}, { diaryUnlocked: hasDiaryAccess(req) });
      if (result.error) return res.status(result.status || 400).json({ error: result.error, current: result.current });
      res.json(result.document);
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

  app.get('/api/knowledge/search', (req, res) => {
    try {
      const { search } = serviceFor(db);
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      const collectionPath = typeof req.query.collectionPath === 'string' ? req.query.collectionPath : '';
      const knowledgeBase = typeof req.query.knowledgeBase === 'string' ? req.query.knowledgeBase : '';
      const folderPath = typeof req.query.folderPath === 'string' ? req.query.folderPath : '';
      const results = search.search(query, {
        diaryUnlocked: hasDiaryAccess(req),
        collectionPath,
        knowledgeBase,
        folderPath,
        limit: 30,
      });
      res.json({ results });
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
      res.setHeader('Content-Type', document.fileMeta?.mimeType || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        contentDisposition(document.fileMeta?.filename || document.title || path.basename(filePath)),
      );
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/knowledge/imports', (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      if (!req.file) return res.status(400).json({ error: 'File is required' });
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
        res.status(result.duplicate ? 200 : 201).json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  });
}

module.exports = { registerKnowledgeRoutes, serviceFor, treeForDocuments };
