import { apiFetch } from '../auth.js';
const STORAGE_KEY = 'liuxu.readingPositions.v1';
const MAX_RECORDS = 2000;
const MIGRATION_KEY = `${STORAGE_KEY}.database-migrated.v1`;
let browserMigration = null;

function desktopStore() {
  return window.liuxuDesktop?.readingPositions || null;
}

function documentId(document) {
  return String(document?.id || '').trim();
}

function sourceType(document) {
  return document?.sourceType === 'file' ? 'file' : 'note';
}

function cleanPosition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = new Set(['totalPages', 'anchor', 'fingerprint', 'top', 'left', 'editTop', 'previewTop', 'page', 'offset', 'sheet', 'scale', 'rotation', 'x', 'y', 'currentTime', 'innerTop', 'listTop', 'textTop', 'scrollLeft']);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item)) output[key] = Math.max(-1e9, Math.min(1e9, item));
    else if (['sheet', 'anchor', 'fingerprint'].includes(key) && typeof item === 'string') output[key] = item.slice(0, key === 'anchor' ? 4096 : 200);
  }
  return output;
}

function readBrowserRecords() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function forgetBrowserRecord(id) {
  try {
    const records = readBrowserRecords();
    delete records[id];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch { /* The database remains authoritative when local storage is unavailable. */ }
}

async function migrateBrowserRecords() {
  if (desktopStore()) return true;
  try { if (localStorage.getItem(MIGRATION_KEY) === '1') return true; } catch { return false; }
  if (browserMigration) return browserMigration;
  browserMigration = (async () => {
    try {
      const records = readBrowserRecords();
      const entries = Object.entries(records);
      if (entries.length > MAX_RECORDS) return false;
      const chunks = [];
      for (let index = 0; index < entries.length; index += 64) chunks.push(entries.slice(index, index + 64));
      if (!chunks.length) chunks.push([]);
      for (let index = 0; index < chunks.length; index += 1) {
        const response = await apiFetch('/api/knowledge/reading-positions/migrate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: Object.fromEntries(chunks[index]), complete: index === chunks.length - 1, totalCount: entries.length }),
          keepalive: index === chunks.length - 1,
        });
        if (!response.ok) return false;
        await response.json();
      }
      try { localStorage.setItem(MIGRATION_KEY, '1'); } catch { /* Server marker makes retry safe. */ }
      return true;
    } catch { return false; }
    finally { browserMigration = null; }
  })();
  return browserMigration;
}

export async function loadReadingPosition(document, kind) {
  const id = documentId(document);
  if (!id) return null;
  try {
    if (desktopStore()) { const record = await desktopStore().get({ documentId: id }); return record?.sourceType === sourceType(document) && record?.kind === String(kind || '') ? cleanPosition(record.position) : null; }
    await migrateBrowserRecords();
    const url = `/api/knowledge/documents/${encodeURIComponent(id)}/reading-position`;
    const response = await apiFetch(url);
    if (!response.ok) return null;
    const { record } = await response.json();
    if (!record || record.sourceType !== sourceType(document) || record.kind !== String(kind || '')) return null;
    return cleanPosition(record.position);
  } catch { return null; }
}

export async function saveReadingPosition(document, kind, position) {
  const id = documentId(document);
  const clean = cleanPosition(position);
  if (!id || !kind || !clean) return false;
  const record = { sourceType: sourceType(document), kind: String(kind).slice(0, 30), position: clean };
  try {
    if (desktopStore()) { await desktopStore().set({ documentId: id, record }); return true; }
    await migrateBrowserRecords();
    const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(id)}/reading-position`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record }), keepalive: true });
    if (!response.ok) return false;
    return true;
  } catch { return false; }
}

export async function clearReadingPosition(documentIdValue) {
  const id = String(documentIdValue || '').trim();
  if (!id) return false;
  try {
    const desktop = desktopStore();
    if (desktop) await desktop.clear({ documentId: id });
    else {
      const response = await apiFetch(`/api/knowledge/documents/${encodeURIComponent(id)}/reading-position`, { method: 'DELETE' });
      if (!response.ok) return false;
      forgetBrowserRecord(id);
    }
    return true;
  } catch { return false; }
}

export async function clearAllReadingPositions() {
  try {
    const desktop = desktopStore();
    if (desktop) await desktop.clear();
    else {
      const response = await apiFetch('/api/knowledge/reading-positions', { method: 'DELETE' });
      if (!response.ok) return false;
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* The database clear has already succeeded. */ }
    }
    return true;
  } catch { return false; }
}
