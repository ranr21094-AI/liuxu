const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAgentSettingsInput, resolveAgentSettings, DEFAULT_AGENT_SETTINGS } = require('../lib/agent/agent-settings');

test('agent settings clamp stored oversized values and reject them on save', () => {
  const resolved = resolveAgentSettings({ agentWebFetchMaxKb: 999999, agentWebFetchTimeoutSec: 1 });
  assert.equal(resolved.agentWebFetchMaxKb, 4096);
  assert.equal(resolved.agentDelegateMaxRounds, DEFAULT_AGENT_SETTINGS.agentDelegateMaxRounds);
  assert.throws(() => parseAgentSettingsInput({ agentWebFetchMaxKb: 999999 }, {}), /Unsupported agentWebFetchMaxKb/);
  assert.throws(() => parseAgentSettingsInput({ agentMaxToolFailures: 0 }, {}), /Unsupported agentMaxToolFailures/);
});
