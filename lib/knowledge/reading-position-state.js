const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = '.reading-positions.json';
const MAX_RECORDS = 5000;
const MAX_RECORD_BYTES = 8192;
const POSITION_KEYS = new Set([
  'totalPages', 'anchor', 'fingerprint', 'top', 'left', 'editTop', 'previewTop', 'page', 'offset', 'sheet', 'scale',
  'rotation', 'x', 'y', 'currentTime', 'innerTop', 'listTop', 'textTop', 'scrollLeft',
]);
const MIGRATION_SOURCES = new Set(['desktop-json', 'browser-localStorage']);

function cleanPosition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const position = {};
  for (const [key, item] of Object.entries(value)) {
    if (!POSITION_KEYS.has(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item)) position[key] = Math.max(-1e9, Math.min(1e9, item));
    else if (['sheet', 'anchor', 'fingerprint'].includes(key) && typeof item === 'string') position[key] = item.slice(0, key === 'anchor' ? 4096 : 200);
  }
  return position;
}

function cleanRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceType = value.sourceType === 'file' ? 'file' : value.sourceType === 'note' ? 'note' : '';
  const kind = String(value.kind || '').slice(0, 30);
  const position = cleanPosition(value.position);
  if (!sourceType || !kind || !position) return null;
  const result = { sourceType, kind, position };
  if (MIGRATION_SOURCES.has(value.migrationSource)) result.migrationSource = value.migrationSource;
  if (typeof value.savedAt === 'string' && Number.isFinite(Date.parse(value.savedAt))) result.savedAt = value.savedAt;
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RECORD_BYTES) return null;
  return result;
}

function cleanDocumentId(value) {
  const id = String(value || '').trim().slice(0, 300);
  return id && !/[\\/\0]/.test(id) ? id : '';
}

function readRecords(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('阅读位置文件格式无效');
    const source = value?.records && typeof value.records === 'object' ? value.records : {};
    const entries = Object.entries(source);
    if (entries.length > MAX_RECORDS) throw new Error('阅读位置数量超过迁移限制，原文件已保留');
    const records = {};
    for (const [rawId, rawRecord] of entries) {
      const id = cleanDocumentId(rawId);
      const record = cleanRecord(rawRecord);
      if (!id || !record) throw new Error('阅读位置记录校验失败');
      records[id] = { ...record, migrationSource: 'desktop-json' };
    }
    return records;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function readMigrationMarker(sqlite, marker) {
  const row = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(marker);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return { completed: true, value: row.value }; }
}

function insertMigratedRecord(sqlite, id, record) {
  const normalized = cleanRecord({ ...record, savedAt: record.savedAt || new Date().toISOString() });
  if (!id || !normalized) throw new Error('阅读位置迁移校验失败');
  sqlite.prepare('INSERT OR IGNORE INTO reading_positions VALUES (?, ?)').run(id, JSON.stringify(normalized));
  const stored = sqlite.prepare('SELECT body FROM reading_positions WHERE document_id = ?').get(id);
  if (!stored || !cleanRecord(JSON.parse(stored.body))) throw new Error('阅读位置迁移校验失败');
  return stored;
}

function createReadingPositionStore(dataDir) {
  const sqlite = require('../db/connection').openAccountDatabase(dataDir);
  const filePath = path.join(path.resolve(dataDir), FILE_NAME);
  const marker = 'reading_positions_json_migrated';
  if (!readMigrationMarker(sqlite, marker)) {
    const records = readRecords(filePath);
    sqlite.transaction(() => {
      for (const [id, record] of Object.entries(records)) insertMigratedRecord(sqlite, id, record);
      const completion = { completed: true, source: 'desktop-json', count: Object.keys(records).length, completedAt: new Date().toISOString() };
      sqlite.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run(marker, JSON.stringify(completion));
    })();
  }
  return {
    get({ documentId } = {}) {
      const row = sqlite.prepare('SELECT body FROM reading_positions WHERE document_id = ?').get(cleanDocumentId(documentId));
      return row ? cleanRecord(JSON.parse(row.body)) : null;
    },
    set({ documentId, record } = {}) {
      const id = cleanDocumentId(documentId);
      const existing = id ? sqlite.prepare('SELECT body FROM reading_positions WHERE document_id=?').get(id) : null;
      const previous = existing ? cleanRecord(JSON.parse(existing.body)) : null;
      const next = cleanRecord({ ...record, migrationSource: previous?.migrationSource || record?.migrationSource, savedAt: new Date().toISOString() });
      if (!id || !next) throw new Error('阅读位置数据无效');
      sqlite.prepare('INSERT INTO reading_positions VALUES (?,?) ON CONFLICT(document_id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify(next));
      return { saved: true };
    },
    migrateBrowserRecords(records = {}, { complete = true, totalCount = null } = {}) {
      const browserMarker = 'reading_positions_browser_v1_migrated';
      const existingMarker = readMigrationMarker(sqlite, browserMarker);
      if (existingMarker) return { migrated: false, alreadyComplete: true, count: Number(existingMarker.count) || 0 };
      if (!records || typeof records !== 'object' || Array.isArray(records)) throw Object.assign(new Error('浏览器阅读位置数据无效'), { status: 400 });
      if (typeof complete !== 'boolean' || (totalCount !== null && (!Number.isSafeInteger(totalCount) || totalCount < 0 || totalCount > MAX_RECORDS))) throw Object.assign(new Error('浏览器阅读位置迁移批次无效'), { status: 400 });
      const entries = Object.entries(records);
      if (entries.length > MAX_RECORDS) throw Object.assign(new Error('浏览器阅读位置数量超过限制'), { status: 413 });
      const normalized = entries.map(([rawId, rawRecord]) => {
        const id = cleanDocumentId(rawId), record = cleanRecord({ ...rawRecord, migrationSource: 'browser-localStorage' });
        if (!id || !record) throw Object.assign(new Error('浏览器阅读位置迁移校验失败'), { status: 400 });
        return [id, record];
      });
      sqlite.transaction(() => {
        for (const [id, record] of normalized) insertMigratedRecord(sqlite, id, record);
        for (const [id, record] of normalized) {
          const stored = cleanRecord(JSON.parse(sqlite.prepare('SELECT body FROM reading_positions WHERE document_id=?').get(id).body));
          // Existing database state wins over stale browser storage, but every
          // imported value must still be valid before the migration is marked.
          if (!stored || !record.position || !record.kind || !record.sourceType) throw new Error('浏览器阅读位置迁移校验失败');
        }
        if (complete) {
          const completion = { completed: true, source: 'browser-localStorage', count: totalCount ?? normalized.length, completedAt: new Date().toISOString() };
          sqlite.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run(browserMarker, JSON.stringify(completion));
        }
      })();
      return { migrated: true, count: normalized.length, complete };
    },
    clear({ documentId } = {}) {
      const id = cleanDocumentId(documentId);
      if (id) sqlite.prepare('DELETE FROM reading_positions WHERE document_id=?').run(id);
      else sqlite.prepare('DELETE FROM reading_positions').run();
      return { cleared: true };
    },
  };
}
function clearReadingPositionState(dataDir, { preserveDatabase = false } = {}) {
  if (!preserveDatabase) createReadingPositionStore(dataDir).clear();
  // Restore discards the old migration source, but retains restored SQLite records.
  const filePath = path.join(path.resolve(dataDir), FILE_NAME);
  try { fs.unlinkSync(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { cleared: true };
}

module.exports = {
  FILE_NAME,
  MAX_RECORDS,
  cleanPosition,
  cleanDocumentId,
  cleanRecord,
  createReadingPositionStore,
  clearReadingPositionState,
};
