const fs = require('fs');
const path = require('path');

const SEEDREAM_PRO_MODEL = process.env.SEEDREAM_PRO_MODEL || 'doubao-seedream-5-0-pro-260628';
const SEEDREAM_LITE_MODEL = 'doubao-seedream-5-0-260128';
const SEEDREAM_LITE_ALIAS = 'doubao-seedream-5-0-lite-260128';
const SEEDREAM_45_MODEL = 'doubao-seedream-4-5-251128';
const SEEDREAM_40_MODEL = 'doubao-seedream-4-0-250828';

const SEEDREAM_DEFAULT_MODEL = process.env.SEEDREAM_DEFAULT_MODEL || SEEDREAM_LITE_MODEL;

const SEEDREAM_ALLOWED_MODELS = new Set([
  SEEDREAM_PRO_MODEL,
  SEEDREAM_LITE_MODEL,
  SEEDREAM_LITE_ALIAS,
  SEEDREAM_45_MODEL,
  SEEDREAM_40_MODEL,
]);

const SEEDREAM_MODEL_ALIASES = Object.freeze({
  [SEEDREAM_LITE_ALIAS]: SEEDREAM_LITE_MODEL,
});

const SEEDREAM_DEFAULT_SETTINGS = Object.freeze({
  seedreamModel: SEEDREAM_DEFAULT_MODEL,
  seedreamSize: '2K',
  seedreamWatermark: true,
  seedreamOutputFormat: 'jpeg',
  seedreamOptimizePromptMode: 'standard',
  seedreamSequential: 'disabled',
  seedreamMaxImages: 15,
  seedreamWebSearch: false,
  seedreamLayerDecomposition: false,
  seedreamBackground: 'opaque',
  seedreamStream: true,
});

const SEEDREAM_MODEL_PROFILES = Object.freeze({
  [SEEDREAM_PRO_MODEL]: Object.freeze({
    label: 'Seedream 5.0 Pro',
    sizeKeywords: new Set(['1K', '1.5K', '2K', 'auto']),
    minPixels: 921600,
    maxPixels: 4624220,
    maxReferenceImages: 10,
    sequential: false,
    stream: false,
    layerDecomposition: true,
    webSearch: false,
    outputFormat: true,
    background: true,
    optimizeFast: true,
  }),
  [SEEDREAM_LITE_MODEL]: Object.freeze({
    label: 'Seedream 5.0 Lite',
    sizeKeywords: new Set(['2K', '3K', '4K']),
    minPixels: 3686400,
    maxPixels: 16777216,
    maxReferenceImages: 14,
    sequential: true,
    stream: true,
    layerDecomposition: false,
    webSearch: true,
    outputFormat: true,
    background: false,
    optimizeFast: false,
  }),
  [SEEDREAM_45_MODEL]: Object.freeze({
    label: 'Seedream 4.5',
    sizeKeywords: new Set(['2K', '4K']),
    minPixels: 3686400,
    maxPixels: 16777216,
    maxReferenceImages: 14,
    sequential: true,
    stream: true,
    layerDecomposition: false,
    webSearch: false,
    outputFormat: false,
    background: false,
    optimizeFast: false,
  }),
  [SEEDREAM_40_MODEL]: Object.freeze({
    label: 'Seedream 4.0',
    sizeKeywords: new Set(['1K', '2K', '4K']),
    minPixels: 921600,
    maxPixels: 16777216,
    maxReferenceImages: 14,
    sequential: true,
    stream: true,
    layerDecomposition: false,
    webSearch: false,
    outputFormat: false,
    background: false,
    optimizeFast: true,
  }),
});

const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 14;
const DATA_URI_PATTERN = /^data:image\/([a-z0-9.+-]+);base64,/i;

function normalizeSeedreamModel(model) {
  const value = String(model || '').trim();
  if (!value) return SEEDREAM_DEFAULT_MODEL;
  return SEEDREAM_MODEL_ALIASES[value] || value;
}

