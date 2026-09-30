const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../database');
const { createAgentStore } = require('../lib/agent/store');
const { runtimeFor } = require('../lib/agent/routes');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-agent-restart-'));
  const db = createDatabase(dir);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, store: createAgentStore(db) };
}

function persistedRun(store, session, status, extra = {}) {
  const run = {
    id: `restart-${status}-${Math.random().toString(16).slice(2)}`,
    sessionId: session.id,
    kind: '',
    goal: 'continue',
    status,
    messages: [{ role: 'user', content: 'continue' }],
    events: [],
    checkpoint: { goal: 'continue', verified: [], failed: 0, next: 'start' },
    pendingApprovals: [],
    queuedApprovals: [],
    round: 1,
    toolCalls: 0,
    depth: 0,
    diaryUnlocked: false,
    createdAt: Date.now(),
    ...extra,
  };
  store.saveRun(run);
  return run;
}

test('runtime startup closes orphaned execution and browser waits without replaying them', async t => {
  const { db, store } = fixture(t);
  const session = store.createSession('restart');
  const queued = persistedRun(store, session, 'queued');
  const running = persistedRun(store, session, 'running');
  const browser = persistedRun(store, session, 'waiting_client_tool', {
    pendingClientTool: { id: 'browser-pending', call: { name: 'browser.click', arguments: { x: 1, y: 2 } } },
  });
  let modelCalls = 0;
  const pack = runtimeFor(db, { modelClient: { complete: async () => {
    modelCalls += 1;
    return { text: 'done', toolCalls: [] };
  } }, hasDiaryAccessFlag: false });

  for (const run of [queued, running, browser]) {
    const recovered = pack.store.getRun(run.id);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.events.at(-1).type, 'run.failed');
  }
  assert.equal(pack.store.getRun(browser.id).pendingClientTool, null);
  assert.equal(modelCalls, 0);
  const next = await pack.runtime.start({ session, goal: 'continue', userMessage: 'continue', modelClient: pack.modelClient });
  assert.ok(next.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pack.store.getRun(next.id).status, 'completed');
  assert.equal(modelCalls, 1);
});

test('approval and user-input waits remain actionable after runtime startup', async t => {
  const { db, store } = fixture(t);
  const approvalSession = store.createSession('approval');
  const approval = persistedRun(store, approvalSession, 'waiting_approval', {
    pendingApprovals: [{ id: 'pending-approval', call: { name: 'task.create', arguments: { title: 'must not execute' } } }],
  });
  const questionSession = store.createSession('question');
  const question = persistedRun(store, questionSession, 'waiting_user', { pendingQuestion: 'Continue?' });
  const pack = runtimeFor(db, { modelClient: { complete: async () => ({ text: 'done', toolCalls: [] }) }, hasDiaryAccessFlag: false });

  assert.equal(pack.store.getRun(approval.id).status, 'waiting_approval');
  assert.equal(pack.store.getRun(question.id).status, 'waiting_user');
  const approved = await pack.runtime.resolveApproval(approval.id, 'pending-approval', { approved: false });
  assert.equal(approved.run.status, 'completed');
  assert.equal(db.getAllTodos().length, 0);
  const answered = await pack.runtime.resumeUserInput(question.id, 'Yes');
  assert.equal(answered.run.status, 'completed');
});
