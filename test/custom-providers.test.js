const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseCustomModelId,
  isCustomModelId,
  buildCustomModelRecords,
  sanitizeCustomProvidersSync,
  normalizeCustomProviders,
  isStoredCustomModel,
  publicCustomProviders,
  resolveModelCapability,
} = require('../lib/agent/custom-providers');
const {
  buildCustomProviderRequest,
  parseCustomProviderReply,
  normalizeOpenAiBaseUrl,
  normalizeAnthropicBaseUrl,
  normalizeResponsesBaseUrl,
  convertOpenAiMessagesToAnthropic,
  convertOpenAiMessagesToResponsesInput,
  openAiToolsToResponses,
  parseResponsesProviderReply,
} = require('../lib/agent/custom-api');

test('parseCustomModelId parses custom model refs', () => {
  assert.deepEqual(parseCustomModelId('custom/p_abcd1234/llama-3.1'), {
    providerId: 'p_abcd1234',
    modelId: 'llama-3.1',
  });
  assert.equal(parseCustomModelId('deepseek-v4-flash'), null);
  assert.equal(isCustomModelId('custom/p_abcd1234/llama-3.1'), true);
  assert.deepEqual(parseCustomModelId('custom/p_abcd1234/anthropic/claude-4'), {
    providerId: 'p_abcd1234',
    modelId: 'anthropic/claude-4',
  });
  assert.equal(isCustomModelId('custom/p_abcd1234/anthropic/claude-4'), true);
});

test('model-level capability overrides beat provider defaults', () => {
  const [provider] = sanitizeCustomProvidersSync([{
    id: 'p_caps5678',
    name: 'Mixed',
    baseUrl: 'https://api.example.com/v1',
    apiFormat: 'openai',
    supportsMedia: true,
    thinking: 'optional',
    zdr: true,
    models: [
      'plain-string-model',
      { id: 'vision-off', supportsMedia: false },
      { id: 'thinking-off', thinking: 'none' },
      { id: 'zdr-off', zdr: false },
    ],
  }]);
  assert.deepEqual(provider.models.map(model => model.id), [
    'plain-string-model', 'vision-off', 'thinking-off', 'zdr-off',
  ]);
  assert.deepEqual(resolveModelCapability(provider, provider.models[0]), {
    supportsMedia: true, thinking: 'optional', zdr: true,
  });
  assert.deepEqual(resolveModelCapability(provider, provider.models[1]), {
    supportsMedia: false, thinking: 'optional', zdr: true,
  });
  assert.deepEqual(resolveModelCapability(provider, provider.models[2]), {
    supportsMedia: true, thinking: 'none', zdr: true,
  });
  assert.deepEqual(resolveModelCapability(provider, provider.models[3]), {
    supportsMedia: true, thinking: 'optional', zdr: false,
  });

  const records = buildCustomModelRecords([provider]);
  assert.deepEqual(records[0].inputModalities, ['text', 'image']);
  assert.deepEqual(records[1].inputModalities, ['text']);

  const [publicProvider] = publicCustomProviders([provider]);
  assert.equal(publicProvider.models[1].supportsMedia, false);
  assert.equal(publicProvider.models[2].thinking, 'none');
  assert.equal(publicProvider.models[3].zdr, false);
});

test('normalizeCustomProvider passes through capability fields and allows zero models', () => {
  const [provider] = sanitizeCustomProvidersSync([{
    id: 'p_caps1234',
    name: 'Capable',
    baseUrl: 'https://api.example.com/v1',
    apiFormat: 'openai',
    apiKey: 'sk-x',
    supportsMedia: true,
    thinking: 'deepseek',
    zdr: true,
    models: [],
  }]);
  assert.ok(provider);
  assert.equal(provider.supportsMedia, true);
  assert.equal(provider.thinking, 'deepseek');
  assert.equal(provider.zdr, true);
  assert.deepEqual(provider.models, []);
  assert.equal(buildCustomModelRecords([provider]).length, 0);

  const [flagged] = sanitizeCustomProvidersSync([{
    id: 'p_caps1234',
    name: 'Capable',
    baseUrl: 'https://api.example.com/v1',
    apiFormat: 'openai',
    supportsMedia: false,
    thinking: 'bogus-style',
    zdr: false,
    models: [{ id: 'anthropic/claude-4', name: 'Claude 4' }],
  }]);
  assert.equal(flagged.supportsMedia, false);
  assert.equal(flagged.thinking, '');
  assert.equal(flagged.zdr, false);
  const record = buildCustomModelRecords([flagged])[0];
  assert.equal(record.id, 'custom/p_caps1234/anthropic/claude-4');
  assert.deepEqual(record.inputModalities, ['text']);

  const [vision] = sanitizeCustomProvidersSync([{
    id: 'p_vision12',
    name: 'Vision',
    baseUrl: 'https://api.example.com/v1',
    apiFormat: 'openai',
    supportsMedia: true,
    models: [{ id: 'vision-model', name: 'Vision' }],
  }]);
  assert.deepEqual(buildCustomModelRecords([vision])[0].inputModalities, ['text', 'image']);

  const [publicProvider] = publicCustomProviders([flagged]);
  assert.equal(publicProvider.apiKey, undefined);
  assert.equal(publicProvider.thinking, '');
  assert.equal(publicProvider.supportsMedia, false);
});

