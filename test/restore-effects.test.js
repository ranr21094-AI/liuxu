const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerBackupRoutes } = require('../lib/http/backup-routes');
const { registerWorkspaceRoutes } = require('../lib/workspace/routes');
const { FILE_NAME, createReadingPositionStore } = require('../lib/knowledge/reading-position-state');

function captureRestoreRoute(register, db) {
  const routes = new Map();
  const app = {
    get() {},
    post(route, handler) { routes.set(route, handler); },
  };
  register(app, {
    db,
    hasDiaryAccess: () => true,
    rejectLockedDiary: () => { throw new Error('unexpected diary rejection'); },
    restoreRequiresDiaryAccess: () => false,
  });
  return routes;
}

function invokeRestore(handler, { mode = 'replace', contentType = 'application/json' } = {}) {
  let status = 200;
  let body;
  const response = {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  handler({ query: { mode }, body: {}, headers: { 'content-type': contentType } }, response);
  return { status, body };
}

test('legacy and workspace JSON restore share the same desktop cleanup', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-restore-effects-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = {
    dataDir,
    restore: () => ({ success: true }),
    getAllUnpaginated: () => [],
  };
  const position = createReadingPositionStore(dataDir);
  const backupRoute = captureRestoreRoute(registerBackupRoutes, db).get('/api/restore');
  const workspaceRoute = captureRestoreRoute(registerWorkspaceRoutes, db).get('/api/workspace/restore');
  const savePosition = () => position.set({ documentId: 'note:1', record: { sourceType: 'note', kind: 'note', position: { editTop: 200 } } });

  savePosition();
  assert.equal(invokeRestore(backupRoute).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, FILE_NAME)), false);

  savePosition();
  assert.equal(invokeRestore(workspaceRoute).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, FILE_NAME)), false);

  savePosition();
  assert.equal(invokeRestore(backupRoute, { mode: 'merge' }).status, 200);
  assert.notEqual(position.get({ documentId: 'note:1' }), null);
});
