const crypto = require('crypto');
const { openAccountDatabase } = require('../db/connection');
const {
  parseJson,
  readMeta,
  writeMeta,
  readIndexedList,
  writeIndexedList,
} = require('../db/helpers');

const SESSION_ACTIVE_RUN_STATUSES = new Set([
  'queued', 'running', 'waiting_approval', 'waiting_client_tool', 'waiting_user',
]);

function parseSessionCheckpoint(raw) {
  const parsed = raw ? parseJson(raw, null) : null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { checkpoint: null, webSearchCache: null };
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'webSearchCache')
    || Object.prototype.hasOwnProperty.call(parsed, 'working')) {
    return {
      checkpoint: parsed.working ?? parsed.checkpoint ?? null,
      webSearchCache: parsed.webSearchCache || null,
    };
  }
  return { checkpoint: parsed, webSearchCache: null };
}

function encodeSessionCheckpoint(session) {
  const checkpoint = session.checkpoint || null;
  const webSearchCache = session.webSearchCache || null;
  if (!webSearchCache) return checkpoint ? JSON.stringify(checkpoint) : null;
  return JSON.stringify({ checkpoint, webSearchCache });
}

function createAgentStore(db) {
  const sqlite = db.sqlite || openAccountDatabase(db.dataDir);

  function hydrateSession(row) {
    if (!row) return null;
    const { checkpoint, webSearchCache } = parseSessionCheckpoint(row.checkpoint);
    const messages = sqlite.prepare(`
      SELECT body FROM agent_messages WHERE session_id = ? ORDER BY sort_index ASC
    `).all(row.id).map(item => parseJson(item.body, {}));
    return {
      id: row.id,
      title: row.title || '新任务',
      status: row.status === 'archived' ? 'archived' : 'active',
      checkpoint,
      webSearchCache,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages,
    };
  }

  function listSessions({ includeArchived = false } = {}) {
    const rows = includeArchived
      ? sqlite.prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC').all()
      : sqlite.prepare(`
        SELECT * FROM agent_sessions WHERE status != 'archived' ORDER BY updated_at DESC
      `).all();
    return rows.map(row => hydrateSession(row));
  }

  function getSession(id) {
    const row = sqlite.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(String(id || ''));
    return hydrateSession(row);
  }

  function sessionSummaryFromRow(row, activeRun) {
    const messageCount = sqlite.prepare(
      'SELECT COUNT(*) AS count FROM agent_messages WHERE session_id = ?',
    ).get(row.id)?.count || 0;
    const lastMessage = sqlite.prepare(`
      SELECT body FROM agent_messages WHERE session_id = ? ORDER BY sort_index DESC LIMIT 1
    `).get(row.id);
    const last = lastMessage ? parseJson(lastMessage.body, {}) : null;
    return {
      id: row.id,
      title: row.title || '新任务',
      status: row.status === 'archived' ? 'archived' : 'active',
      messageCount,
      lastMessagePreview: typeof last?.content === 'string'
        ? last.content.replace(/\s+/g, ' ').trim().slice(0, 120)
        : '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activeRun: activeRun ? { id: activeRun.id, status: activeRun.status } : null,
    };
  }

  function listSessionSummaries(options = {}) {
    const includeArchived = options.includeArchived || options.archived === '1';
    const rows = includeArchived
      ? sqlite.prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC').all()
      : sqlite.prepare(`
        SELECT * FROM agent_sessions WHERE status != 'archived' ORDER BY updated_at DESC
      `).all();
    const activeRows = sqlite.prepare(`
      SELECT id, session_id, status FROM agent_runs
      WHERE kind != 'memory_refresh'
        AND status IN ('queued', 'running', 'waiting_approval', 'waiting_client_tool', 'waiting_user')
      ORDER BY created_at ASC
    `).all();
    const activeBySession = new Map();
    for (const run of activeRows) {
      activeBySession.set(run.session_id, run);
    }
    return rows.map(row => sessionSummaryFromRow(row, activeBySession.get(row.id) || null));
  }

  function writeSessionMessages(sessionId, messages) {
    sqlite.prepare('DELETE FROM agent_messages WHERE session_id = ?').run(sessionId);
    const insert = sqlite.prepare(`
      INSERT INTO agent_messages (session_id, sort_index, body) VALUES (?, ?, ?)
    `);
    const list = Array.isArray(messages) ? messages : [];
    list.forEach((message, index) => insert.run(sessionId, index, JSON.stringify(message)));
  }

  function createSession(title = '新任务') {
    const session = {
      id: crypto.randomUUID(),
      title: String(title || '新任务').slice(0, 80),
      messages: [],
      checkpoint: null,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    sqlite.prepare(`
      INSERT INTO agent_sessions (id, title, status, checkpoint, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(session.id, session.title, 'active', session.createdAt, session.updatedAt);
    writeMeta(sqlite, 'active_session_id', session.id);
    return session;
  }

  function saveSession(session) {
    const next = { ...session, updatedAt: Date.now() };
    const checkpointPayload = encodeSessionCheckpoint(next);
    const exists = sqlite.prepare('SELECT id FROM agent_sessions WHERE id = ?').get(next.id);
    if (!exists) {
      sqlite.prepare(`
        INSERT INTO agent_sessions (id, title, status, checkpoint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        next.id,
        next.title || '新任务',
        next.status === 'archived' ? 'archived' : 'active',
        checkpointPayload,
        Number(next.createdAt) || next.updatedAt,
        next.updatedAt,
      );
    } else {
      sqlite.prepare(`
        UPDATE agent_sessions
        SET title = ?, status = ?, checkpoint = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.title || '新任务',
        next.status === 'archived' ? 'archived' : 'active',
        checkpointPayload,
        next.updatedAt,
        next.id,
      );
    }
    writeSessionMessages(next.id, next.messages || []);
    writeMeta(sqlite, 'active_session_id', next.id);
    return next;
  }

  function updateSession(id, patch = {}) {
    const current = getSession(id);
    if (!current) return null;
    const next = {
      ...current,
      title: typeof patch.title === 'string'
        ? (patch.title.trim().slice(0, 80) || current.title || '新任务')
        : current.title,
      status: patch.status === 'archived' || patch.status === 'active'
        ? patch.status
        : (current.status || 'active'),
      updatedAt: Date.now(),
    };
    sqlite.prepare(`
      UPDATE agent_sessions SET title = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(next.title, next.status === 'archived' ? 'archived' : 'active', next.updatedAt, id);
    if (next.status === 'active') writeMeta(sqlite, 'active_session_id', next.id);
    else if (readMeta(sqlite, 'active_session_id') === id) writeMeta(sqlite, 'active_session_id', '');
    return { ...next, messages: current.messages };
  }

  function deleteSession(id) {
    const current = getSession(id);
    if (!current) return null;
    if (current.status !== 'archived') return { error: 'Only archived sessions can be deleted' };
    sqlite.prepare('DELETE FROM agent_runs WHERE session_id = ?').run(id);
    sqlite.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id);
    if (readMeta(sqlite, 'active_session_id') === id) writeMeta(sqlite, 'active_session_id', '');
    return { id, deleted: true };
  }

  function hydrateRun(row) {
    if (!row) return null;
    const parsed = parseJson(row.body, {});
    return {
      ...parsed,
      id: row.id,
      sessionId: row.session_id,
      status: row.status,
      kind: row.kind,
      parentRunId: row.parent_run_id || parsed.parentRunId || '',
      createdAt: row.created_at || parsed.createdAt || 0,
    };
  }

  function saveRun(run) {
    const body = JSON.stringify(run);
    sqlite.prepare(`
      INSERT INTO agent_runs (id, session_id, status, kind, parent_run_id, created_at, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        status = excluded.status,
        kind = excluded.kind,
        parent_run_id = excluded.parent_run_id,
        created_at = excluded.created_at,
        body = excluded.body
    `).run(
      run.id,
      run.sessionId || '',
      run.status || '',
      run.kind || '',
      run.parentRunId || null,
      Number(run.createdAt) || Date.now(),
      body,
    );
    const overflow = sqlite.prepare(`
      SELECT id FROM agent_runs ORDER BY created_at DESC LIMIT -1 OFFSET 200
    `).all();
    if (overflow.length) {
      const del = sqlite.prepare('DELETE FROM agent_runs WHERE id = ?');
      overflow.forEach(row => del.run(row.id));
    }
    return run;
  }

  function getRun(id) {
    const row = sqlite.prepare('SELECT * FROM agent_runs WHERE id = ?').get(String(id || ''));
    return hydrateRun(row);
  }

  function listRunsForSession(sessionId) {
    const id = String(sessionId || '');
    if (!id) return [];
    return sqlite.prepare(`
      SELECT * FROM agent_runs
      WHERE session_id = ? AND kind != 'memory_refresh'
      ORDER BY created_at ASC
    `).all(id).map(hydrateRun);
  }

  function getLatestRunForSession(sessionId) {
    return listRunsForSession(sessionId).at(-1) || null;
  }

  function findActiveRunForSession(sessionId) {
    const runs = listRunsForSession(sessionId);
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];
      if (SESSION_ACTIVE_RUN_STATUSES.has(run.status)) return run;
    }
    return null;
  }

  function listChildRuns(parentRunId) {
    const id = String(parentRunId || '');
    if (!id) return [];
    return sqlite.prepare(`
      SELECT * FROM agent_runs
      WHERE parent_run_id = ? AND kind = 'delegate'
      ORDER BY created_at ASC
    `).all(id).map(hydrateRun);
  }

  function readMemoriesFixed() {
    return {
      items: sqlite.prepare(`
        SELECT body FROM agent_memories WHERE kind = 'item' ORDER BY sort_index ASC
      `).all().map(row => parseJson(row.body, {})),
      proposals: sqlite.prepare(`
        SELECT body FROM agent_memories WHERE kind = 'proposal' ORDER BY sort_index ASC
      `).all().map(row => parseJson(row.body, {})),
    };
  }

  function writeMemories(value) {
    writeIndexedList(sqlite, 'agent_memories', 'item', Array.isArray(value.items) ? value.items : []);
    writeIndexedList(sqlite, 'agent_memories', 'proposal', Array.isArray(value.proposals) ? value.proposals : []);
    return value;
  }

  return {
    listSessions,
    listSessionSummaries,
    getSession,
    createSession,
    saveSession,
    updateSession,
    deleteSession,
    saveRun,
    getRun,
    getLatestRunForSession,
    listRunsForSession,
    listChildRuns,
    readMemories: readMemoriesFixed,
    writeMemories,
  };
}

module.exports = { createAgentStore };
