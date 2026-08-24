const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentStore } = require('../lib/agent/store');
const { createMemoryService, normalizeMemoryProposalArgs, buildMemoryRefreshUserMessage, MEMORY_CONTENT_MAX } = require('../lib/agent/memory');
const { DEFAULT_MEMORY_SETTINGS, resolveMemorySettings } = require('../lib/agent/memory-settings');
const { createRuntime, parseActionEnvelope, clampMaxRounds } = require('../lib/agent/runtime');
const { toProviderTools, fromProviderName, definitions } = require('../lib/agent/tools');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { savePolicy } = require('../lib/computer/policy');
const { parseMentions, expandMentions } = require('../lib/agent/mentions');
const { registerAgentRoutes, runtimeFor } = require('../lib/agent/routes');
const { traceLinesFromEvents, summarizeRun } = require('../lib/agent/trace');
const express = require('express');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  process.env.AI_SECRETS_KEY_FILE = path.join(dir, 'ai-secrets.key');
  const { createDatabase } = require('../database.js');
  const db = createDatabase(dir);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function openKnowledge(db) {
  const { ensureLogsMigrated } = require('../lib/knowledge/migrate-logs');
  const { createKnowledgeService } = require('../lib/knowledge/documents');
  ensureLogsMigrated(db);
  return createKnowledgeService(db);
}

test('action envelope parses tool calls', () => {
  const parsed = parseActionEnvelope('note {"action":"tool","tools":[{"name":"task.list","arguments":{}}]}');
  assert.equal(parsed.action, 'tool');
  assert.equal(parsed.tools[0].name, 'task.list');
});

test('provider tools use native function calling shape', () => {
  const tools = toProviderTools(definitions());
  const read = tools.find(item => item.function.name === 'knowledge_read');
  assert.ok(read);
  assert.equal(read.type, 'function');
  assert.equal(read.function.parameters.type, 'object');
  assert.equal(read.function.parameters.additionalProperties, true);
  assert.equal(tools.some(item => item.function.name === 'knowledge_search'), true);
  assert.equal(tools.some(item => item.function.name === 'knowledge_tree'), true);
  assert.equal(tools.some(item => item.function.name === 'knowledge_list'), true);
  assert.equal(tools.some(item => item.function.name === 'memory_search'), true);
  assert.equal(tools.some(item => item.function.name === 'agent_delegate'), true);
  assert.equal(tools.some(item => item.function.name === 'web_fetch'), true);
  const webSearch = tools.find(item => item.function.name === 'web_search');
  assert.ok(webSearch);
  assert.deepEqual(webSearch.function.parameters.required, ['query']);
  for (const tool of tools) {
    assert.match(tool.function.name, /^[a-zA-Z0-9_-]+$/);
  }
  assert.equal(fromProviderName('knowledge_read'), 'knowledge.read');
  assert.equal(fromProviderName('knowledge.read'), 'knowledge.read');
  assert.equal(fromProviderName('update_working_checkpoint'), 'update_working_checkpoint');
  const propose = tools.find(item => item.function.name === 'memory_propose');
  assert.equal(propose.function.parameters.properties.content.type, 'string');
  assert.equal(tools.some(item => item.function.name === 'knowledge_import'), true);
  assert.equal(tools.some(item => item.function.name === 'file_delete'), true);
  const withoutComputer = toProviderTools(require('../lib/agent/tools').definitions(require('../lib/agent/tools').computerToolAvailability(false)));
  assert.equal(withoutComputer.some(item => item.function.name === 'knowledge_import'), true);
  assert.equal(withoutComputer.some(item => item.function.name === 'file_list'), false);
  assert.equal(withoutComputer.some(item => item.function.name === 'code_run'), false);
});

test('agent status reports unconfigured when no model key is present', async (t) => {
  const db = tempDb(t);
  const app = express();
  registerAgentRoutes(app, {
    db,
    hasDiaryAccess: () => false,
    agentStatusFor: async () => ({ configured: false, provider: '', model: '' }),
  });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false, provider: '', model: '' });
});

