const crypto = require('crypto');
const { EventEmitter } = require('events');
const { requiresConfirmation, isAuto, definitions, fromProviderName, computerToolAvailability } = require('./tools');
const { createToolAdapters } = require('./adapters');
const { messagesWithMentionContext } = require('./mentions');
const { serviceFor } = require('../knowledge/routes');
const { buildMemoryRefreshUserMessage } = require('./memory');
const { resolveMemorySettings } = require('./memory-settings');

const MAX_ROUNDS = 12;
const MAX_TOOL_CALLS = 24;
const MAX_FAILS = 3;
const READ_CONCURRENCY = 4;
const MIN_MAX_ROUNDS = 4;
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);

const EVENT_TYPES = [
  'run.started', 'assistant.delta', 'tool.proposed', 'approval.required',
  'tool.started', 'tool.completed', 'checkpoint.updated', 'client_tool.requested',
  'memory.proposed', 'run.completed', 'run.failed',
];

function clampMaxRounds(value, fallback = MAX_ROUNDS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_MAX_ROUNDS, Math.round(n));
}

function parseActionEnvelope(text) {
  const match = String(text || '').match(/\{[\s\S]*"action"\s*:\s*"(tool|final|ask)"[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function appendGeneratedImageMarkdown(text, messages) {
  let next = String(text || '');
  for (const message of messages || []) {
    if (message.role !== 'tool') continue;
    let parsed;
    try { parsed = JSON.parse(message.content); } catch { continue; }
    const url = parsed?.data?.url;
    if (typeof url !== 'string' || !url.startsWith('/uploads/') || next.includes(url)) continue;
    const markdown = typeof parsed?.data?.markdown === 'string' && parsed.data.markdown.includes(url)
      ? parsed.data.markdown
      : `![生成图片](${url})`;
    next = `${next}${next ? '\n\n' : ''}${markdown}`;
  }
  return next;
}

function createRuntime({ db, store, memory, modelClient, knowledgeSearch, hasDiaryAccessFlag, webSearch, westockRun, imageGenerate, computer, chrome }) {
  const emitters = new Map();
  const liveRuns = new Map();
  const adapters = createToolAdapters({
    db, knowledgeSearch, hasDiaryAccessFlag, webSearch, westockRun, imageGenerate, computer, chrome, memory,
  });

  function computerAvailable() {
    if (!computer) return false;
    if (typeof computer.available === 'function') return Boolean(computer.available());
    return true;
  }

  function toolsForRun(run) {
    if (run?.kind === 'memory_refresh') {
      return definitions().filter(tool => tool.name === 'memory.propose');
    }
    return definitions(computerToolAvailability(computerAvailable()));
  }

  function saveSessionCheckpoint(run) {
    const session = store.getSession(run.sessionId);
    if (!session) return;
    store.saveSession({
      ...session,
      checkpoint: run.checkpoint,
      messages: run.messages.slice(-40),
    });
  }

  function emitterFor(runId) {
    if (!emitters.has(runId)) emitters.set(runId, new EventEmitter());
    return emitters.get(runId);
  }

  function emit(run, type, payload) {
    const event = { type, at: Date.now(), payload };
    run.events.push(event);
    store.saveRun(run);
    emitterFor(run.id).emit('event', event);
    return event;
  }

  function attach(runId, listener) {
    const run = liveRuns.get(runId) || store.getRun(runId);
    if (!run) return () => {};
    for (const event of run.events || []) listener(event);
    const bus = emitterFor(runId);
    bus.on('event', listener);
    return () => bus.off('event', listener);
  }

  function memorySettings() {
    try {
      return resolveMemorySettings(db.getAiSettings?.() || {});
    } catch {
      return resolveMemorySettings({});
    }
  }

  function runLimits(run) {
    if (run?.kind === 'memory_refresh') {
      const maxRounds = memorySettings().memoryRefreshMaxRounds;
      return { maxRounds, maxToolCalls: maxRounds * 2 };
    }
    let maxRounds = MAX_ROUNDS;
    try {
      maxRounds = clampMaxRounds(db.getAiSettings?.()?.agentMaxRounds, MAX_ROUNDS);
    } catch {
      maxRounds = MAX_ROUNDS;
    }
    return { maxRounds, maxToolCalls: maxRounds * 2 };
  }

  async function executeOne(run, call) {
    emit(run, 'tool.started', call);
    const args = { ...(call.arguments || {}) };
    if (run.kind === 'memory_refresh' && call.name === 'memory.propose') {
      if (!Array.isArray(args.evidence) || !args.evidence.length) {
        args.evidence = [{ type: 'refresh', runId: run.id }];
      }
      args.runId = args.runId || run.id;
    }
    const result = await adapters.execute(call.name, args);
    if (call.name === 'memory.propose' && result?.ok) {
      run.memoryProposals = Number(run.memoryProposals || 0) + 1;
      emit(run, 'memory.proposed', result.data);
    }
    if (result?.clientTool) {
      run.status = 'waiting_client_tool';
      run.pendingClientTool = { id: crypto.randomUUID(), call, request: result.request };
      emit(run, 'client_tool.requested', run.pendingClientTool);
      store.saveRun(run);
      return { call, result, waitingClient: true };
    }
    emit(run, 'tool.completed', { call, result });
    return { call, result, waitingClient: false };
  }

  async function executeTools(run, calls) {
    const auto = [];
    const pending = [];
    for (const call of calls) {
      if (requiresConfirmation(call.name) || call.name.startsWith('browser.') && !['browser.scan', 'browser.screenshot'].includes(call.name)) {
        pending.push(call);
      } else if (isAuto(call.name)) {
        auto.push(call);
      } else {
        pending.push(call);
      }
    }
    const results = [];
    for (let i = 0; i < auto.length; i += READ_CONCURRENCY) {
      const batch = auto.slice(i, i + READ_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(call => executeOne(run, call)));
      results.push(...batchResults);
      if (batchResults.some(item => item.waitingClient)) return results;
    }
    if (pending.length) {
      run.status = 'waiting_approval';
      run.pendingApprovals = pending.map(call => ({
        id: crypto.randomUUID(),
        call,
      }));
      emit(run, 'approval.required', { approvals: run.pendingApprovals });
      store.saveRun(run);
    }
    return results;
  }

  async function loop(run) {
    run.status = 'running';
    emit(run, 'run.started', { goal: run.goal });
    let fails = 0;
    run.round = Number(run.round) || 0;
    run.toolCalls = Number(run.toolCalls) || 0;
    const limits = runLimits(run);
    for (; run.round < limits.maxRounds;) {
      run.round += 1;
      if (run.status === 'cancelled') return run;
      const memories = memory.contextBlocks();
      const knowledge = knowledgeSearch?.knowledge || serviceFor(db).knowledge;
      const diaryUnlocked = typeof hasDiaryAccessFlag === 'function' ? Boolean(hasDiaryAccessFlag()) : Boolean(hasDiaryAccessFlag);
      const tools = toolsForRun(run);
      const modelResult = await modelClient.complete({
        goal: run.goal,
        checkpoint: run.checkpoint,
        memories,
        messages: messagesWithMentionContext(run.messages, { knowledge, db, diaryUnlocked }),
        tools,
      });
      if (modelResult.delta) emit(run, 'assistant.delta', { text: modelResult.delta });
      const envelope = parseActionEnvelope(modelResult.text);
      const proposedCalls = Array.isArray(modelResult.toolCalls) && modelResult.toolCalls.length
        ? modelResult.toolCalls
        : (Array.isArray(envelope?.tools) ? envelope.tools : []);
      let calls = proposedCalls
        .filter(call => call && typeof call === 'object' && typeof call.name === 'string' && call.name.length <= 80)
        .map(call => ({ ...call, name: fromProviderName(call.name, tools) }));
      if (run.kind === 'memory_refresh') {
        const remaining = Math.max(0, memorySettings().memoryRefreshMaxProposals - Number(run.memoryProposals || 0));
        calls = calls.filter(call => call.name === 'memory.propose').slice(0, remaining);
      }
      if (!calls.length) {
        run.status = 'completed';
        const envelope = parseActionEnvelope(modelResult.text);
        run.finalText = appendGeneratedImageMarkdown(envelope?.answer || modelResult.text || '', run.messages);
        run.citations = Array.isArray(modelResult.citations)
          ? modelResult.citations.slice(0, 8)
          : (Array.isArray(envelope?.citations) ? envelope.citations.slice(0, 8) : []);
        run.messages.push({ role: 'assistant', content: run.finalText });
        run.checkpoint = { ...run.checkpoint, next: 'complete', completed: true };
        saveSessionCheckpoint(run);
        emit(run, 'run.completed', { text: run.finalText, citations: run.citations });
        store.saveRun(run);
        return run;
      }
      if (run.toolCalls + calls.length > limits.maxToolCalls) {
        run.status = 'failed';
        run.error = 'Tool call limit exceeded';
        saveSessionCheckpoint(run);
        emit(run, 'run.failed', { error: run.error });
        store.saveRun(run);
        return run;
      }
      emit(run, 'tool.proposed', { calls });
      const executed = await executeTools(run, calls.slice(0, limits.maxToolCalls - run.toolCalls));
      run.toolCalls += executed.length;
      for (const item of executed) {
        run.messages.push({ role: 'tool', name: item.call.name, content: JSON.stringify(item.result) });
        if (!item.result.ok) fails += 1;
        else fails = 0;
      }
      if (fails >= MAX_FAILS) {
        run.status = 'waiting_approval';
        emit(run, 'approval.required', { reason: 'Repeated tool failure', askUser: true });
        store.saveRun(run);
        return run;
      }
      if (run.status === 'waiting_approval' || run.status === 'waiting_client_tool') {
        store.saveRun(run);
        return run;
      }
      run.checkpoint = {
        goal: run.goal,
        verified: executed.filter(item => item.result.ok).map(item => item.result.summary),
        failed: fails,
        next: 'continue',
      };
      saveSessionCheckpoint(run);
      emit(run, 'checkpoint.updated', run.checkpoint);
    }
    run.status = 'failed';
    run.error = 'Round limit exceeded';
    saveSessionCheckpoint(run);
    emit(run, 'run.failed', { error: run.error });
    store.saveRun(run);
    return run;
  }

  async function start({ session, goal, userMessage }) {
    const run = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      goal: String(goal || userMessage || '').slice(0, 2000),
      status: 'queued',
      messages: [...(session.messages || []), { role: 'user', content: userMessage }],
      events: [],
      checkpoint: session.checkpoint || { goal: userMessage, verified: [], failed: 0, next: 'start' },
      pendingApprovals: [],
      round: 0,
      toolCalls: 0,
      createdAt: Date.now(),
    };
    liveRuns.set(run.id, run);
    store.saveSession({ ...session, messages: run.messages });
    store.saveRun(run);
    queueMicrotask(() => loop(run).catch(err => {
      run.status = 'failed';
      run.error = err.message;
      emit(run, 'run.failed', { error: err.message });
    }));
    return run;
  }

  async function startMemoryRefresh() {
    for (const live of liveRuns.values()) {
      if (live.kind === 'memory_refresh' && ACTIVE_RUN_STATUSES.has(live.status)) {
        return { error: 'Memory refresh already running', status: 409 };
      }
    }
    const run = {
      id: crypto.randomUUID(),
      sessionId: '',
      kind: 'memory_refresh',
      goal: '根据近期对话提出长期记忆更新草稿',
      status: 'queued',
      messages: [{ role: 'user', content: buildMemoryRefreshUserMessage(store, memory, memorySettings()) }],
      events: [],
      checkpoint: { goal: 'memory refresh', verified: [], failed: 0, next: 'start' },
      pendingApprovals: [],
      round: 0,
      toolCalls: 0,
      memoryProposals: 0,
      createdAt: Date.now(),
    };
    liveRuns.set(run.id, run);
    store.saveRun(run);
    queueMicrotask(() => loop(run).catch(err => {
      run.status = 'failed';
      run.error = err.message;
      emit(run, 'run.failed', { error: err.message });
    }));
    return { run };
  }

  async function resolveApproval(runId, approvalId, { approved, modelClient: nextClient }) {
    const run = liveRuns.get(runId) || store.getRun(runId);
    if (!run) return { error: 'Run not found' };
    const approval = (run.pendingApprovals || []).find(item => item.id === approvalId);
    if (!approval) return { error: 'Approval not found' };
    run.pendingApprovals = (run.pendingApprovals || []).filter(item => item.id !== approvalId);
    if (approved) {
      const { result, waitingClient } = await executeOne(run, approval.call);
      run.messages.push({ role: 'tool', name: approval.call.name, content: JSON.stringify(result) });
      if (waitingClient) {
        store.saveRun(run);
        return { run };
      }
    } else {
      run.messages.push({ role: 'tool', name: approval.call.name, content: JSON.stringify({ ok: false, summary: 'User rejected the action' }) });
    }
    if (!(run.pendingApprovals || []).length) {
      run.status = 'running';
      store.saveRun(run);
      await loop(run);
    } else {
      store.saveRun(run);
    }
    return { run };
  }

  function cancel(runId) {
    const run = liveRuns.get(runId) || store.getRun(runId);
    if (!run) return { error: 'Run not found' };
    run.status = 'cancelled';
    emit(run, 'run.failed', { error: 'cancelled' });
    store.saveRun(run);
    return { run };
  }

  function clientToolResult(runId, requestId, result) {
    const run = liveRuns.get(runId) || store.getRun(runId);
    if (!run) return { error: 'Run not found' };
    if (!run.pendingClientTool || run.pendingClientTool.id !== requestId) return { error: 'Client tool request not found' };
    emit(run, 'tool.completed', { requestId, result });
    run.messages.push({ role: 'tool', name: 'browser', content: JSON.stringify(result) });
    run.pendingClientTool = null;
    run.status = 'running';
    store.saveRun(run);
    queueMicrotask(() => loop(run));
    return { run };
  }

  return { start, startMemoryRefresh, attach, resolveApproval, cancel, clientToolResult, EVENT_TYPES };
}

module.exports = { createRuntime, parseActionEnvelope, MAX_ROUNDS, MAX_TOOL_CALLS, clampMaxRounds };
