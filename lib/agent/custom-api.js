const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;

function normalizeOpenAiBaseUrl(baseUrl) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (root.endsWith('/chat/completions')) return root;
  return `${root}/chat/completions`;
}

function normalizeAnthropicBaseUrl(baseUrl) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (root.endsWith('/messages')) return root;
  return `${root}/messages`;
}

function normalizeResponsesBaseUrl(baseUrl) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (root.endsWith('/responses')) return root;
  return `${root}/responses`;
}

function openAiHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function anthropicHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && part.type === 'text') return String(part.text || '');
      return '';
    }).filter(Boolean).join('\n');
  }
  return String(content ?? '');
}

function splitSystemMessages(messages = []) {
  const systemParts = [];
  const conversation = [];
  for (const message of messages) {
    if (message?.role === 'system') {
      const text = messageText(message.content).trim();
      if (text) systemParts.push(text);
      continue;
    }
    conversation.push(message);
  }
  return { system: systemParts.join('\n\n'), conversation };
}

function openAiToolsToAnthropic(tools = []) {
  return tools.map(tool => {
    const fn = tool?.function || tool;
    return {
      name: String(fn?.name || '').slice(0, 120),
      description: String(fn?.description || '').slice(0, 4000),
      input_schema: fn?.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    };
  }).filter(tool => tool.name);
}

function anthropicToolChoice(toolChoice) {
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'none') return { type: 'none' };
  return { type: 'auto' };
}

function convertOpenAiMessagesToAnthropic(messages = []) {
  const { system, conversation } = splitSystemMessages(messages);
  const output = [];
  for (const message of conversation) {
    if (message.role === 'tool') {
      output.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(message.tool_call_id || message.tool_use_id || ''),
          content: messageText(message.content),
        }],
      });
      continue;
    }
    if (message.role === 'assistant') {
      const blocks = [];
      const text = messageText(message.content).trim();
      if (text) blocks.push({ type: 'text', text });
      for (const call of message.tool_calls || []) {
        const fn = call?.function || call;
        let input = {};
        try {
          input = typeof fn?.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn?.arguments || {});
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: String(call.id || call.tool_use_id || ''),
          name: String(fn?.name || call.name || ''),
          input: input && typeof input === 'object' ? input : {},
        });
      }
      output.push({ role: 'assistant', content: blocks.length ? blocks : '' });
      continue;
    }
    output.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    });
  }
  return { system, messages: output };
}

function openAiToolsToResponses(tools = []) {
  return tools.map(tool => {
    const fn = tool?.function || tool;
    return {
      type: 'function',
      name: String(fn?.name || '').slice(0, 120),
      description: String(fn?.description || '').slice(0, 4000),
      parameters: fn?.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    };
  }).filter(tool => tool.name);
}

function responsesMessageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return messageText(content);
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      return String(part.text || '');
    }
    return '';
  }).filter(Boolean).join('\n');
}

function convertOpenAiMessagesToResponsesInput(messages = []) {
  const { system, conversation } = splitSystemMessages(messages);
  const input = [];
  for (const message of conversation) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id || message.call_id || ''),
        output: messageText(message.content),
      });
      continue;
    }
    if (message.role === 'assistant') {
      const text = messageText(message.content).trim();
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      for (const call of message.tool_calls || []) {
        const fn = call?.function || call;
        input.push({
          type: 'function_call',
          call_id: String(call.id || call.call_id || ''),
          name: String(fn?.name || call.name || ''),
          arguments: typeof fn?.arguments === 'string'
            ? fn.arguments
            : JSON.stringify(fn?.arguments && typeof fn.arguments === 'object' ? fn.arguments : {}),
        });
      }
      continue;
    }
    const text = messageText(message.content).trim();
    if (!text) continue;
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    });
  }
  return { instructions: system, input };
}

function buildCustomResponsesRequest({ options, messages, tools, toolChoice, stream = false, extras = {} }) {
  const converted = convertOpenAiMessagesToResponsesInput(messages);
  const payload = {
    model: options.model,
    stream,
    ...extras,
  };
  if (converted.instructions) payload.instructions = converted.instructions;
  payload.input = converted.input.length ? converted.input : 'ping';
  const responseTools = openAiToolsToResponses(tools || []);
  if (responseTools.length) {
    payload.tools = responseTools;
    if (toolChoice) payload.tool_choice = toolChoice;
  }
  return {
    url: normalizeResponsesBaseUrl(options.baseUrl),
    headers: openAiHeaders(options.apiKey),
    body: payload,
  };
}

function buildCustomOpenAiRequest({ options, messages, tools, toolChoice, stream = false }) {
  const payload = {
    model: options.model,
    messages,
    stream,
  };
  if (Array.isArray(tools) && tools.length) payload.tools = tools;
  if (toolChoice) payload.tool_choice = toolChoice;
  return {
    url: normalizeOpenAiBaseUrl(options.baseUrl),
    headers: openAiHeaders(options.apiKey),
    body: payload,
  };
}