test('agent runtime completes without tools and can pause for approval', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'task.create', arguments: { title: '写周报' } }] };
        }
        return { text: '已创建任务', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('test');
  const run = await runtime.start({ session, goal: '创建任务', userMessage: '创建任务' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const live = store.getRun(run.id);
  assert.equal(live.status, 'waiting_approval');
  const approvalId = live.pendingApprovals[0].id;
  await runtime.resolveApproval(run.id, approvalId, { approved: true });
  const done = store.getRun(run.id);
  assert.equal(done.status, 'completed');
  assert.equal(db.getAllTodos()[0].title, '写周报');
  assert.equal(memory.listProposals().length, 0);
  assert.equal(memory.list({ layer: 'L3' }).filter(item => !item.builtinId).length, 0);
});

test('agent approval queue exposes one pending item at a time', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [
              { name: 'task.create', arguments: { title: '任务一' } },
              { name: 'task.create', arguments: { title: '任务二' } },
              { name: 'task.create', arguments: { title: '任务三' } },
            ],
          };
        }
        return { text: '全部创建完成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('approval-queue');
  const run = await runtime.start({ session, goal: '批量创建任务', userMessage: '批量创建任务' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiting = store.getRun(run.id);
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(waiting.pendingApprovals.length, 1);
  assert.equal(waiting.queuedApprovals.length, 2);
  assert.equal(waiting.pendingApprovals[0].call.arguments.title, '任务一');
  const approvalEvent = waiting.events.filter(item => item.type === 'approval.required').at(-1);
  assert.equal(approvalEvent.payload.queueTotal, 3);
  assert.equal(approvalEvent.payload.queueIndex, 1);

  await runtime.resolveApproval(run.id, waiting.pendingApprovals[0].id, { approved: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = store.getRun(run.id);
  assert.equal(second.status, 'waiting_approval');
  assert.equal(second.pendingApprovals.length, 1);
  assert.equal(second.queuedApprovals.length, 1);
  assert.equal(second.pendingApprovals[0].call.arguments.title, '任务二');
  assert.equal(db.getAllTodos().length, 1);
  const secondEvent = second.events.filter(item => item.type === 'approval.required').at(-1);
  assert.equal(secondEvent.payload.queueTotal, 3);
  assert.equal(secondEvent.payload.queueIndex, 2);

  await runtime.resolveApproval(run.id, second.pendingApprovals[0].id, { approved: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  const third = store.getRun(run.id);
  assert.equal(third.status, 'waiting_approval');
  assert.equal(third.pendingApprovals.length, 1);
  assert.equal(third.queuedApprovals.length, 0);
  assert.equal(third.pendingApprovals[0].call.arguments.title, '任务三');

  await runtime.resolveApproval(run.id, third.pendingApprovals[0].id, { approved: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  const done = store.getRun(run.id);
  assert.equal(done.status, 'completed');
  assert.equal(db.getAllTodos().length, 3);
  assert.deepEqual(db.getAllTodos().map(item => item.title).sort(), ['任务一', '任务三', '任务二'].sort());
});

test('agent attach replays only the current approval.required event', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [
              { name: 'task.create', arguments: { title: '任务一' } },
              { name: 'task.create', arguments: { title: '任务二' } },
            ],
          };
        }
        return { text: '完成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('attach-approval');
  const run = await runtime.start({ session, goal: '批量创建', userMessage: '批量创建' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiting = store.getRun(run.id);
  assert.equal(waiting.events.filter(item => item.type === 'approval.required').length, 1);

  await runtime.resolveApproval(run.id, waiting.pendingApprovals[0].id, { approved: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = store.getRun(run.id);
  assert.equal(second.events.filter(item => item.type === 'approval.required').length, 2);

  const replayed = [];
  const detach = runtime.attach(run.id, event => replayed.push(event));
  detach();
  assert.equal(replayed.filter(item => item.type === 'approval.required').length, 1);
  assert.equal(replayed.at(-1).payload.approvals[0].call.arguments.title, '任务二');
  assert.equal(replayed.at(-1).payload.queueIndex, 2);
});

test('agent task.create adapter stores recurrence', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [{
              name: 'task.create',
              arguments: {
                title: '每周复盘',
                due_date: '2026-08-25',
                recurrence: 'weekly',
              },
            }],
          };
        }
        return { text: '已创建', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('task-recurrence');
  const run = await runtime.start({ session, goal: '创建重复任务', userMessage: '创建重复任务' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiting = store.getRun(run.id);
  await runtime.resolveApproval(run.id, waiting.pendingApprovals[0].id, { approved: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  const todo = db.getAllTodos()[0];
  assert.equal(todo.title, '每周复盘');
  assert.equal(todo.recurrence, 'weekly');
});

test('agent approved tools increment run.toolCalls', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [{ name: 'task.create', arguments: { title: '需确认' } }],
          };
        }
        return { text: '完成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('approval-tool-count');
  const run = await runtime.start({ session, goal: '计数测试', userMessage: '计数测试' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiting = store.getRun(run.id);
  assert.equal(waiting.toolCalls || 0, 0);
  await runtime.resolveApproval(run.id, waiting.pendingApprovals[0].id, { approved: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  const live = store.getRun(run.id);
  assert.equal(live.toolCalls, 1);
});

test('run snapshots diary permission at start', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let diaryOpen = true;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: () => diaryOpen,
    modelClient: {
      async complete() {
        diaryOpen = false; // another tab locks the diary mid-run
        return { text: '回答完成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('diary-snapshot');
  const run = await runtime.start({ session, goal: '读私密内容', userMessage: '开始' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const live = store.getRun(run.id);
  assert.equal(live.diaryUnlocked, true, 'run keeps the permission it started with');
  assert.equal(live.status, 'completed');
});

test('duplicate client tool submissions return the first outcome', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    chrome: {
      request(name) {
        return {
          clientTool: true,
          request: { name, args: {}, nonce: 'n1', signature: 's1' },
        };
      },
    },
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'browser.scan', arguments: {} }] };
        }
        return { text: '浏览器扫描完成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('client-tool-dedup');
  const run = await runtime.start({ session, goal: '扫描浏览器', userMessage: '扫描' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiting = store.getRun(run.id);
  assert.equal(waiting.status, 'waiting_client_tool');
  const requestId = waiting.pendingClientTool.id;

  const first = await runtime.clientToolResult(run.id, requestId, { ok: true, tabs: [] });
  assert.ok(!first.error);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.getRun(run.id).status, 'completed');

  const second = await runtime.clientToolResult(run.id, requestId, { ok: true, tabs: [] });
  assert.ok(!second.error, 'duplicate submission is a no-op, not an error');
  assert.equal(store.getRun(run.id).status, 'completed');
});

test('agent web.search rejects empty query before approval', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  let searched = false;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    webSearch: async () => {
      searched = true;
      return { ok: true, summary: 'Found 1 web source', data: {}, evidence: [] };
    },
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'web.search', arguments: {} }] };
        }
        return { text: '已补全搜索词', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('search-empty');
  const run = await runtime.start({ session, goal: '搜索资料', userMessage: '网页搜索' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const live = store.getRun(run.id);
  assert.notEqual(live.status, 'waiting_approval');
  assert.equal(searched, false);
  const toolMsg = live.messages.find(item => item.role === 'tool' && item.name === 'web.search');
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /Search query is required/);
});

test('agent web.search rejects oversized query before approval', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  let searched = false;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    webSearch: async () => {
      searched = true;
      return { ok: true, summary: 'Found 1 web source', data: {}, evidence: [] };
    },
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'web.search', arguments: { query: 'x'.repeat(401) } }] };
        }
        return { text: '已缩短搜索词', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('search-long');
  const run = await runtime.start({ session, goal: '搜索资料', userMessage: '网页搜索' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const live = store.getRun(run.id);
  assert.notEqual(live.status, 'waiting_approval');
  assert.equal(searched, false);
  const toolMsg = live.messages.find(item => item.role === 'tool' && item.name === 'web.search');
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /at most 400 characters/);
});

test('web.search fingerprint caps query length', () => {
  const { webSearchFingerprint } = require('../lib/agent/web-search-cache');
  const long = webSearchFingerprint({ query: 'q'.repeat(2000) });
  assert.ok(long.length <= 'web.search:'.length + 400);
});

test('agent web.search uses the injected Tavily adapter after confirmation', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  let searched = '';
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    webSearch: async (args) => {
      searched = String(args.query || '');
      return {
        ok: true,
        summary: 'Found 1 web source',
        data: { sources: [{ provider: 'tavily', title: 'Trusted result', url: 'https://example.com/trusted', content: 'Fresh public snippet' }] },
        evidence: [{ type: 'web', url: 'https://example.com/trusted', title: 'Trusted result' }],
      };
    },
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'web.search', arguments: { query: 'latest release notes' } }] };
        }
        return { text: '已检索公开来源', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('search');
  const run = await runtime.start({ session, goal: '搜索资料', userMessage: '搜索 latest release notes' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const live = store.getRun(run.id);
  assert.equal(live.status, 'waiting_approval');
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  const done = store.getRun(run.id);
  assert.equal(done.status, 'completed');
  assert.equal(searched, 'latest release notes');
});

test('agent web.search duplicate in same run returns cache', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  let searchCount = 0;
  const query = 'latest release notes';
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    webSearch: async (args) => {
      searchCount += 1;
      return {
        ok: true,
        summary: 'Found 1 web source',
        data: { sources: [{ provider: 'tavily', title: 'Trusted result', url: 'https://example.com/trusted', content: 'Fresh public snippet' }] },
        evidence: [{ type: 'web', url: 'https://example.com/trusted', title: 'Trusted result' }],
      };
    },
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1 || round === 2) {
          return { text: '', toolCalls: [{ name: 'web.search', arguments: { query } }] };
        }
        return { text: '已检索公开来源', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('search-dedup');
  const run = await runtime.start({ session, goal: '搜索资料', userMessage: '搜索 latest release notes' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiting = store.getRun(run.id);
  assert.equal(waiting.status, 'waiting_approval');
  await runtime.resolveApproval(run.id, waiting.pendingApprovals[0].id, { approved: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  const done = store.getRun(run.id);
  assert.equal(done.status, 'completed');
  assert.equal(searchCount, 1);
  const cachedTool = done.messages.filter(item => item.role === 'tool' && item.name === 'web.search').at(-1);
  assert.ok(cachedTool);
  const cachedResult = JSON.parse(cachedTool.content);
  assert.equal(cachedResult.data.cached, true);
});

test('agent web.search session cache survives new run', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  let searchCount = 0;
  const query = 'session cached query';
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    webSearch: async () => {
      searchCount += 1;
      return {
        ok: true,
        summary: 'Found 1 web source',
        data: { sources: [{ provider: 'tavily', title: 'Cached result', url: 'https://example.com/cached', content: 'Cached snippet' }] },
        evidence: [{ type: 'web', url: 'https://example.com/cached', title: 'Cached result' }],
      };
    },
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1 || round === 2) {
          return { text: '', toolCalls: [{ name: 'web.search', arguments: { query } }] };
        }
        return { text: 'done', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('search-session-cache');
  const run1 = await runtime.start({ session, goal: 'first search', userMessage: 'search once' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiting = store.getRun(run1.id);
  assert.equal(waiting.status, 'waiting_approval');
  await runtime.resolveApproval(run1.id, waiting.pendingApprovals[0].id, { approved: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.getRun(run1.id).status, 'completed');
  assert.equal(searchCount, 1);

  const sessionAfter = store.getSession(session.id);
  assert.ok(sessionAfter.webSearchCache);
  const run2 = await runtime.start({ session: sessionAfter, goal: 'second search', userMessage: 'search again' });
  await new Promise(resolve => setTimeout(resolve, 80));
  const done2 = store.getRun(run2.id);
  assert.equal(done2.status, 'completed');
  assert.equal(searchCount, 1);
  const cachedTool = done2.messages.filter(item => item.role === 'tool' && item.name === 'web.search').at(-1);
  assert.ok(cachedTool);
  assert.equal(JSON.parse(cachedTool.content).data.cached, true);
});

test('agent image.generate waits for approval then returns a local upload url', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  let generated = '';
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    imageGenerate: async (args) => {
      generated = String(args.prompt || '');
      return {
        ok: true,
        summary: 'Generated image saved to /uploads/test.png',
        data: {
          url: '/uploads/test.png',
          markdown: '![a red cat](/uploads/test.png)',
          prompt: generated,
        },
        evidence: [{ type: 'image', url: '/uploads/test.png' }],
      };
    },
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'image.generate', arguments: { prompt: 'a red cat' } }] };
        }
        return { text: '图已生成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('image');
  const run = await runtime.start({ session, goal: '画一只猫', userMessage: '画一只红色的猫' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const live = store.getRun(run.id);
  assert.equal(live.status, 'waiting_approval');
  assert.equal(live.pendingApprovals[0].call.name, 'image.generate');
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  const done = store.getRun(run.id);
  assert.equal(done.status, 'completed');
  assert.equal(generated, 'a red cat');
  assert.match(done.finalText, /\/uploads\/test\.png/);
});

test('trace lines collapse repeated assistant deltas', () => {
  assert.deepEqual(traceLinesFromEvents([
    { type: 'run.started' },
    { type: 'assistant.delta', payload: { text: 'a' } },
    { type: 'assistant.delta', payload: { text: 'ab' } },
    { type: 'run.completed', payload: { text: 'done' } },
  ]), ['正在分析目标', '正在组织回答', '运行完成']);
});

test('summarizeRun exposes completedAt and model for session message timestamps', () => {
  const at = 1787365144571;
  const summary = summarizeRun({
    id: 'run-1',
    status: 'completed',
    model: 'gemini-test-pro',
    events: [
      { type: 'run.started', at },
      { type: 'run.completed', at: at + 5000, payload: { text: 'done' } },
    ],
  });
  assert.equal(summary.completedAt, at + 5000);
  assert.equal(summary.model, 'gemini-test-pro');
  assert.deepEqual(summary.trace, ['正在分析目标', '运行完成']);
  assert.equal(summarizeRun({ id: 'run-2', status: 'completed', events: [] }).model, '');
});

test('run records the model used and emits it on completion', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        return { text: '直接回答', toolCalls: [], model: 'test-model-x' };
      },
    },
  });
  const session = store.createSession('model-record');
  const run = await runtime.start({ session, goal: '随便回答', userMessage: '你好' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const live = store.getRun(run.id);
  assert.equal(live.status, 'completed');
  assert.equal(live.model, 'test-model-x');
  const completedEvent = (live.events || []).find(item => item.type === 'run.completed');
  assert.ok(completedEvent);
  assert.equal(completedEvent.payload.model, 'test-model-x');
});

test('session API returns a trace for each conversation round', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let answers = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        answers += 1;
        return { text: `回答 ${answers}`, toolCalls: [] };
      },
    },
  });
  const session = store.createSession('rounds');
  await runtime.start({ session, goal: '第一轮', userMessage: '第一轮' });
  await new Promise(resolve => setTimeout(resolve, 50));
  await runtime.start({ session: store.getSession(session.id), goal: '第二轮', userMessage: '第二轮' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.listRunsForSession(session.id).length, 2);

  const app = express();
  registerAgentRoutes(app, { db, hasDiaryAccess: () => false });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/sessions/${encodeURIComponent(session.id)}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.runs.length, 2);
  assert.equal(data.runs[0].status, 'completed');
  assert.equal(data.runs[1].status, 'completed');
  assert.equal(data.runs[0].trace.includes('运行完成'), true);
  assert.equal(data.runs[1].trace.at(-1), '运行完成');
  assert.equal(data.latestRun.id, data.runs[1].id);
});

test('archived sessions can be listed and deleted over HTTP, but active sessions cannot', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const live = store.createSession('进行中');
  const archived = store.createSession('已归档');
  store.saveRun({ id: 'archived-run', sessionId: archived.id, status: 'completed', createdAt: Date.now() });
  store.updateSession(archived.id, { status: 'archived' });

  const app = express();
  registerAgentRoutes(app, { db, hasDiaryAccess: () => false });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const listed = await fetch(`${base}/api/agent/sessions?status=archived`);
  assert.equal(listed.status, 200);
  const listedData = await listed.json();
  assert.equal(listedData.sessions.length, 1);
  assert.equal(listedData.sessions[0].id, archived.id);
  assert.equal(listedData.sessions[0].status, 'archived');

  const rejectActive = await fetch(`${base}/api/agent/sessions/${encodeURIComponent(live.id)}`, { method: 'DELETE' });
  assert.equal(rejectActive.status, 400);
  assert.equal((await rejectActive.json()).error, 'Only archived sessions can be deleted');
  assert.equal(store.getSession(live.id)?.title, '进行中');

  const missing = await fetch(`${base}/api/agent/sessions/not-a-session`, { method: 'DELETE' });
  assert.equal(missing.status, 404);

  const removed = await fetch(`${base}/api/agent/sessions/${encodeURIComponent(archived.id)}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { id: archived.id, deleted: true });
  assert.equal(store.getSession(archived.id), null);
  assert.equal(store.getRun('archived-run'), null);
});

test('memory service seeds builtin Seedream L3 workflow and does not restore after archive', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const l3 = memory.list({ layer: 'L3' });
  assert.equal(l3.length, 2);
  const seedream = l3.find(item => item.builtinId === 'seedream-generate');
  assert.ok(seedream);
  assert.equal(seedream.title, 'Seedream 生图');
  assert.ok(seedream.content.length <= MEMORY_CONTENT_MAX.L3);
  assert.match(seedream.content, /image\.generate/);
  memory.archive(seedream.id);
  assert.equal(memory.list({ layer: 'L3' }).length, 1);
});

test('memory proposals require evidence and filter secrets', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  assert.equal(memory.propose({ runId: 'r1', title: 'x', content: 'y', evidence: [] }).error, 'Memory requires evidence');
  assert.match(memory.propose({ runId: 'r1', title: 'key', content: 'api_key=abc', evidence: [{ id: 1 }] }).error, /secret/);
  const draft = memory.propose({ runId: 'r1', layer: 'L3', title: 'SOP', content: '先搜索再创建任务', evidence: [{ type: 'run', id: 'r1' }] });
  const saved = memory.approve(draft.proposal.id);
  assert.equal(saved.memory.layer, 'L3');
  assert.equal(memory.list({ layer: 'L3' }).some(item => item.title === 'SOP'), true);
});

test('memory proposal args accept content aliases from the model', () => {
  const normalized = normalizeMemoryProposalArgs({
    title: '文风',
    text: '周报用简洁中文，先结论后细节。',
    layer: 'l2',
    evidence: [{ type: 'refresh' }],
  });
  assert.equal(normalized.content, '周报用简洁中文，先结论后细节。');
  assert.equal(normalized.layer, 'L2');
});

test('memory proposals truncate by layer and refresh prompt avoids conversation recaps', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const l2 = memory.propose({
    runId: 'r1',
    layer: 'L2',
    title: '偏好',
    content: 'x'.repeat(MEMORY_CONTENT_MAX.L2 + 40),
    evidence: [{ type: 'run', id: 'r1' }],
  });
  assert.equal(l2.proposal.content.length, MEMORY_CONTENT_MAX.L2);
  const l3 = memory.propose({
    runId: 'r2',
    layer: 'L3',
    title: '流程',
    content: 'y'.repeat(MEMORY_CONTENT_MAX.L3 + 40),
    evidence: [{ type: 'run', id: 'r2' }],
  });
  assert.equal(l3.proposal.content.length, MEMORY_CONTENT_MAX.L3);
  const customSettings = resolveMemorySettings({ memoryRefreshMaxProposals: 10, memoryRefreshSessionLimit: 2 });
  assert.match(buildMemoryRefreshUserMessage({ listSessions: () => [] }, { list: () => [] }, customSettings), /Propose at most 10 drafts/);
  assert.match(buildMemoryRefreshUserMessage({ listSessions: () => [] }, { list: () => [] }, customSettings), /do not recap a conversation/i);
  const longContent = '流程步骤'.repeat(80);
  const prompt = buildMemoryRefreshUserMessage(
    { listSessions: () => [] },
    { list: () => [{ id: 'm1', layer: 'L3', title: '流程', content: longContent }] },
    customSettings,
  );
  assert.match(prompt, new RegExp(longContent.slice(0, 120)));
});

test('@ mentions parse multiple knowledge bases and dates', () => {
  const mentions = parseMentions('@开发 看一下 @测试 @2026-05-16', ['开发', '测试', '文档']);
  assert.deepEqual(mentions, [
    { type: 'knowledgeBase', value: '开发' },
    { type: 'knowledgeBase', value: '测试' },
    { type: 'date', value: '2026-05-16' },
  ]);
});

test('@ mentions inject matching documents and skip locked diary', (t) => {
  const db = tempDb(t);
  db.create({ title: '发布流程', content: '先评审再发布', category: '开发', log_date: '2026-05-16' });
  db.create({ title: '日记秘密', content: '不应出现', category: '日记', log_date: '2026-05-16' });
  const knowledge = openKnowledge(db);
  const locked = expandMentions('@开发 @2026-05-16', { knowledge, db, diaryUnlocked: false });
  assert.equal(locked.documents.some(doc => doc.title === '发布流程'), true);
  assert.match(locked.context, /先评审再发布/);
  assert.equal(locked.documents.some(doc => /秘密/.test(doc.title)), false);
  const open = expandMentions('@2026-05-16', { knowledge, db, diaryUnlocked: true });
  assert.equal(open.documents.some(doc => doc.title === '日记秘密'), true);
});

test('runtime injects @ knowledge for the model without storing it in the session', async (t) => {
  const db = tempDb(t);
  db.create({ title: '发布流程', content: '先评审再发布', category: '开发', log_date: '2026-05-16' });
  const store = createAgentStore(db);
  let seen = '';
  const runtime = createRuntime({
    db,
    store,
    memory: createMemoryService(store),
    knowledgeSearch: { knowledge: openKnowledge(db) },
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ messages }) {
        seen = messages.findLast?.(item => item.role === 'user')?.content
          || [...messages].reverse().find(item => item.role === 'user')?.content
          || '';
        return { text: '已根据材料回答', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('mention');
  const run = await runtime.start({ session, goal: '@开发 总结', userMessage: '@开发 总结' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.getRun(run.id).status, 'completed');
  assert.match(seen, /先评审再发布/);
  assert.equal(store.getSession(session.id).messages[0].content, '@开发 总结');
});

test('runtime maps provider underscore tool names back to dotted names', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'task_create', arguments: { title: '写周报' } }] };
        }
        return { text: '已创建任务', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('underscore');
  const run = await runtime.start({ session, goal: '创建任务', userMessage: '创建任务' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const live = store.getRun(run.id);
  assert.equal(live.status, 'waiting_approval');
  assert.equal(live.pendingApprovals[0].call.name, 'task.create');
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  assert.equal(store.getRun(run.id).status, 'completed');
  assert.equal(db.getAllTodos()[0].title, '写周报');
});

test('agent session summaries stay lightweight and sessions can be renamed, archived, or deleted', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const session = store.createSession('初始标题');
  store.saveSession({ ...session, messages: [{ role: 'user', content: '一段会话内容' }] });
  store.saveRun({ id: 'run-keep', sessionId: session.id, status: 'completed', createdAt: Date.now() });
  const summaries = store.listSessionSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].lastMessagePreview, '一段会话内容');
  assert.equal('messages' in summaries[0], false);
  const renamed = store.updateSession(session.id, { title: '重命名后' });
  assert.equal(renamed.title, '重命名后');
  store.updateSession(session.id, { status: 'archived' });
  assert.equal(store.listSessionSummaries().length, 0);
  assert.equal(store.listSessionSummaries({ includeArchived: true })[0].status, 'archived');
  assert.equal(store.getSession(session.id).messages[0].content, '一段会话内容');
  const active = store.createSession('仍在进行');
  assert.equal(store.deleteSession(active.id).error, 'Only archived sessions can be deleted');
  assert.equal(store.getSession(active.id)?.title, '仍在进行');
  assert.equal(store.deleteSession('missing'), null);
  const deleted = store.deleteSession(session.id);
  assert.deepEqual(deleted, { id: session.id, deleted: true });
  assert.equal(store.getSession(session.id), null);
  assert.equal(store.getRun('run-keep'), null);
  assert.equal(store.listRunsForSession(session.id).length, 0);
});

test('agent runtime picks up the model client after a read-only session listing initializes its cache', async (t) => {
  const db = tempDb(t);
  runtimeFor(db, { hasDiaryAccessFlag: false });
  const pack = runtimeFor(db, {
    hasDiaryAccessFlag: false,
    modelClient: { async complete() { return { text: '动态模型已连接', toolCalls: [] }; } },
  });
  const session = pack.store.createSession('生命周期');
  const run = await pack.runtime.start({ session, goal: '测试', userMessage: '测试' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pack.store.getRun(run.id).status, 'completed');
  assert.equal(pack.store.getRun(run.id).finalText, '动态模型已连接');
});

async function waitForRun(store, id, timeout = 500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const run = store.getRun(id);
    if (run && ['completed', 'failed', 'cancelled', 'waiting_approval'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return store.getRun(id);
}

test('runtime honors saved agentMaxRounds', async (t) => {
  const db = tempDb(t);
  db.saveAiSettings({ ...db.getAiSettings(), agentMaxRounds: 4 });
  const store = createAgentStore(db);
  const runtime = createRuntime({
    db,
    store,
    memory: createMemoryService(store),
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        return { text: '', toolCalls: [{ name: 'task.list', arguments: {} }] };
      },
    },
  });
  const session = store.createSession('rounds');
  const run = await runtime.start({ session, goal: '列表', userMessage: '列表' });
  const done = await waitForRun(store, run.id, 800);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'Round limit exceeded');
  assert.equal(done.round, 4);
});

test('clampMaxRounds has no upper cap', () => {
  assert.equal(clampMaxRounds(64), 64);
  assert.equal(clampMaxRounds(100), 100);
  assert.equal(clampMaxRounds(3), 4);
});

test('runtime honors high saved agentMaxRounds without an upper cap', async (t) => {
  const db = tempDb(t);
  db.saveAiSettings({ ...db.getAiSettings(), agentMaxRounds: 64 });
  const store = createAgentStore(db);
  const runtime = createRuntime({
    db,
    store,
    memory: createMemoryService(store),
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        return { text: 'done', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('high-rounds');
  const run = await runtime.start({ session, goal: 'ok', userMessage: 'ok' });
  const done = await waitForRun(store, run.id, 800);
  assert.equal(done.status, 'completed');
  assert.ok(done.round <= 64);
});

test('memory dismiss rejects a pending proposal', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const draft = memory.propose({
    runId: 'r1',
    title: '偏好',
    content: '喜欢简洁',
    evidence: [{ type: 'run', id: 'r1' }],
  });
  const dismissed = memory.dismiss(draft.proposal.id);
  assert.equal(dismissed.proposal.status, 'rejected');
  assert.equal(memory.listProposals().length, 0);
});

test('memory archive hides an active item from list and agent context', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const draft = memory.propose({
    runId: 'r1',
    title: '偏好',
    content: '喜欢简洁',
    evidence: [{ type: 'run', id: 'r1' }],
  });
  const saved = memory.approve(draft.proposal.id);
  assert.equal(memory.list().filter(item => !item.builtinId).length, 1);
  const missing = memory.archive('missing-id');
  assert.equal(missing.error, 'Memory not found');
  const archived = memory.archive(saved.memory.id);
  assert.equal(archived.memory.status, 'archived');
  assert.equal(memory.list().filter(item => !item.builtinId).length, 0);
  const context = memory.contextBlocks();
  assert.equal(context.l2.length, 0);
  assert.equal(context.l3.filter(item => !item.builtinId).length, 0);
  assert.equal(memory.archive(saved.memory.id).error, 'Memory not found');
});

test('memory refresh proposes drafts without exposing write tools or creating a session', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  store.createSession('近期会话');
  store.saveSession({
    ...store.listSessions()[0],
    messages: [{ role: 'user', content: '我希望周报用简洁中文' }],
  });
  let seenTools = [];
  let round = 0;
  const app = express();
  registerAgentRoutes(app, {
    db,
    hasDiaryAccess: () => false,
    agentStatusFor: async () => ({ configured: true, provider: 'test', model: 'stub' }),
    modelClientFor: async () => ({
      async complete({ tools }) {
        seenTools = (tools || []).map(item => item.name);
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [
              { name: 'memory.propose', arguments: { title: '文风', content: '周报用简洁中文', layer: 'L2' } },
              { name: 'task.create', arguments: { title: '不该创建' } },
            ],
          };
        }
        return { text: '已提出草稿', toolCalls: [] };
      },
    }),
  });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const unconfigured = express();
  registerAgentRoutes(unconfigured, {
    db,
    hasDiaryAccess: () => false,
    agentStatusFor: async () => ({ configured: false, provider: '', model: '' }),
  });
  const blockedServer = await new Promise(resolve => {
    const started = unconfigured.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => blockedServer.close(resolve)));
  const blocked = await fetch(`http://127.0.0.1:${blockedServer.address().port}/api/agent/memory/refresh`, { method: 'POST' });
  assert.equal(blocked.status, 400);

  const started = await fetch(`${base}/api/agent/memory/refresh`, { method: 'POST' });
  assert.equal(started.status, 202);
  const body = await started.json();
  const pack = runtimeFor(db, { hasDiaryAccessFlag: false });
  const done = await waitForRun(pack.store, body.runId, 800);
  assert.equal(done.status, 'completed');
  assert.equal(done.kind, 'memory_refresh');
  assert.equal(done.sessionId, '');
  assert.deepEqual(seenTools, ['memory.propose']);
  const listed = await fetch(`${base}/api/agent/memories`);
  const memories = await listed.json();
  assert.equal(listed.status, 200);
  assert.equal(memories.proposals.length, 1);
  assert.equal(memories.proposals[0].title, '文风');
  assert.equal(memories.items.filter(item => !item.builtinId).length, 0);
  assert.equal(memories.items.some(item => item.builtinId === 'seedream-generate'), true);
  assert.equal((db.getAllTodos() || []).length, 0);

  const approved = await fetch(`${base}/api/agent/memory-proposals/${encodeURIComponent(memories.proposals[0].id)}/approve`, { method: 'POST' });
  assert.equal(approved.status, 200);
  const afterApprove = await (await fetch(`${base}/api/agent/memories`)).json();
  assert.equal(afterApprove.items[0].title, '文风');
  assert.equal(afterApprove.proposals.length, 0);

  const secondDraft = pack.memory.propose({
    runId: 'manual',
    title: '临时',
    content: '可忽略',
    evidence: [{ type: 'refresh', runId: 'manual' }],
  });
  const dismissed = await fetch(`${base}/api/agent/memory-proposals/${encodeURIComponent(secondDraft.proposal.id)}/dismiss`, { method: 'POST' });
  assert.equal(dismissed.status, 200);
  const afterDismiss = await (await fetch(`${base}/api/agent/memories`)).json();
  assert.equal(afterDismiss.proposals.length, 0);

  const archived = await fetch(`${base}/api/agent/memories/${encodeURIComponent(afterApprove.items[0].id)}`, { method: 'DELETE' });
  assert.equal(archived.status, 200);
  const afterArchive = await (await fetch(`${base}/api/agent/memories`)).json();
  assert.equal(afterArchive.items.filter(item => !item.builtinId).length, 0);
  assert.equal(afterArchive.items.some(item => item.builtinId === 'seedream-generate'), true);
  const missing = await fetch(`${base}/api/agent/memories/missing-id`, { method: 'DELETE' });
  assert.equal(missing.status, 404);
});

test('memory refresh honors memoryRefreshMaxProposals setting', async (t) => {
  const db = tempDb(t);
  db.saveAiSettings({ ...db.getAiSettings(), memoryRefreshMaxProposals: 2 });
  const store = createAgentStore(db);
  store.createSession('近期会话');
  store.saveSession({
    ...store.listSessions()[0],
    messages: [{ role: 'user', content: '偏好简洁中文' }],
  });
  const app = express();
  registerAgentRoutes(app, {
    db,
    hasDiaryAccess: () => false,
    agentStatusFor: async () => ({ configured: true, provider: 'test', model: 'stub' }),
    modelClientFor: async () => ({
      async complete() {
        return {
          text: '',
          toolCalls: [
            { name: 'memory.propose', arguments: { title: 'A', content: 'a', layer: 'L2' } },
            { name: 'memory.propose', arguments: { title: 'B', content: 'b', layer: 'L2' } },
            { name: 'memory.propose', arguments: { title: 'C', content: 'c', layer: 'L2' } },
          ],
        };
      },
    }),
  });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const started = await fetch(`${base}/api/agent/memory/refresh`, { method: 'POST' });
  assert.equal(started.status, 202);
  const body = await started.json();
  const pack = runtimeFor(db, { hasDiaryAccessFlag: false });
  const done = await waitForRun(pack.store, body.runId, 800);
  assert.equal(done.status, 'completed');
  const memories = await (await fetch(`${base}/api/agent/memories`)).json();
  assert.equal(memories.proposals.length, 2);
  assert.deepEqual(memories.proposals.map(item => item.title).sort(), ['A', 'B']);
});

test('contextBlocks injects only L0 rules', (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store, {
    settingsFor: () => resolveMemorySettings({ memoryContextMaxL2: 2, memoryContextMaxL3: 1 }),
  });
  for (let i = 0; i < 4; i += 1) {
    const draft = memory.propose({ runId: `r${i}`, layer: 'L2', title: `L2-${i}`, content: `fact ${i}`, evidence: [{ type: 'run', id: `r${i}` }] });
    memory.approve(draft.proposal.id);
  }
  for (let i = 0; i < 3; i += 1) {
    const draft = memory.propose({ runId: `w${i}`, layer: 'L3', title: `L3-${i}`, content: `flow ${i}`, evidence: [{ type: 'run', id: `w${i}` }] });
    memory.approve(draft.proposal.id);
  }
  const blocks = memory.contextBlocks();
  assert.ok(blocks.l0?.rules?.length);
  assert.equal(blocks.l2.length, 0);
  assert.equal(blocks.l3.length, 0);
});

