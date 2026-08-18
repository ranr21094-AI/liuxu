const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, readJsonIfExists } = require('../util/json-file');
const { decodeUploadedFilename } = require('../util/filename');
const { extractDocxPreview, inferPreviewKind } = require('./import');

function nowIso() {
  return new Date().toISOString();
}

function logVersion(log) {
  const parsed = Date.parse(log.updated_at || log.created_at || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function splitCollectionPath(value) {
  const pathValue = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!pathValue) return { knowledgeBase: '其他', folderPath: '', collectionPath: '其他' };
  const [knowledgeBase, ...rest] = pathValue.split('/').filter(Boolean);
  const folderPath = rest.join('/');
  return {
    knowledgeBase: knowledgeBase || '其他',
    folderPath,
    collectionPath: [knowledgeBase || '其他', folderPath].filter(Boolean).join('/'),
  };
}

function composeCollectionPath(knowledgeBase, folderPath, fallback = '其他') {
  const base = String(knowledgeBase || '').trim().replace(/^\/+|\/+$/g, '') || fallback;
  const folder = String(folderPath || '').trim().replace(/^\/+|\/+$/g, '');
  return [base, folder].filter(Boolean).join('/');
}

function normalizeDocument(document) {
  const derived = splitCollectionPath(document.collectionPath || document.knowledgeBase || '其他');
  const knowledgeBase = String(document.knowledgeBase || derived.knowledgeBase || '其他').trim() || '其他';
  const folderPath = String(document.folderPath ?? derived.folderPath ?? '').trim().replace(/^\/+|\/+$/g, '');
  const title = decodeUploadedFilename(document.title);
  const fileMeta = document.fileMeta
    ? {
      ...document.fileMeta,
      filename: decodeUploadedFilename(document.fileMeta.filename) || document.fileMeta.filename,
    }
    : document.fileMeta;
  return {
    ...document,
    title,
    fileMeta,
    knowledgeBase,
    folderPath,
    collectionPath: composeCollectionPath(knowledgeBase, folderPath),
    documentDate: document.documentDate || document.logDate || '',
  };
}

function emptyStore() {
  return { documents: [], nextNoteId: 1, nextFileId: 1 };
}

function isDiaryCollection(collectionPath, db) {
  return typeof db.isDiaryCategory === 'function' && db.isDiaryCategory(collectionPath);
}

function logToDocument(log, db) {
  const location = splitCollectionPath(log.category || '其他');
  return {
    id: `log:${log.id}`,
    sourceType: 'log',
    sourceRef: String(log.id),
    title: log.title || '',
    content: log.content || '',
    collectionPath: location.collectionPath,
    knowledgeBase: location.knowledgeBase,
    folderPath: location.folderPath,
    tags: [],
    visibility: isDiaryCollection(location.collectionPath, db) ? 'diary' : 'standard',
    status: 'active',
    fileMeta: null,
    createdAt: log.created_at || '',
    updatedAt: log.updated_at || '',
    version: logVersion(log),
    pinned: log.pinned === true,
    logDate: log.log_date || '',
    documentDate: log.log_date || '',
    hours: log.hours,
  };
}

function photoToDocument(item) {
  const location = splitCollectionPath('其他/附件');
  return {
    id: `file:photo:${item.id}`,
    sourceType: 'file',
    sourceRef: `photo-wall:${item.id}`,
    title: item.comment || item.filename || `照片 ${item.id}`,
    content: item.comment || '',
    collectionPath: location.collectionPath,
    knowledgeBase: location.knowledgeBase,
    folderPath: location.folderPath,
    tags: ['photo-wall'],
    visibility: 'standard',
    status: 'active',
    fileMeta: {
      filename: item.filename || '',
      mimeType: '',
      bytes: 0,
      sha256: '',
      url: item.url || '',
    },
    createdAt: item.created_at || '',
    updatedAt: item.updated_at || '',
    version: 1,
  };
}

function createKnowledgeService(db) {
  function dataDir() { return db.dataDir; }
  function documentsFile() { return path.join(dataDir(), 'knowledge-documents.json'); }
  function filesDir() { return path.join(dataDir(), 'knowledge-files'); }

  function readStore() {
    const saved = readJsonIfExists(documentsFile(), emptyStore());
    if (!saved || !Array.isArray(saved.documents)) return emptyStore();
    return {
      documents: saved.documents.map(normalizeDocument),
      nextNoteId: Number(saved.nextNoteId) > 0 ? Number(saved.nextNoteId) : 1,
      nextFileId: Number(saved.nextFileId) > 0 ? Number(saved.nextFileId) : 1,
    };
  }

  function writeStore(store) {
    atomicWriteJson(documentsFile(), store);
  }

  function nativeDocuments() {
    return readStore().documents.map(item => normalizeDocument({ ...item }));
  }

  function adaptedDocuments() {
    const logs = db.getAllUnpaginated({}, true);
    const photos = db.getPhotoWall?.().items || [];
    return [
      ...logs.map(log => logToDocument(log, db)),
      ...photos.map(photoToDocument),
    ];
  }

  function allDocuments({ diaryUnlocked = false, includeArchived = false } = {}) {
    const docs = [...adaptedDocuments(), ...nativeDocuments()];
    return docs.filter(doc => {
      if (!includeArchived && doc.status === 'archived') return false;
      if (doc.visibility === 'diary' && !diaryUnlocked) return false;
      return true;
    });
  }

  function getDocument(id, { diaryUnlocked = false } = {}) {
    const docs = [...adaptedDocuments(), ...nativeDocuments()];
    const doc = docs.find(item => item.id === id);
    if (!doc) return null;
    if (doc.visibility === 'diary' && !diaryUnlocked) return null;
    return { ...doc };
  }

  function createNote(input, { diaryUnlocked = false } = {}) {
    const title = String(input.title || '').trim().slice(0, 200);
    const content = String(input.content || '');
    const parentDocumentId = typeof input.parentDocumentId === 'string' && input.parentDocumentId
      ? input.parentDocumentId
      : null;
    const parent = parentDocumentId
      ? getDocument(parentDocumentId, { diaryUnlocked })
      : null;
    if (parentDocumentId && !parent) return { error: 'Parent document not found', status: 404 };
    const legacyLocation = splitCollectionPath(input.collectionPath || '');
    const knowledgeBase = parent
      ? parent.knowledgeBase
      : (String(input.knowledgeBase || legacyLocation.knowledgeBase || '其他').trim() || '其他');
    const folderPath = parent
      ? parent.folderPath
      : String(input.folderPath ?? legacyLocation.folderPath ?? '').trim().replace(/^\/+|\/+$/g, '');
    const collectionPath = composeCollectionPath(knowledgeBase, folderPath);
    const visibility = parent
      ? parent.visibility
      : (isDiaryCollection(collectionPath, db) || input.visibility === 'diary' ? 'diary' : 'standard');
    if (visibility === 'diary' && !diaryUnlocked) {
      return { error: 'Diary is locked', status: 403 };
    }
    const store = readStore();
    const id = `note:${store.nextNoteId}`;
    const now = nowIso();
    const doc = {
      id,
      sourceType: 'note',
      sourceRef: id,
      title: title || '未命名笔记',
      content,
      collectionPath,
      knowledgeBase,
      folderPath,
      tags: Array.isArray(input.tags) ? input.tags.map(tag => String(tag).slice(0, 40)).slice(0, 20) : [],
      visibility,
      status: 'active',
      fileMeta: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
      documentDate: String(input.documentDate || input.date || '').trim(),
      parentDocumentId,
      documentRole: parentDocumentId ? 'annotation' : 'normal',
    };
    store.documents.push(doc);
    store.nextNoteId += 1;
    writeStore(store);
    return { document: doc };
  }

  function updateDocument(id, patch, { diaryUnlocked = false } = {}) {
    const current = getDocument(id, { diaryUnlocked: true });
    if (!current) return { error: 'Document not found', status: 404 };
    if (current.visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    if (patch.baseVersion !== undefined && Number(patch.baseVersion) !== Number(current.version)) {
      return { error: 'Document version conflict', status: 409, current };
    }
    if (current.sourceType === 'file' && patch.content !== undefined && patch.content !== current.content) {
      return { error: 'Imported file content is read-only', status: 400 };
    }

    if (current.sourceType === 'log') {
      const logId = Number(current.sourceRef);
      const legacyLocation = splitCollectionPath(patch.collectionPath || '');
      const knowledgeBase = patch.knowledgeBase !== undefined
        ? String(patch.knowledgeBase).trim()
        : (patch.collectionPath !== undefined ? legacyLocation.knowledgeBase : current.knowledgeBase);
      const folderPath = patch.folderPath !== undefined
        ? String(patch.folderPath).trim().replace(/^\/+|\/+$/g, '')
        : (patch.collectionPath !== undefined ? legacyLocation.folderPath : current.folderPath);
      const collectionPath = composeCollectionPath(knowledgeBase, folderPath);
      if (isDiaryCollection(collectionPath, db) && !diaryUnlocked) {
        return { error: 'Diary is locked', status: 403 };
      }
      const next = db.update(logId, {
        title: patch.title !== undefined ? patch.title : current.title,
        content: patch.content !== undefined ? patch.content : current.content,
        category: collectionPath,
        log_date: patch.documentDate !== undefined
          ? String(patch.documentDate || '')
          : (patch.date !== undefined ? String(patch.date || '') : current.documentDate),
      });
      if (!next) return { error: 'Document not found', status: 404 };
      return { document: logToDocument(next, db) };
    }

    const store = readStore();
    const index = store.documents.findIndex(item => item.id === id);
    if (index < 0) return { error: 'Document not found', status: 404 };
    const existing = store.documents[index];
    const legacyLocation = splitCollectionPath(patch.collectionPath || '');
    const knowledgeBase = patch.knowledgeBase !== undefined
      ? String(patch.knowledgeBase).trim()
      : (patch.collectionPath !== undefined ? legacyLocation.knowledgeBase : existing.knowledgeBase);
    const folderPath = patch.folderPath !== undefined
      ? String(patch.folderPath).trim().replace(/^\/+|\/+$/g, '')
      : (patch.collectionPath !== undefined ? legacyLocation.folderPath : existing.folderPath);
    const collectionPath = composeCollectionPath(knowledgeBase, folderPath);
    const visibility = isDiaryCollection(collectionPath, db) ? 'diary' : existing.visibility;
    const updated = {
      ...existing,
      title: patch.title !== undefined ? String(patch.title).slice(0, 200) : existing.title,
      content: patch.content !== undefined ? String(patch.content) : existing.content,
      collectionPath,
      knowledgeBase,
      folderPath,
      tags: Array.isArray(patch.tags) ? patch.tags.map(tag => String(tag).slice(0, 40)).slice(0, 20) : existing.tags,
      visibility,
      updatedAt: nowIso(),
      version: (existing.version || 1) + 1,
      documentDate: patch.documentDate !== undefined
        ? String(patch.documentDate || '')
        : (patch.date !== undefined ? String(patch.date || '') : existing.documentDate || ''),
    };
    store.documents[index] = updated;
    writeStore(store);
    return { document: updated };
  }

  function getAnnotation(parentDocumentId, { diaryUnlocked = false } = {}) {
    const parent = getDocument(parentDocumentId, { diaryUnlocked });
    if (!parent) return null;
    const annotation = nativeDocuments().find(doc => (
      doc.parentDocumentId === parentDocumentId
      && doc.documentRole === 'annotation'
      && doc.status !== 'archived'
    ));
    if (!annotation) return null;
    if (annotation.visibility === 'diary' && !diaryUnlocked) return null;
    return annotation;
  }

  function upsertAnnotation(parentDocumentId, input, { diaryUnlocked = false } = {}) {
    const parent = getDocument(parentDocumentId, { diaryUnlocked });
    if (!parent) return { error: 'Parent document not found', status: 404 };
    if (parent.sourceType !== 'file') return { error: 'Only files can have an annotation', status: 400 };
    const existing = getAnnotation(parentDocumentId, { diaryUnlocked });
    if (existing) {
      return updateDocument(existing.id, {
        title: input.title,
        content: input.content,
        tags: input.tags,
        baseVersion: input.baseVersion,
      }, { diaryUnlocked });
    }
    return createNote({
      title: input.title || `${parent.title || parent.fileMeta?.filename || '文件'} · 笔记`,
      content: input.content || '',
      tags: Array.isArray(input.tags) ? input.tags : [],
      parentDocumentId,
    }, { diaryUnlocked });
  }

  function archiveDocument(id, { diaryUnlocked = false } = {}) {
    const current = getDocument(id, { diaryUnlocked: true });
    if (!current) return { error: 'Document not found', status: 404 };
    if (current.visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    if (current.sourceType === 'log') {
      db.remove(Number(current.sourceRef));
      return { document: { ...current, status: 'archived' } };
    }
    const store = readStore();
    const index = store.documents.findIndex(item => item.id === id);
    if (index < 0) return { error: 'Document not found', status: 404 };
    store.documents[index] = {
      ...store.documents[index],
      status: 'archived',
      updatedAt: nowIso(),
      version: (store.documents[index].version || 1) + 1,
    };
    writeStore(store);
    return { document: store.documents[index] };
  }

  function rewriteCollectionPath(oldPath, newPath) {
    const sourceLocation = splitCollectionPath(oldPath);
    const targetLocation = splitCollectionPath(newPath);
    const source = composeCollectionPath(sourceLocation.knowledgeBase, sourceLocation.folderPath);
    const target = composeCollectionPath(targetLocation.knowledgeBase, targetLocation.folderPath);
    const store = readStore();
    let changed = false;
    store.documents = store.documents.map(item => {
      const normalized = normalizeDocument(item);
      if (normalized.collectionPath !== source && !normalized.collectionPath.startsWith(`${source}/`)) return item;
      const suffix = normalized.collectionPath === source ? '' : normalized.collectionPath.slice(source.length + 1);
      const nextPath = [target, suffix].filter(Boolean).join('/');
      const nextLocation = splitCollectionPath(nextPath);
      changed = true;
      return normalizeDocument({
        ...item,
        collectionPath: nextLocation.collectionPath,
        knowledgeBase: nextLocation.knowledgeBase,
        folderPath: nextLocation.folderPath,
        updatedAt: nowIso(),
        version: (item.version || 1) + 1,
      });
    });
    if (changed) writeStore(store);
    return changed;
  }

  function reassignCollectionPath(oldPath, targetPath = '其他') {
    return rewriteCollectionPath(oldPath, targetPath);
  }

  function findBySha256(sha256) {
    return nativeDocuments().find(doc => doc.fileMeta?.sha256 === sha256 && doc.status !== 'archived') || null;
  }

  function persistFilePreview(document, patch) {
    const store = readStore();
    const index = store.documents.findIndex(item => item.id === document.id);
    if (index < 0) return document;
    const next = {
      ...store.documents[index],
      ...patch,
      fileMeta: {
        ...store.documents[index].fileMeta,
        ...(patch.fileMeta || {}),
      },
      updatedAt: nowIso(),
    };
    store.documents[index] = next;
    writeStore(store);
    return next;
  }

  async function hydrateFilePreview(document) {
    if (!document || document.sourceType !== 'file') return document;
    const previewKind = inferPreviewKind(
      document.fileMeta?.mimeType,
      document.fileMeta?.filename || document.fileMeta?.storedName,
      document.fileMeta?.previewKind,
    );
    let next = document;
    if (document.fileMeta?.previewKind !== previewKind) {
      next = persistFilePreview(next, { fileMeta: { ...next.fileMeta, previewKind } });
    }
    const saved = readJsonIfExists(documentsFile(), emptyStore());
    const raw = Array.isArray(saved.documents) ? saved.documents.find(item => item.id === document.id) : null;
    if (raw) {
      const repairedTitle = decodeUploadedFilename(raw.title);
      const repairedFilename = decodeUploadedFilename(raw.fileMeta?.filename);
      if (repairedTitle !== raw.title || repairedFilename !== (raw.fileMeta?.filename || '')) {
        next = persistFilePreview(next, {
          title: repairedTitle,
          fileMeta: {
            ...(next.fileMeta || {}),
            filename: repairedFilename || next.fileMeta?.filename,
          },
        });
      }
    }
    if (previewKind === 'docx' && !next.previewHtml) {
      next = await ensureDocxPreview(next);
    }
    return {
      ...next,
      fileMeta: {
        ...(next.fileMeta || {}),
        previewKind,
      },
    };
  }

  async function ensureDocxPreview(document) {
    if (!document || document.sourceType !== 'file') return document;
    if (document.previewHtml) return document;
    const previewKind = inferPreviewKind(
      document.fileMeta?.mimeType,
      document.fileMeta?.filename || document.fileMeta?.storedName,
      document.fileMeta?.previewKind,
    );
    if (previewKind !== 'docx') return document;
    const filePath = filePathFor(document);
    if (!filePath || !fs.existsSync(filePath)) return document;
    try {
      const previewHtml = await extractDocxPreview(fs.readFileSync(filePath));
      if (!previewHtml) return document;
      return persistFilePreview(document, {
        previewHtml,
        fileMeta: { ...(document.fileMeta || {}), previewKind: 'docx' },
      });
    } catch {
      return document;
    }
  }

  function saveImportedFile({
    buffer,
    filename,
    mimeType,
    title,
    collectionPath,
    knowledgeBase,
    folderPath,
    text,
    status,
    previewHtml,
    previewKind,
    diaryUnlocked,
  }) {
    filename = decodeUploadedFilename(filename);
    title = decodeUploadedFilename(title);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const existing = findBySha256(sha256);
    if (existing) {
      if (existing.visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
      return { document: existing, duplicate: true };
    }
    const legacyLocation = splitCollectionPath(collectionPath || '');
    const resolvedKnowledgeBase = String(knowledgeBase || legacyLocation.knowledgeBase || '其他').trim() || '其他';
    const resolvedFolderPath = String(folderPath ?? legacyLocation.folderPath ?? '').trim().replace(/^\/+|\/+$/g, '');
    const resolvedCollectionPath = composeCollectionPath(resolvedKnowledgeBase, resolvedFolderPath);
    const visibility = isDiaryCollection(resolvedCollectionPath, db) ? 'diary' : 'standard';
    if (visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    fs.mkdirSync(filesDir(), { recursive: true });
    const safeName = String(filename || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
    const storedName = `${sha256.slice(0, 16)}-${safeName}`;
    const storedPath = path.join(filesDir(), storedName);
    fs.writeFileSync(storedPath, buffer);
    const store = readStore();
    const id = `file:${store.nextFileId}`;
    const now = nowIso();
    const doc = {
      id,
      sourceType: 'file',
      sourceRef: storedName,
      title: title || filename || id,
      content: text || '',
      collectionPath: resolvedCollectionPath,
      knowledgeBase: resolvedKnowledgeBase,
      folderPath: resolvedFolderPath,
      tags: [],
      visibility,
      status: status || 'active',
      previewHtml: previewHtml || '',
      fileMeta: {
        filename: filename || storedName,
        mimeType: mimeType || 'application/octet-stream',
        bytes: buffer.length,
        sha256,
        storedName,
        previewKind: previewKind || inferPreviewKind(mimeType, filename),
      },
      createdAt: now,
      updatedAt: now,
      version: 1,
      documentDate: '',
    };
    store.documents.push(doc);
    store.nextFileId += 1;
    writeStore(store);
    return { document: doc, duplicate: false };
  }

  function filePathFor(doc) {
    if (!doc?.fileMeta?.storedName) return null;
    const target = path.resolve(filesDir(), doc.fileMeta.storedName);
    if (!target.startsWith(path.resolve(filesDir()) + path.sep)) return null;
    return target;
  }

  function sourceSignature(diaryUnlocked) {
    const payload = JSON.stringify({
      logs: db.getAllUnpaginated({}, true).map(log => [log.id, log.updated_at, log.title, log.category]),
      docs: nativeDocuments().map(doc => [doc.id, doc.updatedAt, doc.version, doc.status]),
      diaryUnlocked: Boolean(diaryUnlocked),
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  return {
    get dataDir() { return dataDir(); },
    get filesDir() { return filesDir(); },
    allDocuments,
    getDocument,
    createNote,
    updateDocument,
    getAnnotation,
    upsertAnnotation,
    archiveDocument,
    rewriteCollectionPath,
    reassignCollectionPath,
    saveImportedFile,
    ensureDocxPreview,
    hydrateFilePreview,
    inferPreviewKind,
    filePathFor,
    sourceSignature,
    nativeDocuments,
  };
}

module.exports = { createKnowledgeService };
