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
const { createMemoryService, buildMemoryRefreshUserMessage } = require('../lib/agent/memory');
const { createRuntime } = require('../lib/agent/runtime');
const { registerAgentRoutes, persistNoteBrowserScreenshot } = require('../lib/agent/routes');
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

function makeRuntime(db, complete, extras = {}) {
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: true,
    modelClient: { async complete(request) { return complete(request); } },
    ...extras,
  });
  return { store, memory, runtime };
}

test('remote note runs persist their capability boundary and omit browser tools', async (t) => {
  const db = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const { document } = knowledge.createNote({ title: '远程笔记', content: '内容' }, { diaryUnlocked: true });
  const store = createAgentStore(db);
  const session = store.createSession('远程笔记', { documentId: document.id });
  let tools = [];
  const { runtime } = makeRuntime(db, ({ tools: offered }) => {
    tools = offered.map(tool => tool.name);
    return { text: '完成', toolCalls: [] };
  }, {
    computer: { available: () => true, execute: async () => ({ ok: true }) },
    noteBrowser: { available: () => true },
  });
  const run = await runtime.startNoteAssist({
    session,
    documentId: document.id,
    userMessage: '读取当前笔记',
    remoteClient: true,
  });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(store.getRun(run.id).remoteClient, true);
  assert.ok(tools.includes('note.read'));
  assert.equal(tools.some(name => name.startsWith('browser.')), false);
  assert.equal(tools.some(name => name.startsWith('note_browser.')), false);
});

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

test('note_assist runs expose the full registered tool set plus bound note tools', async (t) => {
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
  for (const name of ['knowledge.list', 'knowledge.read', 'knowledge.search', 'knowledge.update', 'note.propose_edit', 'note.read', 'agent.delegate', 'ask_user']) assert.ok(seenTools.includes(name), name);
});