test('knowledge.import from content waits for approval then stores a document', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const knowledge = createKnowledgeService(db);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [{
              name: 'knowledge.import',
              arguments: { content: '# Hello import', filename: 'hello.md', title: '导入笔记' },
            }],
          };
        }
        return { text: '已导入', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('import-content');
  const run = await runtime.start({ session, goal: '导入', userMessage: '导入笔记' });
  const live = await waitForRun(store, run.id);
  assert.equal(live.status, 'waiting_approval');
  assert.equal(knowledge.allDocuments({ diaryUnlocked: true }).some(doc => doc.sourceType === 'file'), false);
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  const done = await waitForRun(store, run.id);
  assert.equal(done.status, 'completed');
  const imported = knowledge.allDocuments({ diaryUnlocked: true }).filter(doc => doc.sourceType === 'file');
  assert.equal(imported.length, 1);
  assert.equal(imported[0].title, '导入笔记');
  assert.match(imported[0].content, /Hello import/);
});

test('knowledge.import from an allowlisted path stores a document after approval', async (t) => {
  const db = tempDb(t);
  const allowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-allow-'));
  t.after(() => fs.rmSync(allowDir, { recursive: true, force: true }));
  const filePath = path.join(allowDir, 'from-disk.md');
  fs.writeFileSync(filePath, 'disk import body');
  savePolicy(db.dataDir, { computerToolsEnabled: true, allowedDirectories: [allowDir], chromePaired: false });
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const knowledge = createKnowledgeService(db);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'knowledge.import', arguments: { path: filePath } }] };
        }
        return { text: '已从磁盘导入', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('import-path');
  const run = await runtime.start({ session, goal: '导入文件', userMessage: '导入文件' });
  const live = await waitForRun(store, run.id);
  assert.equal(live.status, 'waiting_approval');
  assert.equal(knowledge.allDocuments({ diaryUnlocked: true }).some(doc => doc.sourceType === 'file'), false);
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  const done = await waitForRun(store, run.id);
  assert.equal(done.status, 'completed');
  const imported = knowledge.allDocuments({ diaryUnlocked: true }).filter(doc => doc.sourceType === 'file');
  assert.equal(imported.length, 1);
  assert.equal(imported[0].fileMeta.filename, 'from-disk.md');
  assert.match(imported[0].content, /disk import body/);
});

