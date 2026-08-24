const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('../util/json-file');

const MARKER_FILE = '.builtin-providers-migrated.json';
const CAPABILITIES_MARKER_FILE = '.builtin-providers-capabilities.json';
const OPENROUTER_STYLE_MODEL = /^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._:+-]{0,119}$/i;

// v2: per-model capability overrides for cards still matching the v1
// auto-generated shape (user-edited cards are left alone).
const V2_MODEL_CAPABILITY_OVERRIDES = {
  DeepSeek: {
    'deepseek-v4-flash-vision-exp': { supportsMedia: true },
  },
  Kimi: {
    'kimi-k3': { thinking: 'k3' },
    'kimi-k2.7-code': { thinking: 'fixed' },
    'kimi-k2.6': { thinking: 'optional' },
  },
};

const BUILTIN_PROVIDER_SPECS = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
    keyField: 'apiKey',
    thinking: 'deepseek',
    supportsMedia: false,
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek Pro' },
      { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek Flash Vision' },
    ],
  },
  {
    key: 'moonshot',
    name: 'Kimi',
    baseUrlEnv: 'MOONSHOT_BASE_URL',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    keyField: 'moonshotApiKey',
    thinking: 'optional',
    supportsMedia: true,
    models: [
      { id: 'kimi-k3', name: 'Kimi K3' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6' },
    ],
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyField: 'openrouterApiKey',
    thinking: '',
    supportsMedia: false,
    models: [],
  },
];

function generateProviderId() {
  return `p_${crypto.randomBytes(4).toString('hex')}`;
}

function isOpenRouterStyleModel(model) {
  const value = String(model || '');
  return OPENROUTER_STYLE_MODEL.test(value);
}

function providerBaseUrl(spec) {
  const fromEnv = typeof process.env[spec.baseUrlEnv] === 'string' ? process.env[spec.baseUrlEnv].trim() : '';
  return (fromEnv || spec.defaultBaseUrl).replace(/\/+$/, '');
}

/**
 * One-time conversion of built-in provider keys into custom provider entries.
 * envSecrets applies server-wide env keys to the legacy (root) database only.
 */
function ensureBuiltinProvidersMigrated(db, { envSecrets = {} } = {}) {
  const markerPath = path.join(db.dataDir, MARKER_FILE);
  if (fs.existsSync(markerPath)) return { skipped: true, migrated: 0 };

  let settings;
  try {
    settings = db.getAiSettings();
  } catch {
    return { skipped: true, error: 'ai-settings.json unreadable', migrated: 0 };
  }

  const providers = (Array.isArray(settings.customProviders) ? settings.customProviders : []).map(item => ({ ...item }));
  const existingNames = new Set(providers.map(item => item.name));
  const currentModel = String(settings.model || '');
  let nextModel = currentModel;
  let migrated = 0;

  for (const spec of BUILTIN_PROVIDER_SPECS) {
    const storedKey = typeof settings[spec.keyField] === 'string' ? settings[spec.keyField].trim() : '';
    const envKey = typeof envSecrets[spec.key] === 'string' ? envSecrets[spec.key].trim() : '';
    const key = storedKey || envKey;
    if (!key) continue;
    if (existingNames.has(spec.name)) continue;

    const isCurrentBuiltin = spec.models.some(model => model.id === currentModel);
    const isCurrentOpenRouter = spec.key === 'openrouter' && isOpenRouterStyleModel(currentModel);
    const models = spec.models.map(model => ({ ...model }));
    if (isCurrentOpenRouter && !models.some(model => model.id === currentModel)) {
      models.unshift({ id: currentModel, name: currentModel });
    }

    const provider = {
      id: generateProviderId(),
      name: spec.name,
      baseUrl: providerBaseUrl(spec),
      apiFormat: 'openai',
      apiKey: key,
      supportsMedia: spec.supportsMedia === true,
      thinking: spec.thinking,
      zdr: spec.key === 'openrouter' ? settings.openrouterZdrEnabled === true : false,
      models,
    };
    providers.push(provider);
    existingNames.add(spec.name);
    migrated += 1;
    if (isCurrentBuiltin || isCurrentOpenRouter) {
      nextModel = `custom/${provider.id}/${currentModel}`;
    }
  }

  const currentWasBuiltinOrOpenRouter = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'].includes(currentModel)
    || isOpenRouterStyleModel(currentModel);
  if (nextModel === currentModel && currentWasBuiltinOrOpenRouter) {
    // The current model referenced a provider that was not migrated (no key
    // anywhere); clear it so the UI shows the unconfigured guide instead of a
    // stale built-in id that no longer appears in the model select.
    nextModel = '';
  }

  if (migrated || nextModel !== currentModel) {
    db.saveAiSettings({ ...settings, model: nextModel, customProviders: providers });
  }
  atomicWriteJson(markerPath, {
    version: 1,
    migratedAt: new Date().toISOString(),
    migrated,
  });
  return { skipped: false, migrated };
}

function stripTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function modelLooksUntouched(model) {
  return !('supportsMedia' in model) && !('thinking' in model) && !('zdr' in model);
}

function providerLooksV1Generated(provider, spec) {
  if (!provider || typeof provider !== 'object') return false;
  if (stripTrailingSlashes(provider.baseUrl) !== stripTrailingSlashes(providerBaseUrl(spec))) return false;
  if ((provider.apiFormat || 'openai') !== 'openai') return false;
  if ((provider.thinking || '') !== (spec.thinking || '')) return false;
  const specIds = new Set(spec.models.map(model => model.id));
  const modelIds = new Set((provider.models || []).map(model => model.id));
  if (specIds.size !== modelIds.size) return false;
  for (const id of specIds) {
    if (!modelIds.has(id)) return false;
  }
  return (provider.models || []).every(model => modelLooksUntouched(model));
}

/**
 * v2: restore per-model capability differences lost by the v1 provider-level
 * migration (DeepSeek vision model, Kimi per-model thinking). Only cards that
 * still exactly match the v1 auto-generated shape are updated; the encrypted
 * settings file is backed up before the rewrite.
 */
function migrateBuiltinProviderModelCapabilities(db) {
  const markerPath = path.join(db.dataDir, CAPABILITIES_MARKER_FILE);
  if (fs.existsSync(markerPath)) return { skipped: true, changed: false };

  let settings;
  try {
    settings = db.getAiSettings();
  } catch {
    return { skipped: true, changed: false, error: 'ai-settings.json unreadable' };
  }

  const providers = (Array.isArray(settings.customProviders) ? settings.customProviders : []).map(item => ({ ...item }));
  let changed = false;
  for (const spec of BUILTIN_PROVIDER_SPECS) {
    const overrides = V2_MODEL_CAPABILITY_OVERRIDES[spec.name];
    if (!overrides) continue;
    const provider = providers.find(item => item && item.name === spec.name);
    if (!providerLooksV1Generated(provider, spec)) continue;
    provider.models = (provider.models || []).map(model => {
      const next = { ...model };
      const override = overrides[next.id];
      if (override && modelLooksUntouched(next)) Object.assign(next, override);
      return next;
    });
    changed = true;
  }

  if (changed) {
    try {
      atomicWriteJson(path.join(db.dataDir, 'ai-settings.pre-capabilities.bak'), settings);
    } catch {}
    db.saveAiSettings({ ...settings, customProviders: providers });
  }
  atomicWriteJson(markerPath, { version: 1, migratedAt: new Date().toISOString(), changed });
  return { skipped: false, changed };
}

module.exports = {
  ensureBuiltinProvidersMigrated,
  migrateBuiltinProviderModelCapabilities,
  BUILTIN_PROVIDER_SPECS,
  isOpenRouterStyleModel,
};
