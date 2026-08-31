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