test('update_working_checkpoint merges model progress and injects checkpoint into model calls', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const seenCheckpoints = [];
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ checkpoint }) {
        seenCheckpoints.push(checkpoint);
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [{
              name: 'update_working_checkpoint',
              arguments: {
                next: 'Compare the two notes',
                notes: 'Read both candidate docs',
                verified: ['Found note A'],
              },
            }],
          };
        }
        return { text: '对比完成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('checkpoint');
  const run = await runtime.start({ session, goal: '对比笔记', userMessage: '对比笔记' });
  const done = await waitForRun(store, run.id);
  assert.equal(done.status, 'completed');
  const saved = store.getSession(session.id);
  assert.equal(saved.checkpoint.notes, 'Read both candidate docs');
  assert.ok(saved.checkpoint.verified.includes('Found note A'));
  assert.equal(saved.checkpoint.next, 'complete');
  assert.ok(seenCheckpoints.length >= 2);
  assert.equal(seenCheckpoints[1]?.next, 'Compare the two notes');
});

test('ask_user pauses the run until the user replies', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'ask_user', arguments: { question: '你要改哪篇笔记？' } }] };
        }
        return { text: '已按你的选择处理', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('ask-user');
  const run = await runtime.start({ session, goal: '修改笔记', userMessage: '修改笔记' });
  const paused = await waitForRun(store, run.id);
  assert.equal(paused.status, 'waiting_user');
  assert.equal(paused.pendingQuestion, '你要改哪篇笔记？');
  assert.ok((paused.events || []).some(event => event.type === 'user_input.required'));
  const resumed = await runtime.resumeUserInput(run.id, '改 note:123');
  assert.equal(resumed.run.status, 'completed');
  assert.equal(resumed.run.finalText, '已按你的选择处理');
  assert.ok(resumed.run.messages.some(item => item.role === 'user' && item.content === '改 note:123'));
});

