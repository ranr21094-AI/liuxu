const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  migrateLegacyImageProviders,
  normalizeImageProviders,
  routeImageModel,
  imageModelRef,
} = require('../lib/agent/image-providers');
const { normalizeUnifiedImageRequest } = require('../lib/agent/image-service');
const { createDatabase } = require('../database');
const { resetSecretStoreForTests } = require('../secret-store');

test('legacy Seedream and Getoken settings migrate without losing per-model keys', () => {
  const migrated = migrateLegacyImageProviders({
    imageProvider: 'getoken',
    getokenModel: 'grok-imagine-image',
    getokenApiKey: 'shared',
    getokenGrokImagineApiKey: 'other',
    getokenNanoBananaApiKey: 'shared',
    seedreamApiKey: 'seed-key',
    seedreamModel: 'doubao-seedream-5-0-260128',
  });
  assert.equal(migrated.imageProvidersVersion, 1);
  assert.equal(migrated.imageProviders.filter(item => item.adapter === 'openai-images').length, 2);
  const shared = migrated.imageProviders.find(item => item.apiKey === 'shared');
  assert.deepEqual(shared.models.map(item => item.upstreamId).sort(), ['gpt-image-2', 'nano-banana-2']);
  const selected = routeImageModel(migrated, {});
  assert.equal(selected.model.upstreamId, 'grok-imagine-image');
});

test('image routing prefers default then falls back to model capabilities', () => {
  const settings = migrateLegacyImageProviders({
    imageProvider: 'seedream',
    seedreamModel: 'doubao-seedream-5-0-pro-260628',
  });
  const preferred = routeImageModel(settings, {});
  assert.equal(preferred.model.upstreamId, 'doubao-seedream-5-0-pro-260628');
  const batch = routeImageModel(settings, { count: 4 });
  assert.notEqual(batch.model.upstreamId, 'doubao-seedream-5-0-pro-260628');
  assert.equal(batch.model.capabilities.sequential, true);
});

test('raw duplicate upstream ids require a stable modelRef', () => {
  const baseModel = {
    id: 'im_model', upstreamId: 'same-model', name: 'Same', enabled: true,
    capabilities: { textToImage: true, maxOutputs: 1, maxReferences: 0 }, defaults: {},
  };
  const settings = {
    imageProviders: [
      { id: 'ip_one', name: 'One', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:1', enabled: true, models: [baseModel] },
      { id: 'ip_two', name: 'Two', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:2', enabled: true, models: [{ ...baseModel, id: 'im_other' }] },
    ],
  };
  assert.throws(() => routeImageModel(settings, { model: 'same-model' }), /ambiguous/i);
  const selected = routeImageModel(settings, { modelRef: imageModelRef(settings.imageProviders[1], settings.imageProviders[1].models[0]) });
  assert.equal(selected.provider.id, 'ip_two');
});

test('custom provider keeps its secret only when endpoint identity is unchanged', async () => {
  const current = [{
    id: 'ip_saved', name: 'Saved', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:1234', apiKey: 'secret', enabled: true,
    models: [{ id: 'im_saved', upstreamId: 'custom-image', name: 'Custom', enabled: true, capabilities: {}, defaults: {} }],
  }];
  const same = await normalizeImageProviders([{ ...current[0], apiKey: '' }], current);
  assert.equal(same[0].apiKey, 'secret');
  const changed = await normalizeImageProviders([{ ...current[0], baseUrl: 'http://127.0.0.1:4321', apiKey: '' }], current);
  assert.equal(changed[0].apiKey, '');
});

test('unified request maps legacy count and applies provider defaults', () => {
  const settings = migrateLegacyImageProviders({
    imageProvider: 'getoken', getokenModel: 'gpt-image-2', getokenApiKey: 'key',
    getokenSize: '1024x1024', getokenQuality: 'high', getokenN: 1,
  });
  const request = normalizeUnifiedImageRequest(settings, { prompt: 'cat', n: 2 });
  assert.equal(request.provider.adapter, 'openai-images');
  assert.equal(request.count, 2);
  assert.equal(request.size, '1024x1024');
  assert.equal(request.apiKey, 'key');
});

test('image provider keys are encrypted in ai_settings and decoded on read', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-providers-db-'));
  const oldKeyFile = process.env.AI_SECRETS_KEY_FILE;
  process.env.AI_SECRETS_KEY_FILE = path.join(dir, 'ai-secrets.key');
  resetSecretStoreForTests();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => {
    if (oldKeyFile === undefined) delete process.env.AI_SECRETS_KEY_FILE;
    else process.env.AI_SECRETS_KEY_FILE = oldKeyFile;
    resetSecretStoreForTests();
  });
  const db = createDatabase(dir, { secretScope: 'image-provider-test' });
  t.after(() => db.close());
  const settings = db.getAiSettings();
  const provider = settings.imageProviders[0];
  provider.apiKey = 'top-secret-image-key';
  db.saveAiSettings({ ...settings, imageProviders: settings.imageProviders });
  const raw = db.sqlite.prepare('SELECT body FROM ai_settings WHERE id = 1').get().body;
  assert.doesNotMatch(raw, /top-secret-image-key/);
  db.resetCache();
  assert.equal(db.getAiSettings().imageProviders[0].apiKey, 'top-secret-image-key');
});
