const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openAccountDatabase } = require('../db/connection');
const { readMeta, writeMeta, parseJson } = require('../db/helpers');
const { decodeUploadedFilename } = require('../util/filename');
const { extractDocxPreview, inferPreviewKind } = require('./import');
const {
  canonicalizeContent,
  normalizeTitle,
  parseWikiLinks,
  isDocumentId,
} = require('./links');

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

// Path segments end up in the DB, link targets and every index rebuild; keep
// them bounded instead of relying on the HTTP body limit alone.
const MAX_LOCATION_SEGMENT_CHARS = 80;
const MAX_FOLDER_SEGMENTS = 8;

function capLocationSegment(value) {
  return String(value || '').trim().slice(0, MAX_LOCATION_SEGMENT_CHARS);
}

function capFolderPath(value) {
  const segments = String(value || '')
    .split('/')
    .map(segment => capLocationSegment(segment))
    .filter(Boolean);
  return segments.slice(0, MAX_FOLDER_SEGMENTS).join('/');
}

const MAX_CONTENT_CHARS = 500000;

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
  const sqlite = db.sqlite || openAccountDatabase(db.dataDir);
  function dataDir() { return db.dataDir; }
  function filesDir() { return path.join(dataDir(), 'knowledge-files'); }

  const REVISION_WINDOW_MS = 5 * 60 * 1000;
  const REVISION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const REVISION_MAX_COUNT = 50;
  let rebuildingTitleMap = null;
  let linkHealthState = null;

  function editableSnapshot(document) {
    return {
      title: String(document?.title || ''),
      content: String(document?.content || ''),
      tags: Array.isArray(document?.tags) ? document.tags.map(String) : [],
      knowledgeBase: String(document?.knowledgeBase || ''),
      folderPath: String(document?.folderPath || ''),
      documentDate: String(document?.documentDate || ''),
    };
  }

  function snapshotKey(document) {
    return JSON.stringify(editableSnapshot(document));
  }

  function linkIndexBuilt() {
    return readMeta(sqlite, 'knowledge_links_index_built', '0') === '1';
  }

  function linkIndexHealthy() {
    if (!linkIndexBuilt()) return false;
    try {
      const documents = sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_documents').get().count;
      const targets = sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_link_targets').get().count;
      const links = sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_links').get().count;
      const version = sqlite.prepare('SELECT version FROM knowledge_index_state WHERE id = 1').get()?.version || 0;
      const state = `${documents}:${targets}:${links}:${version}`;
      if (linkHealthState === state) return true;
      if (Number(documents) !== Number(targets)) return false;
      const expected = sqlite.prepare("SELECT id, body FROM knowledge_documents WHERE body LIKE '%[[%'").all();
      const actual = new Map(sqlite.prepare('SELECT source_document_id AS id, COUNT(*) AS count FROM knowledge_links GROUP BY source_document_id').all()
        .map(row => [String(row.id), Number(row.count) || 0]));
      for (const row of expected) {
        const document = parseJson(row.body, {});
        const count = parseWikiLinks(document.content || '').length;
        if (count !== (actual.get(String(row.id)) || 0)) return false;
      }
      linkHealthState = state;
      return true;
    } catch {
      return false;
    }
  }

  function sourceDocumentsForLinks({ diaryUnlocked = true, includeArchived = false } = {}) {
    return nativeDocuments().filter(document => {
      if (!includeArchived && document.status === 'archived') return false;
      if (document.visibility === 'diary' && !diaryUnlocked) return false;
      return true;
    });
  }

  function titleCandidates(normalized, { diaryUnlocked = true, includeArchived = false } = {}) {
    if (!normalized) return [];
    if (linkIndexBuilt()) {
      const rows = sqlite.prepare(`
        SELECT document_id AS id, title, source_type AS sourceType, visibility, status,
               knowledge_base AS knowledgeBase, folder_path AS folderPath
        FROM knowledge_link_targets WHERE normalized_title = ?
        ORDER BY document_id ASC
      `).all(normalized);
      return rows.filter(row => (
        (includeArchived || row.status !== 'archived')
        && (diaryUnlocked || row.visibility !== 'diary')
      ));
    }
    const source = rebuildingTitleMap
      ? (rebuildingTitleMap.get(normalized) || [])
      : sourceDocumentsForLinks({ diaryUnlocked, includeArchived });
    return source
      .filter(document => rebuildingTitleMap || normalizeTitle(document.title) === normalized)
      .filter(document => (
        (includeArchived || document.status !== 'archived')
        && (diaryUnlocked || document.visibility !== 'diary')
      ))
      .map(document => ({
        id: document.id,
        title: document.title,
        sourceType: document.sourceType,
        visibility: document.visibility,
        status: document.status,
        knowledgeBase: document.knowledgeBase,
        folderPath: document.folderPath,
      }));
  }

  function resolveTitle(normalized, options = {}) {
    const candidates = titleCandidates(normalized, options);
    if (candidates.length === 1) return { status: 'resolved', documentId: candidates[0].id, candidates };
    if (candidates.length > 1) return { status: 'ambiguous', candidates: candidates.slice(0, 20) };
    return { status: 'unresolved', candidates: [] };
  }

  function collectLinkIssues(contentResult, { diaryUnlocked = false } = {}) {
    const issues = Array.isArray(contentResult?.issues) ? [...contentResult.issues] : [];
    const known = new Set(issues.map(item => `${item.raw}:${item.status}`));
    for (const link of parseWikiLinks(contentResult?.content || '')) {
      if (!link.targetId || !isDocumentId(link.targetId)) continue;
      const target = readDocumentById(link.targetId);
      const status = !target ? 'missing' : (target.visibility === 'diary' && !diaryUnlocked ? 'locked' : '');
      if (!status) continue;
      const issue = { raw: link.raw, title: link.label, status, candidates: [] };
      const key = `${issue.raw}:${issue.status}`;
      if (!known.has(key)) {
        known.add(key);
        issues.push(issue);
      }
    }
    return issues;
  }

  function updateLinkTarget(document) {
    sqlite.prepare(`
      INSERT INTO knowledge_link_targets
        (document_id, normalized_title, title, source_type, visibility, status,
         knowledge_base, folder_path, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        normalized_title = excluded.normalized_title,
        title = excluded.title,
        source_type = excluded.source_type,
        visibility = excluded.visibility,
        status = excluded.status,
        knowledge_base = excluded.knowledge_base,
        folder_path = excluded.folder_path,
        updated_at = excluded.updated_at
    `).run(
      String(document.id),
      normalizeTitle(document.title),
      String(document.title || ''),
      String(document.sourceType || 'note'),
      String(document.visibility || 'standard'),
      String(document.status || 'active'),
      String(document.knowledgeBase || ''),
      String(document.folderPath || ''),
      String(document.updatedAt || ''),
    );
  }

  function replaceDocumentLinks(document) {
    sqlite.prepare('DELETE FROM knowledge_links WHERE source_document_id = ?').run(String(document.id));
    const links = parseWikiLinks(document.content || '');
    const insert = sqlite.prepare(`
      INSERT INTO knowledge_links
        (source_document_id, target_document_id, source_version, target_label, raw_target,
         char_offset, occurrence_index, resolved)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seen = new Map();
    links.forEach((link, index) => {
      let targetId = link.targetId || '';
      let resolved = Boolean(targetId && isDocumentId(targetId) && readDocumentById(targetId));
      if (!resolved) {
        const resolution = resolveTitle(normalizeTitle(link.label), { diaryUnlocked: true });
        targetId = resolution.status === 'resolved' ? resolution.documentId : null;
        resolved = Boolean(targetId);
      }
      const occurrenceIndex = seen.get(`${targetId || ''}:${link.start}`) || index;
      seen.set(`${targetId || ''}:${link.start}`, occurrenceIndex);
      insert.run(
        String(document.id),
        targetId || null,
        Number(document.version) || 0,
        String(link.label || ''),
        String(link.rawTarget || ''),
        Number(link.start) || 0,
        occurrenceIndex,
        resolved ? 1 : 0,
      );
    });
  }

  function syncDocumentLinkData(document) {
    updateLinkTarget(document);
    replaceDocumentLinks(document);
  }

  function captureRevision(document, reason = 'auto') {
    if (!document?.id) return;
    const latest = sqlite.prepare(`
      SELECT captured_at AS capturedAt, snapshot
      FROM knowledge_revisions
      WHERE document_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1
    `).get(String(document.id));
    const now = Date.now();
    const latestTime = latest ? Date.parse(latest.capturedAt) : NaN;
    if (reason === 'auto' && Number.isFinite(latestTime) && now - latestTime < REVISION_WINDOW_MS) return;
    const snapshot = JSON.stringify(editableSnapshot(document));
    if (latest?.snapshot === snapshot && reason === 'auto') return;
    sqlite.prepare(`
      INSERT INTO knowledge_revisions
        (document_id, document_version, captured_at, reason, snapshot)
      VALUES (?, ?, ?, ?, ?)
    `).run(String(document.id), Number(document.version) || 1, new Date(now).toISOString(), reason, snapshot);
    const cutoff = new Date(now - REVISION_MAX_AGE_MS).toISOString();
    sqlite.prepare(`
      DELETE FROM knowledge_revisions
      WHERE document_id = ?
        AND (captured_at < ? OR id NOT IN (
          SELECT id FROM knowledge_revisions
          WHERE document_id = ? ORDER BY captured_at DESC, id DESC LIMIT ?
        ))
    `).run(String(document.id), cutoff, String(document.id), REVISION_MAX_COUNT);
  }

  function revisionSummary(row) {
    const snapshot = parseJson(row.snapshot, {});
    return {
      id: Number(row.id),
      documentId: String(row.documentId),
      documentVersion: Number(row.documentVersion) || 1,
      capturedAt: row.capturedAt,
      reason: row.reason || 'auto',
      title: String(snapshot.title || ''),
      contentLength: String(snapshot.content || '').length,
      tags: Array.isArray(snapshot.tags) ? snapshot.tags : [],
    };
  }

  function listRevisions(id, { diaryUnlocked = false, cursor = 0, limit = 30 } = {}) {
    const document = getDocument(id, { diaryUnlocked });
    if (!document) return { error: 'Document not found', status: 404 };
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 30));
    const offset = Math.max(0, Number(cursor) || 0);
    const rows = sqlite.prepare(`
      SELECT id, document_id AS documentId, document_version AS documentVersion,
             captured_at AS capturedAt, reason, snapshot
      FROM knowledge_revisions WHERE document_id = ?
      ORDER BY captured_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(String(id), safeLimit, offset);
    return {
      revisions: rows.map(revisionSummary),
      total: sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_revisions WHERE document_id = ?').get(String(id)).count,
      nextCursor: rows.length === safeLimit ? String(offset + rows.length) : null,
    };
  }

  function getRevision(id, revisionId, { diaryUnlocked = false } = {}) {
    const document = getDocument(id, { diaryUnlocked });
    if (!document) return { error: 'Document not found', status: 404 };
    const row = sqlite.prepare(`
      SELECT id, document_id AS documentId, document_version AS documentVersion,
             captured_at AS capturedAt, reason, snapshot
      FROM knowledge_revisions WHERE id = ? AND document_id = ?
    `).get(Number(revisionId), String(id));
    if (!row) return { error: 'Revision not found', status: 404 };
    return { revision: { ...revisionSummary(row), snapshot: parseJson(row.snapshot, {}) } };
  }

  function rebuildLinkIndex() {
    const documents = nativeDocuments();
    rebuildingTitleMap = new Map();
    documents.forEach(document => {
      const key = normalizeTitle(document.title);
      const list = rebuildingTitleMap.get(key) || [];
      list.push(document);
      rebuildingTitleMap.set(key, list);
    });
    const tx = sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM knowledge_links').run();
      sqlite.prepare('DELETE FROM knowledge_link_targets').run();
      documents.forEach(updateLinkTarget);
      documents.forEach(replaceDocumentLinks);
      writeMeta(sqlite, 'knowledge_links_index_built', '1');
      const current = sqlite.prepare('SELECT version FROM knowledge_index_state WHERE id = 1').get();
      writeMeta(sqlite, 'knowledge_links_index_version', String(Number(current?.version) || 0));
    });
    try {
      tx();
      linkHealthState = null;
    } finally {
      rebuildingTitleMap = null;
    }
    return documents.length;
  }

  function ensureLinkIndex() {
    if (!linkIndexHealthy()) rebuildLinkIndex();
  }

  function linkTargets({ query = '', diaryUnlocked = false, limit = 20, excludeId = '' } = {}) {
    ensureLinkIndex();
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
    const needle = String(query || '').trim();
    const pattern = needle ? `%${needle.replace(/[\\%_]/g, '\\$&')}%` : '%';
    const rows = sqlite.prepare(`
      SELECT document_id AS id, title, source_type AS sourceType, visibility, status,
             knowledge_base AS knowledgeBase, folder_path AS folderPath
      FROM knowledge_link_targets
      WHERE (title LIKE ? ESCAPE '\\' OR normalized_title LIKE ? ESCAPE '\\')
        AND status = 'active'
        AND (? = 1 OR visibility != 'diary')
        AND document_id != ?
      ORDER BY updated_at DESC, document_id ASC LIMIT ?
    `).all(pattern, pattern, diaryUnlocked ? 1 : 0, String(excludeId || ''), safeLimit);
    return rows;
  }

  function backlinks(id, { diaryUnlocked = false, cursor = 0, limit = 20 } = {}) {
    const target = getDocument(id, { diaryUnlocked: true });
    if (!target) return { error: 'Document not found', status: 404 };
    if (target.visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    ensureLinkIndex();
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
    const offset = Math.max(0, Number(cursor) || 0);
    const rows = sqlite.prepare(`
      SELECT l.source_document_id AS sourceId, l.target_label AS label,
             l.char_offset AS offset, d.body
      FROM knowledge_links l
      JOIN knowledge_documents d ON d.id = l.source_document_id
      WHERE l.target_document_id = ? AND l.resolved = 1
        AND COALESCE(json_extract(d.body, '$.status'), 'active') != 'archived'
        AND (? = 1 OR COALESCE(json_extract(d.body, '$.visibility'), 'standard') != 'diary')
      ORDER BY d.rowid DESC, l.char_offset ASC
      LIMIT ? OFFSET ?
    `).all(String(id), diaryUnlocked ? 1 : 0, safeLimit, offset);
    const result = rows.map(row => {
      const source = normalizeDocument(parseJson(row.body, {}));
      const content = String(source.content || '');
      const start = Math.max(0, Number(row.offset) || 0);
      return {
        sourceId: source.id,
        title: source.title,
        knowledgeBase: source.knowledgeBase,
        folderPath: source.folderPath,
        label: row.label,
        offset: start,
        snippet: content.slice(Math.max(0, start - 100), Math.min(content.length, start + 180)).replace(/\s+/g, ' ').trim(),
      };
    }).filter(Boolean);
    const total = sqlite.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_links l
      JOIN knowledge_documents d ON d.id = l.source_document_id
      WHERE l.target_document_id = ? AND l.resolved = 1
        AND COALESCE(json_extract(d.body, '$.status'), 'active') != 'archived'
        AND (? = 1 OR COALESCE(json_extract(d.body, '$.visibility'), 'standard') != 'diary')
    `).get(String(id), diaryUnlocked ? 1 : 0).count;
    return { backlinks: result, total, nextCursor: rows.length === safeLimit ? String(offset + rows.length) : null };
  }

  function outgoingLinks(id, { diaryUnlocked = false } = {}) {
    const document = getDocument(id, { diaryUnlocked });
    if (!document) return { error: 'Document not found', status: 404 };
    const links = parseWikiLinks(document.content || '');
    return {
      links: links.map(link => {
        let targetId = link.targetId || '';
        if (!targetId) {
          const resolution = resolveTitle(normalizeTitle(link.label), { diaryUnlocked });
          if (resolution.status === 'resolved') targetId = resolution.documentId;
          if (resolution.status === 'ambiguous') {
            return { ...link, status: 'ambiguous', candidates: resolution.candidates.slice(0, 20) };
          }
        }
        if (!targetId) return { ...link, status: 'unresolved', targetId: '' };
        const target = getDocument(targetId, { diaryUnlocked: true });
        if (!target) return { ...link, targetId, status: 'missing' };
        if (target.visibility === 'diary' && !diaryUnlocked) return { ...link, targetId: '', status: 'locked' };
        return {
          ...link,
          targetId,
          status: target.status === 'archived' ? 'archived' : 'resolved',
          targetTitle: target.title,
          targetKnowledgeBase: target.knowledgeBase,
          targetFolderPath: target.folderPath,
        };
      }),
    };
  }

  function linkIssuesForDocument(id, { diaryUnlocked = false } = {}) {
    const result = outgoingLinks(id, { diaryUnlocked });
    if (result.error) return result;
    return {
      issues: result.links.filter(link => link.status && link.status !== 'resolved').map(link => ({
        raw: link.raw,
        title: link.label,
        status: link.status,
        candidates: Array.isArray(link.candidates) ? link.candidates : [],
      })),
    };
  }

  function restoreRevision(id, revisionId, { baseVersion, diaryUnlocked = false } = {}) {
    const current = getDocument(id, { diaryUnlocked: true });
    if (!current) return { error: 'Document not found', status: 404 };
    if (current.visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    if (baseVersion === undefined || baseVersion === null || baseVersion === '') {
      return { error: 'baseVersion is required', status: 400, current };
    }
    if (!Number.isInteger(Number(baseVersion)) || Number(baseVersion) < 1) {
      return { error: 'baseVersion is invalid', status: 400, current };
    }
    if (Number(baseVersion) !== Number(current.version)) {
      return { error: 'Document version conflict', status: 409, current };
    }
    const row = sqlite.prepare(`
      SELECT id, document_id AS documentId, document_version AS documentVersion,
             captured_at AS capturedAt, reason, snapshot
      FROM knowledge_revisions WHERE id = ? AND document_id = ?
    `).get(Number(revisionId), String(id));
    if (!row) return { error: 'Revision not found', status: 404 };
    const snapshot = parseJson(row.snapshot, null);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { error: 'Revision snapshot is invalid', status: 500 };
    }
    const knowledgeBase = String(snapshot.knowledgeBase || current.knowledgeBase || '其他').trim() || '其他';
    const folderPath = String(snapshot.folderPath || '').trim().replace(/^\/+|\/+$/g, '');
    const collectionPath = composeCollectionPath(knowledgeBase, folderPath);
    const visibility = isDiaryCollection(collectionPath, db) ? 'diary' : current.visibility;
    if (visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    const updated = normalizeDocument({
      ...current,
      title: String(snapshot.title || '未命名笔记').slice(0, 200),
      content: String(snapshot.content || ''),
      tags: Array.isArray(snapshot.tags) ? snapshot.tags.map(tag => String(tag).slice(0, 40)).slice(0, 20) : [],
      knowledgeBase,
      folderPath,
      collectionPath,
      documentDate: String(snapshot.documentDate || ''),
      visibility,
      updatedAt: nowIso(),
      version: (current.version || 1) + 1,
    });
    writeDocument(updated, { previous: current, revisionReason: 'pre_restore' });
    return { document: updated, restoredRevisionId: Number(revisionId) };
  }

  function readStore() {
    const documents = sqlite.prepare('SELECT body FROM knowledge_documents ORDER BY rowid ASC').all()
      .map(row => normalizeDocument(parseJson(row.body, {})));
    const nextNoteId = Math.max(1, Number(readMeta(sqlite, 'next_note_id', '1')) || 1);
    const nextFileId = Math.max(1, Number(readMeta(sqlite, 'next_file_id', '1')) || 1);
    return { documents, nextNoteId, nextFileId };
  }

  function readDocumentById(id) {
    const row = sqlite.prepare('SELECT body FROM knowledge_documents WHERE id = ?').get(String(id));
    return row ? normalizeDocument(parseJson(row.body, {})) : null;
  }

  let indexChangesSincePrune = 0;

  // knowledge_index_changes grows on every write. Once the on-disk index file
  // has been persisted at the current version, rows at or below that version
  // are no longer reachable by applyIncremental and can be dropped. The
  // version check makes this safe: if the index file is behind, the history
  // is still needed for a fast-forward and nothing is deleted.
  function pruneIndexChanges() {
    if (indexChangesSincePrune < 200) return;
    indexChangesSincePrune = 0;
    try {
      const indexFile = path.join(dataDir(), 'knowledge-index.json');
      if (!fs.existsSync(indexFile)) return;
      const saved = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const persisted = Number(saved?.indexVersion);
      if (!Number.isFinite(persisted) || persisted <= 0) return;
      const current = Number(sqlite.prepare('SELECT version FROM knowledge_index_state WHERE id = 1').get()?.version) || 0;
      if (current > persisted) return;
      sqlite.prepare('DELETE FROM knowledge_index_changes WHERE version <= ?').run(persisted);
    } catch { /* pruning is best-effort */ }
  }

  function touchIndexVersion(changes = []) {
    const current = sqlite.prepare('SELECT version FROM knowledge_index_state WHERE id = 1').get();
    const nextVersion = Math.max(0, Number(current?.version) || 0) + 1;
    sqlite.prepare(`
      INSERT INTO knowledge_index_state (id, version, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version,
        updated_at = excluded.updated_at
    `).run(nextVersion, Date.now());
    const insertChange = sqlite.prepare(
      'INSERT INTO knowledge_index_changes (version, document_id, operation) VALUES (?, ?, ?)',
    );
    for (const change of changes) {
      if (change?.documentId && ['upsert', 'delete'].includes(change.operation)) {
        insertChange.run(nextVersion, String(change.documentId), change.operation);
      }
    }
    indexChangesSincePrune += 1;
    pruneIndexChanges();
    return nextVersion;
  }

  function writeDocument(doc, { previous = null, revisionReason = 'auto' } = {}) {
    const tx = sqlite.transaction(() => {
      if (previous && snapshotKey(previous) !== snapshotKey(doc)) captureRevision(previous, revisionReason);
      sqlite.prepare(`
        INSERT INTO knowledge_documents (id, body) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET body = excluded.body
      `).run(String(doc.id), JSON.stringify(doc));
      const version = touchIndexVersion([{ documentId: doc.id, operation: 'upsert' }]);
      syncDocumentLinkData(doc);
      if (linkIndexBuilt()) writeMeta(sqlite, 'knowledge_links_index_version', String(version));
    });
    tx();
  }

  function writeStore(store) {
    const tx = sqlite.transaction(() => {
      const existing = new Map(sqlite.prepare('SELECT id, body FROM knowledge_documents').all()
        .map(row => [String(row.id), row.body]));
      const upsert = sqlite.prepare(`
        INSERT INTO knowledge_documents (id, body) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET body = excluded.body
      `);
      const currentIds = new Set();
      let changed = false;
      const changes = [];
      const changedDocuments = [];
      for (const doc of store.documents) {
        const id = String(doc.id);
        const body = JSON.stringify(doc);
        currentIds.add(id);
        if (existing.get(id) !== body) {
          upsert.run(id, body);
          changed = true;
          changes.push({ documentId: id, operation: 'upsert' });
          changedDocuments.push(doc);
        }
      }
      const remove = sqlite.prepare('DELETE FROM knowledge_documents WHERE id = ?');
      for (const id of existing.keys()) {
        if (!currentIds.has(id)) {
          remove.run(id);
          sqlite.prepare('DELETE FROM knowledge_link_targets WHERE document_id = ?').run(id);
          changed = true;
          changes.push({ documentId: id, operation: 'delete' });
        }
      }
      writeMeta(sqlite, 'next_note_id', String(Math.max(1, Number(store.nextNoteId) || 1)));
      writeMeta(sqlite, 'next_file_id', String(Math.max(1, Number(store.nextFileId) || 1)));
      if (changed) {
        const version = touchIndexVersion(changes);
        changedDocuments.forEach(syncDocumentLinkData);
        if (linkIndexBuilt()) writeMeta(sqlite, 'knowledge_links_index_version', String(version));
      }
    });
    tx();
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
    const doc = readDocumentById(id);
    if (!doc) return null;
    if (doc.visibility === 'diary' && !diaryUnlocked) return null;
    return { ...doc };
  }

  function createNote(input, { diaryUnlocked = false } = {}) {
    const title = String(input.title || '').trim().slice(0, 200);
    const normalizedContent = canonicalizeContent(String(input.content || ''), normalized => (
      resolveTitle(normalized, { diaryUnlocked })
    ));
    const content = normalizedContent.content;
    const parentDocumentId = typeof input.parentDocumentId === 'string' && input.parentDocumentId
      ? input.parentDocumentId
      : null;
    const parent = parentDocumentId
      ? getDocument(parentDocumentId, { diaryUnlocked })
      : null;
    if (parentDocumentId && !parent) return { error: 'Parent document not found', status: 404 };
    if (parentDocumentId && parent.sourceType !== 'file') {
      return { error: 'Only files can have an annotation', status: 400 };
    }
    const legacyLocation = splitCollectionPath(input.collectionPath || '');
    const knowledgeBase = parent
      ? parent.knowledgeBase
      : (capLocationSegment(input.knowledgeBase || legacyLocation.knowledgeBase || '其他') || '其他');
    const folderPath = parent
      ? parent.folderPath
      : capFolderPath(String(input.folderPath ?? legacyLocation.folderPath ?? ''));
    const collectionPath = composeCollectionPath(knowledgeBase, folderPath);
    const visibility = parent
      ? parent.visibility
      : (isDiaryCollection(collectionPath, db) || input.visibility === 'diary' ? 'diary' : 'standard');
    if (visibility === 'diary' && !diaryUnlocked) {
      return { error: 'Diary is locked', status: 403 };
    }
    if (content.length > MAX_CONTENT_CHARS) {
      return { error: '笔记内容超过大小限制', status: 413 };
    }
    const nextNoteId = Math.max(1, Number(readMeta(sqlite, 'next_note_id', '1')) || 1);
    const id = `note:${nextNoteId}`;
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
      documentDate: String(input.documentDate || input.date || '').trim().slice(0, 40),
      parentDocumentId,
      documentRole: parentDocumentId ? 'annotation' : 'normal',
    };
    writeDocument(doc);
    writeMeta(sqlite, 'next_note_id', String(nextNoteId + 1));
    return { document: doc, linkIssues: collectLinkIssues(normalizedContent, { diaryUnlocked }) };
  }

  function updateDocument(id, patch, { diaryUnlocked = false } = {}) {
    const current = getDocument(id, { diaryUnlocked: true });
    if (!current) return { error: 'Document not found', status: 404 };
    if (current.status === 'archived') return { error: 'Document is archived', status: 403 };
    if (current.visibility === 'diary' && !diaryUnlocked) return { error: 'Diary is locked', status: 403 };
    if (patch.baseVersion !== undefined && Number(patch.baseVersion) !== Number(current.version)) {
      return { error: 'Document version conflict', status: 409, current };
    }

    const existing = readDocumentById(id);
    if (!existing) return { error: 'Document not found', status: 404 };
    const legacyLocation = splitCollectionPath(patch.collectionPath || '');
    const knowledgeBase = patch.knowledgeBase !== undefined
      ? capLocationSegment(patch.knowledgeBase)
      : (patch.collectionPath !== undefined ? capLocationSegment(legacyLocation.knowledgeBase) : existing.knowledgeBase);
    const folderPath = patch.folderPath !== undefined
      ? capFolderPath(String(patch.folderPath))
      : (patch.collectionPath !== undefined ? capFolderPath(legacyLocation.folderPath) : existing.folderPath);
    const collectionPath = composeCollectionPath(knowledgeBase, folderPath);
    const visibility = isDiaryCollection(collectionPath, db) ? 'diary' : existing.visibility;
    if (patch.content !== undefined && String(patch.content).length > MAX_CONTENT_CHARS) {
      return { error: '笔记内容超过大小限制', status: 413 };
    }
    const normalizedContent = patch.content !== undefined
      ? canonicalizeContent(String(patch.content), normalized => resolveTitle(normalized, { diaryUnlocked }))
      : { content: existing.content, issues: [] };
    const updated = {
      ...existing,
      title: patch.title !== undefined ? String(patch.title).slice(0, 200) : existing.title,
      content: normalizedContent.content,
      collectionPath,
      knowledgeBase,
      folderPath,
      tags: Array.isArray(patch.tags) ? patch.tags.map(tag => String(tag).slice(0, 40)).slice(0, 20) : existing.tags,
      visibility,
      updatedAt: nowIso(),
      version: (existing.version || 1) + 1,
      documentDate: patch.documentDate !== undefined
        ? String(patch.documentDate || '').trim().slice(0, 40)
        : (patch.date !== undefined ? String(patch.date || '').trim().slice(0, 40) : existing.documentDate || ''),
    };
    writeDocument(updated, { previous: existing });
    return { document: updated, linkIssues: collectLinkIssues(normalizedContent, { diaryUnlocked }) };
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
      const ids = store.documents
        .filter(item => item.id === id || item.parentDocumentId === id)
        .map(item => item.id);
      const remove = sqlite.prepare('DELETE FROM knowledge_documents WHERE id = ?');
      const tx = sqlite.transaction(() => {
        ids.forEach(itemId => remove.run(itemId));
        ids.forEach(itemId => sqlite.prepare('DELETE FROM knowledge_link_targets WHERE document_id = ?').run(itemId));
        touchIndexVersion(ids.map(documentId => ({ documentId, operation: 'delete' })));
      });
      tx();
      return { document: current, deleted: true };
    } else {
      // Notes can carry annotation children too (created before the
      // file-only restriction); cascade so nothing is orphaned.
      const ids = store.documents
        .filter(item => item.id === id || (item.parentDocumentId === id && item.documentRole === 'annotation'))
        .map(item => item.id);
      const tx = sqlite.transaction(() => {
        ids.forEach(itemId => sqlite.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(itemId));
        ids.forEach(itemId => sqlite.prepare('DELETE FROM knowledge_link_targets WHERE document_id = ?').run(itemId));
        touchIndexVersion(ids.map(documentId => ({ documentId, operation: 'delete' })));
      });
      tx();
      return { document: current, deleted: true };
    }
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
      // Promote-only visibility refresh (same rule as updateDocument): items
      // moved into the diary collection become diary-locked; items moved out
      // keep their existing visibility so a lock never silently lifts.
      const visibility = isDiaryCollection(nextLocation.collectionPath, db) ? 'diary' : normalized.visibility;
      return normalizeDocument({
        ...item,
        visibility,
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
    const saved = readStore();
    const raw = saved.documents.find(item => item.id === document.id) || null;
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
    if (previewKind === 'docx' && !String(next.previewHtml || '').trim() && next.fileMeta?.previewExtracted !== true) {
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
    // previewExtracted marks empty/broken results so empty-preview docx files
    // do not re-run the full mammoth conversion on every single read.
    try {
      const previewHtml = await extractDocxPreview(fs.readFileSync(filePath));
      return persistFilePreview(document, {
        previewHtml: previewHtml || '',
        fileMeta: { ...(document.fileMeta || {}), previewKind: 'docx', previewExtracted: true },
      });
    } catch {
      return persistFilePreview(document, {
        previewHtml: '',
        fileMeta: { ...(document.fileMeta || {}), previewKind: 'docx', previewExtracted: true },
      });
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
    const nextFileId = Math.max(1, Number(readMeta(sqlite, 'next_file_id', '1')) || 1);
    const id = `file:${nextFileId}`;
    const now = nowIso();
    const normalizedContent = canonicalizeContent(String(text || ''), normalized => (
      resolveTitle(normalized, { diaryUnlocked })
    ));
    const doc = {
      id,
      sourceType: 'file',
      sourceRef: storedName,
      title: title || filename || id,
      content: normalizedContent.content,
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
    writeDocument(doc);
    writeMeta(sqlite, 'next_file_id', String(nextFileId + 1));
    return { document: doc, duplicate: false, linkIssues: collectLinkIssues(normalizedContent, { diaryUnlocked }) };
  }

  function filePathFor(doc) {
    if (!doc?.fileMeta?.storedName) return null;
    const target = path.resolve(filesDir(), doc.fileMeta.storedName);
    if (!target.startsWith(path.resolve(filesDir()) + path.sep)) return null;
    return target;
  }

  function sourceSignature(diaryUnlocked) {
    const row = sqlite.prepare('SELECT version FROM knowledge_index_state WHERE id = 1').get();
    return `${Number(row?.version) || 0}:${diaryUnlocked ? '1' : '0'}`;
  }

  function indexChangesSince(version) {
    return sqlite.prepare(`
      SELECT version, document_id AS documentId, operation
      FROM knowledge_index_changes WHERE version > ? ORDER BY version ASC, id ASC
    `).all(Math.max(0, Number(version) || 0));
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
    indexChangesSince,
    nativeDocuments,
    readStore,
    writeStore,
    linkTargets,
    backlinks,
    outgoingLinks,
    linkIssuesForDocument,
    rebuildLinkIndex,
    ensureLinkIndex,
    listRevisions,
    getRevision,
    restoreRevision,
    editableSnapshot,
  };
}

module.exports = { createKnowledgeService };