test('action envelope ask pauses the run for user input', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        return { text: '{"action":"ask","question":"需要哪个日期？"}', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('ask-envelope');
  const run = await runtime.start({ session, goal: '查日志', userMessage: '查日志' });
  const paused = await waitForRun(store, run.id);
  assert.equal(paused.status, 'waiting_user');
  assert.equal(paused.pendingQuestion, '需要哪个日期？');
});

test('countdown.create stores a birthday countdown after approval', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [{
              name: 'countdown.create',
              arguments: {
                title: '心心生日',
                target_date: '2002-10-19',
                repeat_yearly: true,
                notes: '朋友生日',
              },
            }],
          };
        }
        return { text: '已添加倒数日', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('birthday');
  const run = await runtime.start({ session, goal: '加生日倒数日', userMessage: '加生日倒数日' });
  const live = await waitForRun(store, run.id);
  assert.equal(live.status, 'waiting_approval');
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  const done = await waitForRun(store, run.id);
  assert.equal(done.status, 'completed');
  const countdowns = db.getAllCountdowns().filter(item => item.title === '心心生日');
  assert.equal(countdowns.length, 1);
  assert.equal(countdowns[0].target_date, '2002-10-19');
  assert.equal(countdowns[0].repeat_yearly, true);
});

test('task.create with empty title does not enter approval queue', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'task.create', arguments: {} }] };
        }
        return { text: '已停止重试', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('empty-create');
  const run = await runtime.start({ session, goal: '添加待办', userMessage: '添加待办' });
  const done = await waitForRun(store, run.id, 800);
  assert.notEqual(done.status, 'waiting_approval');
  assert.equal(done.status, 'completed');
  const toolMsg = done.messages.find(item => item.role === 'tool' && item.name === 'task.create');
  assert.match(toolMsg.content, /requires a non-empty title/);
});

test('task.create is rejected for countdown goals before approval', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return { text: '', toolCalls: [{ name: 'task.create', arguments: { title: '心心生日' } }] };
        }
        if (round === 2) {
          return {
            text: '',
            toolCalls: [{
              name: 'countdown.create',
              arguments: { title: '心心生日', target_date: '2002-10-19', repeat_yearly: true },
            }],
          };
        }
        return { text: '已添加倒数日', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('countdown-goal');
  const run = await runtime.start({ session, goal: '加入倒数日', userMessage: '加入倒数日' });
  const live = await waitForRun(store, run.id);
  const rejected = live.messages.find(item => item.role === 'tool' && item.name === 'task.create');
  assert.match(rejected.content, /countdown\.create/);
  assert.equal(live.status, 'waiting_approval');
  assert.equal(live.pendingApprovals[0].call.name, 'countdown.create');
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  const done = await waitForRun(store, run.id);
  assert.equal(done.status, 'completed');
  assert.equal(db.getAllCountdowns().filter(item => item.title === '心心生日').length, 1);
});

test('duplicate countdown.create in the same run does not create a second entry', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round <= 2) {
          return {
            text: '',
            toolCalls: [{
              name: 'countdown.create',
              arguments: { title: '测试生日', target_date: '2000-01-01', repeat_yearly: true },
            }],
          };
        }
        return { text: '完成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('dup-countdown');
  const run = await runtime.start({ session, goal: '加倒数日', userMessage: '加倒数日' });
  let live = await waitForRun(store, run.id);
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  live = await waitForRun(store, run.id, 800);
  assert.equal(db.getAllCountdowns().filter(item => item.title === '测试生日').length, 1);
  const dupMsg = live.messages.filter(item => item.role === 'tool' && item.name === 'countdown.create').at(-1);
  assert.match(dupMsg.content, /Already/);
});

