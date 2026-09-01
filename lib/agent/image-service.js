const {
  routeImageModel,
  resolveImageModel,
  imageModelRef,
  MAX_OUTPUTS,
  MAX_REFERENCES,
} = require('./image-providers');
const {
  normalizeImageList,
  validateReferenceImageEntry,
} = require('./seedream');
const { isPrivateIpLiteral } = require('../net/ssrf');

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function pickAllowed(value, allowed, fallback = '') {
  const text = String(value ?? fallback ?? '').trim();
  if (!text) return '';
  return allowed.includes(text) ? text : '';
}

function resolveProviderKey(provider, model, envLookup = () => '') {
  if (provider.apiKey) return provider.apiKey;
  return model.legacyEnvVar ? String(envLookup(model.legacyEnvVar) || '').trim() : '';
}

function normalizeUnifiedImageRequest(settings, args = {}, envLookup = () => '') {
  const selected = routeImageModel(settings, args);
  const { provider, model } = selected;
  const caps = model.capabilities || {};
  const defaults = model.defaults || {};
  const images = normalizeImageList(args.images ?? args.image);
  const requestedCount = args.count ?? args.n ?? args.batch_size ?? args.max_images;
  const count = clampInteger(requestedCount, defaults.count || 1, 1, Math.min(MAX_OUTPUTS, Math.max(1, caps.maxOutputs || 1)));
  const requestedSize = String(args.size ?? defaults.size ?? '').trim();
  const size = (caps.sizes || []).includes(requestedSize)
    || (caps.customSize && /^\d{3,5}x\d{3,5}$/i.test(requestedSize))
    ? requestedSize
    : '';
  const quality = pickAllowed(args.quality, caps.qualities || [], defaults.quality);
  const outputFormat = pickAllowed(args.outputFormat ?? args.output_format, caps.outputFormats || [], defaults.outputFormat);
  const background = (args.background || defaults.background) === 'transparent' ? 'transparent' : 'opaque';
  const layerDecomposition = args.layerDecomposition === true || args.layer_decomposition === true;
  const webSearch = args.webSearch === true || args.web_search === true || defaults.webSearch === true;
  const stream = typeof args.stream === 'boolean' ? args.stream : defaults.streaming === true;
  const watermark = typeof args.watermark === 'boolean' ? args.watermark : defaults.watermark !== false;
  const promptOptimization = String(args.promptOptimization || args.optimize_prompt_mode || defaults.promptOptimization || 'standard') === 'fast'
    ? 'fast'
    : 'standard';
  const prompt = String(args.prompt || '').trim();

  if (!prompt) throw new Error('Image prompt is required');
  if (prompt.length > 4000) throw new Error('Image prompt is too long');
  if (images.length > Math.min(MAX_REFERENCES, caps.maxReferences || 0)) {
    throw new Error(`Too many reference images (max ${Math.min(MAX_REFERENCES, caps.maxReferences || 0)})`);
  }
  for (const image of images) {
    const check = validateReferenceImageEntry(image);
    if (check.error) throw new Error(check.error);
  }
  if (images.length && !caps.imageEdit) throw new Error('Selected image model does not support reference images');
  if (requestedCount != null && Number(requestedCount) > Math.max(1, caps.maxOutputs || 1)) {
    throw new Error(`Selected image model supports at most ${Math.max(1, caps.maxOutputs || 1)} output(s)`);
  }
  if ((args.size || defaults.size) && !size) throw new Error('Unsupported image size for the selected model');
  if ((args.quality || defaults.quality) && !quality) throw new Error('Unsupported image quality for the selected model');
  if ((args.outputFormat || args.output_format || defaults.outputFormat) && !outputFormat) throw new Error('Unsupported output format for the selected model');
  if (background === 'transparent' && !caps.transparentBackground) throw new Error('Selected image model does not support transparent background');
  if (layerDecomposition && !caps.layerDecomposition) throw new Error('Selected image model does not support layer decomposition');
  if (webSearch && !caps.webSearch) throw new Error('Selected image model does not support web search');
  if (count > 1 && images.length + count > 15) throw new Error('Reference images plus generated images must not exceed 15');
  if (provider.adapter === 'seedream' && layerDecomposition && images.length !== 1) {
    throw new Error('Layer decomposition requires exactly one reference image');
  }
  if (provider.adapter === 'seedream' && background === 'transparent') {
    if (images.length !== 1) throw new Error('Transparent background requires exactly one reference image');
    if (outputFormat !== 'png') throw new Error('Transparent background requires PNG output');
  }

  return {
    provider,
    model,
    modelRef: imageModelRef(provider, model),
    apiKey: resolveProviderKey(provider, model, envLookup),
    prompt,
    images,
    count,
    size,
    quality,
    outputFormat,
    background,
    watermark,
    promptOptimization,
    layerDecomposition,
    webSearch,
    stream,
  };
}

