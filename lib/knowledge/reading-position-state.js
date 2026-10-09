const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = '.reading-positions.json';
const MAX_RECORDS = 5000;
const MAX_RECORD_BYTES = 8192;
const POSITION_KEYS = new Set([
  'anchor', 'fingerprint', 'top', 'left', 'editTop', 'previewTop', 'page', 'offset', 'sheet', 'scale',
  'rotation', 'x', 'y', 'currentTime', 'innerTop', 'listTop', 'textTop', 'scrollLeft',
]);

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
    const source = value?.records && typeof value.records === 'object' ? value.records : {};
    const records = {};
    for (const [rawId, rawRecord] of Object.entries(source).slice(-MAX_RECORDS)) {
      const id = cleanDocumentId(rawId);
      const record = cleanRecord(rawRecord);
      if (id && record) records[id] = record;
    }
    return records;
  } catch {
    return {};
  }
}

function writeRecords(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ records })}\n`, { mode: 0o600 });
  try { fs.chmodSync(temporary, 0o600); } catch {}
  fs.renameSync(temporary, filePath);
}

function createReadingPositionStore(dataDir) {
  const filePath = path.join(path.resolve(dataDir), FILE_NAME);
  return {
    get({ documentId } = {}) {
      const id = cleanDocumentId(documentId);
      return id ? (readRecords(filePath)[id] || null) : null;
    },
    set({ documentId, record } = {}) {
      const id = cleanDocumentId(documentId);
      const next = cleanRecord(record);
      if (!id || !next) throw new Error('阅读位置数据无效');
      const records = readRecords(filePath);
      if (!Object.hasOwn(records, id) && Object.keys(records).length >= MAX_RECORDS) {
        delete records[Object.keys(records)[0]];
      }
      records[id] = next;
      writeRecords(filePath, records);
      return { saved: true };
    },
    clear({ documentId } = {}) {
      const id = cleanDocumentId(documentId);
      if (!id) return clearReadingPositionState(dataDir);
      const records = readRecords(filePath);
      delete records[id];
      if (Object.keys(records).length) writeRecords(filePath, records);
      else clearReadingPositionState(dataDir);
      return { cleared: true };
    },
  };
}

function clearReadingPositionState(dataDir) {
  const filePath = path.join(path.resolve(dataDir), FILE_NAME);
  try { fs.unlinkSync(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { cleared: true };
}

module.exports = {
  FILE_NAME,
  MAX_RECORDS,
  cleanPosition,
  cleanRecord,
  createReadingPositionStore,
  clearReadingPositionState,
};