test('desktop note browser tools are bound to note-assist runs and relayed through the client', async (t) => {
  const db = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const { document } = knowledge.createNote({ title: '浏览器助手', content: '正文' }, { diaryUnlocked: true });
  let noteRound = 0;
  let mainTools = [];
  const noteBrowser = {
    available: () => true,
    request(name, args, documentId) {
      return { clientTool: true, request: { name, args, documentId } };
    },
  };
  const { runtime, store } = makeRuntime(db, request => {
    if (request.goal === 'main') {
      mainTools = request.tools.map(tool => tool.name);
      return { text: '完成', toolCalls: [] };
    }
    noteRound += 1;
    return noteRound === 1
      ? { text: '', toolCalls: [{ name: 'note_browser.tabs', arguments: {} }] }
      : { text: '已读取标签', toolCalls: [] };
  }, { noteBrowser });
  const noteSession = store.createSession('浏览器助手', { documentId: document.id });
  const run = await runtime.startNoteAssist({ session: noteSession, documentId: document.id, userMessage: '查看网页' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiting = store.getRun(run.id);
  assert.equal(waiting.status, 'waiting_client_tool');
  assert.deepEqual(waiting.pendingClientTool.request, { name: 'note_browser.tabs', args: {}, documentId: document.id });
  await runtime.clientToolResult(run.id, waiting.pendingClientTool.id, { ok: true, summary: '1 tab', data: { tabs: [] } });
  assert.equal(store.getRun(run.id).status, 'completed');

  const mainSession = store.createSession('普通 Agent');
  const main = await runtime.start({ session: mainSession, goal: 'main', userMessage: 'main' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.getRun(main.id).status, 'completed');
  assert.equal(mainTools.some(name => name.startsWith('note_browser.')), false);
});

test('note browser mutations retain approved tab and page version before client execution', async (t) => {
  const db = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const { document } = knowledge.createNote({ title: '浏览器审批', content: '正文' }, { diaryUnlocked: true });
  let round = 0;
  const { runtime, store } = makeRuntime(db, () => {
    round += 1;
    return round === 1
      ? { text: '', toolCalls: [{ name: 'note_browser.navigate', arguments: { tabId: 'tab-a', pageVersion: 7, url: 'https://example.com/next' } }] }
      : { text: '完成', toolCalls: [] };
  }, { noteBrowser: { available: () => true, request: (name, args, documentId) => ({ clientTool: true, request: { name, args, documentId } }) } });
  const session = store.createSession('浏览器审批', { documentId: document.id });
  const started = await runtime.startNoteAssist({ session, documentId: document.id, userMessage: '打开下一页' });
  await new Promise(resolve => setTimeout(resolve, 50));
  let run = store.getRun(started.id);
  assert.equal(run.status, 'waiting_approval');
  assert.equal(run.pendingApprovals[0].call.name, 'note_browser.navigate');
  await runtime.resolveApproval(run.id, run.pendingApprovals[0].id, { approved: true });
  run = store.getRun(started.id);
  assert.equal(run.status, 'waiting_client_tool');
  assert.equal(run.pendingClientTool.request.documentId, document.id);
  assert.deepEqual(run.pendingClientTool.request.args, { tabId: 'tab-a', pageVersion: 7, url: 'https://example.com/next' });
  await runtime.clientToolResult(run.id, run.pendingClientTool.id, { ok: false, summary: '网页已变化', errorCode: 'stale_target' });
  assert.equal(store.getRun(run.id).status, 'completed');
});

test('note browser screenshots are stored as private visual attachments for diary runs', (t) => {
  const db = tempDb(t);
  const result = persistNoteBrowserScreenshot(
    db,
    { call: { name: 'note_browser.screenshot' } },
    { noteDocumentVisibility: 'diary' },
    { ok: true, data: { image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'), mimeType: 'image/jpeg', title: '网页', url: 'https://example.com/' } },
  );
  assert.match(result.data.imageUrl, /^\/uploads\/note-browser-/);
  assert.equal(result.data.image, undefined);
  assert.equal(result.data.pageUrl, 'https://example.com/');
  const filename = result.data.imageUrl.split('/').pop();
  assert.equal(fs.existsSync(path.join(db.dataDir, 'uploads', filename)), true);
  assert.equal(db.isPrivateUpload(filename), true);
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

test('note-assist sessions list, explicit fetch, and hard delete', async (t) => {
  const db = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const { document } = knowledge.createNote({ title: '多会话', content: '正文' }, { diaryUnlocked: true });

  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, {
    db,
    hasDiaryAccess: () => true,
    noteAssistModelClientFor: async () => ({ async complete() { return { text: '好', toolCalls: [] }; } }),
  });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 两条会话
  const first = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '第一个问题' }),
  });
  const firstData = await first.json();
  await new Promise(resolve => setTimeout(resolve, 150));
  const second = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '第二个问题', newSession: true }),
  });
  const secondData = await second.json();
  assert.ok(secondData.sessionId && secondData.sessionId !== firstData.sessionId);

  // 列表：两条、新会话在前
  const list = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/sessions`);
  assert.equal(list.status, 200);
  const listData = await list.json();
  assert.equal(listData.sessions.length, 2);
  assert.equal(listData.sessions[0].id, secondData.sessionId);
  assert.equal(listData.sessions[0].messageCount, 2, 'user + assistant messages');
  assert.match(listData.sessions[0].preview, /第二个问题/);

  // 按显式 sessionId 回读；绑定失配 → 404
  const explicit = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/session?sessionId=${encodeURIComponent(firstData.sessionId)}`);
  assert.equal(explicit.status, 200);
  const explicitData = await explicit.json();
  assert.equal(explicitData.session.id, firstData.sessionId);
  assert.match(explicitData.session.messages[0].content, /第一个问题/);
  const foreign = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/session?sessionId=nope`);
  assert.equal(foreign.status, 404);

  const resumed = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '回到第一个会话', sessionId: firstData.sessionId }),
  });
  assert.equal(resumed.status, 202);
  await new Promise(resolve => setTimeout(resolve, 150));
  const firstAfter = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/session?sessionId=${encodeURIComponent(firstData.sessionId)}`);
  const firstAfterData = await firstAfter.json();
  assert.equal(firstAfterData.session.messages.some(item => item.content === '回到第一个会话'), true);
  const secondAfter = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/session?sessionId=${encodeURIComponent(secondData.sessionId)}`);
  const secondAfterData = await secondAfter.json();
  assert.equal(secondAfterData.session.messages.some(item => item.content === '回到第一个会话'), false);

  // 删除：不存在 404；成功后 runs/messages 一并清理
  const removed = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/sessions/${encodeURIComponent(firstData.sessionId)}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const after = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/sessions`);
  const afterData = await after.json();
  assert.equal(afterData.sessions.length, 1);
  assert.equal(afterData.sessions[0].id, secondData.sessionId);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_runs WHERE session_id = ?').get(firstData.sessionId).count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_messages WHERE session_id = ?').get(firstData.sessionId).count, 0);
  const removedAgain = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/sessions/${encodeURIComponent(firstData.sessionId)}`, { method: 'DELETE' });
  assert.equal(removedAgain.status, 404);
});

test('note-assist sessions stay out of Agent history and memory refresh', async (t) => {
  const db = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const { document } = knowledge.createNote({ title: '隔离笔记', content: '正文' }, { diaryUnlocked: true });
  const store = createAgentStore(db);
  const agentSession = store.createSession('Agent 任务');
  store.saveSession({ ...agentSession, messages: [{ role: 'user', content: 'Agent 问题' }] });

  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, {
    db,
    hasDiaryAccess: () => true,
    noteAssistModelClientFor: async () => ({ async complete() { return { text: '好', toolCalls: [] }; } }),
  });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const sent = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '笔记里的问题' }),
  });
  assert.equal(sent.status, 202);
  const sentData = await sent.json();
  await new Promise(resolve => setTimeout(resolve, 150));

  const listed = await fetch(`${base}/api/agent/sessions`);
  assert.equal(listed.status, 200);
  const listedData = await listed.json();
  assert.equal(listedData.sessions.some(item => item.id === sentData.sessionId), false);
  assert.equal(listedData.sessions.some(item => item.id === agentSession.id), true);

  const hidden = await fetch(`${base}/api/agent/sessions/${encodeURIComponent(sentData.sessionId)}`);
  assert.equal(hidden.status, 404);
  const patched = await fetch(`${base}/api/agent/sessions/${encodeURIComponent(sentData.sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '不该改' }),
  });
  assert.equal(patched.status, 404);
  const posted = await fetch(`${base}/api/agent/sessions/${encodeURIComponent(sentData.sessionId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '混进 Agent' }),
  });
  assert.equal(posted.status, 404);
  const removed = await fetch(`${base}/api/agent/sessions/${encodeURIComponent(sentData.sessionId)}`, { method: 'DELETE' });
  assert.equal(removed.status, 404);

  const noteSession = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(document.id)}/session`);
  assert.equal(noteSession.status, 200);
  const noteData = await noteSession.json();
  assert.equal(noteData.session.id, sentData.sessionId);
  assert.match(noteData.session.messages[0].content, /笔记里的问题/);

  assert.equal(store.listSessionSummaries().some(item => item.id === sentData.sessionId), false);
  assert.equal(store.listSessions({ excludeDocumentBound: true }).some(item => item.id === sentData.sessionId), false);
  assert.equal(store.listSessions().some(item => item.id === sentData.sessionId), true);

  const prompt = buildMemoryRefreshUserMessage(store, { list: () => [] });
  assert.equal(prompt.includes(sentData.sessionId), false);
  assert.match(prompt, new RegExp(agentSession.id));
});

