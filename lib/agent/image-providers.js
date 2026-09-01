const crypto = require('crypto');
const { validateProviderBaseUrl, normalizeBaseUrl } = require('./custom-providers');
const {
  SEEDREAM_PRO_MODEL,
  SEEDREAM_LITE_MODEL,
  SEEDREAM_45_MODEL,
  SEEDREAM_40_MODEL,
  SEEDREAM_MODEL_PROFILES,
} = require('./seedream');
const { GETOKEN_MODELS } = require('./getoken');

const IMAGE_PROVIDERS_VERSION = 1;
const IMAGE_ADAPTERS = new Set(['seedream', 'openai-images']);
const MAX_IMAGE_PROVIDERS = 32;
const MAX_IMAGE_MODELS = 200;
const MAX_OUTPUTS = 15;
const MAX_REFERENCES = 14;
const IMAGE_REF_PATTERN = /^image\/(ip_[a-z0-9_-]{1,40})\/(im_[a-z0-9_-]{1,48})$/;
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:+/-]{1,160}$/;

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function providerId(value, fallbackSeed = '') {
  const text = String(value || '').trim().toLowerCase();
  return /^ip_[a-z0-9_-]{1,40}$/.test(text) ? text : `ip_${shortHash(fallbackSeed || crypto.randomUUID())}`;
}

function modelInternalId(value, fallbackSeed = '') {
  const text = String(value || '').trim().toLowerCase();
  return /^im_[a-z0-9_-]{1,48}$/.test(text) ? text : `im_${shortHash(fallbackSeed || crypto.randomUUID())}`;
}

function imageModelRef(provider, model) {
  return `image/${provider.id}/${model.id}`;
}

function listOfStrings(value, max = 32) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const text = String(entry || '').trim().slice(0, 40);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

function conservativeCapabilities() {
  return {
    textToImage: true,
    imageEdit: false,
    maxOutputs: 1,
    maxReferences: 0,
    sizes: [],
    qualities: [],
    outputFormats: [],
    customSize: false,
    transparentBackground: false,
    watermark: false,
    sequential: false,
    layerDecomposition: false,
    webSearch: false,
    promptOptimization: false,
    streaming: false,
  };
}

function knownCapabilities(adapter, upstreamId) {
  if (adapter === 'seedream') {
    const profile = SEEDREAM_MODEL_PROFILES[upstreamId];
    if (!profile) return null;
    return {
      textToImage: true,
      imageEdit: true,
      maxOutputs: profile.sequential ? 15 : 1,
      maxReferences: profile.maxReferenceImages,
      sizes: [...profile.sizeKeywords],
      qualities: [],
      outputFormats: profile.outputFormat ? ['jpeg', 'png'] : ['jpeg'],
      customSize: true,
      transparentBackground: profile.background,
      watermark: true,
      sequential: profile.sequential,
      layerDecomposition: profile.layerDecomposition,
      webSearch: profile.webSearch,
      promptOptimization: true,
      streaming: profile.stream,
    };
  }
  if (adapter === 'openai-images' && GETOKEN_MODELS.some(item => item.id === upstreamId)) {
    return {
      ...conservativeCapabilities(),
      imageEdit: true,
      maxOutputs: 4,
      maxReferences: 4,
      sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
      qualities: ['standard', 'high'],
      outputFormats: ['png'],
    };
  }
  return null;
}

function normalizeCapabilities(value, preset = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = preset || conservativeCapabilities();
  const integer = (field, fallback, max) => {
    const n = Number(source[field]);
    return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : fallback;
  };
  return {
    textToImage: source.textToImage === undefined ? base.textToImage !== false : source.textToImage === true,
    imageEdit: source.imageEdit === undefined ? base.imageEdit === true : source.imageEdit === true,
    maxOutputs: integer('maxOutputs', base.maxOutputs || 1, MAX_OUTPUTS),
    maxReferences: integer('maxReferences', base.maxReferences || 0, MAX_REFERENCES),
    sizes: source.sizes === undefined ? [...(base.sizes || [])] : listOfStrings(source.sizes),
    qualities: source.qualities === undefined ? [...(base.qualities || [])] : listOfStrings(source.qualities),
    outputFormats: source.outputFormats === undefined ? [...(base.outputFormats || [])] : listOfStrings(source.outputFormats),
    customSize: source.customSize === undefined ? base.customSize === true : source.customSize === true,
    transparentBackground: source.transparentBackground === undefined ? base.transparentBackground === true : source.transparentBackground === true,
    watermark: source.watermark === undefined ? base.watermark === true : source.watermark === true,
    sequential: source.sequential === undefined ? base.sequential === true : source.sequential === true,
    layerDecomposition: source.layerDecomposition === undefined ? base.layerDecomposition === true : source.layerDecomposition === true,
    webSearch: source.webSearch === undefined ? base.webSearch === true : source.webSearch === true,
    promptOptimization: source.promptOptimization === undefined ? base.promptOptimization === true : source.promptOptimization === true,
    streaming: source.streaming === undefined ? base.streaming === true : source.streaming === true,
  };
}

