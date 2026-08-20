const AUTO_TOOLS = new Set([
  'knowledge.read',
  'task.list', 'task.read',
  'file.list', 'file.read', 'file.search',
  'browser.scan', 'browser.screenshot',
  'update_working_checkpoint', 'memory.propose', 'ask_user',
]);

const CONFIRM_TOOLS = new Set([
  'knowledge.create', 'knowledge.update', 'knowledge.archive', 'knowledge.restore', 'knowledge.delete', 'knowledge.import',
  'task.create', 'task.update', 'task.complete', 'task.delete',
  'file.write', 'file.patch', 'file.move', 'file.delete',
  'code.run',
  'browser.navigate', 'browser.click', 'browser.type', 'browser.select', 'browser.execute_js',
  'web.search', 'westock.run', 'image.generate', 'memory.commit',
]);

function toolResult({ ok, summary, data = null, evidence = [], errorCode = '', retryable = false }) {
  return { ok: Boolean(ok), summary: String(summary || ''), data, evidence, errorCode, retryable };
}

function definitions(available = {}) {
  const all = [
    { name: 'knowledge.read', description: 'Read a local knowledge document or chunk', auto: true },
    { name: 'knowledge.create', description: 'Create a knowledge note', auto: false },
    { name: 'knowledge.update', description: 'Update a knowledge document', auto: false },
    { name: 'knowledge.archive', description: 'Archive a knowledge note or imported file', auto: false },
    { name: 'knowledge.restore', description: 'Restore an archived knowledge note or imported file', auto: false },
    { name: 'knowledge.delete', description: 'Permanently delete a knowledge document', auto: false },
    {
      name: 'knowledge.import',
      description: 'Import a file into the knowledge base. Use path for an allowlisted local file (pdf, docx, md, txt, image), or content plus filename for inline text.',
      auto: false,
      parameters: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string', description: 'Absolute path inside the computer allowlist' },
          content: { type: 'string', description: 'Inline text when not importing from a path' },
          filename: { type: 'string', description: 'Filename for inline content, or override when importing from a path' },
          title: { type: 'string', description: 'Knowledge document title' },
          knowledgeBase: { type: 'string', description: 'Target knowledge base name' },
          folderPath: { type: 'string', description: 'Folder path inside the knowledge base' },
        },
      },
    },
    { name: 'task.list', description: 'List tasks and countdowns', auto: true },
    { name: 'task.read', description: 'Read a task or countdown', auto: true },
    { name: 'task.create', description: 'Create a task', auto: false },
    { name: 'task.update', description: 'Update a task', auto: false },
    { name: 'task.complete', description: 'Complete a task', auto: false },
    { name: 'task.delete', description: 'Archive or delete a task', auto: false },
    { name: 'web.search', description: 'Search the web via configured providers', auto: false },
    { name: 'westock.run', description: 'Run a WeStock market data tool', auto: false },
    {
      name: 'image.generate',
      description: 'Generate an image with Seedream after the user approves. Pass a detailed visual prompt covering subject, composition, style, lighting, camera, and color. Optional size, model, and watermark use saved settings.',
      auto: false,
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', description: 'Optimized visual prompt' },
          size: { type: 'string', description: 'Seedream size keyword or WxH, for example 2K' },
          model: { type: 'string', description: 'Seedream model id' },
          watermark: { type: 'boolean', description: 'Whether to add a watermark' },
        },
      },
    },
    { name: 'file.list', description: 'List files in an allowlisted directory', auto: true },
    { name: 'file.read', description: 'Read a file from an allowlisted directory', auto: true },
    { name: 'file.search', description: 'Search files in an allowlisted directory', auto: true },
    { name: 'file.write', description: 'Write a file in an allowlisted directory', auto: false },
    { name: 'file.patch', description: 'Patch a file in an allowlisted directory', auto: false },
    { name: 'file.move', description: 'Move a file in an allowlisted directory', auto: false },
    { name: 'file.delete', description: 'Delete a file in an allowlisted directory', auto: false },
    { name: 'code.run', description: 'Run PowerShell or Python', auto: false },
    { name: 'browser.scan', description: 'Scan attached Chrome tabs', auto: true },
    { name: 'browser.screenshot', description: 'Capture an attached Chrome tab', auto: true },
    { name: 'browser.navigate', description: 'Navigate an attached Chrome tab', auto: false },
    { name: 'browser.click', description: 'Click in an attached Chrome tab', auto: false },
    { name: 'browser.type', description: 'Type in an attached Chrome tab', auto: false },
    { name: 'browser.select', description: 'Select a value in an attached Chrome tab', auto: false },
    { name: 'browser.execute_js', description: 'Execute approved JavaScript in an attached Chrome tab', auto: false },
    { name: 'update_working_checkpoint', description: 'Update the working checkpoint', auto: true },
    {
      name: 'memory.propose',
      description: 'Propose a long-term memory draft. L2 is a short fact or preference. L3 is a reusable workflow and may include steps. Never recap a conversation.',
      auto: true,
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['title', 'content'],
        properties: {
          title: { type: 'string', description: 'Short memory title' },
          content: { type: 'string', description: 'Short durable summary. L2: one or two sentences. L3: reusable steps, not a session recap' },
          layer: { type: 'string', enum: ['L2', 'L3'], description: 'L2 fact or L3 workflow' },
          existingId: { type: 'string', description: 'Existing memory id to replace' },
          evidence: { type: 'array', items: { type: 'object' } },
        },
      },
    },
    { name: 'memory.commit', description: 'Commit a memory proposal after confirmation', auto: false },
    { name: 'ask_user', description: 'Ask the user a clarifying question', auto: true },
  ];
  return all.filter(tool => available[tool.name] !== false);
}

const COMPUTER_TOOLS = [
  'file.list', 'file.read', 'file.search', 'file.write', 'file.patch', 'file.move', 'file.delete', 'code.run',
];

function computerToolAvailability(enabled) {
  const available = {};
  for (const name of COMPUTER_TOOLS) available[name] = Boolean(enabled);
  return available;
}

function requiresConfirmation(name) {
  return CONFIRM_TOOLS.has(name);
}

function isAuto(name) {
  return AUTO_TOOLS.has(name);
}

function toProviderName(name) {
  return String(name || '').replace(/\./g, '_');
}

function fromProviderName(name, tools = definitions()) {
  const raw = String(name || '');
  if (!raw) return raw;
  const listed = tools || [];
  const exact = listed.find(tool => tool.name === raw);
  if (exact) return exact.name;
  const mapped = listed.find(tool => toProviderName(tool.name) === raw);
  return mapped ? mapped.name : raw;
}

function toProviderTools(tools = definitions()) {
  return (tools || []).map(tool => ({
    type: 'function',
    function: {
      name: toProviderName(tool.name),
      description: String(tool.description || tool.name),
      parameters: tool.parameters && typeof tool.parameters === 'object'
        ? tool.parameters
        : {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
    },
  }));
}

module.exports = {
  AUTO_TOOLS,
  CONFIRM_TOOLS,
  COMPUTER_TOOLS,
  toolResult,
  definitions,
  computerToolAvailability,
  requiresConfirmation,
  isAuto,
  toProviderName,
  fromProviderName,
  toProviderTools,
};