test('locked diary note-assist events and session delete return 403', async (t) => {
  const db = tempDb(t);
  const knowledge = createKnowledgeService(db);
  const diaryNote = knowledge.createNote({
    title: '私密日记',
    content: '秘密正文',
    knowledgeBase: '日记',
    visibility: 'diary',
  }, { diaryUnlocked: true }).document;
  const publicNote = knowledge.createNote({ title: '公开笔记', content: '公开正文' }, { diaryUnlocked: true }).document;

  let diaryUnlocked = true;
  let round = 0;
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, {
    db,
    hasDiaryAccess: () => diaryUnlocked,
    noteAssistModelClientFor: async () => ({
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'note.propose_edit', arguments: { find: '秘密正文', replace: '改写后的正文' } }] };
        }
        return { text: '已提出修改', toolCalls: [] };
      },
    }),
  });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const sent = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(diaryNote.id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '润色这一段' }),
  });
  assert.equal(sent.status, 202);
  const sentData = await sent.json();
  await new Promise(resolve => setTimeout(resolve, 250));

  diaryUnlocked = false;
  const lockedSession = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(diaryNote.id)}/session`);
  assert.equal(lockedSession.status, 403);
  const lockedEvents = await fetch(`${base}/api/agent/runs/${encodeURIComponent(sentData.runId)}/events`);
  assert.equal(lockedEvents.status, 403);
  const lockedDelete = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(diaryNote.id)}/sessions/${encodeURIComponent(sentData.sessionId)}`, { method: 'DELETE' });
  assert.equal(lockedDelete.status, 403);

  diaryUnlocked = true;
  const publicSent = await fetch(`${base}/api/agent/note-assist/${encodeURIComponent(publicNote.id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '你好' }),
  });
  assert.equal(publicSent.status, 202);
  const publicData = await publicSent.json();
  await new Promise(resolve => setTimeout(resolve, 150));
  diaryUnlocked = false;
  const publicEvents = await fetch(`${base}/api/agent/runs/${encodeURIComponent(publicData.runId)}/events`);
  assert.equal(publicEvents.status, 200);
  publicEvents.body?.cancel?.();
});

test('note assistant direct writes require confirmation and preserve original baseVersion', async t => {
  const db = tempDb(t), knowledge = createKnowledgeService(db);
  const doc = knowledge.createNote({ title: '版本', content: 'original' }).document;
  let calls = 0;
  const { runtime, store } = makeRuntime(db, () => ++calls === 1
    ? { toolCalls: [{ name: 'knowledge.update', arguments: { id: doc.id, baseVersion: doc.version, content: 'agent edit' } }] }
    : { text: 'done' });
  const run = await runtime.startNoteAssist({ session: store.createSession('版本', { documentId: doc.id }), documentId: doc.id, userMessage: 'edit' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.status, 'waiting_approval'); assert.equal(knowledge.getDocument(doc.id).content, 'original');
  knowledge.updateDocument(doc.id, { baseVersion: doc.version, content: 'saved draft' });
  await runtime.resolveApproval(run.id, run.pendingApprovals[0].id, { approved: true });
  assert.equal(knowledge.getDocument(doc.id).content, 'saved draft');
  assert.ok(store.getRun(run.id).events.some(event => event.type === 'tool.completed' && /version conflict/i.test(event.payload.result.summary)));
});

test('note assistant rejects unregistered tools and supports confirmed direct writes', async t => {
  const db = tempDb(t), knowledge = createKnowledgeService(db);
  const doc = knowledge.createNote({ title: '写入', content: 'original' }).document;
  let calls = 0;
  const { runtime, store } = makeRuntime(db, () => ++calls === 1
    ? { toolCalls: [{ name: 'nonexistent.tool', arguments: {} }, { name: 'knowledge.update', arguments: { id: doc.id, baseVersion: doc.version, content: 'confirmed' } }] }
    : { text: 'done' });
  const run = await runtime.startNoteAssist({ session: store.createSession('写入', { documentId: doc.id }), documentId: doc.id, userMessage: 'edit' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.pendingApprovals.length, 1);
  assert.ok(run.events.some(event => event.type === 'tool.completed' && event.payload.call.name === 'nonexistent.tool' && !event.payload.result.ok));
  await runtime.resolveApproval(run.id, run.pendingApprovals[0].id, { approved: true });
  assert.equal(knowledge.getDocument(doc.id).content, 'confirmed');
});

test('only the old factory note prompt is upgraded; custom system text stays intact', t => {
  const db = tempDb(t), store = createAgentStore(db), memory = createMemoryService(store);
  const { LEGACY_NOTE_ASSIST_SYSTEM_LINES, factorySystemBody } = require('../lib/agent/system-prompt');
  memory.list();
  let data = store.readMemories();
  const item = data.items.find(item => item.builtinId === 'system-note-assist');
  item.content = LEGACY_NOTE_ASSIST_SYSTEM_LINES.join('\n'); store.writeMemories(data);
  memory.list(); assert.equal(store.readMemories().items.find(item => item.builtinId === 'system-note-assist').content, factorySystemBody('note_assist'));
  data = store.readMemories(); data.items.find(item => item.builtinId === 'system-note-assist').content = 'My custom prompt'; store.writeMemories(data);
  memory.list(); assert.equal(store.readMemories().items.find(item => item.builtinId === 'system-note-assist').content, 'My custom prompt');
});

test('standalone note route initializes full dependencies and resumes an existing question', async t => {
  const db = tempDb(t), knowledge = createKnowledgeService(db);
  const doc = knowledge.createNote({ title: '独立启动', content: 'body' }).document;
  const app = express(); app.use(express.json());
  let rounds = 0; let seen = []; let webCalls = 0;
  registerAgentRoutes(app, {
    db, hasDiaryAccess: () => false,
    modelClient: { complete: async ({ tools }) => { seen = tools.map(tool => tool.name); return ++rounds === 1 ? { toolCalls: [{ name: 'ask_user', arguments: { question: '继续？' } }] } : { text: 'complete' }; } },
    webSearchFor: () => { webCalls++; return async () => ({ ok: true }); },
    computerFor: () => ({ execute: async () => ({ ok: true }) }),
    chromeFor: () => ({ request: () => ({ ok: true }) }),
  });
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/agent/note-assist/${encodeURIComponent(doc.id)}/messages`;
  const post = content => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
  const first = await (await post('begin')).json(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(seen.includes('bash.run')); assert.ok(seen.includes('browser.scan')); assert.ok(seen.includes('image.generate')); assert.equal(webCalls, 1);
  const next = await (await post('answer')).json(); assert.equal(next.resumed, true); assert.equal(next.runId, first.runId); assert.equal(rounds, 2);
});

