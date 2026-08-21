const fs = require('fs');
const path = require('path');
const { normalizeImageList, validateReferenceImageEntry } = require('./seedream');

const GETOKEN_DEFAULT_MODEL = process.env.GETOKEN_DEFAULT_MODEL || 'gpt-image-2';

const GETOKEN_MODELS = Object.freeze([
  { id: 'gpt-image-2', label: 'GPT Image 2', keyField: 'getokenApiKey', envVar: 'GETOKEN_API_KEY' },
  { id: 'grok-imagine-image', label: 'Grok Imagine', keyField: 'getokenGrokImagineApiKey', envVar: 'GETOKEN_GROK_IMAGINE_API_KEY' },
  { id: 'nano-banana-2', label: 'Nano Banana 2', keyField: 'getokenNanoBananaApiKey', envVar: 'GETOKEN_NANO_BANANA_API_KEY' },
]);

const GETOKEN_MODEL_BY_ID = Object.freeze(Object.fromEntries(GETOKEN_MODELS.map(entry => [entry.id, entry])));
const GETOKEN_ALLOWED_MODELS = new Set(GETOKEN_MODELS.map(entry => entry.id));

const GETOKEN_ALLOWED_QUALITIES = new Set(['standard', 'high']);
const GETOKEN_ALLOWED_SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792']);
const GETOKEN_MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;

const GETOKEN_DEFAULT_SETTINGS = Object.freeze({
  imageProvider: 'seedream',
  getokenModel: GETOKEN_DEFAULT_MODEL,
  getokenSize: 'auto',
  getokenQuality: 'high',
  getokenN: 1,
  getokenGrokImagineApiKey: '',
  getokenNanoBananaApiKey: '',
});

function isAllowedGetokenModel(value) {
  return GETOKEN_ALLOWED_MODELS.has(String(value || '').trim());
}

function normalizeGetokenModel(value) {
  const model = String(value || '').trim();
  return isAllowedGetokenModel(model) ? model : GETOKEN_DEFAULT_MODEL;
}

function getGetokenModelDefinition(model) {
  return GETOKEN_MODEL_BY_ID[normalizeGetokenModel(model)] || GETOKEN_MODEL_BY_ID[GETOKEN_DEFAULT_MODEL];
}

function resolveGetokenApiKey(model, savedSettings = {}, envLookup = null) {
  const definition = getGetokenModelDefinition(model);
  const keyField = definition.keyField;
  const stored = typeof savedSettings[keyField] === 'string' ? savedSettings[keyField].trim() : '';
  if (stored) return stored;
  if (typeof envLookup === 'function') {
    const envValue = envLookup(definition.envVar);
    if (typeof envValue === 'string' && envValue.trim()) return envValue.trim();
  }
  return '';
}

function isGetokenModelKeyConfigured(model, savedSettings = {}, envLookup = null) {
  return Boolean(resolveGetokenApiKey(model, savedSettings, envLookup));
}

function normalizeImageProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return provider === 'getoken' ? 'getoken' : 'seedream';
}

function normalizeGetokenSettings(source = {}) {
  const model = normalizeGetokenModel(source.getokenModel || GETOKEN_DEFAULT_MODEL);
  const size = String(source.getokenSize || GETOKEN_DEFAULT_SETTINGS.getokenSize).trim().slice(0, 32);
  const quality = GETOKEN_ALLOWED_QUALITIES.has(String(source.getokenQuality || '').trim())
    ? String(source.getokenQuality).trim()
    : GETOKEN_DEFAULT_SETTINGS.getokenQuality;
  let n = Number(source.getokenN);
  if (!Number.isFinite(n)) n = GETOKEN_DEFAULT_SETTINGS.getokenN;
  n = Math.min(4, Math.max(1, Math.round(n)));
  return {
    imageProvider: normalizeImageProvider(source.imageProvider),
    getokenModel: model,
    getokenSize: GETOKEN_ALLOWED_SIZES.has(size) ? size : GETOKEN_DEFAULT_SETTINGS.getokenSize,
    getokenQuality: quality,
    getokenN: n,
  };
}

