const crypto = require('crypto');

const L0_RULES = Object.freeze({
  layer: 'L0',
  version: 1,
  rules: [
    'Never write secrets, cookies, tokens, API keys, passwords, or PIDs into memory.',
    'Never present unverified guesses as facts.',
    'All long-term memory writes require user confirmation.',
    'Prefer archive over hard delete.',
    'Cite local knowledge with document and chunk identifiers.',
  ],
});

const SECRET_PATTERN = /(api[_-]?key|password|secret|token|cookie|authorization:\s*bearer)/i;
const REFRESH_SESSION_LIMIT = 8;
const REFRESH_MESSAGE_LIMIT = 12;
const REFRESH_SESSION_CHARS = 8000;
const REFRESH_TOTAL_CHARS = 40000;
const MEMORY_TITLE_MAX = 40;
const MEMORY_CONTENT_MAX = Object.freeze({ L2: 240, L3: 1200 });
const BUILTIN_SEEDREAM_ID = 'seedream-generate';
const BUILTIN_SEEDREAM_MEMORY = Object.freeze({
  builtinId: BUILTIN_SEEDREAM_ID,
  layer: 'L3',
  title: 'Seedream 生图',
  content: [
    '用户要出图时按本流程，不要只口头描述画面。',
    '1. 把需求写成可执行视觉提示词：主体、构图、风格、光线、镜头、色彩；去掉无关叙事。',
    '2. 调用 image.generate，参数 prompt 用优化后的提示词；size、model、watermark 可省略以使用设置默认值。',
    '3. 等待用户点「允许执行」后再生成；被拒绝则停止生图。',
    '4. 成功后用返回的 markdown（![说明](/uploads/文件名)）把图贴进最终回复，不要只给外链或纯文字描述。',
    '5. 未配置 Seedream Key 时说明去设置填写，不要假装已出图。',
  ].join('\n'),
  evidence: Object.freeze([{ type: 'builtin', id: BUILTIN_SEEDREAM_ID }]),
});

function contentLimit(layer) {
  return layer === 'L3' ? MEMORY_CONTENT_MAX.L3 : MEMORY_CONTENT_MAX.L2;
}

function clipText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildMemoryRefreshUserMessage(store, memory) {
  const items = typeof memory?.list === 'function' ? memory.list() : [];
  const memories = items.length
    ? items.map(item => `- [${item.layer}] id=${item.id} ${item.title}: ${clipText(item.content, 400)}`).join('\n')
    : '(none)';
  const sessions = typeof store?.listSessions === 'function' ? store.listSessions().slice(0, REFRESH_SESSION_LIMIT) : [];
  let remaining = REFRESH_TOTAL_CHARS;
  const blocks = [];
  for (const session of sessions) {
    if (remaining <= 0) break;
    const messages = (session.messages || [])
      .filter(item => item?.role === 'user' || item?.role === 'assistant')
      .slice(-REFRESH_MESSAGE_LIMIT)
      .map(item => `${item.role}: ${clipText(item.content, REFRESH_SESSION_CHARS)}`);
    const block = `Session ${session.id} (${session.title || ''}):\n${messages.join('\n') || '(empty)'}`;
    const sliced = block.slice(0, Math.min(REFRESH_SESSION_CHARS, remaining));
    if (!sliced) break;
    blocks.push(sliced);
    remaining -= sliced.length;
  }
  return [
    'Review current long-term memories and recent conversations.',
    'Extract durable L2 facts (preferences, constraints) and L3 reusable workflows.',
    'Do not recap a conversation or write one memory per session.',
    'L2 content: one or two sentences. L3 may include steps, but must be a reusable procedure, not a session recap.',
    'Skip anything already captured accurately. To update an existing item, pass existingId.',
    'Propose at most 5 drafts. Call memory.propose for each. If nothing should change, answer with no tools.',
    `Current memories:\n${memories}`,
    `Recent conversations:\n${blocks.join('\n\n') || '(none)'}`,
  ].join('\n\n');
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string' && value.text.trim()) return value.text;
      if (typeof value.content === 'string' && value.content.trim()) return value.content;
    }
  }
  return '';
}

function normalizeMemoryProposalArgs(args = {}) {
  const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return {
    ...source,
    title: firstNonEmptyString(source.title, source.name, source.headline).slice(0, MEMORY_TITLE_MAX),
    content: firstNonEmptyString(
      source.content,
      source.text,
      source.body,
      source.summary,
      source.memory,
      source.details,
      source.note,
    ),
    layer: source.layer === 'L3' || source.layer === 'l3' ? 'L3' : 'L2',
    existingId: firstNonEmptyString(source.existingId, source.id, source.memoryId),
    evidence: Array.isArray(source.evidence) ? source.evidence : [],
    runId: source.runId || '',
  };
}