function seedreamModelProfile(model) {
  const normalized = normalizeSeedreamModel(model);
  return SEEDREAM_MODEL_PROFILES[normalized] || null;
}

function isAllowedSeedreamModel(model) {
  return SEEDREAM_ALLOWED_MODELS.has(String(model || '').trim());
}

function isValidSeedreamSize(model, size, { layerDecomposition = false } = {}) {
  if (typeof size !== 'string') return false;
  const value = size.trim();
  const profile = seedreamModelProfile(model);
  if (!profile) return false;
  if (layerDecomposition && value === 'auto') return profile.layerDecomposition;
  if (profile.sizeKeywords.has(value)) return true;
  const match = /^(\d{3,5})x(\d{3,5})$/i.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 512 || height < 512) return false;
  const ratio = width / height;
  if (ratio < 1 / 16 || ratio > 16) return false;
  const pixels = width * height;
  return pixels >= profile.minPixels && pixels <= profile.maxPixels;
}

function normalizeSeedreamSettings(source = {}) {
  const model = isAllowedSeedreamModel(source.seedreamModel)
    ? normalizeSeedreamModel(source.seedreamModel)
    : SEEDREAM_DEFAULT_SETTINGS.seedreamModel;
  const profile = seedreamModelProfile(model);
  const size = typeof source.seedreamSize === 'string' && source.seedreamSize.trim()
    ? source.seedreamSize.trim().slice(0, 40)
    : SEEDREAM_DEFAULT_SETTINGS.seedreamSize;
  const normalizedSize = isValidSeedreamSize(model, size)
    ? size
    : SEEDREAM_DEFAULT_SETTINGS.seedreamSize;
  const outputFormat = source.seedreamOutputFormat === 'png' ? 'png' : 'jpeg';
  const optimizePromptMode = source.seedreamOptimizePromptMode === 'fast' ? 'fast' : 'standard';
  const sequential = source.seedreamSequential === 'auto' ? 'auto' : 'disabled';
  let maxImages = Number(source.seedreamMaxImages);
  if (!Number.isFinite(maxImages)) maxImages = SEEDREAM_DEFAULT_SETTINGS.seedreamMaxImages;
  maxImages = Math.min(15, Math.max(1, Math.round(maxImages)));
  const background = source.seedreamBackground === 'transparent' ? 'transparent' : 'opaque';
  return {
    seedreamModel: model,
    seedreamSize: normalizedSize,
    seedreamWatermark: typeof source.seedreamWatermark === 'boolean'
      ? source.seedreamWatermark
      : SEEDREAM_DEFAULT_SETTINGS.seedreamWatermark,
    seedreamOutputFormat: profile?.outputFormat ? outputFormat : 'jpeg',
    seedreamOptimizePromptMode: profile?.optimizeFast || optimizePromptMode === 'standard'
      ? optimizePromptMode
      : 'standard',
    seedreamSequential: profile?.sequential ? sequential : 'disabled',
    seedreamMaxImages: maxImages,
    seedreamWebSearch: profile?.webSearch ? Boolean(source.seedreamWebSearch) : false,
    seedreamLayerDecomposition: profile?.layerDecomposition
      ? Boolean(source.seedreamLayerDecomposition)
      : false,
    seedreamBackground: profile?.background ? background : 'opaque',
    seedreamStream: profile?.stream
      ? source.seedreamStream !== false
      : false,
  };
}

function parseSeedreamSettingsInput(body, current = {}) {
  const merged = {
    ...SEEDREAM_DEFAULT_SETTINGS,
    ...current,
    ...body,
  };
  const model = body?.seedreamModel ?? current.seedreamModel ?? SEEDREAM_DEFAULT_SETTINGS.seedreamModel;
  if (!isAllowedSeedreamModel(model)) {
    throw new Error('Unsupported Seedream model');
  }
  const explicitSize = typeof body?.seedreamSize === 'string' ? body.seedreamSize.trim() : '';
  if (explicitSize && !isValidSeedreamSize(normalizeSeedreamModel(model), explicitSize, {
    layerDecomposition: merged.seedreamLayerDecomposition === true,
  })) {
    throw new Error('Unsupported Seedream size');
  }
  if (body?.seedreamWatermark !== undefined && typeof body.seedreamWatermark !== 'boolean') {
    throw new Error('Unsupported Seedream watermark option');
  }
  const normalized = normalizeSeedreamSettings(merged);
  if (!isValidSeedreamSize(normalized.seedreamModel, normalized.seedreamSize, {
    layerDecomposition: normalized.seedreamLayerDecomposition,
  })) {
    throw new Error('Unsupported Seedream size');
  }
  if (typeof normalized.seedreamWatermark !== 'boolean') {
    throw new Error('Unsupported Seedream watermark option');
  }
  return normalized;
}