function normalizeDefaults(value, capabilities) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const choose = (field, allowed) => {
    const text = String(source[field] || '').trim().slice(0, 40);
    if (field === 'size' && capabilities.customSize && /^\d{3,5}x\d{3,5}$/i.test(text)) return text;
    return allowed.includes(text) ? text : '';
  };
  const count = Math.min(Math.max(1, Number(source.count) || 1), Math.max(1, capabilities.maxOutputs));
  return {
    size: choose('size', capabilities.sizes),
    quality: choose('quality', capabilities.qualities),
    count: Math.round(count),
    outputFormat: choose('outputFormat', capabilities.outputFormats),
    background: source.background === 'transparent' && capabilities.transparentBackground ? 'transparent' : 'opaque',
    watermark: capabilities.watermark ? source.watermark !== false : false,
    promptOptimization: source.promptOptimization === 'fast' ? 'fast' : 'standard',
    webSearch: capabilities.webSearch && source.webSearch === true,
    streaming: capabilities.streaming && source.streaming !== false,
  };
}

function normalizeImageModel(raw, adapter, seed) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const upstreamId = String(source.upstreamId || source.model || source.modelId || '').trim().slice(0, 160);
  if (!MODEL_ID_PATTERN.test(upstreamId)) return null;
  const capabilities = normalizeCapabilities(source.capabilities, knownCapabilities(adapter, upstreamId));
  return {
    id: modelInternalId(source.id, `${seed}:${upstreamId}`),
    upstreamId,
    name: String(source.name || upstreamId).trim().slice(0, 160) || upstreamId,
    enabled: source.enabled !== false,
    capabilities,
    defaults: normalizeDefaults(source.defaults, capabilities),
    ...(typeof source.legacyEnvVar === 'string' ? { legacyEnvVar: source.legacyEnvVar.slice(0, 80) } : {}),
  };
}

function normalizeImageProviderSync(raw, existing = null, index = 0) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const adapter = IMAGE_ADAPTERS.has(source.adapter) ? source.adapter : (existing?.adapter || 'openai-images');
  const id = providerId(source.id, `${adapter}:${source.name || index}:${source.baseUrl || ''}`);
  const baseUrl = normalizeBaseUrl(source.baseUrl ?? existing?.baseUrl);
  const modelsSource = Array.isArray(source.models) ? source.models : (existing?.models || []);
  const models = [];
  const seen = new Set();
  for (const rawModel of modelsSource.slice(0, MAX_IMAGE_MODELS)) {
    const model = normalizeImageModel(rawModel, adapter, id);
    if (!model || seen.has(model.id) || [...seen].some(key => key.endsWith(`:${model.upstreamId}`))) continue;
    seen.add(model.id);
    seen.add(`upstream:${model.upstreamId}`);
    models.push(model);
  }
  if (!baseUrl || !models.length) return null;
  return {
    id,
    name: String(source.name || existing?.name || '生图供应商').trim().slice(0, 80) || '生图供应商',
    adapter,
    baseUrl,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim().slice(0, 500) : (existing?.apiKey || ''),
    enabled: source.enabled !== false,
    models,
  };
}

function sanitizeImageProvidersSync(input, current = []) {
  const source = Array.isArray(input) ? input : [];
  const currentById = new Map((Array.isArray(current) ? current : []).map(item => [item.id, item]));
  const providers = [];
  const seen = new Set();
  source.slice(0, MAX_IMAGE_PROVIDERS).forEach((raw, index) => {
    const existing = currentById.get(raw?.id) || null;
    const provider = normalizeImageProviderSync(raw, existing, index);
    if (!provider || seen.has(provider.id)) return;
    seen.add(provider.id);
    providers.push(provider);
  });
  return providers;
}

function mergeImageProviderSecrets(input, current = []) {
  if (!Array.isArray(input)) return current;
  const currentById = new Map((current || []).map(item => [item.id, item]));
  return input.map(raw => {
    if (!raw || typeof raw !== 'object') return raw;
    const existing = currentById.get(raw.id);
    const sameIdentity = existing
      && existing.adapter === raw.adapter
      && normalizeBaseUrl(existing.baseUrl) === normalizeBaseUrl(raw.baseUrl);
    return {
      ...raw,
      apiKey: typeof raw.apiKey === 'string' && raw.apiKey.trim()
        ? raw.apiKey.trim()
        : (sameIdentity ? existing.apiKey || '' : ''),
    };
  });
}