function parseGetokenSettingsInput(body, current = {}) {
  const merged = {
    ...GETOKEN_DEFAULT_SETTINGS,
    ...current,
    ...body,
  };
  if (body?.imageProvider !== undefined) {
    const provider = String(body.imageProvider || '').trim().toLowerCase();
    if (!['seedream', 'getoken'].includes(provider)) {
      throw new Error('Unsupported image provider');
    }
  }
  if (body?.getokenQuality !== undefined && !GETOKEN_ALLOWED_QUALITIES.has(String(body.getokenQuality).trim())) {
    throw new Error('Unsupported Getoken quality option');
  }
  if (body?.getokenSize !== undefined) {
    const size = String(body.getokenSize || '').trim();
    if (size && !GETOKEN_ALLOWED_SIZES.has(size)) {
      throw new Error('Unsupported Getoken size');
    }
  }
  if (body?.getokenN !== undefined) {
    const n = Number(body.getokenN);
    if (!Number.isFinite(n) || n < 1 || n > 4) {
      throw new Error('Unsupported Getoken image count');
    }
  }
  if (body?.getokenModel !== undefined && !isAllowedGetokenModel(body.getokenModel)) {
    throw new Error('Unsupported Getoken model');
  }
  return normalizeGetokenSettings(merged);
}

function mergeGetokenCallArgs(args = {}, saved = {}) {
  const settings = normalizeGetokenSettings(saved);
  const nArg = Number(args.n);
  const n = Number.isFinite(nArg) ? Math.min(4, Math.max(1, Math.round(nArg))) : settings.getokenN;
  const quality = GETOKEN_ALLOWED_QUALITIES.has(String(args.quality || '').trim())
    ? String(args.quality).trim()
    : settings.getokenQuality;
  const size = String(args.size || settings.getokenSize || GETOKEN_DEFAULT_SETTINGS.getokenSize).trim();
  const model = normalizeGetokenModel(args.model || settings.getokenModel || GETOKEN_DEFAULT_MODEL);
  return {
    model,
    prompt: String(args.prompt || '').trim(),
    size: GETOKEN_ALLOWED_SIZES.has(size) ? size : settings.getokenSize,
    quality,
    n,
    images: normalizeImageList(args.image),
  };
}

function validateGetokenArgs(options) {
  const { prompt, size, quality, n, images, model } = options;
  if (!isAllowedGetokenModel(model)) return 'Unsupported Getoken model';
  if (!prompt) return 'Image prompt is required';
  if (prompt.length > 4000) return 'Image prompt is too long';
  if (!GETOKEN_ALLOWED_SIZES.has(size)) return 'Unsupported Getoken size';
  if (!GETOKEN_ALLOWED_QUALITIES.has(quality)) return 'Unsupported Getoken quality option';
  if (!Number.isInteger(n) || n < 1 || n > 4) return 'Unsupported Getoken image count';
  if (images.length > GETOKEN_MAX_REFERENCE_IMAGES) {
    return `Too many reference images (max ${GETOKEN_MAX_REFERENCE_IMAGES})`;
  }
  for (const image of images) {
    const check = validateReferenceImageEntry(image);
    if (check.error) return check.error;
    if (/^https?:\/\//i.test(String(check.value || ''))) {
      return 'Getoken edit requires local /uploads/ reference images';
    }
  }
  return null;
}

function buildGetokenGenerationBody(options) {
  return {
    model: options.model,
    prompt: options.prompt,
    size: options.size,
    quality: options.quality,
    n: options.n,
  };
}

function parseGetokenResponse(data) {
  const items = Array.isArray(data?.data) ? data.data : [];
  return items.map(item => ({
    b64: typeof item?.b64_json === 'string' ? item.b64_json : '',
    url: typeof item?.url === 'string' ? item.url.trim() : '',
  })).filter(item => item.b64 || item.url);
}

function mimeFromUploadFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/png';
}

