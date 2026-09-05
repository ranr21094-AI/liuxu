const { toolResult } = require('./tools');
const { MAX_QUERY_LENGTH } = require('./web-search-cache');

const MUTATION_TOOLS = new Set([
  'task.create', 'task.update', 'task.complete', 'task.delete',
  'countdown.create', 'countdown.update', 'countdown.delete',
  'knowledge.create', 'knowledge.update', 'knowledge.archive', 'knowledge.restore', 'knowledge.delete', 'knowledge.import',
]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isMutationTool(name) {
  return MUTATION_TOOLS.has(name);
}

function countdownGoalText(goal) {
  return /倒数日|countdown|生日提醒|生日.*倒数|倒数.*生日/i.test(String(goal || ''));
}

function claimsCountdownSuccess(text) {
  return /创建成功|已添加|已创建|添加成功|确认倒数日|countdown.*(created|added)/i.test(String(text || ''));
}

function mutationFingerprint(name, args = {}) {
  const title = typeof args.title === 'string' ? args.title.trim().toLowerCase() : '';
  const dueDate = typeof args.due_date === 'string' ? args.due_date.trim() : '';
  const targetDate = typeof args.target_date === 'string' ? args.target_date.trim() : '';
  const recurrence = typeof args.recurrence === 'string' ? args.recurrence.trim() : '';
  const id = args.id !== undefined && args.id !== null ? String(args.id) : '';
  switch (name) {
    case 'countdown.create':
      return `countdown.create:${title}:${targetDate}:${args.repeat_yearly === true}`;
    case 'task.create':
      return `task.create:${title}:${dueDate}:${recurrence || 'none'}`;
    case 'countdown.update':
      return `countdown.update:${id}:${title}:${targetDate}`;
    case 'task.update':
      return `task.update:${id}:${title}:${dueDate}`;
    case 'task.delete':
    case 'countdown.delete':
    case 'task.complete':
      return `${name}:${id}`;
    default:
      return `${name}:${JSON.stringify(args).slice(0, 120)}`;
  }
}

function validateWriteToolCall(name, args = {}, goal = '') {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (name === 'task.create') {
    if (!title) {
      return toolResult({ ok: false, summary: 'task.create requires a non-empty title', errorCode: 'invalid' });
    }
    if (countdownGoalText(goal)) {
      return toolResult({
        ok: false,
        summary: 'Use countdown.create for countdown/birthday entries, not task.create',
        errorCode: 'wrong_tool',
      });
    }
    return null;
  }
  if (name === 'countdown.create') {
    if (!title) {
      return toolResult({ ok: false, summary: 'countdown.create requires a non-empty title', errorCode: 'invalid' });
    }
    const targetDate = typeof args.target_date === 'string' ? args.target_date.trim() : '';
    if (!DATE_PATTERN.test(targetDate)) {
      return toolResult({ ok: false, summary: 'countdown.create requires target_date in YYYY-MM-DD', errorCode: 'invalid' });
    }
    return null;
  }
  if (name === 'countdown.update') {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) {
      return toolResult({ ok: false, summary: 'countdown.update requires a valid id', errorCode: 'invalid' });
    }
    if (args.target_date !== undefined) {
      const targetDate = String(args.target_date || '').trim();
      if (!DATE_PATTERN.test(targetDate)) {
        return toolResult({ ok: false, summary: 'target_date must be YYYY-MM-DD', errorCode: 'invalid' });
      }
    }
    return null;
  }
  if (name === 'web.search') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return toolResult({ ok: false, summary: 'Search query is required', errorCode: 'invalid' });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return toolResult({
        ok: false,
        summary: `Search query must be at most ${MAX_QUERY_LENGTH} characters`,
        errorCode: 'invalid',
      });
    }
    return null;
  }
  return null;
}

function findExistingMutation(db, name, args = {}) {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const targetDate = typeof args.target_date === 'string' ? args.target_date.trim() : '';
  const dueDate = typeof args.due_date === 'string' ? args.due_date.trim() : '';
  const recurrence = typeof args.recurrence === 'string' ? args.recurrence.trim() : 'none';

  if (name === 'countdown.create' && title && targetDate) {
    const existing = db.getAllCountdowns().find(item => item.title === title && item.target_date === targetDate);
    if (existing) return { kind: 'countdown', id: existing.id, item: existing };
  }
  if (name === 'task.create' && title) {
    const existing = db.getAllTodos().find(item => !item.done
      && item.title === title
      && (item.due_date || null) === (dueDate || null)
      && (item.recurrence || 'none') === (recurrence || 'none'));
    if (existing) return { kind: 'task', id: existing.id, item: existing };
  }
  return null;
}