test('premature countdown success checkpoint is rejected', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let round = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        round += 1;
        if (round === 1) {
          return {
            text: '',
            toolCalls: [{
              name: 'update_working_checkpoint',
              arguments: { next: '确认倒数日创建成功', notes: '已添加' },
            }],
          };
        }
        return { text: '已修正', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('checkpoint');
  const run = await runtime.start({ session, goal: '加入倒数日', userMessage: '加入倒数日' });
  const done = await waitForRun(store, run.id);
  const checkpointMsg = done.messages.find(item => item.role === 'tool' && item.name === 'update_working_checkpoint');
  assert.match(checkpointMsg.content, /premature_checkpoint|Countdown not created/);
});

test('cancel clears pending approvals', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        return { text: '', toolCalls: [{ name: 'task.create', arguments: { title: '测试' } }] };
      },
    },
  });
  const session = store.createSession('cancel');
  const run = await runtime.start({ session, goal: '添加待办', userMessage: '添加待办' });
  const live = await waitForRun(store, run.id);
  assert.equal(live.status, 'waiting_approval');
  runtime.cancel(run.id);
  const cancelled = store.getRun(run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((cancelled.pendingApprovals || []).length, 0);
});

test('shouldPauseForRepeatedMutations detects three similar creates', () => {
  const { shouldPauseForRepeatedMutations } = require('../lib/agent/guards');
  const run = {
    mutationHistory: [
      { name: 'task.create', fingerprint: 'task.create:生日::none' },
      { name: 'task.create', fingerprint: 'task.create:生日::none' },
      { name: 'task.create', fingerprint: 'task.create:生日::none' },
    ],
  };
  assert.ok(shouldPauseForRepeatedMutations(run));
});

test('knowledge.search finds matching documents via MiniSearch', async (t) => {
  const db = tempDb(t);
  const knowledge = openKnowledge(db);
  knowledge.createNote({ title: 'Agent搜索笔记', content: '唯一标记 xyzzy-agent-search-test' });
  const { createToolAdapters } = require('../lib/agent/adapters');
  const { serviceFor } = require('../lib/knowledge/routes');
  const adapters = createToolAdapters({
    db,
    knowledgeSearch: serviceFor(db),
    hasDiaryAccessFlag: false,
  });
  const result = await adapters.execute('knowledge.search', { query: 'xyzzy-agent-search-test' });
  assert.equal(result.ok, true);
  assert.ok(result.data.documents.some(item => item.title === 'Agent搜索笔记'));
  assert.ok(result.data.documents[0].searchSnippet || result.data.documents[0].searchScore);
});

test('knowledge.tree lists knowledge base structure', async (t) => {
  const db = tempDb(t);
  const knowledge = openKnowledge(db);
  knowledge.createNote({
    title: '树结构笔记',
    content: 'hello',
    knowledgeBase: '测试库',
    folderPath: '子文件夹',
  });
  const { createToolAdapters } = require('../lib/agent/adapters');
  const { serviceFor } = require('../lib/knowledge/routes');
  const adapters = createToolAdapters({
    db,
    knowledgeSearch: serviceFor(db),
    hasDiaryAccessFlag: false,
  });
  const result = await adapters.execute('knowledge.tree', {});
  assert.equal(result.ok, true);
  const base = result.data.knowledgeBases.find(item => item.name === '测试库');
  assert.ok(base);
  assert.ok(base.documentCount >= 1);
});

test('knowledge.list paginates documents in a folder', async (t) => {
  const db = tempDb(t);
  const knowledge = openKnowledge(db);
  knowledge.createNote({ title: '列表笔记A', content: 'a', knowledgeBase: '列表库', folderPath: '目录' });
  knowledge.createNote({ title: '列表笔记B', content: 'b', knowledgeBase: '列表库', folderPath: '目录' });
  const { createToolAdapters } = require('../lib/agent/adapters');
  const { serviceFor } = require('../lib/knowledge/routes');
  const memory = createMemoryService(createAgentStore(db));
  const adapters = createToolAdapters({
    db,
    knowledgeSearch: serviceFor(db),
    hasDiaryAccessFlag: false,
    memory,
  });
  const result = await adapters.execute('knowledge.list', {
    knowledgeBase: '列表库',
    folderPath: '目录',
    limit: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.total, 2);
  assert.equal(result.data.documents.length, 2);
});

test('memory.search finds matching L2 items with snippets only', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  memory.approve(memory.propose({
    runId: 'test',
    layer: 'L2',
    title: '写作偏好',
    content: '周报用简洁中文',
    evidence: [{ type: 'test' }],
  }).proposal.id);
  const { createToolAdapters } = require('../lib/agent/adapters');
  const adapters = createToolAdapters({ db, hasDiaryAccessFlag: false, memory });
  const result = await adapters.execute('memory.search', { query: '简洁中文', layer: 'L2' });
  assert.equal(result.ok, true);
  const match = result.data.items.find(item => item.title === '写作偏好');
  assert.ok(match);
  assert.ok(match.snippet);
  assert.equal(match.content, undefined);
  assert.ok(match.snippet.length <= 120);
  assert.match(result.summary, /memory\.read/);
});

test('memory.list returns titles without content', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const approved = memory.approve(memory.propose({
    runId: 'test',
    layer: 'L2',
    title: '列表测试',
    content: '完整正文不应出现在 list 结果里',
    evidence: [{ type: 'test' }],
  }).proposal.id);
  const { createToolAdapters } = require('../lib/agent/adapters');
  const adapters = createToolAdapters({ db, hasDiaryAccessFlag: false, memory });
  const result = await adapters.execute('memory.list', { layer: 'L2' });
  assert.equal(result.ok, true);
  const item = result.data.items.find(entry => entry.id === approved.memory.id);
  assert.ok(item);
  assert.equal(item.title, '列表测试');
  assert.equal(item.content, undefined);
});

test('memory.read returns full content after search', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const body = `${'前缀'.repeat(40)}命中关键词${'后缀'.repeat(40)}`;
  const approved = memory.approve(memory.propose({
    runId: 'test',
    layer: 'L3',
    title: '流程记忆',
    content: body,
    evidence: [{ type: 'test' }],
  }).proposal.id);
  const { createToolAdapters, buildMemorySearchSnippet, MEMORY_SEARCH_SNIPPET_MAX } = require('../lib/agent/adapters');
  const adapters = createToolAdapters({ db, hasDiaryAccessFlag: false, memory });
  const search = await adapters.execute('memory.search', { query: '命中关键词' });
  assert.equal(search.ok, true);
  const hit = search.data.items.find(item => item.id === approved.memory.id);
  assert.ok(hit?.snippet);
  assert.ok(hit.snippet.includes('命中关键词'));
  assert.ok(hit.snippet.length <= MEMORY_SEARCH_SNIPPET_MAX);
  const snippet = buildMemorySearchSnippet({ title: '流程记忆', content: body }, '命中关键词');
  assert.ok(snippet.includes('命中关键词'));
  const read = await adapters.execute('memory.read', { id: approved.memory.id });
  assert.equal(read.ok, true);
  assert.equal(read.data.content, body);
});

test('agent.delegate completes a read-only sub-task', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  db.createTodo({ title: '委派可见待办' });
  let parentRound = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ messages }) {
        const inChild = (messages || []).some(item => typeof item.content === 'string' && item.content.includes('列出所有待办'));
        if (inChild) {
          const listed = (messages || []).some(item => item.role === 'tool' && item.name === 'task.list');
          if (!listed) return { text: '', toolCalls: [{ name: 'task.list', arguments: {} }] };
          return { text: '子任务：已列出待办', toolCalls: [] };
        }
        parentRound += 1;
        if (parentRound === 1) {
          return {
            text: '',
            toolCalls: [{
              name: 'agent.delegate',
              arguments: { prompt: '列出所有待办', title: '列待办' },
            }],
          };
        }
        return { text: '父任务完成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('delegate-read');
  const run = await runtime.start({ session, goal: '了解待办', userMessage: '了解待办' });
  let live = await waitForRun(store, run.id);
  assert.equal(live.status, 'waiting_approval');
  assert.equal(live.pendingApprovals[0].call.name, 'agent.delegate');
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  live = await waitForRun(store, run.id, 1200);
  assert.equal(live.status, 'completed');
  const delegateResult = live.messages.find(item => item.role === 'tool' && item.name === 'agent.delegate');
  assert.ok(delegateResult);
  assert.match(delegateResult.content, /子任务：已列出待办/);
});

test('agent.delegate bubbles write approval to parent run', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let parentDelegated = false;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ messages }) {
        const inChild = (messages || []).some(item => typeof item.content === 'string' && item.content.includes('创建待办'));
        if (inChild) {
          const created = (messages || []).some(item => item.role === 'tool' && item.name === 'task.create');
          if (!created) return { text: '', toolCalls: [{ name: 'task.create', arguments: { title: '委派创建' } }] };
          return { text: '子任务已创建', toolCalls: [] };
        }
        if (!parentDelegated) {
          parentDelegated = true;
          return {
            text: '',
            toolCalls: [{ name: 'agent.delegate', arguments: { prompt: '创建待办', title: '建待办' } }],
          };
        }
        return { text: '父任务完成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('delegate-write');
  const run = await runtime.start({ session, goal: '添加待办', userMessage: '添加待办' });
  let live = await waitForRun(store, run.id);
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  live = await waitForRun(store, run.id, 1200);
  assert.equal(live.status, 'waiting_approval');
  assert.equal(live.pendingApprovals[0].call.name, 'task.create');
  assert.equal(live.pendingApprovals[0].delegatedRunId, live.activeChildRunId);
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  live = await waitForRun(store, run.id, 1200);
  assert.equal(live.status, 'completed');
  assert.ok(db.getAllTodos().some(item => item.title === '委派创建'));
});

