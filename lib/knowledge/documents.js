const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, readJsonIfExists } = require('../util/json-file');
const { decodeUploadedFilename } = require('../util/filename');
const { extractDocxPreview, inferPreviewKind } = require('./import');

function nowIso() {
  return new Date().toISOString();
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
    documentDate: document.documentDate || '',
  };
}

function emptyStore() {
  return { documents: [], nextNoteId: 1, nextFileId: 1 };
}

function safeStoredFilename(filename) {
  const raw = String(filename || 'file').trim();
  const ext = path.extname(raw);
  const base = path.basename(raw, ext).replace(/[\x00-\x1f\\/:*?"<>|]+/g, '_').replace(/\.+$/g, '').trim();
  const safeBase = (base || 'file').slice(0, 120);
  return `${safeBase}${ext}`;
}

function isDiaryCollection(collectionPath, db) {
  return typeof db.isDiaryCategory === 'function' && db.isDiaryCategory(collectionPath);
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

  function allDocuments({ diaryUnlocked = false, includeArchived = false } = {}) {
    const docs = nativeDocuments();
    return docs.filter(doc => {
      if (!includeArchived && doc.status === 'archived') return false;
      if (doc.visibility === 'diary' && !diaryUnlocked) return false;
      return true;
    });
  }

  function getDocument(id, { diaryUnlocked = false } = {}) {
    const doc = nativeDocuments().find(item => item.id === id);
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
    if (current.status === 'archived') return { error: 'Document is archived', status: 403 };
    if (current.visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    if (patch.baseVersion !== undefined && Number(patch.baseVersion) !== Number(current.version)) {
      return { error: 'Document version conflict', status: 409, current };
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
    if (!parent || parent.status === 'archived') return null;
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
    if (parent.status === 'archived') return { error: 'Parent document is archived', status: 403 };
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

  function setDocumentStatuses(ids, status, store = readStore()) {
    const idSet = new Set(ids);
    const now = nowIso();
    store.documents = store.documents.map(item => {
      if (!idSet.has(item.id)) return item;
      return {
        ...item,
        status,
        updatedAt: now,
        version: (item.version || 1) + 1,
      };
    });
    writeStore(store);
    return store;
  }

  function annotationIdsForParent(parentId, store = readStore()) {
    return store.documents
      .filter(item => item.parentDocumentId === parentId && item.documentRole === 'annotation')
      .map(item => item.id);
  }

  function archiveDocument(id, { diaryUnlocked = false } = {}) {
    const current = getDocument(id, { diaryUnlocked: true });
    if (!current) return { error: 'Document not found', status: 404 };
    if (current.visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    if (current.status === 'archived') return { document: current };
    const store = readStore();
    if (store.documents.findIndex(item => item.id === id) < 0) {
      return { error: 'Document not found', status: 404 };
    }
    const ids = [id, ...annotationIdsForParent(id, store).filter(annotationId => {
      const annotation = store.documents.find(item => item.id === annotationId);
      return annotation && annotation.status !== 'archived';
    })];
    setDocumentStatuses(ids, 'archived', store);
    return { document: readStore().documents.find(item => item.id === id) };
  }

  function restoreDocument(id, { diaryUnlocked = false } = {}) {
    const current = getDocument(id, { diaryUnlocked: true });
    if (!current) return { error: 'Document not found', status: 404 };
    if (current.visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    if (current.status !== 'archived') return { document: current };
    const store = readStore();
    if (store.documents.findIndex(item => item.id === id) < 0) {
      return { error: 'Document not found', status: 404 };
    }
    const ids = [id, ...annotationIdsForParent(id, store).filter(annotationId => {
      const annotation = store.documents.find(item => item.id === annotationId);
      return annotation && annotation.status === 'archived';
    })];
    setDocumentStatuses(ids, 'active', store);
    return { document: readStore().documents.find(item => item.id === id) };
  }

  function deleteDocument(id, { diaryUnlocked = false } = {}) {
    const current = getDocument(id, { diaryUnlocked: true });
    if (!current) return { error: 'Document not found', status: 404 };
    if (current.visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    const store = readStore();
    const index = store.documents.findIndex(item => item.id === id);
    if (index < 0) return { error: 'Document not found', status: 404 };
    if (current.sourceType === 'file') {
      const filePath = filePathFor(current);
      if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
      store.documents = store.documents.filter(item => item.id !== id && item.parentDocumentId !== id);
    } else {
      store.documents = store.documents.filter(item => item.id !== id);
    }
    writeStore(store);
    return { document: current, deleted: true };
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
    return nativeDocuments().find(doc => doc.fileMeta?.sha256 === sha256) || null;
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
    if (previewKind === 'docx' && !String(next.previewHtml || '').trim()) {
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
      return {
        document: existing,
        duplicate: true,
        archived: existing.status === 'archived',
      };
    }
    const legacyLocation = splitCollectionPath(collectionPath || '');
    const resolvedKnowledgeBase = String(knowledgeBase || legacyLocation.knowledgeBase || '其他').trim() || '其他';
    const resolvedFolderPath = String(folderPath ?? legacyLocation.folderPath ?? '').trim().replace(/^\/+|\/+$/g, '');
    const resolvedCollectionPath = composeCollectionPath(resolvedKnowledgeBase, resolvedFolderPath);
    const visibility = isDiaryCollection(resolvedCollectionPath, db) ? 'diary' : 'standard';
    if (visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    fs.mkdirSync(filesDir(), { recursive: true });
    const safeName = safeStoredFilename(filename);
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
    restoreDocument,
    deleteDocument,
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
