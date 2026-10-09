const STORAGE_KEY = 'liuxu.readingPositions.v1';
const MAX_RECORDS = 2000;

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
  const allowed = new Set(['anchor', 'fingerprint', 'top', 'left', 'editTop', 'previewTop', 'page', 'offset', 'sheet', 'scale', 'rotation', 'x', 'y', 'currentTime', 'innerTop', 'listTop', 'textTop', 'scrollLeft']);
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

export async function loadReadingPosition(document, kind) {
  const id = documentId(document);
  if (!id) return null;
  try {
    const record = desktopStore()
      ? await desktopStore().get({ documentId: id })
      : readBrowserRecords()[id];
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
    const desktop = desktopStore();
    if (desktop) await desktop.set({ documentId: id, record });
    else {
      const records = readBrowserRecords();
      delete records[id];
      records[id] = record;
      const ids = Object.keys(records);
      while (ids.length > MAX_RECORDS) delete records[ids.shift()];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    }
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
      const records = readBrowserRecords();
      delete records[id];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    }
    return true;
  } catch { return false; }
}

export async function clearAllReadingPositions() {
  try {
    const desktop = desktopStore();
    if (desktop) await desktop.clear();
    else localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch { return false; }
}
