const crypto = require('crypto');
const dns = require('dns');
const { promisify } = require('util');
const { isPrivateIpLiteral } = require('../net/ssrf');

const dnsLookup = promisify(dns.lookup);

const MAX_MODELS_PER_PROVIDER = 200;
const CUSTOM_MODEL_ID_PATTERN = /^custom\/([a-z0-9_-]{1,32})\/([a-zA-Z0-9._:+/-]{1,160})$/;
const ALLOWED_API_FORMATS = new Set(['openai', 'anthropic', 'responses']);
const ALLOWED_THINKING_STYLES = new Set(['', 'deepseek', 'k3', 'optional', 'fixed']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function generateProviderId() {
  return `p_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  return text.slice(0, 500);
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return isPrivateIpLiteral(host) && (host === '127.0.0.1' || host === '::1' || host.startsWith('127.'));
}

function isPrivateOrLoopbackHostname(hostname) {
  return isLoopbackHostname(hostname) || isPrivateIpLiteral(hostname);
}

async function validateProviderBaseUrl(url) {
  const normalized = normalizeBaseUrl(url);
  if (!normalized) return { error: 'Base URL is required' };
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return { error: 'Invalid base URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'Base URL must use http or https' };
  }
  if (parsed.username || parsed.password) {
    return { error: 'Base URL must not include credentials' };
  }
  const hostname = parsed.hostname;
  if (parsed.protocol === 'http:') {
    if (!isPrivateOrLoopbackHostname(hostname)) {
      return { error: 'HTTP base URL is only allowed for localhost or private network addresses' };
    }
    return { value: normalized };
  }
  if (isPrivateOrLoopbackHostname(hostname)) {
    return { value: normalized };
  }
  try {
    await dnsLookup(hostname, { all: true });
  } catch {
    return { error: 'Base URL hostname could not be resolved' };
  }
  return { value: normalized };
}

function normalizeModelEntry(raw = {}) {
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 160) : '';
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim().slice(0, 160)
    : id;
  if (!id) return null;
  if (!/^[a-zA-Z0-9._:+/-]+$/.test(id)) return null;
  return { id, name: name || id };
}

function normalizeCustomProvider(raw = {}, existing = null) {
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
  const baseUrl = normalizeBaseUrl(raw.baseUrl ?? existing?.baseUrl);
  const apiFormat = ALLOWED_API_FORMATS.has(raw.apiFormat) ? raw.apiFormat : (existing?.apiFormat || 'openai');
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim().slice(0, 500) : (existing?.apiKey || '');
  const supportsMedia = typeof raw.supportsMedia === 'boolean' ? raw.supportsMedia : Boolean(existing?.supportsMedia);
  const thinking = ALLOWED_THINKING_STYLES.has(raw.thinking) ? raw.thinking : (existing?.thinking || '');
  const zdr = typeof raw.zdr === 'boolean' ? raw.zdr : Boolean(existing?.zdr);
  const modelsSource = Array.isArray(raw.models) ? raw.models : (existing?.models || []);
  const seen = new Set();
  const models = [];
  for (const entry of modelsSource.slice(0, MAX_MODELS_PER_PROVIDER)) {
    const model = normalizeModelEntry(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (!name || !baseUrl) return null;
  return {
    id: typeof raw.id === 'string' && /^p_[a-z0-9_-]{1,32}$/.test(raw.id) ? raw.id : (existing?.id || generateProviderId()),
    name,
    baseUrl,
    apiFormat,
    apiKey,
    supportsMedia,
    thinking,
    zdr,
    models,
  };
}

function sanitizeCustomProvidersSync(input, current = []) {
  const source = Array.isArray(input) ? input : (Array.isArray(current) ? current : []);
  const currentById = new Map((Array.isArray(current) ? current : []).map(item => [item.id, item]));
  const next = [];
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    const existing = currentById.get(raw.id) || null;
    const mergedKey = typeof raw.apiKey === 'string' && raw.apiKey.trim()
      ? raw.apiKey.trim().slice(0, 500)
      : existing?.apiKey || '';
    const candidate = normalizeCustomProvider({ ...raw, apiKey: mergedKey }, existing);
    if (!candidate) continue;
    next.push(candidate);
  }
  return next;
}

async function normalizeCustomProviders(input, current = []) {
  const source = Array.isArray(input) ? input : (Array.isArray(current) ? current : []);
  const currentById = new Map((Array.isArray(current) ? current : []).map(item => [item.id, item]));
  const next = [];
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    const existing = currentById.get(raw.id) || null;
    const mergedKey = typeof raw.apiKey === 'string' && raw.apiKey.trim()
      ? raw.apiKey.trim().slice(0, 500)
      : existing?.apiKey || '';
    const candidate = normalizeCustomProvider({ ...raw, apiKey: mergedKey }, existing);
    if (!candidate) continue;
    const unchangedBaseUrl = existing
      && normalizeBaseUrl(candidate.baseUrl) === normalizeBaseUrl(existing.baseUrl);
    const urlCheck = unchangedBaseUrl
      ? { value: normalizeBaseUrl(candidate.baseUrl) }
      : await validateProviderBaseUrl(candidate.baseUrl);
    if (urlCheck.error) {
      const error = new Error(urlCheck.error);
      error.status = 400;
      throw error;
    }
    candidate.baseUrl = urlCheck.value;
    if (candidate.apiFormat === 'anthropic' && !candidate.apiKey) {
      const error = new Error('Anthropic custom endpoints require an API key');
      error.status = 400;
      throw error;
    }
    next.push(candidate);
  }
  return next;
}

function parseCustomModelId(model) {
  const match = CUSTOM_MODEL_ID_PATTERN.exec(String(model || '').trim());
  if (!match) return null;
  return { providerId: match[1], modelId: match[2] };
}

function isCustomModelId(model) {
  return CUSTOM_MODEL_ID_PATTERN.test(String(model || '').trim());
}

function findCustomProvider(settings, providerId) {
  const list = Array.isArray(settings?.customProviders) ? settings.customProviders : [];
  return list.find(item => item.id === providerId) || null;
}

function resolveCustomModel(settings, model) {
  const parsed = parseCustomModelId(model);
  if (!parsed) return null;
  const provider = findCustomProvider(settings, parsed.providerId);
  if (!provider) return null;
  const catalogModel = (provider.models || []).find(item => item.id === parsed.modelId);
  if (!catalogModel) return null;
  return { provider, catalogModel, modelId: parsed.modelId };
}

function buildCustomModelRecords(providers = []) {
  const records = [];
  for (const provider of providers) {
    for (const model of provider.models || []) {
      records.push({
        id: `custom/${provider.id}/${model.id}`,
        name: `${provider.name} · ${model.name || model.id}`,
        source: 'custom',
        provider: 'custom',
        apiFormat: provider.apiFormat || 'openai',
        providerId: provider.id,
        providerName: provider.name,
        supportsMedia: provider.supportsMedia === true,
        thinking: provider.thinking || '',
        zdr: provider.zdr === true,
        contextLength: null,
        inputModalities: provider.supportsMedia === true ? ['text', 'image'] : ['text'],
        outputModalities: ['text'],
        supportedParameters: provider.apiFormat === 'anthropic' ? [] : ['tools'],
        reasoning: { supported: false, supportedEfforts: [], defaultEffort: null, defaultEnabled: null, mandatory: false },
        pricing: { inputPerMillion: null, outputPerMillion: null, image: null, request: null },
      });
    }
  }
  return records;
}

function publicCustomProviders(providers = []) {
  return providers.map(provider => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat || 'openai',
    supportsMedia: provider.supportsMedia === true,
    thinking: provider.thinking || '',
    zdr: provider.zdr === true,
    apiKeyConfigured: Boolean(provider.apiKey),
    models: (provider.models || []).map(model => ({ id: model.id, name: model.name || model.id })),
  }));
}

function isStoredCustomModel(model, settings) {
  return Boolean(resolveCustomModel(settings, model));
}

function mergeCustomProviderSecrets(bodyProviders, currentProviders = []) {
  if (!Array.isArray(bodyProviders)) return currentProviders;
  const currentById = new Map(currentProviders.map(item => [item.id, item]));
  return bodyProviders.map(raw => {
    if (!raw || typeof raw !== 'object') return raw;
    const existing = currentById.get(raw.id);
    const apiKey = typeof raw.apiKey === 'string' && raw.apiKey.trim()
      ? raw.apiKey.trim()
      : (existing?.apiKey || '');
    return { ...raw, apiKey };
  });
}

module.exports = {
  MAX_MODELS_PER_PROVIDER,
  CUSTOM_MODEL_ID_PATTERN,
  ALLOWED_API_FORMATS,
  ALLOWED_THINKING_STYLES,
  parseCustomModelId,
  isCustomModelId,
  normalizeCustomProviders,
  sanitizeCustomProvidersSync,
  validateProviderBaseUrl,
  resolveCustomModel,
  buildCustomModelRecords,
  publicCustomProviders,
  isStoredCustomModel,
  mergeCustomProviderSecrets,
  findCustomProvider,
};