function duplicateInRunResult(run, fingerprint, existing = null) {
  const prior = run.mutationFingerprints?.[fingerprint];
  if (!prior) return null;
  return toolResult({
    ok: true,
    summary: existing
      ? `Already exists (${prior.kind} id ${prior.id})`
      : 'Already created in this run',
    data: {
      duplicate: true,
      existingId: prior.id,
      kind: prior.kind || '',
    },
    evidence: prior.kind ? [{ type: prior.kind, id: prior.id }] : [],
  });
}

function recordMutationAttempt(run, name, args = {}) {
  if (!['task.create', 'countdown.create', 'task.delete', 'countdown.delete', 'task.update', 'countdown.update'].includes(name)) return;
  if (!run.mutationHistory) run.mutationHistory = [];
  run.mutationHistory.push({
    name,
    fingerprint: mutationFingerprint(name, args),
    round: run.round || 0,
    at: Date.now(),
  });
  if (run.mutationHistory.length > 12) run.mutationHistory = run.mutationHistory.slice(-12);
}

function recordMutationSuccess(run, name, args, result) {
  if (!result?.ok || result?.data?.duplicate) return;
  if (!isMutationTool(name) || !['task.create', 'countdown.create'].includes(name)) return;
  const fingerprint = mutationFingerprint(name, args);
  if (!run.mutationFingerprints) run.mutationFingerprints = {};
  const kind = name.startsWith('countdown.') ? 'countdown' : 'task';
  const id = result?.data?.id;
  run.mutationFingerprints[fingerprint] = { id, kind, at: Date.now() };
}

function countdownCreatedThisRun(run) {
  return (run.messages || []).some(message => {
    if (message.role !== 'tool' || message.name !== 'countdown.create') return false;
    try {
      const parsed = JSON.parse(message.content || '{}');
      return parsed.ok && !parsed.data?.duplicate;
    } catch {
      return false;
    }
  });
}

function validateCheckpointUpdate(run, args = {}, db) {
  const next = typeof args.next === 'string' ? args.next.trim() : '';
  const notes = typeof args.notes === 'string' ? args.notes.trim() : '';
  if (!countdownGoalText(run.goal)) return null;
  if (!claimsCountdownSuccess(next) && !claimsCountdownSuccess(notes)) return null;
  if (countdownCreatedThisRun(run)) return null;
  const countdowns = db.getAllCountdowns();
  if (countdowns.length) {
    const userText = (run.messages || []).filter(item => item.role === 'user').map(item => item.content).join('\n');
    const dateMatch = userText.match(/\d{4}-\d{2}-\d{2}/);
    if (dateMatch && countdowns.some(item => item.target_date === dateMatch[0])) return null;
  }
  return toolResult({
    ok: false,
    summary: 'Countdown not created yet. Call countdown.create and wait for user approval before marking success.',
    errorCode: 'premature_checkpoint',
    data: { suggestedNext: '调用 countdown.create 并等待用户确认' },
  });
}

function shouldPauseForRepeatedMutations(run, limit = 3) {
  const threshold = Math.max(1, Number(limit) || 3);
  const history = run.mutationHistory || [];
  if (history.length < threshold) return null;
  const recent = history.slice(-threshold);
  const sameName = recent.every(item => item.name === recent[0].name);
  const sameFingerprint = recent.every(item => item.fingerprint === recent[0].fingerprint);
  const createDeleteLoop = recent.length === threshold
    && recent.filter(item => item.name.includes('.create')).length >= 2
    && recent.some(item => item.name.includes('.delete'));
  if ((sameName && sameFingerprint) || createDeleteLoop) {
    return '检测到重复的创建/删除操作。请确认：要用倒数日（countdown.create）还是每年重复的待办（task.create + recurrence yearly）？只需创建一次。';
  }
  return null;
}

module.exports = {
  MUTATION_TOOLS,
  isMutationTool,
  countdownGoalText,
  mutationFingerprint,
  validateWriteToolCall,
  findExistingMutation,
  duplicateInRunResult,
  recordMutationAttempt,
  recordMutationSuccess,
  validateCheckpointUpdate,
  shouldPauseForRepeatedMutations,
};
