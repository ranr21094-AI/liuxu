const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('../util/json-file');

const MARKER_FILE = '.builtin-providers-migrated.json';
const OPENROUTER_STYLE_MODEL = /^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._:+-]{0,119}$/i;

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

module.exports = {
  ensureBuiltinProvidersMigrated,
  BUILTIN_PROVIDER_SPECS,
  isOpenRouterStyleModel,
};
