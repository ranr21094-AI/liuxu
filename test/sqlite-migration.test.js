const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { createAgentStore } = require('../lib/agent/store');
const { accountDbPath, closeAllDatabases } = require('../lib/db/connection');
const { cleanupTempDataDir } = require('./db-temp');

function seedJsonAccount(dir) {
  fs.writeFileSync(path.join(dir, 'logs.json'), JSON.stringify([
    {
      id: 1,
      title: 'legacy log',
      content: 'hello sqlite',
      category: '开发',
      hours: 1,
      log_date: '2026-05-16',
      pinned: false,
      pinned_at: null,
      created_at: '2026-05-16T08:00:00.000Z',
      updated_at: '2026-05-16T08:00:00.000Z',
    },
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'todos.json'), JSON.stringify([
    { id: 1, title: 'todo one', completed: false, sort_order: 1 },
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'knowledge-documents.json'), JSON.stringify({
    documents: [{
      id: 'note:1',
      sourceType: 'note',
      sourceRef: 'note:1',
      title: 'note title',
      content: 'note body',
      collectionPath: '开发',
      knowledgeBase: '开发',
      folderPath: '',
      tags: [],
      visibility: 'standard',
      status: 'active',
      fileMeta: null,
      createdAt: '2026-05-16T08:00:00.000Z',
      updatedAt: '2026-05-16T08:00:00.000Z',
      version: 1,
      documentDate: '2026-05-16',
      documentRole: 'normal',
    }],
    nextNoteId: 2,
    nextFileId: 1,
  }, null, 2));
  const sessionId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(dir, 'agent-sessions.json'), JSON.stringify({
    activeSessionId: sessionId,
    sessions: [{
      id: sessionId,
      title: 'import session',
      status: 'active',
      checkpoint: null,
      createdAt: 1,
      updatedAt: 2,
      messages: Array.from({ length: 3 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}`,
      })),
    }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'agent-runs.json'), JSON.stringify({ runs: [] }, null, 2));
  fs.writeFileSync(path.join(dir, 'agent-memories.json'), JSON.stringify({ items: [], proposals: [] }, null, 2));
}

test('JSON fixtures import into schedule.db with matching API data', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-import-'));
  process.env.AI_SECRETS_KEY_FILE = path.join(dir, 'ai-secrets.key');
  seedJsonAccount(dir);
  t.after(() => {
    delete process.env.AI_SECRETS_KEY_FILE;
    cleanupTempDataDir(dir);
  });

  const { createDatabase } = require('../database.js');
  const db = createDatabase(dir);
  t.after(() => db.close());

  assert.equal(fs.existsSync(accountDbPath(dir)), true);
  assert.equal(fs.existsSync(path.join(dir, '.sqlite-migrated.json')), true);
  assert.equal(db.getAllUnpaginated().length, 1);
  assert.equal(db.getAllTodos().length, 1);
  assert.equal(createKnowledgeService(db).nativeDocuments().length, 1);

  const store = createAgentStore(db);
  const session = store.getSession('11111111-1111-4111-8111-111111111111');
  assert.equal(session.messages.length, 3);
  assert.deepEqual(session.messages.map(item => item.content), ['message-0', 'message-1', 'message-2']);
});

test('backup and restore round-trip preserves SQLite-backed account data', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-backup-'));
  process.env.AI_SECRETS_KEY_FILE = path.join(dir, 'ai-secrets.key');
  t.after(() => {
    delete process.env.AI_SECRETS_KEY_FILE;
    cleanupTempDataDir(dir);
  });

  const { createDatabase } = require('../database.js');
  const db = createDatabase(dir);
  db.create({ title: 'round trip', content: 'body', category: '开发', hours: 1, log_date: '2026-05-16' });
  db.createTodo({ title: 'after backup' });
  const backup = db.backup();

  const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-restore-'));
  t.after(() => {
    closeAllDatabases();
    fs.rmSync(restoreDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const restored = createDatabase(restoreDir);
  t.after(() => restored.close());

  assert.equal(restored.restore(backup).success, true);
  assert.equal(restored.getAllUnpaginated().length, 1);
  assert.equal(restored.getAllTodos().length, 1);
  assert.equal(restored.getAllUnpaginated()[0].title, 'round trip');
});

test('schema v3 migration is repeatable and keeps row-level updates stable', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-v2-'));
  process.env.AI_SECRETS_KEY_FILE = path.join(dir, 'ai-secrets.key');
  t.after(() => {
    delete process.env.AI_SECRETS_KEY_FILE;
    cleanupTempDataDir(dir);
  });
  const { createDatabase } = require('../database.js');
  const db = createDatabase(dir);
  const knowledge = createKnowledgeService(db);
  const first = db.create({ title: 'first', content: 'one' });
  const second = db.create({ title: 'second', content: 'two' });
  const secondRow = db.sqlite.prepare('SELECT rowid FROM logs WHERE id = ?').get(second.id).rowid;
  const note = knowledge.createNote({ title: 'note', content: 'body' }).document;
  const noteRow = db.sqlite.prepare('SELECT rowid FROM knowledge_documents WHERE id = ?').get(note.id).rowid;
  const agent = createAgentStore(db);
  const session = agent.createSession('incremental');
  agent.saveSession({ ...session, messages: [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
  ] });
  const messageRow = db.sqlite.prepare(
    'SELECT id FROM agent_messages WHERE session_id = ? AND sort_index = 0',
  ).get(session.id).id;
  agent.saveSession({ ...session, messages: [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two updated' },
    { role: 'user', content: 'three' },
  ] });
  db.update(first.id, { title: 'first updated' });
  knowledge.updateDocument(note.id, { content: 'body updated' });
  assert.equal(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '3');
  assert.ok(db.sqlite.prepare('SELECT 1 FROM knowledge_link_targets LIMIT 1').get());
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_revisions').get().count, 1);
  assert.ok(db.sqlite.prepare('SELECT 1 FROM knowledge_index_state WHERE id = 1').get());
  assert.equal(db.sqlite.pragma('busy_timeout', { simple: true }), 5000);
  assert.equal(String(db.sqlite.pragma('synchronous', { simple: true })).toLowerCase(), '1');
  assert.equal(db.sqlite.prepare('SELECT rowid FROM logs WHERE id = ?').get(second.id).rowid, secondRow);
  assert.equal(db.sqlite.prepare('SELECT rowid FROM knowledge_documents WHERE id = ?').get(note.id).rowid, noteRow);
  assert.equal(db.sqlite.prepare(
    'SELECT id FROM agent_messages WHERE session_id = ? AND sort_index = 0',
  ).get(session.id).id, messageRow);
  db.close();
  const reopened = createDatabase(dir);
  t.after(() => reopened.close());
  assert.equal(reopened.sqlite.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '3');
  assert.ok(reopened.sqlite.prepare('SELECT version FROM knowledge_index_state WHERE id = 1').get().version >= 2);
});