async function normalizeImageProviders(input, current = []) {
  const providers = sanitizeImageProvidersSync(mergeImageProviderSecrets(input, current), current);
  const oldById = new Map((current || []).map(item => [item.id, item]));
  for (const provider of providers) {
    const old = oldById.get(provider.id);
    if (!old || old.adapter !== provider.adapter || normalizeBaseUrl(old.baseUrl) !== provider.baseUrl) {
      const check = await validateProviderBaseUrl(provider.baseUrl);
      if (check.error) {
        const error = new Error(check.error);
        error.status = 400;
        throw error;
      }
      provider.baseUrl = check.value;
    }
  }
  return providers;
}

function seedreamModelsFromLegacy(source) {
  const legacyDefaults = {
    size: source.seedreamSize || '2K',
    count: source.seedreamSequential === 'auto' ? source.seedreamMaxImages || 1 : 1,
    outputFormat: source.seedreamOutputFormat || 'jpeg',
    background: source.seedreamBackground || 'opaque',
    watermark: source.seedreamWatermark !== false,
    promptOptimization: source.seedreamOptimizePromptMode || 'standard',
    webSearch: source.seedreamWebSearch === true,
    streaming: source.seedreamStream !== false,
  };
  return [
    [SEEDREAM_PRO_MODEL, 'Seedream 5.0 Pro'],
    [SEEDREAM_LITE_MODEL, 'Seedream 5.0 Lite'],
    [SEEDREAM_45_MODEL, 'Seedream 4.5'],
    [SEEDREAM_40_MODEL, 'Seedream 4.0'],
  ].map(([upstreamId, name]) => ({
    id: modelInternalId('', `seedream:${upstreamId}`), upstreamId, name, enabled: true,
    capabilities: knownCapabilities('seedream', upstreamId),
    defaults: upstreamId === source.seedreamModel ? legacyDefaults : {},
    legacyEnvVar: 'SEEDREAM_API_KEY',
  }));
}

function migrateLegacyImageProviders(source = {}) {
  if (Number(source.imageProvidersVersion) >= IMAGE_PROVIDERS_VERSION && Array.isArray(source.imageProviders)) {
    const providers = sanitizeImageProvidersSync(source.imageProviders, source.imageProviders);
    return {
      imageProvidersVersion: IMAGE_PROVIDERS_VERSION,
      imageProviders: providers,
      defaultImageModelRef: resolveDefaultRef(providers, source.defaultImageModelRef),
    };
  }
  const seedreamProvider = normalizeImageProviderSync({
    id: 'ip_seedream', name: 'Seedream', adapter: 'seedream',
    baseUrl: process.env.SEEDREAM_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: source.seedreamApiKey || '', enabled: true,
    models: seedreamModelsFromLegacy(source),
  });
  const getokenDefinitions = GETOKEN_MODELS.map((definition, index) => ({
    definition,
    key: String(source[definition.keyField] || ''),
    defaults: definition.id === source.getokenModel ? {
      size: source.getokenSize || 'auto', quality: source.getokenQuality || 'high', count: source.getokenN || 1,
    } : {},
    index,
  }));
  const groups = new Map();
  for (const entry of getokenDefinitions) {
    const groupKey = entry.key ? `key:${shortHash(entry.key)}` : 'empty';
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(entry);
  }
  const getokenProviders = [...groups.values()].map((entries, groupIndex) => normalizeImageProviderSync({
    id: `ip_getoken_${groupIndex + 1}`,
    name: groups.size === 1 ? 'Getoken' : `Getoken ${groupIndex + 1}`,
    adapter: 'openai-images',
    baseUrl: process.env.GETOKEN_BASE_URL || 'https://api.getoken.tech',
    apiKey: entries[0].key,
    enabled: true,
    models: entries.map(({ definition, defaults }) => ({
      id: modelInternalId('', `getoken:${definition.id}`),
      upstreamId: definition.id,
      name: definition.label,
      enabled: true,
      capabilities: knownCapabilities('openai-images', definition.id),
      defaults,
      legacyEnvVar: definition.envVar,
    })),
  }, null, groupIndex)).filter(Boolean);
  const providers = [seedreamProvider, ...getokenProviders].filter(Boolean);
  const preferredAdapter = source.imageProvider === 'getoken' ? 'openai-images' : 'seedream';
  const preferredUpstream = preferredAdapter === 'seedream' ? source.seedreamModel : source.getokenModel;
  const preferredProvider = providers.find(item => item.adapter === preferredAdapter
    && item.models.some(model => model.upstreamId === preferredUpstream));
  const preferredModel = preferredProvider?.models.find(model => model.upstreamId === preferredUpstream);
  return {
    imageProvidersVersion: IMAGE_PROVIDERS_VERSION,
    imageProviders: providers,
    defaultImageModelRef: preferredProvider && preferredModel
      ? imageModelRef(preferredProvider, preferredModel)
      : resolveDefaultRef(providers, ''),
  };
}

