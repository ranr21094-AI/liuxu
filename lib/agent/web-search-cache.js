const { toolResult } = require('./tools');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_ENTRIES = 32;
const MAX_QUERY_LENGTH = 400;

function normalizeQuery(query) {
  return String(query || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function webSearchFingerprint(args = {}) {
  const query = normalizeQuery(args.query).slice(0, MAX_QUERY_LENGTH);
  return `web.search:${query}`;
}

function isFreshEntry(entry, now = Date.now()) {
  if (!entry || entry.pending) return false;
  if (!entry.result) return false;
  const at = Number(entry.at) || 0;
  return at > 0 && (now - at) <= CACHE_TTL_MS;
}

function cloneCachedResult(result) {
  const data = result?.data && typeof result.data === 'object'
    ? { ...result.data, cached: true }
    : { cached: true };
  const summary = String(result?.summary || '');
  return toolResult({
    ok: result?.ok !== false,
    summary: summary.startsWith('Cached:') ? summary : `Cached: ${summary}`,
    data,
    evidence: Array.isArray(result?.evidence) ? result.evidence.slice() : [],
    errorCode: result?.errorCode || '',
    retryable: Boolean(result?.retryable),
  });
}

function getRunCacheEntry(run, fingerprint) {
  if (!run?.webSearchCache) return null;
  const entry = run.webSearchCache[fingerprint];
  if (!entry) return null;
  if (entry.pending) return entry;
  return isFreshEntry(entry) ? entry : null;
}

function getSessionCacheEntry(session, fingerprint) {
  if (!session?.webSearchCache) return null;
  const entry = session.webSearchCache[fingerprint];
  if (!entry || entry.pending) return null;
  return isFreshEntry(entry) ? entry : null;
}

function lookupWebSearchCacheByFingerprint(run, session, fingerprint) {
  const sessionEntry = getSessionCacheEntry(session, fingerprint);
  if (sessionEntry?.result) {
    return { fingerprint, entry: sessionEntry, source: 'session' };
  }
  const runEntry = getRunCacheEntry(run, fingerprint);
  if (runEntry?.pending) {
    return { fingerprint, entry: runEntry, source: 'pending' };
  }
  if (runEntry?.result) {
    return { fingerprint, entry: runEntry, source: 'run' };
  }
  return null;
}

function lookupWebSearchCacheForCall(run, session, args = {}) {
  const fingerprint = webSearchFingerprint(args);
  return lookupWebSearchCacheByFingerprint(run, session, fingerprint);
}

function ensureRunCache(run) {
  if (!run.webSearchCache) run.webSearchCache = {};
  return run.webSearchCache;
}

function reserveWebSearchPending(run, fingerprint) {
  const cache = ensureRunCache(run);
  const existing = cache[fingerprint];
  if (existing?.pending) {
    return toolResult({
      ok: true,
      summary: 'Cached: web search already pending in this run',
      data: { duplicate: true, pending: true, cached: true },
      evidence: [],
    });
  }
  if (existing?.result && isFreshEntry(existing)) {
    return cloneCachedResult(existing.result);
  }
  cache[fingerprint] = { pending: true, at: Date.now() };
  return null;
}

function trimSessionCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_SESSION_ENTRIES) return cache;
  const sorted = keys
    .map(key => ({ key, at: Number(cache[key]?.at) || 0 }))
    .sort((a, b) => a.at - b.at);
  const next = { ...cache };
  while (Object.keys(next).length > MAX_SESSION_ENTRIES) {
    const oldest = sorted.shift();
    if (!oldest) break;
    delete next[oldest.key];
  }
  return next;
}

function recordWebSearchSuccess(run, session, store, fingerprint, result) {
  if (!result?.ok) return;
  const entry = { result, at: Date.now() };
  ensureRunCache(run)[fingerprint] = entry;
  if (!run?.sessionId || !store || typeof store.getSession !== 'function') return;
  const current = session || store.getSession(run.sessionId);
  if (!current) return;
  const webSearchCache = trimSessionCache({
    ...(current.webSearchCache || {}),
    [fingerprint]: entry,
  });
  store.saveSession({ ...current, webSearchCache });
}

function seedRunWebSearchCache(run, session) {
  if (!session?.webSearchCache || typeof session.webSearchCache !== 'object') {
    run.webSearchCache = {};
    return;
  }
  const now = Date.now();
  const seeded = {};
  for (const [key, entry] of Object.entries(session.webSearchCache)) {
    if (isFreshEntry(entry, now)) seeded[key] = { ...entry };
  }
  run.webSearchCache = seeded;
}

function clearWebSearchPending(run, fingerprint) {
  if (!run?.webSearchCache?.[fingerprint]?.pending) return;
  delete run.webSearchCache[fingerprint];
}

module.exports = {
  CACHE_TTL_MS,
  MAX_SESSION_ENTRIES,
  MAX_QUERY_LENGTH,
  webSearchFingerprint,
  lookupWebSearchCacheForCall,
  reserveWebSearchPending,
  recordWebSearchSuccess,
  cloneCachedResult,
  seedRunWebSearchCache,
  clearWebSearchPending,
};