function createMemoryService(store) {
  function ensureBuiltinMemories() {
    const data = store.readMemories();
    const exists = (data.items || []).some(item => item.builtinId === BUILTIN_SEEDREAM_ID);
    if (exists) return;
    data.items = [{
      id: 'builtin-seedream-generate',
      builtinId: BUILTIN_SEEDREAM_MEMORY.builtinId,
      layer: BUILTIN_SEEDREAM_MEMORY.layer,
      title: BUILTIN_SEEDREAM_MEMORY.title,
      content: BUILTIN_SEEDREAM_MEMORY.content,
      evidence: [...BUILTIN_SEEDREAM_MEMORY.evidence],
      version: 1,
      status: 'active',
      createdAt: Date.now(),
    }, ...(data.items || [])];
    store.writeMemories(data);
  }

  function list({ layer } = {}) {
    ensureBuiltinMemories();
    const items = store.readMemories().items.filter(item => item.status === 'active');
    return layer ? items.filter(item => item.layer === layer) : items;
  }

  function listProposals() {
    return store.readMemories().proposals.filter(item => item.status === 'pending');
  }

  function propose({ runId, layer, title, content, evidence, existingId }) {
    if (!Array.isArray(evidence) || !evidence.length) return { error: 'Memory requires evidence' };
    if (SECRET_PATTERN.test(`${title}\n${content}\n${JSON.stringify(evidence)}`)) return { error: 'Memory contains secret material' };
    const data = store.readMemories();
    const nextLayer = layer === 'L3' ? 'L3' : 'L2';
    const proposal = {
      id: crypto.randomUUID(),
      runId,
      layer: nextLayer,
      title: firstNonEmptyString(title).slice(0, MEMORY_TITLE_MAX),
      content: firstNonEmptyString(content).slice(0, contentLimit(nextLayer)),
      evidence,
      existingId: existingId || '',
      status: 'pending',
      createdAt: Date.now(),
    };
    data.proposals.unshift(proposal);
    store.writeMemories(data);
    return { proposal };
  }

  function approve(id) {
    const data = store.readMemories();
    const proposal = data.proposals.find(item => item.id === id);
    if (!proposal || proposal.status !== 'pending') return { error: 'Proposal not found' };
    if (proposal.existingId) {
      data.items = data.items.map(item => item.id === proposal.existingId ? { ...item, status: 'superseded', supersededAt: Date.now() } : item);
    }
    const memory = {
      id: crypto.randomUUID(),
      layer: proposal.layer,
      title: proposal.title,
      content: proposal.content,
      evidence: proposal.evidence,
      version: 1,
      status: 'active',
      sourceProposalId: proposal.id,
      createdAt: Date.now(),
    };
    data.items.unshift(memory);
    proposal.status = 'approved';
    proposal.memoryId = memory.id;
    store.writeMemories(data);
    return { memory };
  }

  function dismiss(id) {
    const data = store.readMemories();
    const proposal = data.proposals.find(item => item.id === id);
    if (!proposal || proposal.status !== 'pending') return { error: 'Proposal not found' };
    proposal.status = 'rejected';
    proposal.rejectedAt = Date.now();
    store.writeMemories(data);
    return { proposal };
  }

  function archive(id) {
    const data = store.readMemories();
    const memory = data.items.find(item => item.id === id && item.status === 'active');
    if (!memory) return { error: 'Memory not found' };
    memory.status = 'archived';
    memory.archivedAt = Date.now();
    store.writeMemories(data);
    return { memory };
  }

  function contextBlocks() {
    const items = list();
    return {
      l0: L0_RULES,
      l2: items.filter(item => item.layer === 'L2').slice(0, 20),
      l3: items.filter(item => item.layer === 'L3').slice(0, 20),
    };
  }

  return { list, listProposals, propose, approve, dismiss, archive, contextBlocks, L0_RULES };
}

module.exports = {
  createMemoryService,
  L0_RULES,
  SECRET_PATTERN,
  buildMemoryRefreshUserMessage,
  normalizeMemoryProposalArgs,
  MEMORY_TITLE_MAX,
  MEMORY_CONTENT_MAX,
  BUILTIN_SEEDREAM_ID,
  BUILTIN_SEEDREAM_MEMORY,
};
