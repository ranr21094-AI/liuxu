const crypto = require('crypto');
const { EventEmitter } = require('events');
const { requiresConfirmation, isAuto, definitions, fromProviderName, computerToolAvailability, toolResult } = require('./tools');
const { createToolAdapters } = require('./adapters');
const { messagesWithMentionContext } = require('./mentions');
const { serviceFor } = require('../knowledge/routes');
const { buildMemoryRefreshUserMessage } = require('./memory');
const { resolveMemorySettings } = require('./memory-settings');
const { resolveAgentSettings } = require('./agent-settings');
const {
  validateWriteToolCall,
  findExistingMutation,
  duplicateInRunResult,
  mutationFingerprint,
  recordMutationAttempt,
  recordMutationSuccess,
  validateCheckpointUpdate,
  shouldPauseForRepeatedMutations,
} = require('./guards');
const {
  webSearchFingerprint,
  lookupWebSearchCacheForCall,
  reserveWebSearchPending,
  recordWebSearchSuccess,
  cloneCachedResult,
  seedRunWebSearchCache,
  clearWebSearchPending,
} = require('./web-search-cache');
const MAX_ROUNDS = 12;
const MIN_MAX_ROUNDS = 4;
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);
const WAITING_STATUSES = new Set(['waiting_approval', 'waiting_client_tool', 'waiting_user']);
const SESSION_ACTIVE_RUN_STATUSES = new Set([...ACTIVE_RUN_STATUSES, ...WAITING_STATUSES]);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const EVENT_TYPES = [
  'run.started', 'assistant.delta', 'tool.proposed', 'approval.required',
  'tool.started', 'tool.completed', 'checkpoint.updated', 'client_tool.requested',
  'user_input.required', 'memory.proposed', 'delegate.started', 'delegate.completed', 'delegate.progress',
  'note.edit_proposed',
  'run.completed', 'run.failed',
];
const CHECKPOINT_VERIFIED_LIMIT = 20;
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
function mergeVerified(existing, additions = []) {
  return [...new Set([
    ...(Array.isArray(existing) ? existing : []),
    ...additions.map(item => String(item || '').trim()).filter(Boolean),
  ])].slice(-CHECKPOINT_VERIFIED_LIMIT);
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
function createRuntime({ db, store, memory, modelClient, knowledgeSearch, hasDiaryAccessFlag, webSearch, webFetch, westockRun, imageGenerate, computer, chrome }) {
  const emitters = new Map();
  const liveRuns = new Map();
  const adapters = createToolAdapters({
    db, knowledgeSearch, hasDiaryAccessFlag, webSearch, webFetch, westockRun, imageGenerate, computer, chrome, memory,
    agentSettingsFor: () => agentSettings(),
  });
  function findRun(runId) {
    if (!runId) return null;
    let run = liveRuns.get(runId) || store.getRun(runId);
    // Terminal runs are served from the store; caching them again would
    // re-grow the live map this runtime works hard to keep bounded.
    if (run && !TERMINAL_RUN_STATUSES.has(run.status)) liveRuns.set(run.id, run);
    return run || null;
  }
  function pruneRunIfTerminal(run) {
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) return;
    liveRuns.delete(run.id);
    emitters.delete(run.id);
  }
  function findActiveRunForSession(sessionId) {
    const id = String(sessionId || '');
    if (!id) return null;
    for (const run of liveRuns.values()) {
      if (run.sessionId === id && run.kind !== 'memory_refresh' && SESSION_ACTIVE_RUN_STATUSES.has(run.status)) {
        return run;
      }
    }
    return store.listRunsForSession(id).slice().reverse().find(item => SESSION_ACTIVE_RUN_STATUSES.has(item.status)) || null;
  }
  function computerAvailable() {
    if (!computer) return false;
    if (typeof computer.available === 'function') return Boolean(computer.available());
    return true;
  }
  function toolsForRun(run) {
    if (run?.kind === 'memory_refresh') {
      return definitions().filter(tool => tool.name === 'memory.propose');
    }
    if (run?.kind === 'note_assist') {
      const allowed = new Set(['note.read', 'note.propose_edit', 'knowledge.read', 'knowledge.search', 'knowledge.list']);
      return definitions().filter(tool => allowed.has(tool.name));
    }
    const available = computerToolAvailability(computerAvailable());
    if ((run?.depth || 0) >= 1 || run?.kind === 'delegate') {
      available['agent.delegate'] = false;
    }
    return definitions(available);
  }
  function saveSessionCheckpoint(run) {
    if (!run.sessionId) return;
    const session = store.getSession(run.sessionId);
    if (!session) return;
    store.saveSession({
      ...session,
      checkpoint: run.checkpoint,
      messages: run.messages.slice(-40),
    });
  }
  function applyCheckpointFromTool(run, args = {}) {
    const blocked = validateCheckpointUpdate(run, args, db);
    if (blocked) return blocked;
    const next = typeof args.next === 'string' ? args.next.trim().slice(0, 500) : '';
    const notes = typeof args.notes === 'string' ? args.notes.trim().slice(0, 500) : '';
    const verified = mergeVerified(run.checkpoint?.verified, args.verified);
    run.checkpoint = {
      ...(run.checkpoint || {}),
      goal: run.goal,
      ...(next ? { next } : {}),
      ...(notes ? { notes } : {}),
      verified,
      updatedAt: Date.now(),
    };
    saveSessionCheckpoint(run);
    emit(run, 'checkpoint.updated', run.checkpoint);
    return toolResult({
      ok: true,
      summary: next || notes || 'Working checkpoint updated',
      data: run.checkpoint,
      evidence: [{ type: 'checkpoint' }],
    });
  }
  function pauseForUserInput(run, question, call = null) {
    if (run.status === 'cancelled') {
      return toolResult({ ok: false, summary: 'Run cancelled', errorCode: 'cancelled' });
    }
    const text = String(question || '').trim();
    run.status = 'waiting_user';
    run.pendingQuestion = text;
    const result = toolResult({ ok: true, summary: text, data: { question: text }, evidence: [] });
    if (call) emit(run, 'tool.completed', { call, result });
    emit(run, 'user_input.required', { question: text, runId: run.id });
    store.saveRun(run);
    return result;
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
  function approvalQueueMeta(run) {
    const pending = Array.isArray(run?.pendingApprovals) ? run.pendingApprovals : [];
    const queued = Array.isArray(run?.queuedApprovals) ? run.queuedApprovals : [];
    const fallbackTotal = pending.length + queued.length;
    const queueTotal = Number(run?.approvalQueueTotal) || fallbackTotal;
    const queueIndex = Number(run?.approvalQueueIndex)
      || (queueTotal ? queueTotal - queued.length : 0);
    return { queueTotal, queueIndex };
  }
  function enqueueApprovals(run, calls) {
    if (run.status === 'cancelled') return false;
    const items = (Array.isArray(calls) ? calls : []).map(call => ({
      id: crypto.randomUUID(),
      call,
    }));
    run.pendingApprovals = items.length ? [items[0]] : [];
    run.queuedApprovals = items.slice(1);
    run.approvalQueueTotal = items.length;
    run.approvalQueueIndex = items.length ? 1 : 0;
    run.status = 'waiting_approval';
    return true;
  }
  function emitApprovalRequired(run, extra = {}) {
    const { queueTotal, queueIndex } = approvalQueueMeta(run);
    emit(run, 'approval.required', {
      approvals: run.pendingApprovals || [],
      queueTotal,
      queueIndex,
      ...extra,
    });
  }
  function promoteNextApproval(run) {
    run.pendingApprovals = [];
    if (!(run.queuedApprovals || []).length) return false;
    const next = run.queuedApprovals.shift();
    run.pendingApprovals = [next];
    run.approvalQueueIndex = (Number(run.approvalQueueIndex) || 0) + 1;
    run.status = 'waiting_approval';
    return true;
  }
  function attach(runId, listener) {
    const run = findRun(runId);
    if (!run) return () => {};
    for (const event of run.events || []) {
      if (event.type === 'approval.required') continue;
      listener(event);
    }
    if (run.status === 'waiting_approval') {
      const pending = run.pendingApprovals || [];
      const queued = run.queuedApprovals || [];
      if (pending.length || queued.length) {
        const child = pending[0]?.delegatedRunId ? findRun(pending[0].delegatedRunId) : null;
        const meta = child ? approvalQueueMeta(child) : approvalQueueMeta(run);
        listener({
          type: 'approval.required',
          at: Date.now(),
          payload: {
            approvals: pending,
            queueTotal: meta.queueTotal,
            queueIndex: meta.queueIndex,
            delegated: Boolean(pending[0]?.delegatedRunId),
            delegateTitle: pending[0]?.delegateTitle || run.delegateTitle || '',
            replay: true,
          },
        });
      }
    }
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
  function agentSettings() {
    try {
      return resolveAgentSettings(db.getAiSettings?.() || {});
    } catch {
      return resolveAgentSettings({});
    }
  }
  function runLimits(run) {
    if (run?.kind === 'memory_refresh') {
      const maxRounds = memorySettings().memoryRefreshMaxRounds;
      return { maxRounds, maxToolCalls: maxRounds * 2 };
    }
    if (run?.kind === 'note_assist') {
      return { maxRounds: 8, maxToolCalls: 16 };
    }
    if (run?.kind === 'delegate' || (run?.depth || 0) >= 1) {
      const maxRounds = run?.maxRoundsOverride || agentSettings().agentDelegateMaxRounds;
      return { maxRounds, maxToolCalls: maxRounds * 2 };
    }
    let maxRounds = MAX_ROUNDS;
    try {
      maxRounds = clampMaxRounds(db.getAiSettings?.()?.agentMaxRounds, MAX_ROUNDS);
    } catch {
      maxRounds = MAX_ROUNDS;
    }
    if (run?.maxRoundsOverride) {
      maxRounds = Math.min(maxRounds, run.maxRoundsOverride);
    }
    return { maxRounds, maxToolCalls: maxRounds * 2 };
  }
  function buildDelegateResult(childRun) {
    return toolResult({
      ok: childRun.status === 'completed',
      summary: childRun.finalText || childRun.error || 'Delegate completed',
      data: {
        text: childRun.finalText || '',
        citations: childRun.citations || [],
        roundsUsed: childRun.round || 0,
        toolCallsUsed: childRun.toolCalls || 0,
        status: childRun.status,
        childRunId: childRun.id,
      },
      evidence: (childRun.citations || []).slice(0, 8),
      errorCode: childRun.status === 'failed' ? 'delegate_failed' : '',
    });
  }
  function bubbleWaitingState(childRun, parentRun) {
    // A cancelled parent must not be resurrected by a child reaching a
    // waiting state; persist the child and leave the parent alone.
    if (parentRun.status === 'cancelled') {
      store.saveRun(childRun);
      return;
    }
    parentRun.activeChildRunId = childRun.id;
    parentRun.delegatedRunId = childRun.id;
    parentRun.delegateTitle = childRun.delegateTitle || childRun.goal;
    if (childRun.status === 'waiting_approval') {
      parentRun.status = 'waiting_approval';
      parentRun.pendingApprovals = (childRun.pendingApprovals || []).map(item => ({
        ...item,
        delegatedRunId: childRun.id,
        delegateTitle: childRun.delegateTitle || childRun.goal,
      }));
      parentRun.queuedApprovals = [];
      const { queueTotal, queueIndex } = approvalQueueMeta(childRun);
      emit(parentRun, 'approval.required', {
        approvals: parentRun.pendingApprovals,
        queueTotal,
        queueIndex,
        delegated: true,
        delegateTitle: parentRun.delegateTitle,
      });
    } else if (childRun.status === 'waiting_client_tool') {
      parentRun.status = 'waiting_client_tool';
      parentRun.pendingClientTool = {
        ...childRun.pendingClientTool,
        delegatedRunId: childRun.id,
        delegateTitle: childRun.delegateTitle || childRun.goal,
      };
      emit(parentRun, 'client_tool.requested', parentRun.pendingClientTool);
    } else if (childRun.status === 'waiting_user') {
      parentRun.status = 'waiting_user';
      parentRun.pendingQuestion = childRun.pendingQuestion;
      emit(parentRun, 'user_input.required', {
        question: childRun.pendingQuestion,
        runId: parentRun.id,
        delegatedRunId: childRun.id,
        delegateTitle: parentRun.delegateTitle,
      });
    }
    store.saveRun(parentRun);
    store.saveRun(childRun);
  }
  function restoreParentRunningWhileDelegateContinues(parentRun, childRun) {
    if (!parentRun || !childRun || parentRun.status === 'cancelled') return;
    parentRun.status = 'running';
    parentRun.pendingApprovals = [];
    parentRun.queuedApprovals = [];
    parentRun.pendingClientTool = null;
    parentRun.pendingQuestion = null;
    parentRun.delegatedRunId = null;
    parentRun.activeChildRunId = childRun.id;
    parentRun.delegateTitle = childRun.delegateTitle || childRun.goal || parentRun.delegateTitle || '';
    emit(parentRun, 'delegate.progress', {
      childRunId: childRun.id,
      delegateTitle: parentRun.delegateTitle,
    });
  }
  function bubbleMemoryProposed(childRun, parentRun, payload) {
    if (!childRun || !parentRun || !payload) return;
    emit(parentRun, 'memory.proposed', {
      ...payload,
      delegated: true,
      delegatedRunId: childRun.id,
      delegateTitle: childRun.delegateTitle || childRun.goal || '',
    });
  }
  async function finishDelegateOnParent(parentRun, childRun, delegateCall = null) {
    if (!parentRun || !childRun) return parentRun;
    const result = buildDelegateResult(childRun);
    parentRun.messages.push({
      role: 'tool',
      name: delegateCall?.name || 'agent.delegate',
      content: JSON.stringify(result),
    });
    parentRun.activeChildRunId = null;
    parentRun.delegatedRunId = null;
    parentRun.delegateTitle = null;
    parentRun.pendingApprovals = [];
    parentRun.queuedApprovals = [];
    parentRun.pendingClientTool = null;
    parentRun.pendingQuestion = null;
    if (parentRun.status !== 'cancelled') parentRun.status = 'running';
    store.saveRun(parentRun);
    emit(parentRun, 'delegate.completed', {
      childRunId: childRun.id,
      delegateTitle: childRun.delegateTitle || childRun.goal || '',
      status: childRun.status,
    });
    if (parentRun.status === 'running') await driveRun(parentRun);
    return parentRun;
  }
  async function runDelegate(parentRun, args = {}) {
    if ((parentRun.depth || 0) >= 1) {
      return toolResult({ ok: false, summary: 'Nested delegate is not allowed', errorCode: 'denied' });
    }
    const prompt = String(args.prompt || '').trim();
    if (!prompt) {
      return toolResult({ ok: false, summary: 'prompt is required', errorCode: 'invalid' });
    }
    const requested = Number(args.maxRounds);
    const delegateMaxRounds = agentSettings().agentDelegateMaxRounds;
    const maxRoundsOverride = Math.min(
      delegateMaxRounds,
      Number.isFinite(requested) && requested > 0 ? Math.round(requested) : delegateMaxRounds,
    );
    const context = typeof args.context === 'string' ? args.context.trim() : '';
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 80) : '委派任务';
    const userContent = context ? `${prompt}\n\nContext:\n${context}` : prompt;
    const childRun = {
      id: crypto.randomUUID(),
      sessionId: '',
      parentRunId: parentRun.id,
      kind: 'delegate',
      depth: 1,
      delegateTitle: title,
      goal: prompt.slice(0, 2000),
      status: 'queued',
      messages: [{ role: 'user', content: userContent }],
      events: [],
      checkpoint: { goal: prompt, verified: [], failed: 0, next: 'start' },
      pendingApprovals: [],
      queuedApprovals: [],
      mutationFingerprints: {},
      mutationHistory: [],
      round: 0,
      toolCalls: 0,
      diaryUnlocked: parentRun.diaryUnlocked === true,
      maxRoundsOverride,
      createdAt: Date.now(),
    };
    liveRuns.set(childRun.id, childRun);
    parentRun.activeChildRunId = childRun.id;
    store.saveRun(childRun);
    store.saveRun(parentRun);
    emit(parentRun, 'delegate.started', { childRunId: childRun.id, delegateTitle: title });
    await driveRun(childRun);
    if (WAITING_STATUSES.has(childRun.status) && childRun.parentRunId) {
      const parent = findRun(childRun.parentRunId);
      if (parent) bubbleWaitingState(childRun, parent);
      return { delegateWaiting: true, childRun };
    }
    parentRun.activeChildRunId = null;
    parentRun.delegatedRunId = null;
    return buildDelegateResult(childRun);
  }
  async function executePreflight(run, call) {
    const args = { ...(call.arguments || {}) };
    if (call.name === 'agent.delegate' && (run.depth || 0) >= 1) {
      const result = toolResult({ ok: false, summary: 'Nested delegate is not allowed', errorCode: 'denied' });
      emit(run, 'tool.started', call);
      emit(run, 'tool.completed', { call, result });
      return { call, result, waitingClient: false, waitingUser: false };
    }
    const validationError = validateWriteToolCall(call.name, args, run.goal);
    if (validationError) {
      emit(run, 'tool.started', call);
      emit(run, 'tool.completed', { call, result: validationError });
      return { call, result: validationError, waitingClient: false, waitingUser: false };
    }
    if (call.name === 'web.search') {
      const session = run.sessionId ? store.getSession(run.sessionId) : null;
      const cached = lookupWebSearchCacheForCall(run, session, args);
      if (cached?.entry?.result) {
        const result = cloneCachedResult(cached.entry.result);
        emit(run, 'tool.started', call);
        emit(run, 'tool.completed', { call, result });
        return { call, result, waitingClient: false, waitingUser: false };
      }
    }
    const fingerprint = mutationFingerprint(call.name, args);
    const duplicateResult = duplicateInRunResult(run, fingerprint);
    if (duplicateResult) {
      recordMutationAttempt(run, call.name, args);
      emit(run, 'tool.started', call);
      emit(run, 'tool.completed', { call, result: duplicateResult });
      return { call, result: duplicateResult, waitingClient: false, waitingUser: false };
    }
    const existing = findExistingMutation(db, call.name, args);
    if (existing && ['task.create', 'countdown.create'].includes(call.name)) {
      const result = toolResult({
        ok: true,
        summary: `Already exists (${existing.kind} id ${existing.id})`,
        data: { duplicate: true, existingId: existing.id, ...existing.item },
        evidence: [{ type: existing.kind, id: existing.id }],
      });
      emit(run, 'tool.started', call);
      emit(run, 'tool.completed', { call, result });
      if (!run.mutationFingerprints) run.mutationFingerprints = {};
      run.mutationFingerprints[fingerprint] = { id: existing.id, kind: existing.kind, at: Date.now() };
      return { call, result, waitingClient: false, waitingUser: false };
    }
    return null;
  }
  async function executeOne(run, call) {
    const preflight = await executePreflight(run, call);
    if (preflight) return preflight;
    emit(run, 'tool.started', call);
    const args = { ...(call.arguments || {}) };
    if (run.kind === 'memory_refresh' && call.name === 'memory.propose') {
      if (!Array.isArray(args.evidence) || !args.evidence.length) {
        args.evidence = [{ type: 'refresh', runId: run.id }];
      }
      args.runId = args.runId || run.id;
    }
    if (call.name === 'update_working_checkpoint') {
      const result = applyCheckpointFromTool(run, args);
      emit(run, 'tool.completed', { call, result });
      return { call, result, waitingClient: false, waitingUser: false };
    }
    if (call.name === 'ask_user') {
      const question = String(args.question || '').trim();
      if (!question) {
        const result = toolResult({ ok: false, summary: 'Question is required', errorCode: 'invalid' });
        emit(run, 'tool.completed', { call, result });
        return { call, result, waitingClient: false, waitingUser: false };
      }
      const result = pauseForUserInput(run, question, call);
      return { call, result, waitingClient: false, waitingUser: true };
    }
    if (call.name === 'agent.delegate') {
      const delegateOutcome = await runDelegate(run, args);
      if (delegateOutcome?.delegateWaiting) {
        const result = toolResult({
          ok: true,
          summary: 'Sub-task waiting for user input',
          data: { waiting: true, childRunId: delegateOutcome.childRun?.id },
          evidence: [],
        });
        emit(run, 'tool.completed', { call, result });
        return {
          call,
          result,
          waitingClient: run.status === 'waiting_client_tool',
          waitingUser: run.status === 'waiting_user',
          delegateWaiting: true,
        };
      }
      emit(run, 'tool.completed', { call, result: delegateOutcome });
      return { call, result: delegateOutcome, waitingClient: false, waitingUser: false };
    }
    const result = await adapters.execute(call.name, args, {
      diaryUnlocked: run.diaryUnlocked === true,
      note: run.kind === 'note_assist' && run.noteDocumentId
        ? { documentId: run.noteDocumentId, onProposal: proposal => emitNoteProposal(run, proposal) }
        : null,
    });
    recordMutationAttempt(run, call.name, args);
    recordMutationSuccess(run, call.name, args, result);
    if (call.name === 'web.search') {
      const fingerprint = webSearchFingerprint(args);
      if (result?.ok) {
        const session = run.sessionId ? store.getSession(run.sessionId) : null;
        recordWebSearchSuccess(run, session, store, fingerprint, result);
      } else {
        clearWebSearchPending(run, fingerprint);
      }
    }
    if (call.name === 'memory.propose' && result?.ok) {
      run.memoryProposals = Number(run.memoryProposals || 0) + 1;
      emit(run, 'memory.proposed', result.data);
      if (run.parentRunId) {
        const parent = findRun(run.parentRunId);
        if (parent) bubbleMemoryProposed(run, parent, result.data);
      }
    }
    if (result?.clientTool) {
      run.status = 'waiting_client_tool';
      run.pendingClientTool = { id: crypto.randomUUID(), call, request: result.request };
      emit(run, 'client_tool.requested', run.pendingClientTool);
      scheduleClientToolTimeout(run);
      store.saveRun(run);
      return { call, result, waitingClient: true };
    }
    emit(run, 'tool.completed', { call, result });
    return { call, result, waitingClient: false, waitingUser: false };
  }
  async function executeTools(run, calls) {
    const auto = [];
    const pending = [];
    const preflightResults = [];
    for (const call of calls) {
      const preflight = await executePreflight(run, call);
      if (preflight) {
        preflightResults.push(preflight);
        continue;
      }
      if (requiresConfirmation(call.name) || call.name.startsWith('browser.') && !['browser.scan', 'browser.screenshot'].includes(call.name)) {
        if (call.name === 'web.search') {
          const fingerprint = webSearchFingerprint(call.arguments || {});
          const pendingDuplicate = reserveWebSearchPending(run, fingerprint);
          if (pendingDuplicate) {
            emit(run, 'tool.started', call);
            emit(run, 'tool.completed', { call, result: pendingDuplicate });
            preflightResults.push({ call, result: pendingDuplicate, waitingClient: false, waitingUser: false });
            continue;
          }
        }
        pending.push(call);
      } else if (isAuto(call.name)) {
        auto.push(call);
      } else {
        pending.push(call);
      }
    }
    const results = [...preflightResults];
    const readConcurrency = agentSettings().agentReadConcurrency;
    for (let i = 0; i < auto.length; i += readConcurrency) {
      if (run.status === 'cancelled') break;
      const batch = auto.slice(i, i + readConcurrency);
      const batchResults = await Promise.all(batch.map(call => executeOne(run, call)));
      results.push(...batchResults);
      if (batchResults.some(item => item.waitingClient || item.waitingUser || item.delegateWaiting)) return results;
    }
    if (pending.length && run.status !== 'cancelled') {
      enqueueApprovals(run, pending);
      emitApprovalRequired(run);
      store.saveRun(run);
    }
    return results;
  }
  async function driveRun(run) {
    if (run.status === 'cancelled') {
      pruneRunIfTerminal(run);
      return run;
    }
    run.status = 'running';
    if ((run.round || 0) === 0) emit(run, 'run.started', { goal: run.goal });
    let fails = 0;
    run.round = Number(run.round) || 0;
    run.toolCalls = Number(run.toolCalls) || 0;
    const limits = runLimits(run);
    for (; run.round < limits.maxRounds;) {
      run.round += 1;
      if (run.status === 'cancelled') {
        pruneRunIfTerminal(run);
        return run;
      }
      const memories = run.kind === 'note_assist' ? [] : memory.contextBlocks();
      const knowledge = knowledgeSearch?.knowledge || serviceFor(db).knowledge;
      const diaryUnlocked = run.diaryUnlocked === true;
      const tools = toolsForRun(run);
      const modelResult = await modelClient.complete({
        goal: run.goal,
        checkpoint: run.checkpoint,
        memories,
        messages: messagesWithMentionContext(run.messages, { knowledge, db, diaryUnlocked }),
        tools,
      });
      // The cancel may land while the model call is in flight; dropping the
      // round here keeps already-proposed tools from executing afterwards.
      if (run.status === 'cancelled') {
        pruneRunIfTerminal(run);
        return run;
      }
      if (modelResult.model) run.model = String(modelResult.model);
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
        const finalEnvelope = parseActionEnvelope(modelResult.text);
        if (finalEnvelope?.action === 'ask') {
          const question = String(finalEnvelope.question || finalEnvelope.answer || '').trim();
          if (question) {
            pauseForUserInput(run, question);
            if (run.parentRunId) {
              const parent = findRun(run.parentRunId);
              if (parent) bubbleWaitingState(run, parent);
            }
            return run;
          }
        }
        run.status = 'completed';
        run.finalText = appendGeneratedImageMarkdown(finalEnvelope?.answer || modelResult.text || '', run.messages);
        run.citations = Array.isArray(modelResult.citations)
          ? modelResult.citations.slice(0, 8)
          : (Array.isArray(finalEnvelope?.citations) ? finalEnvelope.citations.slice(0, 8) : []);
        run.messages.push({ role: 'assistant', content: run.finalText });
        run.checkpoint = { ...run.checkpoint, next: 'complete', completed: true };
        saveSessionCheckpoint(run);
        emit(run, 'run.completed', { text: run.finalText, citations: run.citations, model: run.model || '' });
        store.saveRun(run);
        pruneRunIfTerminal(run);
        return run;
      }
      const toolCallsUsed = Number(run.toolCalls) || 0;
      const remainingBudget = limits.maxToolCalls - toolCallsUsed;
      if (remainingBudget <= 0 || calls.length > remainingBudget) {
        run.status = 'failed';
        run.error = 'Tool call limit exceeded';
        saveSessionCheckpoint(run);
        emit(run, 'run.failed', { error: run.error });
        store.saveRun(run);
        pruneRunIfTerminal(run);
        return run;
      }
      emit(run, 'tool.proposed', { calls });
      const executed = await executeTools(run, calls.slice(0, remainingBudget));
      run.toolCalls += executed.length;
      // Cancel may land while tools execute; stop before any further state
      // transitions (approval queue, waiting states, terminal writes).
      if (run.status === 'cancelled') {
        pruneRunIfTerminal(run);
        return run;
      }
      for (const item of executed) {
        if (item.delegateWaiting) continue;
        run.messages.push({ role: 'tool', name: item.call.name, content: JSON.stringify(item.result) });
        if (!item.result.ok) fails += 1;
        else fails = 0;
      }
      const repeatQuestion = shouldPauseForRepeatedMutations(run, agentSettings().agentRepeatMutationLimit);
      if (repeatQuestion) {
        pauseForUserInput(run, repeatQuestion);
        if (run.parentRunId) {
          const parent = findRun(run.parentRunId);
          if (parent) bubbleWaitingState(run, parent);
        }
        return run;
      }
      if (fails >= agentSettings().agentMaxToolFailures) {
        run.status = 'waiting_approval';
        emit(run, 'approval.required', { reason: 'Repeated tool failure', askUser: true });
        store.saveRun(run);
        if (run.parentRunId) {
          const parent = findRun(run.parentRunId);
          if (parent) bubbleWaitingState(run, parent);
        }
        return run;
      }
      if (WAITING_STATUSES.has(run.status)) {
        if (run.parentRunId) {
          const parent = findRun(run.parentRunId);
          if (parent) bubbleWaitingState(run, parent);
        }
        store.saveRun(run);
        return run;
      }
      const autoVerified = executed.filter(item => item.result.ok && !item.delegateWaiting).map(item => item.result.summary);
      run.checkpoint = {
        ...(run.checkpoint || {}),
        goal: run.goal,
        verified: mergeVerified(run.checkpoint?.verified, autoVerified),
        failed: fails,
        next: typeof run.checkpoint?.next === 'string' && run.checkpoint.next && run.checkpoint.next !== 'continue'
          ? run.checkpoint.next
          : 'continue',
        updatedAt: Date.now(),
      };
      saveSessionCheckpoint(run);
      emit(run, 'checkpoint.updated', run.checkpoint);
    }
    run.status = 'failed';
    run.error = 'Round limit exceeded';
    saveSessionCheckpoint(run);
    emit(run, 'run.failed', { error: run.error });
    store.saveRun(run);
    pruneRunIfTerminal(run);
    return run;
  }
  function emitNoteProposal(run, proposal) {
    if (!proposal || !run.noteDocumentId) return;
    emit(run, 'note.edit_proposed', { ...proposal, runId: run.id });
  }

  async function startNoteAssist({ session, documentId, userMessage }) {
    const existing = findActiveRunForSession(session.id);
    if (existing) {
      return { error: 'Session already has an active run', status: 409 };
    }
    const run = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      kind: 'note_assist',
      noteDocumentId: String(documentId || ''),
      goal: String(userMessage || '').slice(0, 2000),
      status: 'queued',
      diaryUnlocked: typeof hasDiaryAccessFlag === 'function' ? Boolean(hasDiaryAccessFlag()) : Boolean(hasDiaryAccessFlag),
      messages: [...(session.messages || []), { role: 'user', content: String(userMessage || '') }],
      events: [],
      checkpoint: session.checkpoint || { goal: userMessage, verified: [], failed: 0, next: 'start' },
      pendingApprovals: [],
      queuedApprovals: [],
      mutationFingerprints: {},
      mutationHistory: [],
      round: 0,
      toolCalls: 0,
      depth: 0,
      createdAt: Date.now(),
    };
    liveRuns.set(run.id, run);
    store.saveSession({ ...session, messages: run.messages });
    store.saveRun(run);
    queueMicrotask(() => driveRun(run).catch(err => {
      run.status = 'failed';
      run.error = err.message;
      emit(run, 'run.failed', { error: err.message });
      pruneRunIfTerminal(run);
    }));
    return run;
  }

  async function start({ session, goal, userMessage, attachments = [] }) {
    const existing = findActiveRunForSession(session.id);
    if (existing) {
      return { error: 'Session already has an active run', status: 409 };
    }
    const message = {
      role: 'user',
      content: userMessage,
      ...(attachments.length ? { attachments } : {}),
    };
    const run = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      goal: String(goal || userMessage || '').slice(0, 2000),
      status: 'queued',
      // Snapshot diary permission at start: later requests (another tab
      // locking/unlocking) must not change what an in-flight run can read.
      diaryUnlocked: typeof hasDiaryAccessFlag === 'function' ? Boolean(hasDiaryAccessFlag()) : Boolean(hasDiaryAccessFlag),
      messages: [...(session.messages || []), message],
      events: [],
      checkpoint: session.checkpoint || { goal: userMessage, verified: [], failed: 0, next: 'start' },
      pendingApprovals: [],
      queuedApprovals: [],
      mutationFingerprints: {},
      mutationHistory: [],
      round: 0,
      toolCalls: 0,
      depth: 0,
      createdAt: Date.now(),
    };
    seedRunWebSearchCache(run, session);
    liveRuns.set(run.id, run);
    store.saveSession({ ...session, messages: run.messages });
    store.saveRun(run);
    queueMicrotask(() => driveRun(run).catch(err => {
      run.status = 'failed';
      run.error = err.message;
      emit(run, 'run.failed', { error: err.message });
      pruneRunIfTerminal(run);
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
    queueMicrotask(() => driveRun(run).catch(err => {
      run.status = 'failed';
      run.error = err.message;
      emit(run, 'run.failed', { error: err.message });
      pruneRunIfTerminal(run);
    }));
    return { run };
  }
  async function continueDelegatedRun(parentRun, childRun, approvalCall = null) {
    if (!(childRun.pendingApprovals || []).length) {
      childRun.status = 'running';
      store.saveRun(childRun);
      await driveRun(childRun);
    }
    if (WAITING_STATUSES.has(childRun.status)) {
      bubbleWaitingState(childRun, parentRun);
      return parentRun;
    }
    if (['completed', 'failed', 'cancelled'].includes(childRun.status)) {
      await finishDelegateOnParent(parentRun, childRun, approvalCall ? { name: 'agent.delegate', arguments: {} } : null);
    }
    return parentRun;
  }
  async function resolveApproval(runId, approvalId, { approved }) {
    const run = findRun(runId);
    if (!run) return { error: 'Run not found' };
    const approval = (run.pendingApprovals || []).find(item => item.id === approvalId);
    if (!approval) return { error: 'Approval not found' };
    if (approval.delegatedRunId) {
      const child = findRun(approval.delegatedRunId);
      if (!child) return { error: 'Delegated run not found' };
      run.pendingApprovals = (run.pendingApprovals || []).filter(item => item.id !== approvalId);
      child.pendingApprovals = (child.pendingApprovals || []).filter(item => item.id !== approvalId);
      if (approved) {
        const { result, waitingClient, waitingUser } = await executeOne(child, approval.call);
        child.toolCalls = (Number(child.toolCalls) || 0) + 1;
        if (!waitingUser && !waitingClient) {
          child.messages.push({ role: 'tool', name: approval.call.name, content: JSON.stringify(result) });
        }
        if (waitingClient || waitingUser) {
          bubbleWaitingState(child, run);
          store.saveRun(run);
          store.saveRun(child);
          return { run };
        }
      } else {
        if (approval.call.name === 'web.search') {
          clearWebSearchPending(child, webSearchFingerprint(approval.call.arguments || {}));
        }
        child.messages.push({ role: 'tool', name: approval.call.name, content: JSON.stringify({ ok: false, summary: 'User rejected the action' }) });
      }
      store.saveRun(run);
      store.saveRun(child);
      if (promoteNextApproval(child)) {
        emitApprovalRequired(child);
        bubbleWaitingState(child, run);
        return { run };
      }
      if (child.status === 'cancelled') return { run };
      child.status = 'running';
      restoreParentRunningWhileDelegateContinues(run, child);
      store.saveRun(run);
      store.saveRun(child);
      await driveRun(child);
      if (WAITING_STATUSES.has(child.status)) {
        bubbleWaitingState(child, run);
        return { run };
      }
      if (['completed', 'failed', 'cancelled'].includes(child.status)) {
        await finishDelegateOnParent(run, child);
      }
      return { run };
    }
    run.pendingApprovals = (run.pendingApprovals || []).filter(item => item.id !== approvalId);
    if (approved) {
      const { result, waitingClient, waitingUser, delegateWaiting } = await executeOne(run, approval.call);
      run.toolCalls = (Number(run.toolCalls) || 0) + 1;
      if (!delegateWaiting) {
        run.messages.push({ role: 'tool', name: approval.call.name, content: JSON.stringify(result) });
      }
      if (waitingClient || waitingUser || delegateWaiting) {
        store.saveRun(run);
        return { run };
      }
    } else {
      if (approval.call.name === 'web.search') {
        clearWebSearchPending(run, webSearchFingerprint(approval.call.arguments || {}));
      }
      run.messages.push({ role: 'tool', name: approval.call.name, content: JSON.stringify({ ok: false, summary: 'User rejected the action' }) });
    }
    if (promoteNextApproval(run)) {
      emitApprovalRequired(run);
      store.saveRun(run);
      return { run };
    }
    if (run.status === 'cancelled') return { run };
    run.status = 'running';
    store.saveRun(run);
    await driveRun(run);
    return { run };
  }
  function cancel(runId) {
    const run = findRun(runId);
    if (!run) return { error: 'Run not found' };
    // Already settled: cancelling must not rewrite a terminal run or emit a
    // second run.failed after the SSE stream ended.
    if (TERMINAL_RUN_STATUSES.has(run.status)) return { run };
    if (run.activeChildRunId) {
      const child = findRun(run.activeChildRunId);
      if (child && child.status !== 'cancelled') cancel(child.id);
    }
    for (const live of [...liveRuns.values()]) {
      if (live.parentRunId === runId && live.status !== 'cancelled') cancel(live.id);
    }
    run.status = 'cancelled';
    run.pendingApprovals = [];
    run.queuedApprovals = [];
    run.approvalQueueTotal = 0;
    run.approvalQueueIndex = 0;
    run.pendingClientTool = null;
    run.pendingQuestion = null;
    run.activeChildRunId = null;
    clearClientToolTimeout(run.id);
    emit(run, 'run.failed', { error: 'cancelled' });
    store.saveRun(run);
    pruneRunIfTerminal(run);
    return { run };
  }
  const clientToolTimers = new Map();
  const resolvedClientTools = new Map();
  const CLIENT_TOOL_TIMEOUT_MS = 30000;

  function clearClientToolTimeout(runId) {
    const timer = clientToolTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      clientToolTimers.delete(runId);
    }
  }

  function trimResolvedClientTools() {
    while (resolvedClientTools.size > 200) {
      resolvedClientTools.delete(resolvedClientTools.keys().next().value);
    }
  }

  function scheduleClientToolTimeout(run) {
    clearClientToolTimeout(run.id);
    const requestId = run.pendingClientTool?.id;
    if (!requestId) return;
    const timer = setTimeout(() => {
      clientToolTimers.delete(run.id);
      const target = findRun(run.id);
      if (!target || target.status !== 'waiting_client_tool' || target.pendingClientTool?.id !== requestId) return;
      const timeoutResult = toolResult({
        ok: false,
        summary: 'Browser tool timed out (30s)',
        errorCode: 'client_tool_timeout',
        retryable: true,
      });
      void resolveClientToolInternal(run.id, requestId, timeoutResult).catch(() => {});
    }, CLIENT_TOOL_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    clientToolTimers.set(run.id, timer);
  }

  async function resolveClientToolInternal(ownerRunId, requestId, result) {
    const owner = findRun(ownerRunId);
    if (!owner || owner.pendingClientTool?.id !== requestId) return null;
    resolvedClientTools.set(requestId, { runId: ownerRunId });
    trimResolvedClientTools();
    emit(owner, 'tool.completed', { requestId, result });
    owner.messages.push({ role: 'tool', name: 'browser', content: JSON.stringify(result) });
    owner.pendingClientTool = null;
    owner.status = 'running';
    clearClientToolTimeout(ownerRunId);
    if (owner.parentRunId) {
      const parent = findRun(owner.parentRunId);
      if (parent) {
        parent.pendingClientTool = null;
        store.saveRun(owner);
        store.saveRun(parent);
        await continueDelegatedRun(parent, owner);
        return parent;
      }
    }
    store.saveRun(owner);
    await driveRun(owner);
    return owner;
  }

  async function clientToolResult(runId, requestId, result) {
    // Duplicate submissions of the same requestId return the first outcome
    // instead of executing the tool again.
    if (resolvedClientTools.has(requestId)) {
      const cached = resolvedClientTools.get(requestId);
      return { run: findRun(cached.runId) || findRun(runId) };
    }
    const run = findRun(runId);
    if (!run) return { error: 'Run not found' };
    let ownerRun = run;
    if (run.pendingClientTool?.delegatedRunId) {
      const child = findRun(run.pendingClientTool.delegatedRunId);
      if (child && child.pendingClientTool?.id === requestId) ownerRun = child;
    }
    if (ownerRun.pendingClientTool?.id !== requestId) return { error: 'Client tool request not found' };
    if (ownerRun.parentRunId) {
      const parent = findRun(ownerRun.parentRunId);
      if (parent) parent.pendingClientTool = null;
    }
    const next = await resolveClientToolInternal(ownerRun.id, requestId, result);
    if (!next) return { error: 'Client tool request not found' };
    return { run: next };
  }
  async function resumeUserInput(runId, userMessage, attachments = []) {
    const run = findRun(runId);
    if (!run) return { error: 'Run not found' };
    if (run.delegatedRunId && run.status === 'waiting_user') {
      const child = findRun(run.delegatedRunId);
      if (!child) return { error: 'Delegated run not found' };
      run.delegatedRunId = null;
      run.pendingQuestion = null;
      run.status = 'running';
      store.saveRun(run);
      const childResult = await resumeUserInput(child.id, userMessage, attachments);
      if (childResult.error) return childResult;
      if (run.status === 'cancelled') return { run };
      await continueDelegatedRun(run, child);
      return { run };
    }
    if (run.status !== 'waiting_user') return { error: 'Run is not waiting for user input' };
    const content = String(userMessage || '').trim();
    if (!content) return { error: 'Message is required' };
    run.pendingQuestion = null;
    run.messages.push({
      role: 'user',
      content,
      ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
    });
    run.status = 'running';
    liveRuns.set(run.id, run);
    const session = store.getSession(run.sessionId);
    if (session) store.saveSession({ ...session, messages: run.messages, checkpoint: run.checkpoint });
    store.saveRun(run);
    await driveRun(run);
    if (run.parentRunId && WAITING_STATUSES.has(run.status)) {
      const parent = findRun(run.parentRunId);
      if (parent) bubbleWaitingState(run, parent);
    } else if (run.parentRunId && run.status === 'completed') {
      const parent = findRun(run.parentRunId);
      if (parent?.activeChildRunId === run.id) await finishDelegateOnParent(parent, run);
    }
    return { run };
  }
  return { start, startMemoryRefresh, startNoteAssist, attach, resolveApproval, cancel, clientToolResult, resumeUserInput, EVENT_TYPES, driveRun };
}
module.exports = { createRuntime, parseActionEnvelope, MAX_ROUNDS, clampMaxRounds, mergeVerified };
