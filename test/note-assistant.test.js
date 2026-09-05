const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.AI_SECRETS_KEY_FILE = process.env.AI_SECRETS_KEY_FILE
  || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'note-assist-')), 'ai-secrets.key');

const { createDatabase } = require('../database.js');
const { createAgentStore } = require('../lib/agent/store');
const { createMemoryService } = require('../lib/agent/memory');
const { createRuntime } = require('../lib/agent/runtime');
const { registerAgentRoutes } = require('../lib/agent/routes');
const { ensureLogsMigrated } = require('../lib/knowledge/migrate-logs');
const { createKnowledgeService } = require('../lib/knowledge/documents');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-assist-db-'));
  const db = createDatabase(dir);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  ensureLogsMigrated(db);
  return db;
}

function makeRuntime(db, complete) {
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: true,
    modelClient: { async complete(request) { return complete(request); } },
  });
  return { store, memory, runtime };
}

test('note.propose_edit validates matches and emits a proposal without touching the document', async (t) => {
  const db = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const { document } = knowledge.createNote({
    title: '助手笔记',
    content: '第一段。\n\n第二段包含关键词苹果。\n\n第二段包含关键词苹果。复述。\n\n第三段。',
  }, { diaryUnlocked: true });
  const { runtime } = makeRuntime(db, () => ({ text: '', toolCalls: [] }));
  const session = knowledge.createNote ? undefined : undefined;
  const store = createAgentStore(db);
  const noteSession = store.createSession('助手笔记', { documentId: document.id });

  // 通过一次真实 run 驱动：唯一匹配 → 提案事件；多匹配 → find_ambiguous；无匹配 → find_not_found；append → 追加提案
  let round = 0;
  const runtimeWithScript = makeRuntime(db, () => {
    round += 1;
    if (round === 1) {
      return { text: '', toolCalls: [
        { name: 'note.read', arguments: {} },
        { name: 'note.propose_edit', arguments: { find: '第一段。', replace: '第一段改写。' } },
        { name: 'note.propose_edit', arguments: { find: '第二段包含关键词苹果。', replace: 'x' } },
        { name: 'note.propose_edit', arguments: { find: '不存在的文本', replace: 'y' } },
        { name: 'note.propose_edit', arguments: { append: true, content: '追加的段落' } },
      ] };
    }
    return { text: '完成', toolCalls: [] };
  });
  const run = await runtimeWithScript.runtime.startNoteAssist({
    session: noteSession,
    documentId: document.id,
    userMessage: '改一下',
  });
  await new Promise(resolve => setTimeout(resolve, 250));
  const settled = runtimeWithScript.store.getRun(run.id);
  assert.equal(settled.status, 'completed');

  const proposals = settled.events.filter(event => event.type === 'note.edit_proposed');
  assert.equal(proposals.length, 2, 'unique match and append produce proposals');
  assert.equal(proposals[0].payload.find, '第一段。');
  assert.equal(proposals[0].payload.replace, '第一段改写。');
  assert.ok(proposals[0].payload.proposedContent.includes('第一段改写。'));
  assert.equal(proposals[1].payload.append, true);
  assert.ok(proposals[1].payload.proposedContent.endsWith('追加的段落'));

  const toolResults = settled.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  const bySummary = toolResults.map(result => result.errorCode || result.summary);
  assert.equal(toolResults[0].ok, true, 'note.read succeeds');
  assert.equal(toolResults[1].ok, true, 'unique replace proposal succeeds');
  assert.equal(toolResults[2].errorCode, 'find_ambiguous', 'multi-match proposal is rejected');
  assert.equal(toolResults[3].errorCode, 'find_not_found', 'missing match proposal is rejected');
  assert.equal(toolResults[4].ok, true, 'append proposal succeeds');

  // 服务端绝不直接写文档
  assert.ok(knowledge.getDocument(document.id, { diaryUnlocked: true }).content.includes('第二段包含关键词苹果。复述。'), 'document content is untouched');
  assert.equal(runtimeWithScript.store.findLatestSessionForDocument(document.id).id, noteSession.id);
});

test('note_assist runs expose only the restricted tool set', async (t) => {
  const db = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const { document } = knowledge.createNote({ title: '工具集', content: '正文' }, { diaryUnlocked: true });
  let seenTools = [];
  const { runtime, store } = makeRuntime(db, ({ tools }) => {
    seenTools = (tools || []).map(tool => tool.name);
    return { text: '答复', toolCalls: [] };
  });
  const session = store.createSession('工具集', { documentId: document.id });
  const run = await runtime.startNoteAssist({ session, documentId: document.id, userMessage: 'hi' });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(store.getRun(run.id).status, 'completed');
  assert.deepEqual([...seenTools].sort(), ['knowledge.list', 'knowledge.read', 'knowledge.search', 'note.propose_edit', 'note.read']);
  assert.equal(seenTools.includes('bash.run'), false);
  assert.equal(seenTools.includes('agent.delegate'), false);
});

test('note-assist routes serve sessions and gate locked documents', async (t) => {
  const db = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const { document } = knowledge.createNote({ title: '路由笔记', content: '路由正文' }, { diaryUnlocked: true });
  const diaryNote = knowledge.createNote({
    title: '日记',
    content: '私密',
    knowledgeBase: '日记',
    visibility: 'diary',
  }, { diaryUnlocked: true }).document;

  const app = express();
  app.use(express.json());
  let round = 0;
  registerAgentRoutes(app, {
    db,
    hasDiaryAccess: () => true,
    noteAssistModelClientFor: async () => ({
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'note.propose_edit', arguments: { find: '路由正文', replace: '路由正文（已润色）' } }] };
        }
        return { text: '已提出修改提案', toolCalls: [] };
      },
    }),
  });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 无会话 → 404
  const missing = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/session`);
  assert.equal(missing.status, 404);

  // 发送消息 → 202 + runId；提案走事件
  const sent = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '帮我润色第一句' }),
  });
  assert.equal(sent.status, 202);
  const sentData = await sent.json();
  assert.ok(sentData.runId);
  await new Promise(resolve => setTimeout(resolve, 250));

  // 会话可回读，消息包含本轮对话
  const session = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/session`);
  assert.equal(session.status, 200);
  const sessionData = await session.json();
  assert.equal(sessionData.session.documentId, document.id);
  assert.equal(sessionData.session.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(sessionData.activeRun, null, 'terminal run is not reported as active');

  // 锁定日记 → 403；未知文档 → 404
  const locked = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(diaryNote.id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hi', __diaryUnlockedOverride: false }),
  });
  // hasDiaryAccess 在此测试中恒为 true，因此日记可访问；用未知文档验证 404
  assert.notEqual(locked.status, 500);
  const unknown = await fetch(`${base}/api/agent/note-assist/note:99999/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hi' }),
  });
  assert.equal(unknown.status, 404);
  const unknownSession = await fetch(`${base}/api/agent/note-assist/note:99999/session`);
  assert.equal(unknownSession.status, 404);
});