function normalizeImageList(image) {
  if (image == null || image === '') return [];
  if (Array.isArray(image)) return image.map(item => String(item || '').trim()).filter(Boolean);
  return [String(image).trim()].filter(Boolean);
}

function estimateDataUriBytes(value) {
  const comma = value.indexOf(',');
  if (comma < 0) return value.length;
  const base64 = value.slice(comma + 1).replace(/\s/g, '');
  return Math.floor(base64.length * 0.75);
}

function validateReferenceImageEntry(value) {
  const text = String(value || '').trim();
  if (!text) return { error: 'Reference image is empty' };
  if (DATA_URI_PATTERN.test(text)) {
    if (estimateDataUriBytes(text) > MAX_REFERENCE_BYTES) {
      return { error: 'Reference image exceeds 30MB' };
    }
    return { value: text };
  }
  if (/^https?:\/\//i.test(text)) return { value: text };
  if (text.startsWith('/uploads/')) return { value: text };
  return { error: 'Unsupported reference image URL' };
}

function mergeSeedreamCallArgs(args = {}, saved = {}) {
  const settings = normalizeSeedreamSettings(saved);
  const model = args.model ? normalizeSeedreamModel(args.model) : settings.seedreamModel;
  const profile = seedreamModelProfile(model);
  if (!profile) throw new Error('Unsupported Seedream model');

  const layerDecomposition = typeof args.layer_decomposition === 'boolean'
    ? args.layer_decomposition
    : settings.seedreamLayerDecomposition;
  const size = typeof args.size === 'string' && args.size.trim()
    ? args.size.trim()
    : settings.seedreamSize;
  const watermark = typeof args.watermark === 'boolean' ? args.watermark : settings.seedreamWatermark;
  const outputFormat = args.output_format === 'png' || args.output_format === 'jpeg'
    ? args.output_format
    : settings.seedreamOutputFormat;
  const optimizePromptMode = args.optimize_prompt_mode === 'fast' || args.optimize_prompt_mode === 'standard'
    ? args.optimize_prompt_mode
    : settings.seedreamOptimizePromptMode;
  let sequential = args.sequential_image_generation === 'auto' || args.sequential_image_generation === 'disabled'
    ? args.sequential_image_generation
    : settings.seedreamSequential;
  let maxImages = Number(args.max_images ?? settings.seedreamMaxImages);
  if (!Number.isFinite(maxImages)) maxImages = settings.seedreamMaxImages;
  if (args.batch === true) sequential = 'auto';
  const batchSize = Number(args.batch_size);
  if (Number.isFinite(batchSize) && batchSize >= 2) {
    sequential = 'auto';
    maxImages = Math.min(15, Math.max(2, Math.round(batchSize)));
  }
  maxImages = Math.min(15, Math.max(1, Math.round(maxImages)));
  if (maxImages > 1 && sequential === 'disabled') sequential = 'auto';
  const webSearch = typeof args.web_search === 'boolean' ? args.web_search : settings.seedreamWebSearch;
  const background = args.background === 'transparent' || args.background === 'opaque'
    ? args.background
    : settings.seedreamBackground;
  const stream = typeof args.stream === 'boolean'
    ? args.stream
    : (sequential === 'auto' ? settings.seedreamStream : false);
  const images = normalizeImageList(args.image);

  return {
    model,
    profile,
    prompt: String(args.prompt || '').trim(),
    size,
    watermark,
    outputFormat,
    optimizePromptMode,
    sequential,
    maxImages,
    webSearch,
    background,
    stream,
    layerDecomposition,
    images,
  };
}

function validateSeedreamArgs(options) {
  const {
    model, profile, prompt, size, watermark, outputFormat, optimizePromptMode,
    sequential, maxImages, webSearch, background, stream, layerDecomposition, images,
  } = options;

  if (!prompt) return 'Image prompt is required';
  if (prompt.length > 4000) return 'Image prompt is too long';
  if (!isAllowedSeedreamModel(model)) return 'Unsupported Seedream model';
  if (!isValidSeedreamSize(model, size, { layerDecomposition })) return 'Unsupported Seedream size';
  if (typeof watermark !== 'boolean') return 'Unsupported Seedream watermark option';

  if (layerDecomposition) {
    if (!profile.layerDecomposition) return 'Layer decomposition is not supported for this model';
    if (images.length !== 1) return 'Layer decomposition requires exactly one reference image';
  }
  if (background === 'transparent') {
    if (!profile.background) return 'Transparent background is not supported for this model';
    if (images.length !== 1) return 'Transparent background requires exactly one reference image';
    if (outputFormat === 'jpeg') return 'Transparent background requires PNG output';
  }
  if (outputFormat === 'png' || outputFormat === 'jpeg') {
    if (!profile.outputFormat && outputFormat === 'png') return 'PNG output is not supported for this model';
  }
  if (optimizePromptMode === 'fast' && !profile.optimizeFast) {
    return 'Fast prompt optimization is not supported for this model';
  }
  if (sequential === 'auto' && !profile.sequential) {
    return 'Batch/sequential image generation is not supported for this model; use Lite, 4.5, or 4.0 for 组图';
  }
  if (webSearch && !profile.webSearch) return 'Web search is not supported for this model';
  if (stream && !profile.stream) return 'Stream output is not supported for this model';
  if (images.length > profile.maxReferenceImages) {
    return `Too many reference images (max ${profile.maxReferenceImages})`;
  }
  for (const image of images) {
    const check = validateReferenceImageEntry(image);
    if (check.error) return check.error;
  }
  if (sequential === 'auto' && images.length + maxImages > 15) {
    return 'Reference images plus generated images must not exceed 15';
  }
  return null;
}

function buildSeedreamRequestBody(options, resolvedImages = []) {
  const body = {
    model: options.model,
    prompt: options.prompt,
    size: options.size,
    response_format: options.stream ? 'b64_json' : 'url',
    watermark: options.watermark,
  };
  if (resolvedImages.length === 1) body.image = resolvedImages[0];
  else if (resolvedImages.length > 1) body.image = resolvedImages;
  if (options.profile.outputFormat) body.output_format = options.outputFormat;
  if (options.profile.optimizeFast || options.optimizePromptMode) {
    body.optimize_prompt_options = { mode: options.optimizePromptMode };
  }
  if (options.profile.background) body.background = options.background;
  if (options.profile.sequential) {
    body.sequential_image_generation = options.sequential;
    if (options.sequential === 'auto') {
      body.sequential_image_generation_options = { max_images: options.maxImages };
    }
  }
  if (options.profile.webSearch && options.webSearch) {
    body.tools = [{ type: 'web_search' }];
  }
  if (options.profile.layerDecomposition && options.layerDecomposition) {
    body.layer_decomposition = true;
  }
  if (options.profile.stream && options.stream) body.stream = true;
  return body;
}

function normalizeSeedreamItem(raw = {}) {
  const item = {
    url: typeof raw.url === 'string' ? raw.url.trim() : '',
    b64: typeof raw.b64_json === 'string' ? raw.b64_json : (typeof raw.b64 === 'string' ? raw.b64 : ''),
    size: typeof raw.size === 'string' ? raw.size : '',
    outputFormat: typeof raw.output_format === 'string' ? raw.output_format : '',
    zIndex: Number.isFinite(Number(raw.z_index)) ? Number(raw.z_index) : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    boundingBox: raw.bounding_box && typeof raw.bounding_box === 'object' ? raw.bounding_box : null,
    error: raw.error && typeof raw.error === 'object'
      ? { code: raw.error.code || '', message: raw.error.message || '' }
      : null,
  };
  return item;
}

function parseSeedreamResponse(json) {
  const data = json && typeof json === 'object' ? json : {};
  const items = Array.isArray(data.data) ? data.data.map(normalizeSeedreamItem) : [];
  return {
    items,
    usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
    error: data.error && typeof data.error === 'object'
      ? { code: data.error.code || '', message: data.error.message || '' }
      : null,
  };
}

function parseSeedreamStreamChunk(bufferText) {
  const items = [];
  const lines = String(bufferText || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload);
      if (event?.type === 'image_generation.partial_succeeded') {
        items.push(normalizeSeedreamItem({
          b64_json: event.b64_json,
          size: event.size,
          output_format: event.output_format,
        }));
      } else if (event?.type === 'image_generation.completed' && Array.isArray(event.data)) {
        for (const entry of event.data) items.push(normalizeSeedreamItem(entry));
      } else if (Array.isArray(event?.data)) {
        for (const entry of event.data) items.push(normalizeSeedreamItem(entry));
      } else if (event?.url || event?.b64_json) {
        items.push(normalizeSeedreamItem(event));
      }
    } catch {
      // ignore malformed chunks
    }
  }
  return items;
}

function mimeFromUploadFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  return 'image/jpeg';
}

function fileToDataUri(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length > MAX_REFERENCE_BYTES) {
    throw new Error('Reference image exceeds 30MB');
  }
  const mime = mimeFromUploadFilename(filePath);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function resolveReferenceImages(images, { dataDir, isSafeUploadFilename, preferPublicUrl = false, publicOrigin = '' }) {
  const resolved = [];
  for (const image of images) {
    const text = String(image || '').trim();
    if (!text) continue;
    if (DATA_URI_PATTERN.test(text) || /^https?:\/\//i.test(text)) {
      resolved.push(text);
      continue;
    }
    if (!text.startsWith('/uploads/')) {
      throw new Error('Unsupported reference image URL');
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
    if (preferPublicUrl && publicOrigin) {
      resolved.push(`${publicOrigin.replace(/\/+$/, '')}${text}`);
    } else {
      resolved.push(fileToDataUri(resolvedPath));
    }
  }
  return resolved;
}

function buildSeedreamMarkdown(savedImages, { layerDecomposition = false } = {}) {
  const lines = [];
  for (const item of savedImages) {
    const alt = item.name || item.description || 'generated image';
    const safeAlt = String(alt).slice(0, 80).replace(/[[\]]/g, '');
    lines.push(`![${safeAlt}](${item.url})`);
    if (layerDecomposition && item.zIndex != null) {
      const bits = [`z=${item.zIndex}`];
      if (item.name) bits.push(item.name);
      lines.push(`> 图层 ${bits.join(' · ')}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  SEEDREAM_PRO_MODEL,
  SEEDREAM_LITE_MODEL,
  SEEDREAM_LITE_ALIAS,
  SEEDREAM_45_MODEL,
  SEEDREAM_40_MODEL,
  SEEDREAM_DEFAULT_MODEL,
  SEEDREAM_ALLOWED_MODELS,
  SEEDREAM_DEFAULT_SETTINGS,
  SEEDREAM_MODEL_PROFILES,
  normalizeSeedreamModel,
  seedreamModelProfile,
  isAllowedSeedreamModel,
  isValidSeedreamSize,
  normalizeSeedreamSettings,
  parseSeedreamSettingsInput,
  mergeSeedreamCallArgs,
  validateSeedreamArgs,
  buildSeedreamRequestBody,
  parseSeedreamResponse,
  parseSeedreamStreamChunk,
  resolveReferenceImages,
  buildSeedreamMarkdown,
  normalizeImageList,
  validateReferenceImageEntry,
};