test('nested agent.delegate is rejected inside child run', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let parentDelegated = false;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ messages }) {
        const inChild = (messages || []).some(item => typeof item.content === 'string' && item.content.includes('嵌套委派'));
        if (inChild) {
          const nested = (messages || []).some(item => item.role === 'tool' && item.name === 'agent.delegate');
          if (!nested) return { text: '', toolCalls: [{ name: 'agent.delegate', arguments: { prompt: 'again' } }] };
          return { text: '子任务结束', toolCalls: [] };
        }
        if (!parentDelegated) {
          parentDelegated = true;
          return {
            text: '',
            toolCalls: [{ name: 'agent.delegate', arguments: { prompt: '嵌套委派测试', title: '外层' } }],
          };
        }
        return { text: '父任务完成', toolCalls: [] };
      },
    },
  });
  const session = store.createSession('delegate-nested');
  const run = await runtime.start({ session, goal: '测试嵌套', userMessage: '测试嵌套' });
  let live = await waitForRun(store, run.id);
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  live = await waitForRun(store, run.id, 1200);
  const delegateResult = live.messages.find(item => item.role === 'tool' && item.name === 'agent.delegate');
  assert.ok(delegateResult);
  const parsed = JSON.parse(delegateResult.content);
  const child = store.getRun(parsed.data?.childRunId);
  assert.ok(child);
  const nestedTool = child.messages.find(item => item.role === 'tool' && item.name === 'agent.delegate');
  assert.ok(nestedTool);
  assert.match(nestedTool.content, /Nested delegate is not allowed/);
});

test('cancel cascades to active delegate child run', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ messages }) {
        const inChild = (messages || []).some(item => typeof item.content === 'string' && item.content.includes('慢子任务'));
        if (inChild) {
          return { text: '', toolCalls: [{ name: 'task.create', arguments: { title: '不应创建' } }] };
        }
        return {
          text: '',
          toolCalls: [{ name: 'agent.delegate', arguments: { prompt: '慢子任务', title: '慢' } }],
        };
      },
    },
  });
  const session = store.createSession('delegate-cancel');
  const run = await runtime.start({ session, goal: '取消测试', userMessage: '取消测试' });
  let live = await waitForRun(store, run.id);
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  live = await waitForRun(store, run.id, 800);
  assert.equal(live.status, 'waiting_approval');
  assert.ok(live.activeChildRunId);
  const childBefore = store.getRun(live.activeChildRunId);
  runtime.cancel(run.id);
  const childAfter = store.getRun(live.activeChildRunId);
  assert.equal(childAfter.status, 'cancelled');
  assert.equal((childBefore.pendingApprovals || []).length >= 0, true);
});

test('agent tools exclude locked diary from search, tree, and list', async (t) => {
  const db = tempDb(t);
  const knowledge = openKnowledge(db);
  db.create({ title: '日记秘密', content: 'agent-diary-marker-xyzzy', category: '日记', log_date: '2026-05-16' });
  knowledge.createNote({ title: '普通笔记', content: 'agent-diary-marker-visible', knowledgeBase: '开发' });
  const { createToolAdapters } = require('../lib/agent/adapters');
  const { serviceFor } = require('../lib/knowledge/routes');
  const adapters = createToolAdapters({
    db,
    knowledgeSearch: serviceFor(db),
    hasDiaryAccessFlag: false,
  });
  const search = await adapters.execute('knowledge.search', { query: 'agent-diary-marker' });
  assert.equal(search.ok, true);
  assert.equal(search.data.documents.some(item => item.title === '日记秘密'), false);
  assert.equal(search.data.documents.some(item => item.title === '普通笔记'), true);
  const tree = await adapters.execute('knowledge.tree', {});
  assert.equal(tree.ok, true);
  const list = await adapters.execute('knowledge.list', { knowledgeBase: '开发' });
  assert.equal(list.ok, true);
  assert.equal(list.data.documents.some(item => item.title === '日记秘密'), false);
});

test('web.fetch uses injected fetch handler', async (t) => {
  const db = tempDb(t);
  const { createToolAdapters } = require('../lib/agent/adapters');
  const { toolResult } = require('../lib/agent/tools');
  const adapters = createToolAdapters({
    db,
    webFetch: async (args) => toolResult({
      ok: true,
      summary: `Fetched ${args.url}`,
      data: { url: args.url, text: 'hello world' },
      evidence: [{ type: 'web', url: args.url }],
    }),
  });
  const result = await adapters.execute('web.fetch', { url: 'https://example.com/page' });
  assert.equal(result.ok, true);
  assert.equal(result.data.text, 'hello world');
});

test('agent.delegate child tool budget is independent of parent usage', async (t) => {
  const db = tempDb(t);
  db.saveAiSettings({
    ...db.getAiSettings(),
    agentMaxRounds: 4,
    agentDelegateMaxRounds: 2,
  });
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let parentDelegated = false;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ messages }) {
        const inChild = (messages || []).some(item => typeof item.content === 'string' && item.content.includes('耗尽预算'));
        if (inChild) {
          return {
            text: '',
            toolCalls: Array.from({ length: 5 }, (_, index) => ({
              name: 'task.list',
              arguments: { note: String(index) },
            })),
          };
        }
        if (parentDelegated) {
          return { text: '预算测试完成', toolCalls: [] };
        }
        parentDelegated = true;
        return {
          text: '',
          toolCalls: [
            ...Array.from({ length: 6 }, (_, index) => ({ name: 'task.list', arguments: { parent: String(index) } })),
            { name: 'agent.delegate', arguments: { prompt: '耗尽预算', title: '预算子任务' } },
          ],
        };
      },
    },
  });
  const session = store.createSession('delegate-budget');
  const run = await runtime.start({ session, goal: '预算测试', userMessage: '预算测试' });
  let live = await waitForRun(store, run.id, 1200);
  while (live?.status === 'waiting_approval' && (live.pendingApprovals || []).length) {
    await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
    live = await waitForRun(store, run.id, 1200);
  }
  assert.ok((live.toolCalls || 0) >= 6);
  const child = store.listChildRuns(run.id).at(-1);
  assert.ok(child);
  assert.equal(child.maxRoundsOverride, 2);
  const failedChild = await waitForRun(store, child.id, 1200);
  assert.equal(failedChild.status, 'failed');
  assert.equal(failedChild.error, 'Tool call limit exceeded');
  assert.equal((failedChild.toolCalls || 0) <= 4, true);
});

