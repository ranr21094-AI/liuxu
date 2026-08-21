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

test('normalizeCustomProviders rejects HTTPS private targets', async () => {
  await assert.rejects(
    () => normalizeCustomProviders([{
      id: 'p_badurl01',
      name: 'Bad',
      baseUrl: 'https://127.0.0.1/v1',
      apiFormat: 'openai',
      models: [{ id: 'm1', name: 'M1' }],
    }], []),
    /private network/i,
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
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'ai-settings.json'), 'utf8'));
    assert.notEqual(raw.customProviders[0].apiKey, 'local-secret');
    assert.match(raw.customProviders[0].apiKey, /^enc:v1:/);
    delete require.cache[require.resolve('../database.js')];
    const dbReload = createDatabase(dataDir);
    assert.equal(dbReload.getAiSettings().customProviders[0].apiKey, 'local-secret');
  } finally {
    delete process.env.DATA_DIR;
    delete process.env.AI_SECRETS_KEY_FILE;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
