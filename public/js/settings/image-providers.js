import { apiFetch } from '../auth.js';
import { escHtml, showToast } from '../helpers.js';

const MAX_PROVIDERS = 32;
const MAX_MODELS = 200;
const expanded = new Set();
const capabilityExpanded = new Set();
const testStates = new Map();
const testControllers = new Map();
let providers = [];
let defaultModelRef = '';
let bound = false;

const seedreamModels = [
  ['doubao-seedream-5-0-pro-260628', 'Seedream 5.0 Pro'],
  ['doubao-seedream-5-0-260128', 'Seedream 5.0 Lite'],
  ['doubao-seedream-4-5-251128', 'Seedream 4.5'],
  ['doubao-seedream-4-0-250828', 'Seedream 4.0'],
];

function uid(prefix) {
  const value = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12)
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${value}`;
}

function conservativeCaps(adapter, upstreamId = '') {
  if (adapter === 'seedream' && seedreamModels.some(([id]) => id === upstreamId)) {
    const pro = upstreamId.includes('-pro-');
    const lite = upstreamId === 'doubao-seedream-5-0-260128';
    const model45 = upstreamId.includes('-4-5-');
    return {
      textToImage: true, imageEdit: true, maxOutputs: pro ? 1 : 15, maxReferences: pro ? 10 : 14,
      sizes: pro ? ['1K', '1.5K', '2K', 'auto'] : lite ? ['2K', '3K', '4K'] : model45 ? ['2K', '4K'] : ['1K', '2K', '4K'],
      qualities: [], outputFormats: pro || lite ? ['jpeg', 'png'] : ['jpeg'], customSize: true,
      transparentBackground: pro, watermark: true, sequential: !pro,
      layerDecomposition: pro, webSearch: lite, promptOptimization: true, streaming: !pro,
    };
  }
  const knownOpenAi = ['gpt-image-2', 'grok-imagine-image', 'nano-banana-2'].includes(upstreamId);
  if (adapter === 'openai-images' && knownOpenAi) {
    return {
      textToImage: true, imageEdit: true, maxOutputs: 4, maxReferences: 4,
      sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
      qualities: ['standard', 'high'], outputFormats: ['png'], customSize: false,
      transparentBackground: false, watermark: false, sequential: false,
      layerDecomposition: false, webSearch: false, promptOptimization: false, streaming: false,
    };
  }
  return {
    textToImage: true, imageEdit: false, maxOutputs: 1, maxReferences: 0,
    sizes: [], qualities: [], outputFormats: [], customSize: false,
    transparentBackground: false, watermark: false, sequential: false,
    layerDecomposition: false, webSearch: false, promptOptimization: false, streaming: false,
  };
}

function blankModel(adapter, upstreamId = '', name = '') {
  return {
    id: uid('im'), upstreamId, name: name || upstreamId, enabled: true,
    capabilities: conservativeCaps(adapter, upstreamId),
    defaults: { size: '', quality: '', count: 1, outputFormat: '', background: 'opaque', watermark: false, promptOptimization: 'standard', webSearch: false, streaming: false },
    testPrompt: '极简蓝色圆点，白色背景',
  };
}

function providerTemplate(adapter) {
  if (adapter === 'seedream') {
    return {
      id: uid('ip'), name: 'Seedream', adapter, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: '', apiKeyConfigured: false, enabled: true,
      models: seedreamModels.map(([id, name]) => blankModel(adapter, id, name)),
    };
  }
  return {
    id: uid('ip'), name: 'OpenAI Images', adapter: 'openai-images', baseUrl: '',
    apiKey: '', apiKeyConfigured: false, enabled: true,
    models: [blankModel('openai-images')],
  };
}

function cloneSettingsProvider(provider) {
  return {
    id: provider.id || uid('ip'),
    name: provider.name || '',
    adapter: provider.adapter === 'seedream' ? 'seedream' : 'openai-images',
    baseUrl: provider.baseUrl || '',
    apiKey: '',
    apiKeyConfigured: Boolean(provider.apiKeyConfigured),
    enabled: provider.enabled !== false,
    models: (provider.models || []).map(model => ({
      id: model.id || uid('im'), upstreamId: model.upstreamId || '', name: model.name || model.upstreamId || '',
      enabled: model.enabled !== false,
      capabilities: { ...conservativeCaps(provider.adapter, model.upstreamId), ...(model.capabilities || {}) },
      defaults: { ...blankModel(provider.adapter).defaults, ...(model.defaults || {}) },
      testPrompt: model.testPrompt || '极简蓝色圆点，白色背景',
    })),
  };
}

function modelRef(provider, model) {
  return `image/${provider.id}/${model.id}`;
}

function generationEndpoint(provider) {
  const root = String(provider.baseUrl || '').replace(/\/+$/, '');
  if (!root) return '保存前会校验接口地址';
  if (provider.adapter === 'seedream') return `${root}/images/generations`;
  return `${root.endsWith('/v1') ? root : `${root}/v1`}/images/generations`;
}

function csv(value) {
  return Array.isArray(value) ? value.join(', ') : '';
}

function testKey(providerId, modelId, kind) {
  return `${providerId}:${modelId || 'provider'}:${kind}`;
}

function renderTestState(key) {
  const item = testStates.get(key);
  if (!item) return '';
  const status = item.status === 'success' ? 'success' : item.status === 'running' ? 'running' : 'error';
  const details = [item.message, item.httpStatus ? `HTTP ${item.httpStatus}` : '', item.durationMs != null ? `${item.durationMs}ms` : ''].filter(Boolean).join(' · ');
  const image = item.url ? `<img class="image-provider-test-preview" src="${escHtml(item.url)}" alt="试生图结果">` : '';
  return `<div class="custom-model-test-result ${status}" aria-live="polite">${image}<span>${escHtml(details || '处理中…')}</span></div>`;
}

function renderModel(provider, model, index) {
  const caps = model.capabilities || conservativeCaps(provider.adapter, model.upstreamId);
  const defaults = model.defaults || {};
  const ref = modelRef(provider, model);
  const connectionKey = testKey(provider.id, model.id, 'connection');
  const generationKey = testKey(provider.id, model.id, 'generation');
  const connectionRunning = testStates.get(connectionKey)?.status === 'running';
  const running = testStates.get(generationKey)?.status === 'running';
  const checks = [
    ['textToImage', '文生图'], ['imageEdit', '参考图编辑'], ['customSize', '自定义尺寸'], ['transparentBackground', '透明背景'],
    ['watermark', '水印'], ['sequential', '连续组图'], ['layerDecomposition', '图层拆分'],
    ['webSearch', '联网增强'], ['promptOptimization', '提示词优化'], ['streaming', '流式响应'],
  ];
  return `<article class="image-model-card" data-model-id="${escHtml(model.id)}">
    <div class="image-model-grid">
      <label>模型 ID<input class="image-model-upstream" value="${escHtml(model.upstreamId)}" spellcheck="false" placeholder="上游模型 ID"></label>
      <label>显示名称<input class="image-model-name" value="${escHtml(model.name)}" placeholder="显示名称"></label>
      <label class="image-provider-check"><input class="image-model-enabled" type="checkbox" ${model.enabled !== false ? 'checked' : ''}>启用</label>
      <label class="image-provider-check"><input type="radio" name="defaultImageModel" value="${escHtml(ref)}" ${defaultModelRef === ref ? 'checked' : ''}>默认</label>
    </div>
    <details class="image-model-capabilities" data-capability-key="${escHtml(`${provider.id}:${model.id}`)}" ${capabilityExpanded.has(`${provider.id}:${model.id}`) ? 'open' : ''}>
      <summary>能力与默认参数</summary>
      <div class="image-capability-grid">
        ${checks.map(([key, label]) => `<label class="image-provider-check"><input data-capability="${key}" type="checkbox" ${caps[key] ? 'checked' : ''}>${label}</label>`).join('')}
        <label>最多输出<input data-capability-number="maxOutputs" type="number" min="1" max="15" value="${Number(caps.maxOutputs) || 1}"></label>
        <label>最多参考图<input data-capability-number="maxReferences" type="number" min="0" max="14" value="${Number(caps.maxReferences) || 0}"></label>
        <label>尺寸列表<input data-capability-list="sizes" value="${escHtml(csv(caps.sizes))}" placeholder="auto, 1024x1024"></label>
        <label>质量列表<input data-capability-list="qualities" value="${escHtml(csv(caps.qualities))}" placeholder="standard, high"></label>
        <label>格式列表<input data-capability-list="outputFormats" value="${escHtml(csv(caps.outputFormats))}" placeholder="png, jpeg"></label>
        <label>默认尺寸<input data-default="size" value="${escHtml(defaults.size || '')}"></label>
        <label>默认质量<input data-default="quality" value="${escHtml(defaults.quality || '')}"></label>
        <label>默认张数<input data-default-number="count" type="number" min="1" max="15" value="${Number(defaults.count) || 1}"></label>
        <label>默认格式<input data-default="outputFormat" value="${escHtml(defaults.outputFormat || '')}"></label>
        <label>默认背景<select data-default="background"><option value="opaque" ${defaults.background !== 'transparent' ? 'selected' : ''}>不透明</option><option value="transparent" ${defaults.background === 'transparent' ? 'selected' : ''}>透明</option></select></label>
        <label>提示词优化<select data-default="promptOptimization"><option value="standard" ${defaults.promptOptimization !== 'fast' ? 'selected' : ''}>standard</option><option value="fast" ${defaults.promptOptimization === 'fast' ? 'selected' : ''}>fast</option></select></label>
        <label class="image-provider-check"><input data-default-bool="watermark" type="checkbox" ${defaults.watermark ? 'checked' : ''}>默认水印</label>
        <label class="image-provider-check"><input data-default-bool="webSearch" type="checkbox" ${defaults.webSearch ? 'checked' : ''}>默认联网增强</label>
        <label class="image-provider-check"><input data-default-bool="streaming" type="checkbox" ${defaults.streaming ? 'checked' : ''}>默认流式</label>
      </div>
    </details>
    <div class="image-model-test-row">
      <button type="button" class="btn ghost small" data-image-action="test" data-model-index="${index}" ${connectionRunning ? 'disabled' : ''}>${connectionRunning ? '测试中…' : '连接测试'}</button>
      <input class="image-test-prompt" value="${escHtml(model.testPrompt || '极简蓝色圆点，白色背景')}" aria-label="试生图提示词">
      <button type="button" class="btn ghost small" data-image-action="generate" data-model-index="${index}">${running ? '取消试生图' : '试生图'}</button>
      <button type="button" class="btn ghost small" data-image-action="remove-model" data-model-index="${index}">删除模型</button>
    </div>
    ${renderTestState(connectionKey)}${renderTestState(generationKey)}
  </article>`;
}

function renderProvider(provider, index) {
  const open = expanded.has(provider.id) || index === 0;
  return `<details class="custom-provider-card image-provider-card" data-provider-id="${escHtml(provider.id)}" data-provider-index="${index}" ${open ? 'open' : ''}>
    <summary class="custom-provider-summary">
      <span class="custom-provider-summary-main"><strong>${escHtml(provider.name || '未命名供应商')}</strong><span class="custom-provider-summary-meta">${escHtml(provider.adapter)} · ${provider.models.length} 个模型${provider.apiKeyConfigured || provider.apiKey ? ' · Key 已配置' : ''}</span></span>
    </summary>
    <div class="custom-provider-body">
      <div class="custom-provider-conn-grid">
        <label class="custom-provider-inline-field">名称<input class="image-provider-name" value="${escHtml(provider.name)}"></label>
        <label class="custom-provider-inline-field">协议<select class="image-provider-adapter"><option value="seedream" ${provider.adapter === 'seedream' ? 'selected' : ''}>Seedream</option><option value="openai-images" ${provider.adapter === 'openai-images' ? 'selected' : ''}>OpenAI Images</option></select></label>
        <label class="custom-provider-inline-field">API 根地址<input class="image-provider-base-url" value="${escHtml(provider.baseUrl)}" spellcheck="false" placeholder="https://..."><small>生成端点：${escHtml(generationEndpoint(provider))}</small></label>
        <label class="custom-provider-inline-field">API Key<input class="image-provider-key" type="password" autocomplete="off" placeholder="${provider.apiKeyConfigured ? '已配置；留空保持不变' : '可留空用于本地接口'}"></label>
      </div>
      <div class="image-provider-toolbar">
        <label class="image-provider-check"><input class="image-provider-enabled" type="checkbox" ${provider.enabled !== false ? 'checked' : ''}>启用供应商</label>
        <button type="button" class="btn ghost small" data-image-action="fetch-models">获取模型</button>
        <button type="button" class="btn ghost small" data-image-action="duplicate-provider">复制</button>
        <button type="button" class="btn ghost small" data-image-action="move-up" ${index === 0 ? 'disabled' : ''}>上移</button>
        <button type="button" class="btn ghost small" data-image-action="move-down" ${index === providers.length - 1 ? 'disabled' : ''}>下移</button>
        <button type="button" class="btn ghost small" data-image-action="remove-provider">删除</button>
      </div>
      <div class="image-provider-models">${provider.models.map((model, modelIndex) => renderModel(provider, model, modelIndex)).join('')}</div>
      <button type="button" class="btn ghost small" data-image-action="add-model">添加模型</button>
    </div>
  </details>`;
}

function render() {
  const root = document.querySelector('#imageProvidersSettings');
  if (!root) return;
  root.innerHTML = `<div class="image-provider-toolbar image-provider-add-toolbar">
    <button type="button" class="btn ghost" data-image-add="seedream">添加 Seedream</button>
    <button type="button" class="btn ghost" data-image-add="openai-images">添加 OpenAI Images</button>
  </div>
  <div class="custom-providers-list image-providers-list">${providers.map(renderProvider).join('') || '<p class="empty-list">还没有生图供应商，请添加一个。</p>'}</div>`;
}

function splitList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean).slice(0, 32);
}

function syncFromDom() {
  document.querySelectorAll('.image-provider-card').forEach(card => {
    const provider = providers.find(item => item.id === card.dataset.providerId);
    if (!provider) return;
    provider.name = card.querySelector('.image-provider-name')?.value.trim() || '';
    provider.adapter = card.querySelector('.image-provider-adapter')?.value === 'seedream' ? 'seedream' : 'openai-images';
    provider.baseUrl = card.querySelector('.image-provider-base-url')?.value.trim() || '';
    provider.apiKey = card.querySelector('.image-provider-key')?.value.trim() || '';
    provider.enabled = card.querySelector('.image-provider-enabled')?.checked !== false;
    card.querySelectorAll('.image-model-card').forEach(modelCard => {
      const model = provider.models.find(item => item.id === modelCard.dataset.modelId);
      if (!model) return;
      model.upstreamId = modelCard.querySelector('.image-model-upstream')?.value.trim() || '';
      model.name = modelCard.querySelector('.image-model-name')?.value.trim() || model.upstreamId;
      model.enabled = modelCard.querySelector('.image-model-enabled')?.checked !== false;
      model.testPrompt = modelCard.querySelector('.image-test-prompt')?.value || model.testPrompt || '';
      modelCard.querySelectorAll('[data-capability]').forEach(input => { model.capabilities[input.dataset.capability] = input.checked; });
      modelCard.querySelectorAll('[data-capability-number]').forEach(input => { model.capabilities[input.dataset.capabilityNumber] = Number(input.value) || 0; });
      modelCard.querySelectorAll('[data-capability-list]').forEach(input => { model.capabilities[input.dataset.capabilityList] = splitList(input.value); });
      modelCard.querySelectorAll('[data-default]').forEach(input => { model.defaults[input.dataset.default] = input.value.trim(); });
      modelCard.querySelectorAll('[data-default-number]').forEach(input => { model.defaults[input.dataset.defaultNumber] = Number(input.value) || 1; });
      modelCard.querySelectorAll('[data-default-bool]').forEach(input => { model.defaults[input.dataset.defaultBool] = input.checked; });
      const selected = modelCard.querySelector('input[name="defaultImageModel"]:checked');
      if (selected) defaultModelRef = selected.value;
    });
  });
}

function draftProvider(provider) {
  return {
    id: provider.id, name: provider.name, adapter: provider.adapter, baseUrl: provider.baseUrl,
    apiKey: provider.apiKey || '', enabled: provider.enabled !== false,
    models: provider.models.map(model => ({
      id: model.id, upstreamId: model.upstreamId, name: model.name, enabled: model.enabled !== false,
      capabilities: model.capabilities, defaults: model.defaults,
    })),
  };
}

async function connectionTest(provider, model) {
  const key = testKey(provider.id, model.id, 'connection');
  testStates.set(key, { status: 'running', message: '正在测试…' });
  render();
  try {
    const response = await apiFetch('/api/ai/image-providers/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: draftProvider(provider), modelId: model.id }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '连接测试失败');
    testStates.set(key, { status: 'success', message: data.message || '连接成功', httpStatus: data.status, durationMs: data.durationMs });
  } catch (error) {
    testStates.set(key, { status: 'error', message: error.message || '连接测试失败' });
  }
  render();
}

async function testGeneration(provider, model, prompt) {
  const key = testKey(provider.id, model.id, 'generation');
  const existing = testControllers.get(key);
  if (existing) {
    existing.abort();
    testControllers.delete(key);
    testStates.set(key, { status: 'error', message: '已取消试生图' });
    render();
    return;
  }
  if (!globalThis.confirm('试生图会调用外部接口并可能产生费用，是否继续？')) return;
  const controller = new AbortController();
  testControllers.set(key, controller);
  testStates.set(key, { status: 'running', message: '正在生成测试图片…' });
  render();
  try {
    const response = await apiFetch('/api/ai/image-providers/test-generation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ provider: draftProvider(provider), modelId: model.id, prompt, confirmed: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '试生图失败');
    testStates.set(key, { status: 'success', message: `生成成功 · ${data.provider} · ${data.model}`, durationMs: data.durationMs, url: data.url });
  } catch (error) {
    testStates.set(key, { status: 'error', message: error.name === 'AbortError' ? '已取消试生图' : (error.message || '试生图失败') });
  } finally {
    testControllers.delete(key);
    render();
  }
}

async function fetchModels(provider) {
  if (provider.adapter !== 'openai-images') {
    showToast('Seedream 请手动添加模型，当前协议没有低成本模型目录。', 'error');
    return;
  }
  try {
    const response = await apiFetch('/api/ai/image-providers/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: draftProvider(provider), modelId: provider.models[0]?.id }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '获取模型失败');
    const existing = new Set(provider.models.map(item => item.upstreamId));
    const additions = (data.models || []).filter(id => !existing.has(id)).slice(0, MAX_MODELS - provider.models.length);
    provider.models.push(...additions.map(id => blankModel(provider.adapter, id, id)));
    expanded.add(provider.id);
    render();
    showToast(additions.length ? `已添加 ${additions.length} 个模型` : '没有发现新模型', 'success');
  } catch (error) {
    showToast(error.message || '获取模型失败', 'error');
  }
}

async function handleAction(button, card) {
  syncFromDom();
  const index = Number(card.dataset.providerIndex);
  const provider = providers[index];
  if (!provider) return;
  expanded.add(provider.id);
  const action = button.dataset.imageAction;
  const modelIndex = Number(button.dataset.modelIndex);
  const model = provider.models[modelIndex];
  if (action === 'add-model') provider.models.push(blankModel(provider.adapter));
  if (action === 'remove-model' && model) provider.models.splice(modelIndex, 1);
  if (action === 'remove-provider') providers.splice(index, 1);
  if (action === 'duplicate-provider') {
    const copy = structuredClone(provider);
    copy.id = uid('ip'); copy.name = `${copy.name} 副本`; copy.apiKey = ''; copy.apiKeyConfigured = false;
    copy.models.forEach(item => { item.id = uid('im'); });
    providers.splice(index + 1, 0, copy); expanded.add(copy.id);
  }
  if (action === 'move-up' && index > 0) [providers[index - 1], providers[index]] = [providers[index], providers[index - 1]];
  if (action === 'move-down' && index < providers.length - 1) [providers[index + 1], providers[index]] = [providers[index], providers[index + 1]];
  if (action === 'fetch-models') return fetchModels(provider);
  if (action === 'test' && model) return connectionTest(provider, model);
  if (action === 'generate' && model) {
    const prompt = card.querySelector(`.image-model-card[data-model-id="${CSS.escape(model.id)}"] .image-test-prompt`)?.value.trim() || '';
    if (!prompt) return showToast('请填写试生图提示词', 'error');
    return testGeneration(provider, model, prompt);
  }
  if (!providers.some(item => item.models.some(entry => modelRef(item, entry) === defaultModelRef))) {
    const firstProvider = providers.find(item => item.enabled && item.models.some(modelItem => modelItem.enabled));
    const firstModel = firstProvider?.models.find(item => item.enabled);
    defaultModelRef = firstProvider && firstModel ? modelRef(firstProvider, firstModel) : '';
  }
  render();
}

export function bindImageProviderSettings() {
  if (bound) return;
  const root = document.querySelector('#imageProvidersSettings');
  if (!root) return;
  bound = true;
  root.addEventListener('toggle', event => {
    const capabilities = event.target.closest?.('.image-model-capabilities');
    if (capabilities?.dataset.capabilityKey) {
      if (capabilities.open) capabilityExpanded.add(capabilities.dataset.capabilityKey);
      else capabilityExpanded.delete(capabilities.dataset.capabilityKey);
      return;
    }
    const card = event.target.closest?.('.image-provider-card');
    if (!card) return;
    if (card.open) expanded.add(card.dataset.providerId); else expanded.delete(card.dataset.providerId);
  }, true);
  root.addEventListener('click', event => {
    const add = event.target.closest('[data-image-add]');
    if (add) {
      syncFromDom();
      if (providers.length >= MAX_PROVIDERS) return showToast(`最多 ${MAX_PROVIDERS} 个生图供应商`, 'error');
      const provider = providerTemplate(add.dataset.imageAdd);
      providers.push(provider); expanded.add(provider.id);
      if (!defaultModelRef && provider.models[0]) defaultModelRef = modelRef(provider, provider.models[0]);
      render();
      return;
    }
    const button = event.target.closest('[data-image-action]');
    const card = event.target.closest('.image-provider-card');
    if (button && card) handleAction(button, card);
  });
  root.addEventListener('change', event => {
    const card = event.target.closest('.image-provider-card');
    if (!card) return;
    const provider = providers.find(item => item.id === card.dataset.providerId);
    if (!provider) return;
    syncFromDom();
    if (event.target.matches('.image-provider-adapter')) {
      provider.models.forEach(model => { model.capabilities = conservativeCaps(provider.adapter, model.upstreamId); });
      render();
      return;
    }
    if (event.target.matches('.image-model-upstream')) {
      const modelCard = event.target.closest('.image-model-card');
      const model = provider.models.find(item => item.id === modelCard?.dataset.modelId);
      if (model) {
        model.capabilities = conservativeCaps(provider.adapter, model.upstreamId);
        if (!model.name) model.name = model.upstreamId;
        render();
      }
    }
  });
}

export function loadImageProviderSettings(settings = {}) {
  providers = (settings.imageProviders || []).map(cloneSettingsProvider);
  defaultModelRef = settings.defaultImageModelRef || '';
  expanded.clear();
  capabilityExpanded.clear();
  testStates.clear();
  if (providers[0]) expanded.add(providers[0].id);
  render();
  bindImageProviderSettings();
}

export function readImageProviderSettings() {
  syncFromDom();
  const clean = providers.map(draftProvider)
    .map(provider => ({ ...provider, models: provider.models.filter(model => model.upstreamId && model.name) }))
    .filter(provider => provider.name && provider.baseUrl && provider.models.length);
  return { imageProvidersVersion: 1, imageProviders: clean, defaultImageModelRef: defaultModelRef };
}

export function describeImageSelection(settings = {}, args = {}) {
  const list = settings.imageProviders || [];
  const explicit = args.modelRef || args.model;
  let pair = null;
  for (const provider of list) {
    const model = (provider.models || []).find(item => explicit
      ? modelRef(provider, item) === explicit || item.upstreamId === explicit
      : modelRef(provider, item) === settings.defaultImageModelRef);
    if (model) { pair = { provider, model }; break; }
  }
  return pair ? `${pair.provider.name} · ${pair.model.name || pair.model.upstreamId}` : '按能力自动选择';
}
