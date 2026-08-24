const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportWorkspace, restoreWorkspace } = require('../lib/workspace/zip');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { createTempDatabase, cleanupTempDataDir } = require('./db-temp');

function tempDb(t) {
  const { db, dir } = createTempDatabase(t, 'workspace-');
  db.create({ title: 'zip log', content: 'body', category: '开发', log_date: '2026-05-16' });
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', 'pic.png'), Buffer.from([1, 2, 3]));
  return { db, dir };
}

test('workspace zip export includes binaries and restores them', async (t) => {
  const { db, dir } = tempDb(t);
  const knowledge = createKnowledgeService(db);
  knowledge.createNote({ title: 'ZIP 知识', content: '知识正文' });
  const buffer = await exportWorkspace(db);
  assert.ok(buffer.length > 20);
  fs.rmSync(path.join(dir, 'uploads'), { recursive: true, force: true });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-b-'));
  process.env.AI_SECRETS_KEY_FILE = path.join(other, 'ai-secrets.key');
  const { createDatabase } = require('../database.js');
  const db2 = createDatabase(other);
  t.after(() => {
    db2.close();
    cleanupTempDataDir(other);
  });
  const result = await restoreWorkspace(db2, buffer);
  assert.equal(result.success, true);
  assert.equal(result.includesBinaries, true);
  assert.ok(fs.existsSync(path.join(other, 'uploads', 'pic.png')));
  const restoredKnowledge = createKnowledgeService(db2);
  assert.equal(restoredKnowledge.allDocuments().length, 1);
  assert.equal(restoredKnowledge.allDocuments()[0].title, 'ZIP 知识');
});