test('session API includes delegate run traces nested under parent run', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let parentDelegated = false;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ messages }) {
        const inChild = (messages || []).some(item => typeof item.content === 'string' && item.content.includes('列出待办'));
        if (inChild) {
          return { text: '', toolCalls: [{ name: 'task.list', arguments: {} }] };
        }
        if (parentDelegated) {
          return { text: '父任务完成', toolCalls: [] };
        }
        parentDelegated = true;
        return {
          text: '',
          toolCalls: [{ name: 'agent.delegate', arguments: { prompt: '列出待办', title: '待办子任务' } }],
        };
      },
    },
  });
  const session = store.createSession('delegate-trace');
  const run = await runtime.start({ session, goal: 'trace', userMessage: 'trace' });
  let live = await waitForRun(store, run.id, 1200);
  while (live?.status === 'waiting_approval' && (live.pendingApprovals || []).length) {
    await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
    live = await waitForRun(store, run.id, 2000);
  }
  assert.equal(live.status, 'completed');
  const child = store.listChildRuns(run.id)[0];
  assert.ok(child);
  assert.equal(child.delegateTitle, '待办子任务');

  const app = express();
  registerAgentRoutes(app, { db, hasDiaryAccess: () => false });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/sessions/${encodeURIComponent(session.id)}`);
  const data = await response.json();
  assert.equal(data.runs.length, 1);
  assert.equal(Array.isArray(data.runs[0].delegateRuns), true);
  assert.equal(data.runs[0].delegateRuns[0].id, child.id);
  assert.equal(data.runs[0].delegateRuns[0].delegateTitle, '待办子任务');
  assert.ok(data.runs[0].delegateRuns[0].trace.length >= 1);
});

test('trace lines include delegate lifecycle labels', () => {
  const { traceLinesFromEvents } = require('../lib/agent/trace');
  assert.deepEqual(traceLinesFromEvents([
    { type: 'delegate.started', payload: { delegateTitle: '整理笔记' } },
    { type: 'delegate.completed', payload: { delegateTitle: '整理笔记' } },
  ]), ['已委派子任务「整理笔记」', '子任务「整理笔记」已完成']);
});

test('resolveAgentSettings clamps defaults and enforces max limits', () => {
  const { resolveAgentSettings } = require('../lib/agent/agent-settings');
  const resolved = resolveAgentSettings({
    agentDelegateMaxRounds: 12,
    agentKnowledgeSearchLimit: 80,
    agentKnowledgeSearchMaxLimit: 60,
    agentKnowledgeListLimit: 120,
    agentKnowledgeListMaxLimit: 100,
    agentMemorySearchLimit: 50,
    agentMemorySearchMaxLimit: 40,
    agentMemoryListLimit: 120,
    agentMemoryListMaxLimit: 100,
  });
  assert.equal(resolved.agentDelegateMaxRounds, 12);
  assert.equal(resolved.agentKnowledgeSearchLimit, 60);
  assert.equal(resolved.agentKnowledgeSearchMaxLimit, 60);
  assert.equal(resolved.agentKnowledgeListLimit, 100);
  assert.equal(resolved.agentMemorySearchLimit, 40);
  assert.equal(resolved.agentMemoryListLimit, 100);
});

test('agentDelegateMaxRounds setting caps child delegate run rounds', async (t) => {
  const db = tempDb(t);
  db.saveAiSettings({ ...db.getAiSettings(), agentDelegateMaxRounds: 2, agentMaxRounds: 12 });
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let parentDelegated = false;
  let childRounds = 0;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ messages }) {
        const inChild = (messages || []).some(item => typeof item.content === 'string' && item.content.includes('两轮子任务'));
        if (inChild) {
          childRounds += 1;
          return { text: '', toolCalls: [{ name: 'task.list', arguments: {} }] };
        }
        if (parentDelegated) return { text: '完成', toolCalls: [] };
        parentDelegated = true;
        return {
          text: '',
          toolCalls: [{ name: 'agent.delegate', arguments: { prompt: '两轮子任务', title: '短子任务' } }],
        };
      },
    },
  });
  const session = store.createSession('delegate-round-cap');
  const run = await runtime.start({ session, goal: '轮数', userMessage: '轮数' });
  let live = await waitForRun(store, run.id, 1200);
  while (live?.status === 'waiting_approval' && (live.pendingApprovals || []).length) {
    await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
    live = await waitForRun(store, run.id, 2000);
  }
  const child = store.listChildRuns(run.id).at(-1);
  assert.ok(child);
  assert.equal(child.maxRoundsOverride, 2);
  assert.equal(childRounds, 2);
});

test('rejecting delegated approval restores parent run to running while child continues', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let parentDelegated = false;
  let releaseChild = null;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ messages }) {
        const inChild = (messages || []).some(item => typeof item.content === 'string' && item.content.includes('拒绝后续'));
        if (inChild) {
          const rejected = (messages || []).some(item => item.role === 'tool' && String(item.content).includes('User rejected'));
          if (!rejected) {
            return { text: '', toolCalls: [{ name: 'task.create', arguments: { title: '先被拒绝' } }] };
          }
          if (!releaseChild) {
            await new Promise(resolve => { releaseChild = resolve; });
          }
          return { text: '子任务在拒绝后继续', toolCalls: [] };
        }
        if (parentDelegated) return { text: '父任务完成', toolCalls: [] };
        parentDelegated = true;
        return {
          text: '',
          toolCalls: [{ name: 'agent.delegate', arguments: { prompt: '拒绝后续', title: '写待办' } }],
        };
      },
    },
  });
  const session = store.createSession('delegate-reject-resume');
  const run = await runtime.start({ session, goal: '拒绝恢复', userMessage: '拒绝恢复' });
  let live = await waitForRun(store, run.id, 1200);
  while (live?.status === 'waiting_approval' && live.pendingApprovals?.[0]?.call?.name === 'agent.delegate') {
    await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
    live = await waitForRun(store, run.id, 1200);
  }
  assert.equal(live.status, 'waiting_approval');
  const approvalPromise = runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: false });
  await new Promise(resolve => setTimeout(resolve, 30));
  live = store.getRun(run.id);
  assert.equal(live.status, 'running');
  assert.equal((live.pendingApprovals || []).length, 0);
  assert.ok(live.events.some(item => item.type === 'delegate.progress'));
  releaseChild?.();
  await approvalPromise;
  live = await waitForRun(store, run.id, 2000);
  assert.equal(live.status, 'completed');
});

test('delegated memory.propose bubbles proposal event to parent run', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  let parentDelegated = false;
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete({ messages }) {
        const inChild = (messages || []).some(item => typeof item.content === 'string' && item.content.includes('记忆提案'));
        if (inChild) {
          return {
            text: '',
            toolCalls: [{
              name: 'memory.propose',
              arguments: {
                title: '写作偏好',
                content: '周报用简洁中文',
                layer: 'L2',
                evidence: [{ type: 'run', id: 'delegate-memory' }],
              },
            }],
          };
        }
        if (parentDelegated) return { text: '完成', toolCalls: [] };
        parentDelegated = true;
        return {
          text: '',
          toolCalls: [{ name: 'agent.delegate', arguments: { prompt: '记忆提案', title: '整理记忆' } }],
        };
      },
    },
  });
  const session = store.createSession('delegate-memory');
  const run = await runtime.start({ session, goal: 'memory', userMessage: 'memory' });
  let live = await waitForRun(store, run.id, 1200);
  await runtime.resolveApproval(run.id, live.pendingApprovals[0].id, { approved: true });
  live = await waitForRun(store, run.id, 2000);
  const bubbled = live.events.find(item => item.type === 'memory.proposed' && item.payload?.delegated);
  assert.ok(bubbled);
  assert.equal(bubbled.payload.delegateTitle, '整理记忆');
  assert.ok(bubbled.payload.id || bubbled.payload.proposal?.id);
});

test('listSessionSummaries includes activeRun for in-progress runs', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const session = store.createSession('active');
  store.saveRun({
    id: 'run-active',
    sessionId: session.id,
    status: 'waiting_approval',
    createdAt: Date.now(),
  });
  const summary = store.listSessionSummaries().find(item => item.id === session.id);
  assert.deepEqual(summary.activeRun, { id: 'run-active', status: 'waiting_approval' });
});

test('runtime.start rejects a second active run for the same session', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const memory = createMemoryService(store);
  const runtime = createRuntime({
    db,
    store,
    memory,
    hasDiaryAccessFlag: false,
    modelClient: {
      async complete() {
        return { text: '', toolCalls: [{ name: 'task.create', arguments: { title: 'hang' } }] };
      },
    },
  });
  const session = store.createSession('parallel-guard');
  const first = await runtime.start({ session, goal: 'first', userMessage: 'first' });
  assert.ok(first.id);
  await waitForRun(store, first.id, 800);
  assert.equal(store.getRun(first.id).status, 'waiting_approval');
  const second = await runtime.start({
    session: store.getSession(session.id),
    goal: 'second',
    userMessage: 'second',
  });
  assert.equal(second.error, 'Session already has an active run');
  assert.equal(second.status, 409);
});

test('agent messages API allows parallel runs across sessions but not within one session', async (t) => {
  const db = tempDb(t);
  const store = createAgentStore(db);
  const sessionA = store.createSession('session-a');
  const sessionB = store.createSession('session-b');
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, {
    db,
    hasDiaryAccess: () => false,
    agentStatusFor: async () => ({ configured: true, provider: 'test', model: 'stub' }),
    modelClientFor: async () => ({
      async complete() {
        return { text: '', toolCalls: [{ name: 'task.create', arguments: { title: 'hang' } }] };
      },
    }),
  });
  const server = await new Promise(resolve => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const postMessage = (sessionId, content) => fetch(`${base}/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  const firstA = await postMessage(sessionA.id, 'run a');
  assert.equal(firstA.status, 202);
  const bodyA = await firstA.json();
  await waitForRun(store, bodyA.runId, 800);
  assert.equal(store.getRun(bodyA.runId).status, 'waiting_approval');

  const duplicateA = await postMessage(sessionA.id, 'run a again');
  assert.equal(duplicateA.status, 409);
  assert.match((await duplicateA.json()).error, /active run/i);

  const firstB = await postMessage(sessionB.id, 'run b');
  assert.equal(firstB.status, 202);
  const bodyB = await firstB.json();
  await waitForRun(store, bodyB.runId, 800);
  assert.equal(store.getRun(bodyB.runId).status, 'waiting_approval');

  const listed = await fetch(`${base}/api/agent/sessions`);
  assert.equal(listed.status, 200);
  const summaries = (await listed.json()).sessions;
  const summaryA = summaries.find(item => item.id === sessionA.id);
  const summaryB = summaries.find(item => item.id === sessionB.id);
  assert.deepEqual(summaryA.activeRun, { id: bodyA.runId, status: 'waiting_approval' });
  assert.deepEqual(summaryB.activeRun, { id: bodyB.runId, status: 'waiting_approval' });
});

test('workbench tracks per-session runs for parallel agent sessions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'workbench.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'workbench.css'), 'utf8');
  assert.match(source, /sessionRuns:\s*new Map\(\)/);
  assert.match(source, /function subscribeRun\(sessionId,\s*runId/);
  assert.match(source, /function handleRunEvent\(sessionId,\s*event\)/);
  assert.match(source, /function activeRunState\(\)/);
  assert.match(source, /function updateSessionRunBadge/);
  assert.match(source, /MAX_PARALLEL_SESSION_SSE/);
  assert.match(source, /sessionMessagesFingerprint/);
  assert.match(source, /session-run-badge/);
  assert.match(styles, /\.session-run-badge/);
  assert.match(source, /BLOCKING_RUN_STATES\.has\(activeRunState\(\)\?\.status/);
  assert.doesNotMatch(source, /function setSessionRunStatus[\s\S]{0,500}renderSessions\(\)/);
});