function buildCustomAnthropicRequest({ options, messages, tools, toolChoice, stream = false }) {
  const converted = convertOpenAiMessagesToAnthropic(messages);
  const payload = {
    model: options.model,
    max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
    messages: converted.messages,
    stream,
  };
  if (converted.system) payload.system = converted.system;
  const anthropicTools = openAiToolsToAnthropic(tools || []);
  if (anthropicTools.length) {
    payload.tools = anthropicTools;
    payload.tool_choice = anthropicToolChoice(toolChoice);
  }
  return {
    url: normalizeAnthropicBaseUrl(options.baseUrl),
    headers: anthropicHeaders(options.apiKey),
    body: payload,
  };
}

function buildCustomProviderRequest(params) {
  const apiFormat = params.options?.profile?.apiFormat || params.options?.apiFormat || 'openai';
  if (apiFormat === 'anthropic') {
    return buildCustomAnthropicRequest(params);
  }
  if (apiFormat === 'responses') {
    return buildCustomResponsesRequest(params);
  }
  return buildCustomOpenAiRequest(params);
}

function buildCustomProviderModelsRequest({ baseUrl, apiFormat = 'openai', apiKey = '' }) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const headers = apiFormat === 'anthropic' ? anthropicHeaders(apiKey) : openAiHeaders(apiKey);
  return { url: `${root}/models`, headers };
}

function parseOpenAiProviderReply(data) {
  const message = data?.choices?.[0]?.message;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const reply = typeof message?.content === 'string' ? message.content : messageText(message?.content);
  return {
    content: reply,
    reasoningContent: '',
    openrouterReasoningDetails: [],
    sources: [],
    toolCalls,
    rawMessage: message,
    finishReason: data?.choices?.[0]?.finish_reason || '',
  };
}

function parseResponsesProviderReply(data) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const textParts = [];
  const toolCalls = [];
  const reasoningParts = [];
  for (const item of output) {
    if (item?.type === 'message') {
      const text = responsesMessageContentText(item.content).trim();
      if (text) textParts.push(text);
    }
    if (item?.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id || item.id || ''),
        type: 'function',
        function: {
          name: String(item.name || ''),
          arguments: typeof item.arguments === 'string'
            ? item.arguments
            : JSON.stringify(item.arguments && typeof item.arguments === 'object' ? item.arguments : {}),
        },
      });
    }
    if (item?.type === 'reasoning') {
      const text = responsesMessageContentText(item.content || item.summary).trim();
      if (text) reasoningParts.push(text);
    }
  }
  const content = textParts.join('\n').trim() || String(data?.output_text || '').trim();
  return {
    content,
    reasoningContent: reasoningParts.join('\n').trim(),
    openrouterReasoningDetails: [],
    sources: [],
    toolCalls,
    rawMessage: { role: 'assistant', content: output },
    finishReason: data?.status || data?.stop_reason || '',
  };
}

function parseAnthropicProviderReply(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const textParts = [];
  const toolCalls = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
    if (block?.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id || ''),
        type: 'function',
        function: {
          name: String(block.name || ''),
          arguments: JSON.stringify(block.input && typeof block.input === 'object' ? block.input : {}),
        },
      });
    }
  }
  return {
    content: textParts.join('\n').trim(),
    reasoningContent: '',
    openrouterReasoningDetails: [],
    sources: [],
    toolCalls,
    rawMessage: { role: 'assistant', content: blocks },
    finishReason: data?.stop_reason || '',
  };
}

function parseCustomProviderReply(apiFormat, data) {
  if (apiFormat === 'anthropic') return parseAnthropicProviderReply(data);
  if (apiFormat === 'responses') return parseResponsesProviderReply(data);
  return parseOpenAiProviderReply(data);
}

function buildCustomProviderTestBody(apiFormat, model) {
  if (apiFormat === 'anthropic') {
    return {
      url: null,
      headers: null,
      body: {
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      },
    };
  }
  if (apiFormat === 'responses') {
    return {
      url: null,
      headers: null,
      body: {
        model,
        max_output_tokens: 16,
        input: 'ping',
      },
    };
  }
  return {
    url: null,
    headers: null,
    body: {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    },
  };
}

module.exports = {
  ANTHROPIC_VERSION,
  buildCustomProviderRequest,
  buildCustomProviderModelsRequest,
  parseCustomProviderReply,
  buildCustomProviderTestBody,
  normalizeOpenAiBaseUrl,
  normalizeAnthropicBaseUrl,
  normalizeResponsesBaseUrl,
  convertOpenAiMessagesToAnthropic,
  convertOpenAiMessagesToResponsesInput,
  openAiToolsToResponses,
  parseResponsesProviderReply,
};
