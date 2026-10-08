const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAgentStore } = require('../lib/agent/store');
const { createMemoryService, buildMemoryRefreshUserMessage } = require('../lib/agent/memory');
const { registerAgentRoutes, runtimeFor } = require('../lib/agent/routes');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-regression-'));
  const { createDatabase } = require('../database');
  const db = createDatabase(dir);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, store, memory };
}

const args = { layer: 'L2', title: '语言偏好', content: '使用简洁中文', evidence: [{ type: 'conversation', id: 's1' }] };

test('memory rejects blank drafts and legacy blank approvals without changing storage', t => {
  const { store, memory } = setup(t);
  const before = store.readMemories();
  for (const fields of [{ title: '' }, { title: ' \n\t' }, { content: '' }, { content: ' \n\t' }]) {
    assert.equal(memory.propose({ ...args, ...fields }).status, 400);
  }
  assert.deepEqual(store.readMemories(), before);
  store.writeMemories({ ...before, proposals: [{ id: 'legacy', status: 'pending', title: ' ', content: '', evidence: args.evidence }] });
  const legacy = store.readMemories();
  assert.equal(memory.approve('legacy').status, 400);
  assert.deepEqual(store.readMemories(), legacy);
});

test('only the first of competing replacements can be approved', t => {
  const { store, memory } = setup(t);
  const old = memory.approve(memory.propose(args).proposal.id).memory;
  const first = memory.propose({ ...args, content: '中文简短回答', existingId: old.id }).proposal;
  const second = memory.propose({ ...args, content: '中文详细回答', existingId: old.id }).proposal;
  assert.ok(first.baseFingerprint);
  const saved = memory.approve(first.id).memory;
  const before = store.readMemories();
  assert.equal(memory.approve(second.id).status, 409);
  assert.deepEqual(store.readMemories(), before);
  assert.deepEqual(memory.list({ layer: 'L2' }).map(item => item.id), [saved.id]);
});

test('replacement rejects missing, archived, edited and legacy unchecked targets', t => {
  const { store, memory } = setup(t);
  assert.equal(memory.propose({ ...args, existingId: 'missing' }).status, 409);
  const old = memory.approve(memory.propose(args).proposal.id).memory;
  const edited = memory.propose({ ...args, existingId: old.id }).proposal;
  const data = store.readMemories();
  data.items.find(item => item.id === old.id).content = '已更新的偏好';
  store.writeMemories(data);
  assert.equal(memory.approve(edited.id).status, 409);
  const legacy = memory.propose({ ...args, existingId: old.id }).proposal;
  const unchecked = store.readMemories();
  delete unchecked.proposals.find(item => item.id === legacy.id).baseFingerprint;
  store.writeMemories(unchecked);
  assert.equal(memory.approve(legacy.id).status, 409);
  const archived = memory.propose({ ...args, existingId: old.id }).proposal;
  memory.archive(old.id);
  assert.equal(memory.approve(archived.id).status, 409);
  assert.equal(memory.propose({ ...args, existingId: old.id }).status, 409);
  const missing = store.readMemories();
  missing.items = [];
  store.writeMemories(missing);
  assert.equal(memory.approve(archived.id).status, 409);
});

test('successful replacement supersedes the target and approves the draft together', t => {
  const { store, memory } = setup(t);
  const old = memory.approve(memory.propose(args).proposal.id).memory;
  const draft = memory.propose({ ...args, content: '简短回答，必要时展开', existingId: old.id }).proposal;
  const saved = memory.approve(draft.id).memory;
  const data = store.readMemories();
  assert.equal(data.items.find(item => item.id === old.id).status, 'superseded');
  assert.equal(data.proposals.find(item => item.id === draft.id).memoryId, saved.id);
  assert.equal(memory.approve(draft.id).error, 'Proposal not found');
});

test('proposal persistence failure rolls back the memory replacement too', t => {
  const { db, store, memory } = setup(t);
  const old = memory.approve(memory.propose(args).proposal.id).memory;
  const draft = memory.propose({ ...args, content: '更新偏好', existingId: old.id }).proposal;
  const before = store.readMemories();
  db.sqlite.exec(`CREATE TEMP TRIGGER fail_memory_proposal BEFORE INSERT ON agent_memories
    WHEN NEW.kind = 'proposal' BEGIN SELECT RAISE(ABORT, 'injected proposal failure'); END;`);
  assert.throws(() => memory.approve(draft.id), /injected proposal failure/);
  assert.deepEqual(store.readMemories(), before);
  db.sqlite.exec('DROP TRIGGER fail_memory_proposal');
  assert.ok(memory.approve(draft.id).memory);
});

test('refresh keeps newest corrections under message, session and total limits', () => {
  const store = { listSessions: () => [{ id: 's1', title: '会话', messages: [
    { role: 'user', content: 'OLD-PREFERENCE ' + 'x'.repeat(1000) },
    { role: 'assistant', content: 'y'.repeat(1000) },
    { role: 'user', content: 'z'.repeat(1000) + ' LATEST-CORRECTION' },
  ] }, { id: 's2', messages: [{ role: 'user', content: 'SECOND-SESSION' }] }] };
  const memory = { list: () => [] };
  for (const settings of [
    { memoryRefreshMessageChars: 40, memoryRefreshSessionBlockChars: 80 },
    { memoryRefreshSessionBlockChars: 80 },
    { memoryRefreshTotalChars: 80 },
  ]) {
    const prompt = buildMemoryRefreshUserMessage(store, memory, settings);
    assert.match(prompt, /LATEST-CORRECTION/);
    assert.doesNotMatch(prompt, /OLD-PREFERENCE/);
    const blocks = prompt.split('Recent conversations:\n')[1];
    if (settings.memoryRefreshTotalChars) assert.ok(blocks.length <= 80);
  }
  const prompt = buildMemoryRefreshUserMessage({ listSessions: () => [{ id: 's1', messages: [
    { role: 'user', content: 'FIRST' }, { role: 'assistant', content: 'SECOND' }, { role: 'user', content: 'THIRD' },
  ] }] }, memory);
  assert.ok(prompt.indexOf('FIRST') < prompt.indexOf('SECOND'));
  assert.ok(prompt.indexOf('SECOND') < prompt.indexOf('THIRD'));
  const bounded = buildMemoryRefreshUserMessage({ listSessions: () => [
    { id: 'one', messages: [{ role: 'user', content: 'a' }] },
    { id: 'two', messages: [{ role: 'user', content: 'b'.repeat(100) }] },
  ] }, memory, { memoryRefreshTotalChars: 80 });
  assert.ok(bounded.split('Recent conversations:\n')[1].length <= 80);
});

test('memory approval HTTP route returns 409 for stale replacement', async t => {
  const { db } = setup(t);
  const app = express();
  registerAgentRoutes(app, { db, hasDiaryAccess: () => false });
  const { memory } = runtimeFor(db);
  const old = memory.approve(memory.propose(args).proposal.id).memory;
  const draft = memory.propose({ ...args, existingId: old.id }).proposal;
  memory.archive(old.id);
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/memory-proposals/${draft.id}/approve`, { method: 'POST' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /changed/);
});
