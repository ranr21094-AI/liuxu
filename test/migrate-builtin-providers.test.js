const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDatabase } = require('../database');
const { ensureBuiltinProvidersMigrated, migrateBuiltinProviderModelCapabilities } = require('../lib/agent/migrate-builtin-providers');
const { parseCustomModelId, resolveModelCapability } = require('../lib/agent/custom-providers');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-providers-'));
}

function markerPath(dir) {
  return path.join(dir, '.builtin-providers-migrated.json');
}

test('ensureBuiltinProvidersMigrated converts built-in keys into custom providers', () => {
  const dir = tempDir();
  const db = createDatabase(dir);
  db.saveAiSettings({
    apiKey: 'sk-ds-key',
    moonshotApiKey: 'sk-ms-key',
    openrouterApiKey: 'sk-or-key',
    model: 'deepseek-v4-pro',
    openrouterZdrEnabled: true,
  });

  const result = ensureBuiltinProvidersMigrated(db);
  assert.equal(result.skipped, false);
  assert.equal(result.migrated, 3);

  const settings = db.getAiSettings();
  const byName = new Map(settings.customProviders.map(item => [item.name, item]));
  const deepseek = byName.get('DeepSeek');
  const kimi = byName.get('Kimi');
  const openrouter = byName.get('OpenRouter');
  assert.ok(deepseek && kimi && openrouter);

  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(deepseek.apiFormat, 'openai');
  assert.equal(deepseek.thinking, 'deepseek');
  assert.equal(deepseek.supportsMedia, false);
  assert.deepEqual(deepseek.models.map(model => model.id), ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']);

  assert.equal(kimi.baseUrl, 'https://api.moonshot.cn/v1');
  assert.equal(kimi.thinking, 'optional');
  assert.equal(kimi.supportsMedia, true);
  assert.equal(kimi.models.length, 3);

  assert.equal(openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(openrouter.zdr, true);
  assert.equal(openrouter.models.length, 0);

  assert.match(settings.model, /^custom\/p_[a-z0-9]+\/deepseek-v4-pro$/);
  const parsed = parseCustomModelId(settings.model);
  assert.equal(parsed.providerId, deepseek.id);
  assert.equal(parsed.modelId, 'deepseek-v4-pro');

  assert.equal(deepseek.apiKey, 'sk-ds-key');
  assert.equal(kimi.apiKey, 'sk-ms-key');
  assert.equal(openrouter.apiKey, 'sk-or-key');

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ai-settings.json'), 'utf8'));
  for (const provider of raw.customProviders) {
    assert.match(provider.apiKey, /^enc:v1:/);
  }

  assert.equal(fs.existsSync(markerPath(dir)), true);
  const second = ensureBuiltinProvidersMigrated(db);
  assert.equal(second.skipped, true);
  assert.equal(db.getAiSettings().customProviders.length, 3);
});

test('ensureBuiltinProvidersMigrated pulls env secrets for the legacy database', () => {
  const dir = tempDir();
  const db = createDatabase(dir);
  db.saveAiSettings({});

  const result = ensureBuiltinProvidersMigrated(db, {
    envSecrets: { deepseek: 'sk-env-ds', moonshot: '', openrouter: 'sk-env-or' },
  });
  assert.equal(result.migrated, 2);

  const settings = db.getAiSettings();
  const byName = new Map(settings.customProviders.map(item => [item.name, item]));
  assert.equal(byName.get('DeepSeek').apiKey, 'sk-env-ds');
  assert.equal(byName.get('Kimi'), undefined);
  assert.equal(byName.get('OpenRouter').apiKey, 'sk-env-or');
});

test('ensureBuiltinProvidersMigrated keeps the OpenRouter model with slashes', () => {
  const dir = tempDir();
  const db = createDatabase(dir);
  db.saveAiSettings({ openrouterApiKey: 'sk-or', model: 'anthropic/test-reasoner' });

  ensureBuiltinProvidersMigrated(db);
  const settings = db.getAiSettings();
  const openrouter = settings.customProviders.find(item => item.name === 'OpenRouter');
  assert.ok(openrouter);
  assert.deepEqual(openrouter.models.map(model => model.id), ['anthropic/test-reasoner']);
  assert.match(settings.model, /^custom\/p_[a-z0-9]+\/anthropic\/test-reasoner$/);
  const parsed = parseCustomModelId(settings.model);
  assert.equal(parsed.providerId, openrouter.id);
  assert.equal(parsed.modelId, 'anthropic/test-reasoner');
});

test('ensureBuiltinProvidersMigrated clears stale built-in models when nothing migrates', () => {
  const dir = tempDir();
  const db = createDatabase(dir);
  db.saveAiSettings({ model: 'kimi-k2.6' });

  const result = ensureBuiltinProvidersMigrated(db);
  assert.equal(result.migrated, 0);
  const settings = db.getAiSettings();
  assert.deepEqual(settings.customProviders, []);
  assert.equal(settings.model, '');
  assert.equal(fs.existsSync(markerPath(dir)), true);
});

test('ensureBuiltinProvidersMigrated leaves existing custom models untouched', () => {
  const dir = tempDir();
  const db = createDatabase(dir);
  const existing = {
    id: 'p_existing1',
    name: 'MyProxy',
    baseUrl: 'https://api.example.com/v1',
    apiFormat: 'openai',
    apiKey: 'sk-proxy',
    models: [{ id: 'gpt-test', name: 'GPT Test' }],
  };
  db.saveAiSettings({ apiKey: 'sk-ds', model: 'custom/p_existing1/gpt-test', customProviders: [existing] });

  ensureBuiltinProvidersMigrated(db);
  const settings = db.getAiSettings();
  assert.equal(settings.model, 'custom/p_existing1/gpt-test');
  assert.equal(settings.customProviders.some(item => item.name === 'DeepSeek'), true);
  assert.equal(settings.customProviders.some(item => item.id === 'p_existing1'), true);
});

test('custom providers are no longer capped at eight entries', () => {
  const dir = tempDir();
  const db = createDatabase(dir);
  const providers = Array.from({ length: 10 }, (_, index) => ({
    id: `p_cap${String(index).padStart(2, '0')}`,
    name: `Provider ${index}`,
    baseUrl: 'https://api.example.com/v1',
    apiFormat: 'openai',
    apiKey: '',
    models: [{ id: `model-${index}`, name: `Model ${index}` }],
  }));
  db.saveAiSettings({ customProviders: providers, model: 'custom/p_cap00/model-0' });

  ensureBuiltinProvidersMigrated(db);
  assert.equal(db.getAiSettings().customProviders.length, 10);
});

test('v2 migration restores per-model capabilities on untouched v1 cards', () => {
  const dir = tempDir();
  const db = createDatabase(dir);
  db.saveAiSettings({
    apiKey: 'sk-ds-key',
    moonshotApiKey: 'sk-ms-key',
    model: 'deepseek-v4-flash',
  });
  ensureBuiltinProvidersMigrated(db);

  const first = migrateBuiltinProviderModelCapabilities(db);
  assert.equal(first.skipped, false);
  assert.equal(first.changed, true);

  const settings = db.getAiSettings();
  const byName = new Map(settings.customProviders.map(item => [item.name, item]));
  const deepseek = byName.get('DeepSeek');
  const kimi = byName.get('Kimi');

  const vision = deepseek.models.find(model => model.id === 'deepseek-v4-flash-vision-exp');
  assert.equal(vision.supportsMedia, true);
  const plain = deepseek.models.find(model => model.id === 'deepseek-v4-flash');
  assert.equal(plain.supportsMedia, undefined, 'unrelated models keep inheriting');

  assert.deepEqual(
    kimi.models.map(model => model.thinking),
    ['k3', 'fixed', 'optional'],
  );
  assert.equal(kimi.thinking, 'optional', 'provider default stays as fallback');

  // Effective capability: vision model sees images, plain model does not.
  assert.equal(resolveModelCapability(deepseek, vision).supportsMedia, true);
  assert.equal(resolveModelCapability(deepseek, plain).supportsMedia, false);

  assert.equal(fs.existsSync(path.join(dir, 'ai-settings.pre-capabilities.bak')), true);
  assert.equal(fs.existsSync(path.join(dir, '.builtin-providers-capabilities.json')), true);

  const second = migrateBuiltinProviderModelCapabilities(db);
  assert.equal(second.skipped, true);
});

test('v2 migration leaves user-edited cards alone', () => {
  const dir = tempDir();
  const db = createDatabase(dir);
  db.saveAiSettings({
    apiKey: 'sk-ds-key',
    model: 'deepseek-v4-flash',
  });
  ensureBuiltinProvidersMigrated(db);
  // Simulate user edits: extra model + a manual capability override.
  const settings = db.getAiSettings();
  const deepseek = settings.customProviders.find(item => item.name === 'DeepSeek');
  deepseek.models.push({ id: 'custom-extra', name: 'Custom Extra' });
  deepseek.models[0].supportsMedia = true;
  db.saveAiSettings({ ...settings, customProviders: settings.customProviders });

  const result = migrateBuiltinProviderModelCapabilities(db);
  assert.equal(result.changed, false);
  const after = db.getAiSettings().customProviders.find(item => item.name === 'DeepSeek');
  assert.equal(after.models.some(model => model.id === 'custom-extra'), true);
  const vision = after.models.find(model => model.id === 'deepseek-v4-flash-vision-exp');
  assert.equal(vision.supportsMedia, undefined, 'edited card is not auto-corrected');
});
