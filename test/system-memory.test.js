const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.AI_SECRETS_KEY_FILE = process.env.AI_SECRETS_KEY_FILE
  || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'system-mem-')), 'ai-secrets.key');

const { createDatabase } = require('../database.js');
const { createAgentStore } = require('../lib/agent/store');
const {
  createMemoryService,
  SYSTEM_AGENT_BUILTIN_ID,
  SYSTEM_NOTE_ASSIST_BUILTIN_ID,
  SYSTEM_MEMORY_REFRESH_BUILTIN_ID,
  SYSTEM_CONTENT_MAX,
  buildMemoryRefreshUserMessage,
} = require('../lib/agent/memory');
const { factorySystemBody, buildAgentSystemText } = require('../lib/agent/system-prompt');
const { registerAgentRoutes } = require('../lib/agent/routes');
const { createToolAdapters } = require('../lib/agent/adapters');
const { resolveMemorySettings } = require('../lib/agent/memory-settings');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-mem-db-'));
  const db = createDatabase(dir);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

async function listen(app, t) {
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('system memories seed once and keep user edits', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const first = memory.list({ layer: 'system' });
  assert.equal(first.length, 3);
  assert.deepEqual(first.map(item => item.builtinId).sort(), [
    SYSTEM_AGENT_BUILTIN_ID,
    SYSTEM_MEMORY_REFRESH_BUILTIN_ID,
    SYSTEM_NOTE_ASSIST_BUILTIN_ID,
  ].sort());
  const agent = first.find(item => item.builtinId === SYSTEM_AGENT_BUILTIN_ID);
  assert.equal(agent.content, factorySystemBody('agent'));
  const updated = memory.updateSystemContent(agent.id, 'Stay terse and cite notes.');
  assert.equal(updated.memory.content, 'Stay terse and cite notes.');
  const again = createMemoryService(store);
  const reread = again.list({ layer: 'system' }).find(item => item.builtinId === SYSTEM_AGENT_BUILTIN_ID);
  assert.equal(reread.content, 'Stay terse and cite notes.');
  assert.equal(again.list({ layer: 'system' }).length, 3);
});

test('system prompt updates reject empty content and cannot be archived', (t) => {
  const db = tempDb(t);
  const memory = createMemoryService(createAgentStore(db));
  const agent = memory.list({ layer: 'system' }).find(item => item.builtinId === SYSTEM_AGENT_BUILTIN_ID);
  assert.equal(memory.updateSystemContent(agent.id, '   ').status, 400);
  assert.equal(memory.updateSystemContent('not-system', 'hello').status, 404);
  assert.equal(memory.archive(agent.id).error, 'System prompts cannot be deleted');
  assert.equal(memory.propose({
    runId: 'r1',
    title: 'rewrite',
    content: 'hijack',
    evidence: [{ type: 'run', id: 'r1' }],
    existingId: agent.id,
  }).error, 'System prompts cannot be changed by the agent');
  const restored = memory.restoreSystemContent(agent.id);
  assert.equal(restored.memory.content, factorySystemBody('agent'));
});

test('agent and note-assist system text prefer Memory body', (t) => {
  const db = tempDb(t);
  const memory = createMemoryService(createAgentStore(db));
  const note = memory.list({ layer: 'system' }).find(item => item.builtinId === SYSTEM_NOTE_ASSIST_BUILTIN_ID);
  memory.updateSystemContent(note.id, 'Help with the open note only.');
  const body = memory.getSystemPrompt('note_assist');
  const text = buildAgentSystemText({
    systemPreset: 'note_assist',
    body,
    toolList: 'note.read: Read',
  });
  assert.match(text, /^Help with the open note only\./);
  assert.equal(text.includes('You are the AI assistant embedded'), false);
  assert.match(text, /Available tools:\nnote.read: Read/);
});

test('memory refresh instructions come from system memory and skip system items', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const refresh = memory.list({ layer: 'system' }).find(item => item.builtinId === SYSTEM_MEMORY_REFRESH_BUILTIN_ID);
  memory.updateSystemContent(refresh.id, 'Only extract L2 facts.\nPropose at most {maxProposals} drafts.');
  const settings = resolveMemorySettings({ memoryRefreshMaxProposals: 7 });
  const prompt = buildMemoryRefreshUserMessage(store, memory, settings);
  assert.match(prompt, /^Only extract L2 facts\./);
  assert.match(prompt, /Propose at most 7 drafts/);
  assert.equal(prompt.includes('Agent 系统提示词'), false);
  assert.equal(prompt.includes(SYSTEM_AGENT_BUILTIN_ID), false);
});

test('system memory HTTP update, restore, and isolation from Agent tools', async (t) => {
  const db = tempDb(t);
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, { db, hasDiaryAccess: () => true });
  const base = await listen(app, t);
  const listed = await fetch(`${base}/api/agent/memories`);
  const listedData = await listed.json();
  const agent = listedData.items.find(item => item.builtinId === SYSTEM_AGENT_BUILTIN_ID);
  assert.ok(agent);

  const empty = await fetch(`${base}/api/agent/memories/${encodeURIComponent(agent.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '  ' }),
  });
  assert.equal(empty.status, 400);

  const userItem = listedData.items.find(item => item.builtinId === 'image-generate');
  const notSystem = await fetch(`${base}/api/agent/memories/${encodeURIComponent(userItem.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'nope' }),
  });
  assert.equal(notSystem.status, 404);

  const saved = await fetch(`${base}/api/agent/memories/${encodeURIComponent(agent.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Be a careful local agent.' }),
  });
  assert.equal(saved.status, 200);
  const savedData = await saved.json();
  assert.equal(savedData.memory.content, 'Be a careful local agent.');

  const blocked = await fetch(`${base}/api/agent/memories/${encodeURIComponent(agent.id)}`, { method: 'DELETE' });
  assert.equal(blocked.status, 400);

  const restored = await fetch(`${base}/api/agent/memories/${encodeURIComponent(agent.id)}/restore`, { method: 'POST' });
  assert.equal(restored.status, 200);
  const restoredData = await restored.json();
  assert.equal(restoredData.memory.content, factorySystemBody('agent'));

  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const adapters = createToolAdapters({ db, hasDiaryAccessFlag: false, memory });
  const listedTools = await adapters.execute('memory.list', {});
  assert.equal(listedTools.data.items.some(item => item.id === agent.id), false);
  const readSystem = await adapters.execute('memory.read', { id: agent.id });
  assert.equal(readSystem.ok, false);
});

test('workbench requires two confirmations before saving a system prompt', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/workbench.js'), 'utf8');
  assert.match(source, /async function confirmSystemPromptChange/);
  assert.match(source, /async function saveSystemMemoryItem/);
  assert.match(source, /confirmText: '继续'/);
  assert.match(source, /confirmText: '应用'/);
  assert.match(source, /method: 'PUT'/);
  assert.match(source, /\/restore/);
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /data-memory-layer="system"/);
});

test('system prompt max length is independent from L2/L3 caps', () => {
  assert.equal(SYSTEM_CONTENT_MAX, 8000);
  assert.ok(factorySystemBody('agent').length < SYSTEM_CONTENT_MAX);
  assert.ok(factorySystemBody('note_assist').length < SYSTEM_CONTENT_MAX);
});
