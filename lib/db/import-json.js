const fs = require('fs');
const path = require('path');
const { readJsonIfExists, atomicWriteJson } = require('../util/json-file');
const {
  writeMeta,
  writeIdTable,
  writeSingleton,
  writeStringList,
  writeIndexedList,
} = require('./helpers');

const MIGRATION_MARKER = '.sqlite-migrated.json';
const JSON_BACKUP_SUFFIX = '.pre-sqlite-bak';

function failCorruptImport(name, file, err) {
  let backup = '';
  try {
    if (fs.existsSync(file)) {
      backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    }
  } catch { /* ignore backup failures */ }
  const suffix = backup ? `; preserved at ${backup}` : '';
  throw new Error(`Failed to read ${name}: ${err.message}${suffix}`);
}

function readAccountJsonFile(dataDir, name, fallback) {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return failCorruptImport(name, file, err);
  }
}

const ACCOUNT_JSON_FILES = [
  'logs.json',
  'todos.json',
  'todo-categories.json',
  'countdowns.json',
  'categories.json',
  'private-uploads.json',
  'ai-settings.json',
  'todo-reminder-settings.json',
  'todo-reminder-state.json',
  'knowledge-documents.json',
  'agent-sessions.json',
  'agent-runs.json',
  'agent-memories.json',
];

function backupJsonFile(dataDir, name) {
  const source = path.join(dataDir, name);
  if (!fs.existsSync(source)) return;
  const backup = `${source}${JSON_BACKUP_SUFFIX}`;
  if (!fs.existsSync(backup)) fs.copyFileSync(source, backup);
}