function seedreamOptions(request, context = {}) {
  const caps = request.model.capabilities || {};
  return {
    apiKey: request.apiKey,
    baseUrl: request.provider.baseUrl,
    model: request.model.upstreamId,
    profile: {
      outputFormat: (caps.outputFormats || []).length > 1,
      optimizeFast: caps.promptOptimization === true,
      background: caps.transparentBackground === true,
      sequential: caps.sequential === true,
      webSearch: caps.webSearch === true,
      layerDecomposition: caps.layerDecomposition === true,
      stream: caps.streaming === true,
    },
    prompt: request.prompt,
    size: request.size,
    watermark: request.watermark,
    outputFormat: request.outputFormat || 'jpeg',
    optimizePromptMode: request.promptOptimization,
    sequential: request.count > 1 ? 'auto' : 'disabled',
    maxImages: request.count,
    webSearch: request.webSearch,
    background: request.background,
    stream: request.count > 1 && request.stream,
    layerDecomposition: request.layerDecomposition,
    images: request.images,
    ...context,
  };
}

function openAiOptions(request, context = {}) {
  return {
    apiKey: request.apiKey,
    model: request.model.upstreamId,
    prompt: request.prompt,
    size: request.size,
    quality: request.quality,
    n: request.count,
    images: request.images,
    signal: context.signal,
    ...context,
  };
}

const IMAGE_GENERATION_ADAPTERS = Object.freeze({
  seedream: async (request, dependencies) => dependencies.requestSeedream(
    seedreamOptions(request, dependencies.context),
    dependencies.signal,
  ),
  'openai-images': async (request, dependencies) => {
    const options = openAiOptions(request, { ...dependencies.context, signal: dependencies.signal });
    return request.images.length
      ? dependencies.requestOpenAiEdit(options, { baseUrl: request.provider.baseUrl, ...dependencies.context, signal: dependencies.signal })
      : dependencies.requestOpenAiGeneration(options, { baseUrl: request.provider.baseUrl, signal: dependencies.signal });
  },
});

async function generateUnifiedImage(request, dependencies = {}) {
  let localEndpoint = false;
  try {
    const url = new URL(request.provider.baseUrl);
    localEndpoint = url.protocol === 'http:' || url.hostname === 'localhost' || isPrivateIpLiteral(url.hostname);
  } catch {}
  if (!request.apiKey && !localEndpoint) {
    throw new Error(`${request.provider.name} API key is not configured`);
  }
  const adapter = IMAGE_GENERATION_ADAPTERS[request.provider.adapter];
  if (!adapter) throw new Error('Unsupported image provider adapter');
  return adapter(request, dependencies);
}

function publicGenerationSelection(settings, ref) {
  const selected = resolveImageModel(settings, ref);
  if (!selected) return null;
  return {
    providerId: selected.provider.id,
    providerName: selected.provider.name,
    adapter: selected.provider.adapter,
    modelRef: selected.modelRef,
    model: selected.model.upstreamId,
    modelName: selected.model.name,
  };
}

module.exports = {
  resolveProviderKey,
  IMAGE_GENERATION_ADAPTERS,
  normalizeUnifiedImageRequest,
  generateUnifiedImage,
  publicGenerationSelection,
};
