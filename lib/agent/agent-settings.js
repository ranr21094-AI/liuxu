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

function normalizePositiveInt(value, fallback, { min = 1 } = {}) {
  const n = Number(value);
  const base = Number(fallback);
  const safeFallback = Number.isFinite(base) ? base : fallback;
  if (!Number.isFinite(n)) return safeFallback;
  return Math.max(min, Math.round(n));
}

function resolveAgentSettings(source = {}) {
  const input = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const resolved = {};
  for (const key of AGENT_SETTING_KEYS) {
    resolved[key] = normalizePositiveInt(input[key], DEFAULT_AGENT_SETTINGS[key]);
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
  if (value === undefined || value === null || value === '') {
    return normalizePositiveInt(fallback, DEFAULT_AGENT_SETTINGS[key]);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
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
  resolveAgentSettings,
  parseAgentSettingsInput,
  normalizePositiveInt,
};
