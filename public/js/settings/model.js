/** Stable, renderer-only model identity helpers.  These IDs are stripped
 * before settings are persisted and therefore never change the API format. */
export function randomModelUiId() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return `m_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function ensureModelUiId(model) {
  if (!model || typeof model !== 'object') return randomModelUiId();
  if (!model._uiId) model._uiId = randomModelUiId();
  return model._uiId;
}

export function customModelTestKey(providerId, modelUiId) {
  return `${providerId}:${modelUiId}`;
}

/**
 * Replace one provider in an in-memory settings draft without dropping
 * providers whose detail panels are not currently rendered.  The stable ID
 * wins over the fallback index so a reordered sidebar cannot update the wrong
 * provider.
 */
export function replaceProviderDraft(providers, provider, fallbackIndex = -1) {
  const list = Array.isArray(providers) ? providers.slice() : [];
  if (!provider || typeof provider !== 'object') return list;
  const providerId = typeof provider.id === 'string' ? provider.id : '';
  const byId = providerId ? list.findIndex(item => item?.id === providerId) : -1;
  const targetIndex = byId >= 0
    ? byId
    : (Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < list.length
      ? fallbackIndex
      : -1);
  if (targetIndex >= 0) list[targetIndex] = provider;
  else list.push(provider);
  return list;
}

const PROVIDER_ID_PATTERN = /^p_[a-z0-9_-]{1,32}$/i;
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:+/-]{1,160}$/;

function providerFallbackLabel(provider, index) {
  const baseUrl = typeof provider?.baseUrl === 'string' ? provider.baseUrl.trim() : '';
  if (baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname;
      if (hostname) return hostname;
    } catch {
      // Keep a generic label for an invalid or incomplete draft URL.
    }
  }
  return `未命名供应商${index > 0 ? ` ${index + 1}` : ''}`;
}

/**
 * Build the grouped model options used by both Agent model selectors.
 * Provider IDs are internal identities, never user-facing labels. Invalid,
 * duplicate or empty model entries are omitted so stale drafts cannot leak
 * unknown options into the picker.
 */
export function buildModelPickerGroups(providers = []) {
  if (!Array.isArray(providers)) return [];
  const seenProviders = new Set();
  const seenRefs = new Set();
  const groups = [];
  providers.forEach((provider, providerIndex) => {
    if (!provider || typeof provider !== 'object') return;
    const providerId = typeof provider.id === 'string' ? provider.id.trim() : '';
    if (!PROVIDER_ID_PATTERN.test(providerId) || seenProviders.has(providerId)) return;
    seenProviders.add(providerId);
    const items = [];
    if (provider.enabled === false) return;
    const sourceModels = Array.isArray(provider.models) ? provider.models : [];
    sourceModels.forEach(model => {
      if (!model || typeof model !== 'object') return;
      const modelId = typeof model.id === 'string' ? model.id.trim() : '';
      if (!MODEL_ID_PATTERN.test(modelId)) return;
      const ref = `custom/${providerId}/${modelId}`;
      if (seenRefs.has(ref)) return;
      seenRefs.add(ref);
      const modelName = typeof model.name === 'string' ? model.name.trim() : '';
      items.push({ id: ref, name: modelName || modelId });
    });
    if (!items.length) return;
    const name = typeof provider.name === 'string' ? provider.name.trim() : '';
    const label = name && name.toLowerCase() !== providerId.toLowerCase()
      ? name
      : providerFallbackLabel(provider, providerIndex);
    groups.push({ label, items });
  });
  return groups;
}