test('buildCustomModelRecords exposes grouped custom models', () => {
  const records = buildCustomModelRecords([{
    id: 'p_test1234',
    name: 'Local Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiFormat: 'openai',
    models: [{ id: 'llama3.2', name: 'Llama 3.2' }],
  }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'custom/p_test1234/llama3.2');
  assert.equal(records[0].provider, 'custom');
  assert.equal(records[0].apiFormat, 'openai');
});

test('sanitizeCustomProvidersSync keeps provider api keys when omitted', () => {
  const current = [{
    id: 'p_keepkey1',
    name: 'Proxy',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiFormat: 'openai',
    apiKey: 'secret-key',
    models: [{ id: 'gpt-4o-mini', name: 'Mini' }],
  }];
  const next = sanitizeCustomProvidersSync([{
    id: 'p_keepkey1',
    name: 'Proxy',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiFormat: 'openai',
    models: [{ id: 'gpt-4o-mini', name: 'Mini' }],
  }], current);
  assert.equal(next[0].apiKey, 'secret-key');
});

test('normalizeCustomProviders allows HTTPS private and LAN targets', async () => {
  const next = await normalizeCustomProviders([{
    id: 'p_local001',
    name: 'Local HTTPS',
    baseUrl: 'https://127.0.0.1:11434/v1',
    apiFormat: 'openai',
    models: [{ id: 'm1', name: 'M1' }],
  }, {
    id: 'p_lan00001',
    name: 'LAN HTTP',
    baseUrl: 'http://192.168.1.10:8080/v1',
    apiFormat: 'openai',
    models: [{ id: 'm2', name: 'M2' }],
  }], []);
  assert.equal(next.length, 2);
  assert.equal(next[0].baseUrl, 'https://127.0.0.1:11434/v1');
  assert.equal(next[1].baseUrl, 'http://192.168.1.10:8080/v1');
});

test('normalizeCustomProviders rejects HTTP on public hosts', async () => {
  await assert.rejects(
    () => normalizeCustomProviders([{
      id: 'p_badurl01',
      name: 'Bad',
      baseUrl: 'http://api.example.com/v1',
      apiFormat: 'openai',
      models: [{ id: 'm1', name: 'M1' }],
    }], []),
    /HTTP base URL is only allowed/i,
  );
});

test('normalizeCustomProviders skips DNS re-check when base URL is unchanged', async () => {
  const current = [{
    id: 'p_keepurl1',
    name: 'Getoken',
    baseUrl: 'https://api.getoken.tech/v1',
    apiFormat: 'openai',
    apiKey: 'secret',
    models: [{ id: 'gpt-5.6-sol', name: 'GPT' }],
  }];
  const next = await normalizeCustomProviders([{
    id: 'p_keepurl1',
    name: 'Getoken',
    baseUrl: 'https://api.getoken.tech/v1',
    apiFormat: 'openai',
    models: [{ id: 'gpt-5.6-sol', name: 'GPT' }],
  }], current);
  assert.equal(next.length, 1);
  assert.equal(next[0].baseUrl, 'https://api.getoken.tech/v1');
  assert.equal(next[0].apiKey, 'secret');
});

test('isStoredCustomModel validates saved custom refs', () => {
  const settings = {
    customProviders: [{
      id: 'p_saved001',
      name: 'Saved',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiFormat: 'openai',
      models: [{ id: 'qwen2.5', name: 'Qwen' }],
    }],
  };
  assert.equal(isStoredCustomModel('custom/p_saved001/qwen2.5', settings), true);
  assert.equal(isStoredCustomModel('custom/p_saved001/missing', settings), false);
});

test('publicCustomProviders hides api keys', () => {
  const output = publicCustomProviders([{
    id: 'p_pub00001',
    name: 'Proxy',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiFormat: 'anthropic',
    apiKey: 'secret',
    models: [{ id: 'claude', name: 'Claude' }],
  }]);
  assert.equal(output[0].apiKeyConfigured, true);
  assert.equal(output[0].apiKey, undefined);
});

test('buildCustomProviderRequest targets OpenAI and Anthropic endpoints', () => {
  const openai = buildCustomProviderRequest({
    options: {
      model: 'gpt-4o-mini',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: 'sk-test',
      profile: { apiFormat: 'openai' },
    },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    stream: false,
  });
  assert.equal(normalizeOpenAiBaseUrl('http://127.0.0.1:8080/v1'), openai.url);
  assert.equal(openai.headers.Authorization, 'Bearer sk-test');

  const anthropic = buildCustomProviderRequest({
    options: {
      model: 'claude-3-5-sonnet-20241022',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant',
      profile: { apiFormat: 'anthropic' },
    },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    stream: false,
  });
  assert.equal(normalizeAnthropicBaseUrl('https://api.anthropic.com/v1'), anthropic.url);
  assert.equal(anthropic.headers['x-api-key'], 'sk-ant');
  assert.equal(anthropic.body.max_tokens, 8192);
});

test('convertOpenAiMessagesToAnthropic maps tool calls and results', () => {
  const converted = convertOpenAiMessagesToAnthropic([
    { role: 'system', content: 'Be helpful' },
    { role: 'user', content: 'run tool' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"x"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
  ]);
  assert.match(converted.system, /Be helpful/);
  assert.equal(converted.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(converted.messages.at(-1).content[0].tool_use_id, 'call_1');
});

test('parseCustomProviderReply normalizes OpenAI and Anthropic payloads', () => {
  const openai = parseCustomProviderReply('openai', {
    choices: [{
      message: {
        content: 'hello',
        tool_calls: [{ id: 't1', function: { name: 'search', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  });
  assert.equal(openai.content, 'hello');
  assert.equal(openai.toolCalls.length, 1);

  const anthropic = parseCustomProviderReply('anthropic', {
    content: [
      { type: 'text', text: 'done' },
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } },
    ],
    stop_reason: 'tool_use',
  });
  assert.equal(anthropic.content, 'done');
  assert.equal(anthropic.toolCalls[0].function.name, 'search');
});

test('buildCustomProviderRequest targets Responses endpoint with flat tools', () => {
  const responses = buildCustomProviderRequest({
    options: {
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      profile: { apiFormat: 'responses' },
    },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      type: 'function',
      function: { name: 'search', description: 'Search', parameters: { type: 'object', properties: {} } },
    }],
    toolChoice: 'auto',
    stream: false,
  });
  assert.equal(normalizeResponsesBaseUrl('https://api.deepseek.com'), responses.url);
  assert.equal(responses.body.tools[0].name, 'search');
  assert.equal(responses.body.tools[0].function, undefined);
  assert.equal(responses.body.input[0].content[0].text, 'hi');
});

test('convertOpenAiMessagesToResponsesInput maps tool calls and results', () => {
  const converted = convertOpenAiMessagesToResponsesInput([
    { role: 'system', content: 'Be helpful' },
    { role: 'user', content: 'run tool' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"x"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
  ]);
  assert.match(converted.instructions, /Be helpful/);
  assert.equal(converted.input.at(-1).type, 'function_call_output');
  assert.equal(converted.input.at(-1).call_id, 'call_1');
  assert.equal(converted.input.find(item => item.type === 'function_call')?.name, 'lookup');
});

test('openAiToolsToResponses flattens Chat Completions tool schema', () => {
  const tools = openAiToolsToResponses([{
    type: 'function',
    function: { name: 'search', description: 'Search docs', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  }]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].name, 'search');
});

test('parseResponsesProviderReply extracts message text and function calls', () => {
  const parsed = parseResponsesProviderReply({
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
    ],
  });
  assert.equal(parsed.content, 'hello');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'search');

  const viaCustom = parseCustomProviderReply('responses', {
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ],
    output_text: 'done',
  });
  assert.equal(viaCustom.content, 'done');
});

test('database encrypts custom provider api keys', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-provider-db-'));
  try {
    delete require.cache[require.resolve('../database.js')];
    process.env.DATA_DIR = dataDir;
    process.env.AI_SECRETS_KEY_FILE = path.join(dataDir, 'ai-secrets.key');
    const { createDatabase } = require('../database.js');
    const db = createDatabase(dataDir);
    const saved = db.saveAiSettings({
      ...db.getAiSettings(),
      customProviders: [{
        id: 'p_enc00001',
        name: 'Local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiFormat: 'openai',
        apiKey: 'local-secret',
        models: [{ id: 'llama3.2', name: 'Llama' }],
      }],
    });
    assert.equal(saved.customProviders[0].apiKey, 'local-secret');
    const row = db.sqlite.prepare('SELECT body FROM ai_settings WHERE id = 1').get();
    const raw = JSON.parse(row.body);
    assert.notEqual(raw.customProviders[0].apiKey, 'local-secret');
    assert.match(raw.customProviders[0].apiKey, /^enc:v1:/);
    delete require.cache[require.resolve('../database.js')];
    db.close();
    const dbReload = createDatabase(dataDir);
    assert.equal(dbReload.getAiSettings().customProviders[0].apiKey, 'local-secret');
    dbReload.close();
  } finally {
    delete process.env.DATA_DIR;
    delete process.env.AI_SECRETS_KEY_FILE;
    const { closeAllDatabases } = require('../lib/db/connection');
    closeAllDatabases();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