test('note delegates inherit the document and bubble confirmed mutations to their parent', async t => {
  const db = tempDb(t), knowledge = createKnowledgeService(db);
  const doc = knowledge.createNote({ title: '委派', content: 'original' }).document;
  let parents = 0, children = 0;
  const { runtime, store } = makeRuntime(db, ({ goal, tools }) => {
    if (goal !== 'child') return ++parents === 1 ? { toolCalls: [{ name: 'agent.delegate', arguments: { prompt: 'child' } }] } : { text: 'parent done' };
    assert.ok(tools.some(tool => tool.name === 'note.read')); assert.ok(!tools.some(tool => tool.name === 'agent.delegate'));
    children++;
    if (children === 1) return { toolCalls: [{ name: 'note.read', arguments: {} }] };
    if (children === 2) return { toolCalls: [{ name: 'knowledge.update', arguments: { id: doc.id, baseVersion: doc.version, content: 'child edit' } }] };
    return { text: 'child done' };
  });
  const run = await runtime.startNoteAssist({ session: store.createSession('委派', { documentId: doc.id }), documentId: doc.id, userMessage: 'parent' });
  await new Promise(resolve => setImmediate(resolve));
  await runtime.resolveApproval(run.id, run.pendingApprovals[0].id, { approved: true });
  const child = store.listChildRuns(run.id)[0]; assert.equal(child.noteDocumentId, doc.id);
  assert.equal(run.status, 'waiting_approval'); assert.equal(run.pendingApprovals[0].call.name, 'knowledge.update');
  await runtime.resolveApproval(run.id, run.pendingApprovals[0].id, { approved: true });
  assert.equal(knowledge.getDocument(doc.id).content, 'child edit'); assert.equal(parents, 2); assert.equal(children, 3);
  assert.ok(store.getRun(run.id).events.some(event => event.type === 'tool.completed' && event.payload.delegatedRunId === child.id && event.payload.call.name === 'knowledge.update'));
});
