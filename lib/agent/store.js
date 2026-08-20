const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, readJsonIfExists } = require('../util/json-file');

function emptySessions() {
  return { sessions: [], activeSessionId: '' };
}

function emptyRuns() {
  return { runs: [] };
}

function emptyMemories() {
  return { items: [], proposals: [] };
}

function createAgentStore(db) {
  function sessionsFile() { return path.join(db.dataDir, 'agent-sessions.json'); }
  function runsFile() { return path.join(db.dataDir, 'agent-runs.json'); }
  function memoriesFile() { return path.join(db.dataDir, 'agent-memories.json'); }

  function readSessions() {
    const saved = readJsonIfExists(sessionsFile(), emptySessions());
    return saved && Array.isArray(saved.sessions) ? saved : emptySessions();
  }
  function writeSessions(value) { atomicWriteJson(sessionsFile(), value); }
  function readRuns() {
    const saved = readJsonIfExists(runsFile(), emptyRuns());
    return saved && Array.isArray(saved.runs) ? saved : emptyRuns();
  }
  function writeRuns(value) { atomicWriteJson(runsFile(), value); }
  function readMemories() {
    const saved = readJsonIfExists(memoriesFile(), emptyMemories());
    return {
      items: Array.isArray(saved.items) ? saved.items : [],
      proposals: Array.isArray(saved.proposals) ? saved.proposals : [],
    };
  }
  function writeMemories(value) { atomicWriteJson(memoriesFile(), value); }

  function listSessions({ includeArchived = false } = {}) {
    return readSessions().sessions
      .filter(item => includeArchived || item.status !== 'archived')
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function getSession(id) {
    return readSessions().sessions.find(item => item.id === id) || null;
  }

  function sessionSummary(session) {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const lastMessage = messages.at(-1);
    return {
      id: session.id,
      title: session.title || '新任务',
      status: session.status === 'archived' ? 'archived' : 'active',
      messageCount: messages.length,
      lastMessagePreview: typeof lastMessage?.content === 'string'
        ? lastMessage.content.replace(/\s+/g, ' ').trim().slice(0, 120)
        : '',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  function listSessionSummaries(options) {
    return listSessions(options).map(sessionSummary);
  }

  function createSession(title = '新任务') {
    const data = readSessions();
    const session = {
      id: crypto.randomUUID(),
      title: String(title || '新任务').slice(0, 80),
      messages: [],
      checkpoint: null,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    data.sessions.unshift(session);
    data.activeSessionId = session.id;
    writeSessions(data);
    return session;
  }

  function saveSession(session) {
    const data = readSessions();
    const index = data.sessions.findIndex(item => item.id === session.id);
    const next = { ...session, updatedAt: Date.now() };
    if (index < 0) data.sessions.unshift(next);
    else data.sessions[index] = next;
    data.activeSessionId = next.id;
    writeSessions(data);
    return next;
  }

  function updateSession(id, patch = {}) {
    const data = readSessions();
    const index = data.sessions.findIndex(item => item.id === id);
    if (index < 0) return null;
    const current = data.sessions[index];
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
    data.sessions[index] = next;
    if (next.status === 'active') data.activeSessionId = next.id;
    else if (data.activeSessionId === next.id) data.activeSessionId = '';
    writeSessions(data);
    return next;
  }

  function deleteSession(id) {
    const data = readSessions();
    const index = data.sessions.findIndex(item => item.id === id);
    if (index < 0) return null;
    const current = data.sessions[index];
    if (current.status !== 'archived') {
      return { error: 'Only archived sessions can be deleted' };
    }
    data.sessions.splice(index, 1);
    if (data.activeSessionId === id) data.activeSessionId = '';
    writeSessions(data);
    const runs = readRuns();
    runs.runs = runs.runs.filter(item => item.sessionId !== id);
    writeRuns(runs);
    return { id, deleted: true };
  }

  function saveRun(run) {
    const data = readRuns();
    const index = data.runs.findIndex(item => item.id === run.id);
    if (index < 0) data.runs.unshift(run);
    else data.runs[index] = run;
    data.runs = data.runs.slice(0, 200);
    writeRuns(data);
    return run;
  }

  function getRun(id) {
    return readRuns().runs.find(item => item.id === id) || null;
  }

  function getLatestRunForSession(sessionId) {
    return listRunsForSession(sessionId).at(-1) || null;
  }

  function listRunsForSession(sessionId) {
    const id = String(sessionId || '');
    if (!id) return [];
    return readRuns().runs
      .filter(item => item.sessionId === id && item.kind !== 'memory_refresh')
      .slice()
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
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
    readMemories,
    writeMemories,
  };
}

module.exports = { createAgentStore };