function resolveDefaultRef(providers, requested) {
  const resolved = resolveImageModel({ imageProviders: providers }, requested);
  if (resolved && resolved.provider.enabled && resolved.model.enabled) return imageModelRef(resolved.provider, resolved.model);
  for (const provider of providers || []) {
    const model = (provider.models || []).find(item => item.enabled);
    if (provider.enabled && model) return imageModelRef(provider, model);
  }
  return '';
}

function resolveImageModel(settings, refOrUpstream) {
  const providers = Array.isArray(settings?.imageProviders) ? settings.imageProviders : [];
  const text = String(refOrUpstream || '').trim();
  const match = IMAGE_REF_PATTERN.exec(text);
  if (match) {
    const provider = providers.find(item => item.id === match[1]);
    const model = provider?.models?.find(item => item.id === match[2]);
    return provider && model ? { provider, model, modelRef: imageModelRef(provider, model) } : null;
  }
  if (!text) return null;
  const matches = [];
  for (const provider of providers) {
    for (const model of provider.models || []) {
      if (model.upstreamId === text) matches.push({ provider, model, modelRef: imageModelRef(provider, model) });
    }
  }
  if (matches.length > 1) {
    const error = new Error('Image model id is ambiguous; use modelRef');
    error.code = 'AMBIGUOUS_IMAGE_MODEL';
    throw error;
  }
  return matches[0] || null;
}

function requestedCapabilities(args = {}) {
  const images = args.images ?? args.image;
  const imageCount = Array.isArray(images) ? images.length : (images ? 1 : 0);
  const count = Math.max(1, Number(args.count ?? args.n ?? args.batch_size ?? args.max_images) || 1);
  return {
    imageCount,
    count,
    transparentBackground: args.background === 'transparent',
    layerDecomposition: args.layerDecomposition === true || args.layer_decomposition === true,
    webSearch: args.webSearch === true || args.web_search === true,
  };
}

function modelSupports(model, requirements) {
  const caps = model.capabilities || conservativeCapabilities();
  if (!caps.textToImage) return false;
  if (requirements.imageCount && (!caps.imageEdit || requirements.imageCount > caps.maxReferences)) return false;
  if (requirements.count > Math.max(1, caps.maxOutputs)) return false;
  if (requirements.transparentBackground && !caps.transparentBackground) return false;
  if (requirements.layerDecomposition && !caps.layerDecomposition) return false;
  if (requirements.webSearch && !caps.webSearch) return false;
  return true;
}

function routeImageModel(settings, args = {}) {
  const requirements = requestedCapabilities(args);
  const explicit = args.modelRef || args.model || '';
  if (explicit) {
    const selected = resolveImageModel(settings, explicit);
    if (!selected) throw new Error('Configured image model was not found');
    if (!selected.provider.enabled || !selected.model.enabled) throw new Error('Selected image model is disabled');
    if (!modelSupports(selected.model, requirements)) throw new Error('Selected image model does not support the requested capabilities');
    return selected;
  }
  const preferred = resolveImageModel(settings, settings.defaultImageModelRef);
  if (preferred && preferred.provider.enabled && preferred.model.enabled && modelSupports(preferred.model, requirements)) return preferred;
  for (const provider of settings.imageProviders || []) {
    if (!provider.enabled) continue;
    const model = (provider.models || []).find(item => item.enabled && modelSupports(item, requirements));
    if (model) return { provider, model, modelRef: imageModelRef(provider, model) };
  }
  throw new Error('No enabled image model supports the requested capabilities. Update Settings → Image.');
}

function publicImageProviders(providers = [], envLookup = () => '') {
  return providers.map(provider => ({
    id: provider.id,
    name: provider.name,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled !== false,
    apiKeyConfigured: Boolean(provider.apiKey || provider.models?.some(model => model.legacyEnvVar && envLookup(model.legacyEnvVar))),
    models: (provider.models || []).map(model => ({
      id: model.id,
      upstreamId: model.upstreamId,
      name: model.name,
      enabled: model.enabled !== false,
      capabilities: model.capabilities,
      defaults: model.defaults,
    })),
  }));
}

module.exports = {
  IMAGE_PROVIDERS_VERSION,
  IMAGE_ADAPTERS,
  MAX_OUTPUTS,
  MAX_REFERENCES,
  conservativeCapabilities,
  knownCapabilities,
  normalizeCapabilities,
  normalizeImageProviderSync,
  sanitizeImageProvidersSync,
  normalizeImageProviders,
  mergeImageProviderSecrets,
  migrateLegacyImageProviders,
  resolveDefaultRef,
  resolveImageModel,
  routeImageModel,
  imageModelRef,
  publicImageProviders,
};