function resolveGetokenEditFiles(images, { dataDir, isSafeUploadFilename }) {
  const files = [];
  for (const image of images) {
    const text = String(image || '').trim();
    if (!text.startsWith('/uploads/')) {
      throw new Error('Getoken edit requires local /uploads/ reference images');
    }
    const filename = text.slice('/uploads/'.length);
    if (typeof isSafeUploadFilename === 'function' && !isSafeUploadFilename(filename)) {
      throw new Error('Invalid reference image filename');
    }
    const filePath = path.join(dataDir, 'uploads', filename);
    const resolvedPath = path.resolve(filePath);
    const uploadsRoot = path.resolve(path.join(dataDir, 'uploads'));
    if (!resolvedPath.startsWith(uploadsRoot + path.sep) || !fs.existsSync(resolvedPath)) {
      throw new Error('Reference image file not found');
    }
    const buffer = fs.readFileSync(resolvedPath);
    if (buffer.length > MAX_REFERENCE_BYTES) {
      throw new Error('Reference image exceeds 30MB');
    }
    files.push({
      filename,
      buffer,
      mime: mimeFromUploadFilename(filename),
    });
  }
  return files;
}

function safeGetokenError(status, data) {
  const detail = typeof data?.error?.message === 'string'
    ? data.error.message.slice(0, 240)
    : (typeof data?.error === 'string' ? data.error.slice(0, 240) : '');
  return detail
    ? `Getoken request failed (${status}): ${detail}`
    : `Getoken request failed (${status})`;
}

async function requestGetokenGeneration(options, { fetchImpl, baseUrl, timeoutMs = 300000 }) {
  const fetchFn = fetchImpl || fetch;
  const response = await fetchFn(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildGetokenGenerationBody(options)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = {}; }
  if (!response.ok) throw new Error(safeGetokenError(response.status, data));
  const items = parseGetokenResponse(data);
  if (!items.length) throw new Error('Getoken did not return any images');
  return { items };
}

async function requestGetokenEdit(options, { fetchImpl, baseUrl, dataDir, isSafeUploadFilename, timeoutMs = 300000 }) {
  const fetchFn = fetchImpl || fetch;
  const files = resolveGetokenEditFiles(options.images, { dataDir, isSafeUploadFilename });
  if (!files.length) throw new Error('Getoken edit requires at least one reference image');

  const form = new FormData();
  form.append('model', options.model);
  form.append('prompt', options.prompt);
  form.append('size', options.size);
  form.append('quality', options.quality);
  form.append('n', String(options.n));
  for (const file of files) {
    form.append('image[]', new Blob([file.buffer], { type: file.mime }), file.filename);
  }

  const response = await fetchFn(`${baseUrl}/v1/images/edits`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = {}; }
  if (!response.ok) throw new Error(safeGetokenError(response.status, data));
  const items = parseGetokenResponse(data);
  if (!items.length) throw new Error('Getoken edit did not return any images');
  return { items };
}

function buildGetokenMarkdown(savedImages) {
  return savedImages.map(item => {
    const alt = String(item.filename || 'generated image').slice(0, 80).replace(/[[\]]/g, '');
    return `![${alt}](${item.url})`;
  }).join('\n');
}

module.exports = {
  GETOKEN_DEFAULT_MODEL,
  GETOKEN_MODELS,
  GETOKEN_ALLOWED_MODELS,
  GETOKEN_DEFAULT_SETTINGS,
  GETOKEN_ALLOWED_QUALITIES,
  GETOKEN_ALLOWED_SIZES,
  isAllowedGetokenModel,
  normalizeGetokenModel,
  getGetokenModelDefinition,
  resolveGetokenApiKey,
  isGetokenModelKeyConfigured,
  normalizeImageProvider,
  normalizeGetokenSettings,
  parseGetokenSettingsInput,
  mergeGetokenCallArgs,
  validateGetokenArgs,
  buildGetokenGenerationBody,
  parseGetokenResponse,
  resolveGetokenEditFiles,
  requestGetokenGeneration,
  requestGetokenEdit,
  buildGetokenMarkdown,
};
