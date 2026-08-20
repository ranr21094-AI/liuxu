const DEFAULT_MEMORY_SETTINGS = Object.freeze({
  memoryRefreshMaxRounds: 4,
  memoryRefreshMaxProposals: 5,
  memoryRefreshSessionLimit: 8,
  memoryRefreshMessageLimit: 12,
  memoryRefreshMessageChars: 8000,
  memoryRefreshSessionBlockChars: 8000,
  memoryRefreshTotalChars: 40000,
  memoryTitleMaxChars: 40,
  memoryContentMaxCharsL2: 240,
  memoryContentMaxCharsL3: 1200,
  memoryContextMaxL2: 20,
  memoryContextMaxL3: 20,
});

const MEMORY_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_MEMORY_SETTINGS));

function normalizePositiveInt(value, fallback, { min = 1 } = {}) {
  const n = Number(value);
  const base = Number(fallback);
  const safeFallback = Number.isFinite(base) ? base : fallback;
  if (!Number.isFinite(n)) return safeFallback;
  return Math.max(min, Math.round(n));
}

function resolveMemorySettings(source = {}) {
  const input = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const resolved = {};
  for (const key of MEMORY_SETTING_KEYS) {
    resolved[key] = normalizePositiveInt(input[key], DEFAULT_MEMORY_SETTINGS[key]);
  }
  return resolved;
}

function parseMemorySettingInput(value, fallback, key) {
  if (value === undefined || value === null || value === '') {
    return normalizePositiveInt(fallback, DEFAULT_MEMORY_SETTINGS[key]);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Unsupported ${key} option`);
  }
  return n;
}

function parseMemorySettingsInput(body = {}, current = {}) {
  const resolved = {};
  for (const key of MEMORY_SETTING_KEYS) {
    resolved[key] = parseMemorySettingInput(body[key], current[key], key);
  }
  return resolved;
}

module.exports = {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_SETTING_KEYS,
  resolveMemorySettings,
  parseMemorySettingsInput,
  normalizePositiveInt,
};
