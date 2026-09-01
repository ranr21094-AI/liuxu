const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  SEEDREAM_PRO_MODEL,
  SEEDREAM_LITE_MODEL,
  SEEDREAM_45_MODEL,
  SEEDREAM_40_MODEL,
  isValidSeedreamSize,
  validateSeedreamArgs,
  mergeSeedreamCallArgs,
  buildSeedreamRequestBody,
  parseSeedreamResponse,
  resolveReferenceImages,
  normalizeSeedreamSettings,
  parseSeedreamSettingsInput,
} = require('../lib/agent/seedream');
const { BUILTIN_IMAGE_VERSION } = require('../lib/agent/memory');
const { createMemoryService } = require('../lib/agent/memory');
const { createAgentStore } = require('../lib/agent/store');
const { createTempDatabase } = require('./db-temp');

test('seedream size validation is model-aware', () => {
  assert.equal(isValidSeedreamSize(SEEDREAM_PRO_MODEL, '1.5K'), true);
  assert.equal(isValidSeedreamSize(SEEDREAM_PRO_MODEL, '3K'), false);
  assert.equal(isValidSeedreamSize(SEEDREAM_LITE_MODEL, '3K'), true);
  assert.equal(isValidSeedreamSize(SEEDREAM_40_MODEL, '1K'), true);
  assert.equal(isValidSeedreamSize(SEEDREAM_45_MODEL, '2048x2048'), true);
  assert.equal(isValidSeedreamSize(SEEDREAM_PRO_MODEL, '512x512'), false);
});

test('seedream rejects incompatible parameter combinations', () => {
  const proSequential = mergeSeedreamCallArgs({
    prompt: 'test',
    sequential_image_generation: 'auto',
  }, { seedreamModel: SEEDREAM_PRO_MODEL });
  assert.match(validateSeedreamArgs(proSequential), /not supported for this model/);

  const liteLayer = mergeSeedreamCallArgs({
    prompt: 'test',
    layer_decomposition: true,
  }, { seedreamModel: SEEDREAM_LITE_MODEL });
  assert.equal(validateSeedreamArgs(liteLayer), 'Layer decomposition is not supported for this model');
});

test('seedream batch alias maps to sequential auto and max_images', () => {
  const options = mergeSeedreamCallArgs({
    prompt: 'four seasons',
    batch: true,
    batch_size: 4,
  }, { seedreamModel: SEEDREAM_LITE_MODEL });
  assert.equal(validateSeedreamArgs(options), null);
  assert.equal(options.sequential, 'auto');
  assert.equal(options.maxImages, 4);
  const body = buildSeedreamRequestBody(options, []);
  assert.equal(body.sequential_image_generation, 'auto');
  assert.deepEqual(body.sequential_image_generation_options, { max_images: 4 });
});

test('seedream max_images alone enables sequential auto', () => {
  const options = mergeSeedreamCallArgs({
    prompt: 'three views',
    max_images: 3,
  }, { seedreamModel: SEEDREAM_45_MODEL, seedreamSequential: 'disabled' });
  assert.equal(options.sequential, 'auto');
  assert.equal(options.maxImages, 3);
});

test('seedream build payload includes lite web search and sequential options', () => {
  const options = mergeSeedreamCallArgs({
    prompt: 'four seasons poster',
    sequential_image_generation: 'auto',
    max_images: 4,
    web_search: true,
  }, { seedreamModel: SEEDREAM_LITE_MODEL });
  assert.equal(validateSeedreamArgs(options), null);
  const body = buildSeedreamRequestBody(options, []);
  assert.equal(body.sequential_image_generation, 'auto');
  assert.deepEqual(body.sequential_image_generation_options, { max_images: 4 });
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
});

test('seedream parse response keeps layer metadata', () => {
  const parsed = parseSeedreamResponse({
    data: [
      { url: 'https://example.com/base.png', z_index: 0 },
      { url: 'https://example.com/layer.png', z_index: 1, name: 'subject', bounding_box: { absolute: [1, 2, 3, 4] } },
    ],
  });
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[1].name, 'subject');
  assert.equal(parsed.items[1].zIndex, 1);
});

test('resolveReferenceImages converts local uploads to base64', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedream-ref-'));
  const uploadsDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = '1735-test.png';
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const [resolved] = await resolveReferenceImages([`/uploads/${filename}`], {
    dataDir: dir,
    isSafeUploadFilename: name => name === filename,
  });
  assert.match(resolved, /^data:image\/png;base64,/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('seedream settings normalize drops unsupported fields per model', () => {
  const normalized = normalizeSeedreamSettings({
    seedreamModel: SEEDREAM_45_MODEL,
    seedreamOutputFormat: 'png',
    seedreamWebSearch: true,
    seedreamSequential: 'auto',
  });
  assert.equal(normalized.seedreamOutputFormat, 'jpeg');
  assert.equal(normalized.seedreamWebSearch, false);
  assert.equal(normalized.seedreamSequential, 'auto');
});

test('seedream settings input accepts pro model and extended fields', () => {
  const parsed = parseSeedreamSettingsInput({
    seedreamModel: SEEDREAM_PRO_MODEL,
    seedreamSize: '2K',
    seedreamOutputFormat: 'png',
    seedreamLayerDecomposition: true,
  }, {});
  assert.equal(parsed.seedreamModel, SEEDREAM_PRO_MODEL);
  assert.equal(parsed.seedreamOutputFormat, 'png');
  assert.equal(parsed.seedreamLayerDecomposition, true);
});

test('legacy seedream memory is superseded by unified image workflow', (t) => {
  const { db, dir } = createTempDatabase(t, 'seedream-mem-');
  const { createAgentStore } = require('../lib/agent/store');
  const store = createAgentStore(db);
  store.writeMemories({
    items: [{
      id: 'builtin-seedream-generate',
      builtinId: 'seedream-generate',
      layer: 'L3',
      title: 'Seedream 生图',
      content: 'old content',
      evidence: [{ type: 'builtin', id: 'seedream-generate' }],
      version: 1,
      status: 'active',
    }],
    proposals: [],
  });
  const memory = createMemoryService(store);
  const items = memory.list({ layer: 'L3' });
  const builtin = items.find(item => item.builtinId === 'image-generate');
  assert.ok(builtin);
  assert.equal(builtin.version, BUILTIN_IMAGE_VERSION);
  assert.match(builtin.content, /modelRef/);
  const legacy = store.readMemories().items.find(item => item.builtinId === 'seedream-generate');
  assert.equal(legacy.status, 'superseded');
});
