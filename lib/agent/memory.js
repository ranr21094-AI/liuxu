const crypto = require('crypto');
const { DEFAULT_MEMORY_SETTINGS, resolveMemorySettings } = require('./memory-settings');

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

const BUILTIN_GETOKEN_ID = 'getoken-generate';
const BUILTIN_GETOKEN_VERSION = 2;
const BUILTIN_GETOKEN_MEMORY = Object.freeze({
  builtinId: BUILTIN_GETOKEN_ID,
  layer: 'L3',
  title: 'Getoken 生图',
  content: [
    '设置中 imageProvider=getoken 时，image.generate 走 Getoken API。',
    '1. 文生图：仅 prompt；可用 n=1–4 一次生成多张，不要循环多次单张调用。',
    '2. 图生图/编辑：传入 image（/uploads/ 本地附件 URL）；多张参考图可传数组，走 edits 接口。',
    '3. Getoken 模型：gpt-image-2、grok-imagine-image、nano-banana-2；默认 model 与 size/quality 可省略以使用设置页默认值。',
    '4. 各模型 Key 在设置页分别填写；调用时按 model 自动选 Key，未配置则提示去设置填写对应模型 Key。',
    '5. 不支持 Seedream 的 batch/sequential/layer_decomposition。',
  ].join('\n'),
  evidence: Object.freeze([{ type: 'builtin', id: BUILTIN_GETOKEN_ID }]),
});

const SECRET_PATTERN = /(api[_-]?key|password|secret|token|cookie|authorization:\s*bearer)/i;
const BUILTIN_SEEDREAM_ID = 'seedream-generate';
const BUILTIN_SEEDREAM_VERSION = 3;
const BUILTIN_SEEDREAM_MEMORY = Object.freeze({
  builtinId: BUILTIN_SEEDREAM_ID,
  layer: 'L3',
  title: 'Seedream 生图',
  content: [
    '用户要出图时按本流程，不要只口头描述画面。',
    '1. 判断任务：文生图 / 参考图编辑 / 组图(2–15张) / 图层拆分；附件优先作为 image 参数。',
    '2. 选模型：Pro=精准编辑/图层拆分/透明背景(不支持组图)；Lite/4.5/4.0=单图或组图。',
    '3. 组图必须只调用一次 image.generate：batch=true 且 batch_size=N，或 sequential_image_generation=auto 且 max_images=N；禁止为同一组图循环多次单张调用。',
    '4. 组图用一个 prompt 描述整组主题/变体，不要拆成 N 个 prompt 多次调；Lite/4.x 组图示例：{prompt, batch:true, batch_size:4}。',
    '5. 单张图省略 batch/sequential；写 prompt（中文≤300字），等待用户确认后再生成。',
    '6. 用返回 markdown 贴全部成功图；未配置 Seedream Key 时提示去设置填写。',
  ].join('\n'),
  evidence: Object.freeze([{ type: 'builtin', id: BUILTIN_SEEDREAM_ID }]),
});
const BUILTIN_IMAGE_ID = 'image-generate';
const BUILTIN_IMAGE_VERSION = 1;
const BUILTIN_IMAGE_MEMORY = Object.freeze({
  builtinId: BUILTIN_IMAGE_ID,
  layer: 'L3',
  title: '统一生图工作流',
  content: [
    '用户要求生成或编辑图片时，调用 image.generate，不要只描述画面。',
    '1. 提供 prompt；附件作为 images。需要多张时使用 count，一次调用完成，不循环单张调用。',
    '2. 通常省略 modelRef，让系统优先使用默认模型并按参考图、多图、透明背景或图层能力自动路由。',
    '3. 用户明确指定模型时使用设置页显示的稳定 modelRef；上游模型 ID 重名时不能猜测。',
    '4. 只有模型声明支持时才请求 layer_decomposition、web_search、透明背景等高级能力。',
    '5. image.generate 始终等待用户确认；返回后展示 markdown 中的全部成功图片。',
  ].join('\n'),
  evidence: Object.freeze([{ type: 'builtin', id: BUILTIN_IMAGE_ID }]),
});

const MEMORY_TITLE_MAX = DEFAULT_MEMORY_SETTINGS.memoryTitleMaxChars;
const MEMORY_CONTENT_MAX = Object.freeze({
  L2: DEFAULT_MEMORY_SETTINGS.memoryContentMaxCharsL2,
  L3: DEFAULT_MEMORY_SETTINGS.memoryContentMaxCharsL3,
});

function contentLimit(layer, settings = DEFAULT_MEMORY_SETTINGS) {
  return layer === 'L3' ? settings.memoryContentMaxCharsL3 : settings.memoryContentMaxCharsL2;
}

function clipText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatExistingMemoryContent(content) {
  return String(content || '').trim();
}

