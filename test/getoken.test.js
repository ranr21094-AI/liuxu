const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  GETOKEN_DEFAULT_SETTINGS,
  GETOKEN_ALLOWED_MODELS,
  normalizeGetokenSettings,
  normalizeGetokenModel,
  parseGetokenSettingsInput,
  mergeGetokenCallArgs,
  validateGetokenArgs,
  parseGetokenResponse,
  buildGetokenGenerationBody,
  resolveGetokenEditFiles,
  requestGetokenGeneration,
  requestGetokenEdit,
  resolveGetokenApiKey,
  isGetokenModelKeyConfigured,
} = require('../lib/agent/getoken');

test('normalizeGetokenSettings applies defaults', () => {
  const normalized = normalizeGetokenSettings({});
  assert.equal(normalized.imageProvider, 'seedream');
  assert.equal(normalized.getokenModel, 'gpt-image-2');
  assert.equal(normalized.getokenSize, 'auto');
  assert.equal(normalized.getokenQuality, 'high');
  assert.equal(normalized.getokenN, 1);
});

test('parseGetokenSettingsInput rejects invalid provider and quality', () => {
  assert.throws(() => parseGetokenSettingsInput({ imageProvider: 'bad' }, {}), /Unsupported image provider/);
  assert.throws(() => parseGetokenSettingsInput({ getokenQuality: 'ultra' }, {}), /Unsupported Getoken quality/);
  assert.throws(() => parseGetokenSettingsInput({ getokenN: 9 }, {}), /Unsupported Getoken image count/);
  assert.throws(() => parseGetokenSettingsInput({ getokenModel: 'bad-model' }, {}), /Unsupported Getoken model/);
});

test('normalizeGetokenModel falls back to default for unknown models', () => {
  assert.equal(normalizeGetokenModel('grok-imagine-image'), 'grok-imagine-image');
  assert.equal(normalizeGetokenModel('nano-banana-2'), 'nano-banana-2');
  assert.equal(normalizeGetokenModel('unknown'), 'gpt-image-2');
  assert.equal(GETOKEN_ALLOWED_MODELS.size, 3);
});

test('resolveGetokenApiKey picks per-model settings and env fallback', () => {
  const saved = {
    getokenApiKey: 'key-gpt',
    getokenGrokImagineApiKey: 'key-grok',
    getokenNanoBananaApiKey: 'key-nano',
  };
  assert.equal(resolveGetokenApiKey('gpt-image-2', saved), 'key-gpt');
  assert.equal(resolveGetokenApiKey('grok-imagine-image', saved), 'key-grok');
  assert.equal(resolveGetokenApiKey('nano-banana-2', saved), 'key-nano');
  assert.equal(resolveGetokenApiKey('grok-imagine-image', {}, envVar => (
    envVar === 'GETOKEN_GROK_IMAGINE_API_KEY' ? 'env-grok' : ''
  )), 'env-grok');
  assert.equal(isGetokenModelKeyConfigured('nano-banana-2', { getokenNanoBananaApiKey: 'key-nano' }), true);
});

test('mergeGetokenCallArgs merges saved defaults and call overrides', () => {
  const merged = mergeGetokenCallArgs({
    prompt: 'a cat',
    n: 2,
    quality: 'standard',
  }, {
    getokenModel: 'gpt-image-2',
    getokenSize: '1024x1024',
    getokenQuality: 'high',
    getokenN: 1,
  });
  assert.equal(merged.prompt, 'a cat');
  assert.equal(merged.n, 2);
  assert.equal(merged.quality, 'standard');
  assert.equal(merged.size, '1024x1024');
});

test('parseGetokenResponse reads b64_json and url entries', () => {
  const items = parseGetokenResponse({
    data: [
      { b64_json: 'abc123' },
      { url: 'https://example.com/a.png' },
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].b64, 'abc123');
  assert.equal(items[1].url, 'https://example.com/a.png');
});

test('buildGetokenGenerationBody matches API shape', () => {
  assert.deepEqual(buildGetokenGenerationBody({
    model: 'gpt-image-2',
    prompt: 'sunset',
    size: 'auto',
    quality: 'high',
    n: 1,
  }), {
    model: 'gpt-image-2',
    prompt: 'sunset',
    size: 'auto',
    quality: 'high',
    n: 1,
  });
});

test('validateGetokenArgs rejects remote reference images', () => {
  const error = validateGetokenArgs({
    model: 'gpt-image-2',
    prompt: 'edit',
    size: 'auto',
    quality: 'high',
    n: 1,
    images: ['https://example.com/a.png'],
  });
  assert.match(error, /local \/uploads/);
});

test('resolveGetokenEditFiles reads local uploads safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'getoken-edit-'));
  const uploadsDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = '1735-test.png';
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const [file] = resolveGetokenEditFiles([`/uploads/${filename}`], {
    dataDir: dir,
    isSafeUploadFilename: name => name === filename,
  });
  assert.equal(file.filename, filename);
  assert.equal(file.mime, 'image/png');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('requestGetokenGeneration posts JSON to generations endpoint', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      async text() {
        return JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] });
      },
    };
  };
  const result = await requestGetokenGeneration({
    apiKey: 'sk-test',
    model: 'gpt-image-2',
    prompt: 'hello',
    size: 'auto',
    quality: 'high',
    n: 1,
  }, { fetchImpl, baseUrl: 'https://api.getoken.tech' });
  assert.equal(captured.url, 'https://api.getoken.tech/v1/images/generations');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test');
  assert.match(captured.init.body, /"prompt":"hello"/);
  assert.equal(result.items.length, 1);
});

test('requestGetokenEdit sends multipart image[] fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'getoken-edit-req-'));
  const uploadsDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = '1735-test.png';
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      async text() {
        return JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] });
      },
    };
  };
  try {
    await requestGetokenEdit({
      apiKey: 'sk-test',
      model: 'gpt-image-2',
      prompt: 'night city',
      size: 'auto',
      quality: 'high',
      n: 1,
      images: [`/uploads/${filename}`],
    }, {
      fetchImpl,
      baseUrl: 'https://api.getoken.tech',
      dataDir: dir,
      isSafeUploadFilename: name => name === filename,
    });
    assert.equal(captured.url, 'https://api.getoken.tech/v1/images/edits');
    assert.ok(captured.init.body instanceof FormData);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
