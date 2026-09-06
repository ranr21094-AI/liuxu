const DEFAULT_AGENT_SETTINGS = Object.freeze({
  agentDelegateMaxRounds: 8,
  agentMaxToolFailures: 3,
  agentReadConcurrency: 4,
  agentRepeatMutationLimit: 3,
  agentWebFetchMaxKb: 512,
  agentWebFetchTimeoutSec: 15,
  agentKnowledgeSearchLimit: 20,
  agentKnowledgeSearchMaxLimit: 60,
  agentKnowledgeListLimit: 40,
  agentKnowledgeListMaxLimit: 100,
  agentMemorySearchLimit: 20,
  agentMemorySearchMaxLimit: 40,
  agentMemoryListLimit: 40,
  agentMemoryListMaxLimit: 100,
});

const AGENT_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_AGENT_SETTINGS));

const AGENT_SETTING_LIMITS = Object.freeze({
  agentDelegateMaxRounds: { min: 1, max: 32 },
  agentMaxToolFailures: { min: 1, max: 20 },
  agentReadConcurrency: { min: 1, max: 16 },
  agentRepeatMutationLimit: { min: 1, max: 20 },
  agentWebFetchMaxKb: { min: 1, max: 4096 },
  agentWebFetchTimeoutSec: { min: 1, max: 120 },
  agentKnowledgeSearchLimit: { min: 1, max: 200 },
  agentKnowledgeSearchMaxLimit: { min: 1, max: 200 },
  agentKnowledgeListLimit: { min: 1, max: 200 },
  agentKnowledgeListMaxLimit: { min: 1, max: 200 },
  agentMemorySearchLimit: { min: 1, max: 200 },
  agentMemorySearchMaxLimit: { min: 1, max: 200 },
  agentMemoryListLimit: { min: 1, max: 200 },
  agentMemoryListMaxLimit: { min: 1, max: 200 },
});

function limitsFor(key) {
  return AGENT_SETTING_LIMITS[key] || { min: 1, max: Number.MAX_SAFE_INTEGER };
}

function normalizePositiveInt(value, fallback, { min = 1, max } = {}) {
  const n = Number(value);
  const base = Number(fallback);
  const safeFallback = Number.isFinite(base) ? base : fallback;
  const ceiling = Number.isFinite(max) ? max : Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(n)) return Math.min(ceiling, Math.max(min, Number(safeFallback) || min));
  return Math.min(ceiling, Math.max(min, Math.round(n)));
}

function resolveAgentSettings(source = {}) {
  const input = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const resolved = {};
  for (const key of AGENT_SETTING_KEYS) {
    const { min, max } = limitsFor(key);
    resolved[key] = normalizePositiveInt(input[key], DEFAULT_AGENT_SETTINGS[key], { min, max });
  }
  if (resolved.agentKnowledgeSearchLimit > resolved.agentKnowledgeSearchMaxLimit) {
    resolved.agentKnowledgeSearchLimit = resolved.agentKnowledgeSearchMaxLimit;
  }
  if (resolved.agentKnowledgeListLimit > resolved.agentKnowledgeListMaxLimit) {
    resolved.agentKnowledgeListLimit = resolved.agentKnowledgeListMaxLimit;
  }
  if (resolved.agentMemorySearchLimit > resolved.agentMemorySearchMaxLimit) {
    resolved.agentMemorySearchLimit = resolved.agentMemorySearchMaxLimit;
  }
  if (resolved.agentMemoryListLimit > resolved.agentMemoryListMaxLimit) {
    resolved.agentMemoryListLimit = resolved.agentMemoryListMaxLimit;
  }
  return resolved;
}

function parseAgentSettingInput(value, fallback, key) {
  const { min, max } = limitsFor(key);
  if (value === undefined || value === null || value === '') {
    return normalizePositiveInt(fallback, DEFAULT_AGENT_SETTINGS[key], { min, max });
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Unsupported ${key} option`);
  }
  return n;
}

function parseAgentSettingsInput(body = {}, current = {}) {
  const resolved = {};
  for (const key of AGENT_SETTING_KEYS) {
    resolved[key] = parseAgentSettingInput(body[key], current[key], key);
  }
  return resolveAgentSettings(resolved);
}

module.exports = {
  DEFAULT_AGENT_SETTINGS,
  AGENT_SETTING_KEYS,
  AGENT_SETTING_LIMITS,
  resolveAgentSettings,
  parseAgentSettingsInput,
  normalizePositiveInt,
};