function buildMemoryRefreshUserMessage(store, memory, settings = DEFAULT_MEMORY_SETTINGS) {
  const resolved = resolveMemorySettings(settings);
  const items = typeof memory?.list === 'function' ? memory.list() : [];
  const memories = items.length
    ? items.map(item => `- [${item.layer}] id=${item.id} ${item.title}: ${formatExistingMemoryContent(item.content)}`).join('\n')
    : '(none)';
  const sessions = typeof store?.listSessions === 'function'
    ? store.listSessions().slice(0, resolved.memoryRefreshSessionLimit)
    : [];
  let remaining = resolved.memoryRefreshTotalChars;
  const blocks = [];
  for (const session of sessions) {
    if (remaining <= 0) break;
    const messages = (session.messages || [])
      .filter(item => item?.role === 'user' || item?.role === 'assistant')
      .slice(-resolved.memoryRefreshMessageLimit)
      .map(item => `${item.role}: ${clipText(item.content, resolved.memoryRefreshMessageChars)}`);
    const block = `Session ${session.id} (${session.title || ''}):\n${messages.join('\n') || '(empty)'}`;
    const sliced = block.slice(0, Math.min(resolved.memoryRefreshSessionBlockChars, remaining));
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
    `Propose at most ${resolved.memoryRefreshMaxProposals} drafts. Call memory.propose for each. If nothing should change, answer with no tools.`,
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

function normalizeMemoryProposalArgs(args = {}, settings = DEFAULT_MEMORY_SETTINGS) {
  const resolved = resolveMemorySettings(settings);
  const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const layer = source.layer === 'L3' || source.layer === 'l3' ? 'L3' : 'L2';
  return {
    ...source,
    title: firstNonEmptyString(source.title, source.name, source.headline).slice(0, resolved.memoryTitleMaxChars),
    content: firstNonEmptyString(
      source.content,
      source.text,
      source.body,
      source.summary,
      source.memory,
      source.details,
      source.note,
    ),
    layer,
    existingId: firstNonEmptyString(source.existingId, source.id, source.memoryId),
    evidence: Array.isArray(source.evidence) ? source.evidence : [],
    runId: source.runId || '',
  };
}

function createMemoryService(store, { settingsFor = () => DEFAULT_MEMORY_SETTINGS } = {}) {
  function currentSettings() {
    return resolveMemorySettings(typeof settingsFor === 'function' ? settingsFor() : settingsFor);
  }

  function ensureBuiltinMemories() {
    const data = store.readMemories();
    let changed = false;
    const upsert = (builtin, version, id) => {
      const index = (data.items || []).findIndex(item => item.builtinId === builtin.builtinId);
      if (index < 0) {
        data.items = [{
          id,
          builtinId: builtin.builtinId,
          layer: builtin.layer,
          title: builtin.title,
          content: builtin.content,
          evidence: [...builtin.evidence],
          version,
          status: 'active',
          createdAt: Date.now(),
        }, ...(data.items || [])];
        changed = true;
        return;
      }
      const existing = data.items[index];
      if ((existing.version || 1) >= version) return;
      data.items[index] = {
        ...existing,
        title: builtin.title,
        content: builtin.content,
        evidence: [...builtin.evidence],
        version,
        updatedAt: Date.now(),
      };
      changed = true;
    };
    upsert(BUILTIN_IMAGE_MEMORY, BUILTIN_IMAGE_VERSION, 'builtin-image-generate');
    for (const item of data.items || []) {
      if (![BUILTIN_SEEDREAM_ID, BUILTIN_GETOKEN_ID].includes(item.builtinId) || item.status !== 'active') continue;
      item.status = 'superseded';
      item.supersededAt = Date.now();
      changed = true;
    }
    if (changed) store.writeMemories(data);
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
    const settings = currentSettings();
    if (!Array.isArray(evidence) || !evidence.length) return { error: 'Memory requires evidence' };
    if (SECRET_PATTERN.test(`${title}\n${content}\n${JSON.stringify(evidence)}`)) return { error: 'Memory contains secret material' };
    const data = store.readMemories();
    const nextLayer = layer === 'L3' ? 'L3' : 'L2';
    const proposal = {
      id: crypto.randomUUID(),
      runId,
      layer: nextLayer,
      title: firstNonEmptyString(title).slice(0, settings.memoryTitleMaxChars),
      content: firstNonEmptyString(content).slice(0, contentLimit(nextLayer, settings)),
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
    return {
      l0: L0_RULES,
      l2: [],
      l3: [],
    };
  }

  return {
    list,
    listProposals,
    propose,
    approve,
    dismiss,
    archive,
    contextBlocks,
    getSettings: currentSettings,
    normalizeProposalArgs: args => normalizeMemoryProposalArgs(args, currentSettings()),
    L0_RULES,
  };
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
  BUILTIN_SEEDREAM_VERSION,
  BUILTIN_SEEDREAM_MEMORY,
  BUILTIN_GETOKEN_ID,
  BUILTIN_GETOKEN_VERSION,
  BUILTIN_GETOKEN_MEMORY,
  BUILTIN_IMAGE_ID,
  BUILTIN_IMAGE_VERSION,
  BUILTIN_IMAGE_MEMORY,
};
