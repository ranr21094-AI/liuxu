const fs = require('fs');
const path = require('path');
const { atomicWriteJson, readJsonIfExists } = require('../util/json-file');
const { createKnowledgeService } = require('./documents');

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

function logTimestampToIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return new Date().toISOString();
  if (raw.includes('T')) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
  }
  const normalized = raw.replace(' ', 'T');
  const parsed = Date.parse(`${normalized}Z`);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const localParsed = Date.parse(normalized);
  return Number.isFinite(localParsed) ? new Date(localParsed).toISOString() : new Date().toISOString();
}

function clearLegacyLogs(db, logs, mappings) {
  const dataDir = db.dataDir;
  atomicWriteJson(path.join(dataDir, 'logs.migrated.json'), logs);
  atomicWriteJson(path.join(dataDir, 'logs.json'), []);
  if (typeof db.clearLogs === 'function') db.clearLogs();
  atomicWriteJson(path.join(dataDir, '.logs-migrated.json'), {
    version: 1,
    migratedAt: new Date().toISOString(),
    count: Object.keys(mappings).length,
    mappings,
    backupFile: 'logs.migrated.json',
  });
}

function ensureLogsMigrated(db) {
  const logs = (typeof db.getAllUnpaginated === 'function' ? db.getAllUnpaginated({}, true) : [])
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (!Array.isArray(logs) || logs.length === 0) {
    return { migrated: 0, skipped: true };
  }

  const dataDir = db.dataDir;
  const markerFile = path.join(dataDir, '.logs-migrated.json');
  const marker = readJsonIfExists(markerFile, { version: 1, mappings: {}, migratedAt: null });
  const mappings = { ...(marker.mappings || {}) };
  const pending = logs.filter(log => !mappings[String(log.id)]);

  if (pending.length === 0) {
    clearLegacyLogs(db, logs, mappings);
    return { migrated: 0, cleared: logs.length, mappings };
  }

  const knowledge = createKnowledgeService(db);
  const store = knowledge.readStore();

  let migrated = 0;
  for (const log of pending) {
    const key = String(log.id);
    const location = splitCollectionPath(log.category || '其他');
    const visibility = typeof db.isDiaryCategory === 'function' && db.isDiaryCategory(location.collectionPath)
      ? 'diary'
      : 'standard';
    const id = `note:${store.nextNoteId}`;
    store.nextNoteId += 1;
    store.documents.push({
      id,
      sourceType: 'note',
      sourceRef: id,
      title: String(log.title || '').trim().slice(0, 200) || '未命名笔记',
      content: String(log.content || ''),
      collectionPath: location.collectionPath,
      knowledgeBase: location.knowledgeBase,
      folderPath: location.folderPath,
      tags: [],
      visibility,
      status: 'active',
      fileMeta: null,
      createdAt: logTimestampToIso(log.created_at),
      updatedAt: logTimestampToIso(log.updated_at),
      version: 1,
      documentDate: String(log.log_date || '').trim(),
      documentRole: 'normal',
    });
    mappings[key] = id;
    migrated += 1;
  }

  knowledge.writeStore(store);
  clearLegacyLogs(db, logs, mappings);
  return { migrated, total: logs.length, mappings };
}

module.exports = { ensureLogsMigrated };