function importJsonAccount(dataDir, sqlite) {
  const tx = sqlite.transaction(() => {
    const logs = readAccountJsonFile(dataDir, 'logs.json', []);
    if (!Array.isArray(logs)) throw new Error('Invalid logs.json');
    writeIdTable(sqlite, 'logs', logs);

    const todos = readAccountJsonFile(dataDir, 'todos.json', []);
    if (!Array.isArray(todos)) throw new Error('Invalid todos.json');
    writeIdTable(sqlite, 'todos', todos);

    const todoCategories = readAccountJsonFile(dataDir, 'todo-categories.json', []);
    if (!Array.isArray(todoCategories)) throw new Error('Invalid todo-categories.json');
    sqlite.prepare('DELETE FROM todo_categories').run();
    const insertCategory = sqlite.prepare('INSERT INTO todo_categories (sort_index, name) VALUES (?, ?)');
    todoCategories.forEach((name, index) => insertCategory.run(index, String(name)));

    const countdowns = readAccountJsonFile(dataDir, 'countdowns.json', []);
    if (!Array.isArray(countdowns)) throw new Error('Invalid countdowns.json');
    writeIdTable(sqlite, 'countdowns', countdowns);

    const categories = readAccountJsonFile(dataDir, 'categories.json', null);
    if (categories !== null && !Array.isArray(categories)) throw new Error('Invalid categories.json');
    if (Array.isArray(categories)) writeSingleton(sqlite, 'categories', categories);

    const privateUploads = readAccountJsonFile(dataDir, 'private-uploads.json', []);
    if (!Array.isArray(privateUploads)) throw new Error('Invalid private-uploads.json');
    writeStringList(sqlite, 'private_uploads', 'filename', privateUploads);

    const aiSettings = readAccountJsonFile(dataDir, 'ai-settings.json', null);
    if (aiSettings !== null && (typeof aiSettings !== 'object' || Array.isArray(aiSettings))) {
      throw new Error('Invalid ai-settings.json');
    }
    if (aiSettings && typeof aiSettings === 'object') writeSingleton(sqlite, 'ai_settings', aiSettings);

    const reminderSettings = readAccountJsonFile(dataDir, 'todo-reminder-settings.json', null);
    if (reminderSettings !== null && (typeof reminderSettings !== 'object' || Array.isArray(reminderSettings))) {
      throw new Error('Invalid todo-reminder-settings.json');
    }
    if (reminderSettings && typeof reminderSettings === 'object') {
      writeSingleton(sqlite, 'todo_reminder_settings', reminderSettings);
    }

    const reminderState = readAccountJsonFile(dataDir, 'todo-reminder-state.json', null);
    if (reminderState !== null && (typeof reminderState !== 'object' || Array.isArray(reminderState))) {
      throw new Error('Invalid todo-reminder-state.json');
    }
    if (reminderState && typeof reminderState === 'object') {
      writeSingleton(sqlite, 'todo_reminder_state', reminderState);
    }

    const knowledge = readAccountJsonFile(dataDir, 'knowledge-documents.json', { documents: [] });
    if (!knowledge || typeof knowledge !== 'object' || Array.isArray(knowledge)) {
      throw new Error('Invalid knowledge-documents.json');
    }
    const documents = Array.isArray(knowledge.documents) ? knowledge.documents : [];
    sqlite.prepare('DELETE FROM knowledge_documents').run();
    const insertDoc = sqlite.prepare('INSERT INTO knowledge_documents (id, body) VALUES (?, ?)');
    for (const doc of documents) insertDoc.run(String(doc.id), JSON.stringify(doc));
    if (Number(knowledge.nextNoteId) > 0) writeMeta(sqlite, 'next_note_id', String(knowledge.nextNoteId));
    if (Number(knowledge.nextFileId) > 0) writeMeta(sqlite, 'next_file_id', String(knowledge.nextFileId));

    const sessionsData = readAccountJsonFile(dataDir, 'agent-sessions.json', { sessions: [], activeSessionId: '' });
    if (!sessionsData || typeof sessionsData !== 'object' || Array.isArray(sessionsData)) {
      throw new Error('Invalid agent-sessions.json');
    }
    const sessions = Array.isArray(sessionsData.sessions) ? sessionsData.sessions : [];
    sqlite.prepare('DELETE FROM agent_messages').run();
    sqlite.prepare('DELETE FROM agent_sessions').run();
    const insertSession = sqlite.prepare(`
      INSERT INTO agent_sessions (id, title, status, checkpoint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertMessage = sqlite.prepare(`
      INSERT INTO agent_messages (session_id, sort_index, body) VALUES (?, ?, ?)
    `);
    for (const session of sessions) {
      insertSession.run(
        session.id,
        session.title || '新任务',
        session.status === 'archived' ? 'archived' : 'active',
        session.checkpoint ? JSON.stringify(session.checkpoint) : null,
        Number(session.createdAt) || 0,
        Number(session.updatedAt) || 0,
      );
      const messages = Array.isArray(session.messages) ? session.messages : [];
      messages.forEach((message, index) => {
        insertMessage.run(session.id, index, JSON.stringify(message));
      });
    }
    if (sessionsData.activeSessionId) {
      writeMeta(sqlite, 'active_session_id', String(sessionsData.activeSessionId));
    }

    const runsData = readAccountJsonFile(dataDir, 'agent-runs.json', { runs: [] });
    if (!runsData || typeof runsData !== 'object' || Array.isArray(runsData)) {
      throw new Error('Invalid agent-runs.json');
    }
    const runs = Array.isArray(runsData.runs) ? runsData.runs : [];
    sqlite.prepare('DELETE FROM agent_runs').run();
    const insertRun = sqlite.prepare(`
      INSERT INTO agent_runs (id, session_id, status, kind, parent_run_id, created_at, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const run of runs) {
      insertRun.run(
        run.id,
        run.sessionId || '',
        run.status || '',
        run.kind || '',
        run.parentRunId || null,
        Number(run.createdAt) || 0,
        JSON.stringify(run),
      );
    }

    const memories = readAccountJsonFile(dataDir, 'agent-memories.json', { items: [], proposals: [] });
    if (!memories || typeof memories !== 'object' || Array.isArray(memories)) {
      throw new Error('Invalid agent-memories.json');
    }
    writeIndexedList(sqlite, 'agent_memories', 'item', Array.isArray(memories.items) ? memories.items : []);
    writeIndexedList(sqlite, 'agent_memories', 'proposal', Array.isArray(memories.proposals) ? memories.proposals : []);
  });
  tx();

  for (const name of ACCOUNT_JSON_FILES) backupJsonFile(dataDir, name);
  atomicWriteJson(path.join(dataDir, MIGRATION_MARKER), {
    version: 1,
    migratedAt: new Date().toISOString(),
    source: 'json',
  });
}

function importJsonAuth(dataDir, sqlite) {
  const usersFile = path.join(dataDir, 'users.json');
  const sessionsFile = path.join(dataDir, 'auth-sessions.json');
  const usersData = fs.existsSync(usersFile) ? readAccountJsonFile(dataDir, 'users.json', null) : null;
  const sessionsData = fs.existsSync(sessionsFile) ? readAccountJsonFile(dataDir, 'auth-sessions.json', null) : null;
  const users = Array.isArray(usersData) ? usersData : usersData?.users;
  const sessions = Array.isArray(sessionsData) ? sessionsData : sessionsData?.sessions;

  const tx = sqlite.transaction(() => {
    if (Array.isArray(users)) {
      sqlite.prepare('DELETE FROM auth_users').run();
      const insert = sqlite.prepare(`
        INSERT INTO auth_users (
          id, username, display_name, password_hash, role, status,
          must_change_password, storage_key, created_at, updated_at, last_login_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const user of users) {
        insert.run(
          user.id,
          user.username,
          user.display_name,
          user.password_hash,
          user.role,
          user.status,
          user.must_change_password ? 1 : 0,
          user.storage_key,
          user.created_at,
          user.updated_at,
          user.last_login_at || '',
        );
      }
    }
    if (Array.isArray(sessions)) {
      sqlite.prepare('DELETE FROM auth_sessions').run();
      const insert = sqlite.prepare(`
        INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const session of sessions) {
        insert.run(session.token_hash, session.user_id, session.created_at, session.expires_at);
      }
    }
  });
  tx();

  if (fs.existsSync(usersFile)) backupJsonFile(dataDir, 'users.json');
  if (fs.existsSync(sessionsFile)) backupJsonFile(dataDir, 'auth-sessions.json');
  atomicWriteJson(path.join(dataDir, MIGRATION_MARKER), {
    version: 1,
    migratedAt: new Date().toISOString(),
    source: 'json-auth',
  });
}

module.exports = {
  MIGRATION_MARKER,
  JSON_BACKUP_SUFFIX,
  importJsonAccount,
  importJsonAuth,
};
