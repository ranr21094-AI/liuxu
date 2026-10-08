const STORAGE_KEY = 'knowledgeRecentItems';
const MAX_ITEMS = 20;
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

function validItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = ['document', 'folder', 'knowledgeBase'].includes(item.type) ? item.type : '';
  const id = typeof item.id === 'string' ? item.id.slice(0, 200) : '';
  const title = typeof item.title === 'string' ? item.title.slice(0, 200) : '';
  const timestamp = Number(item.timestamp);
  if (!type || !id || !title || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (Date.now() - timestamp > MAX_AGE_MS) return null;
  return {
    type, id, title,
    path: typeof item.path === 'string' ? item.path.slice(0, 300) : '',
    knowledgeBase: typeof item.knowledgeBase === 'string' ? item.knowledgeBase.slice(0, 80) : '',
    folderPath: typeof item.folderPath === 'string' ? item.folderPath.slice(0, 200) : '',
    subtitle: typeof item.subtitle === 'string' ? item.subtitle.slice(0, 200) : '',
    timestamp,
  };
}

function readItems(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    const items = parsed.map(validItem).filter(item => {
      if (!item || seen.has(`${item.type}:${item.id}`)) return false;
      seen.add(`${item.type}:${item.id}`);
      return true;
    }).sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_ITEMS);
    if (items.length !== parsed.length) storage?.setItem(STORAGE_KEY, JSON.stringify(items));
    return items;
  } catch {
    try { storage?.removeItem(STORAGE_KEY); } catch {}
    return [];
  }
}

export function getRecentItems(storage) { return readItems(storage); }

export function rememberRecentItem(item, storage) {
  const normalized = validItem({ ...item, timestamp: Date.now() });
  if (!normalized) return readItems(storage);
  const key = `${normalized.type}:${normalized.id}`;
  const next = [normalized, ...readItems(storage).filter(entry => `${entry.type}:${entry.id}` !== key)].slice(0, MAX_ITEMS);
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  return next;
}

export function removeRecentItem(item, storage) {
  const key = `${item?.type || ''}:${item?.id || ''}`;
  const next = readItems(storage).filter(entry => `${entry.type}:${entry.id}` !== key);
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  return next;
}

export { MAX_ITEMS, STORAGE_KEY };
