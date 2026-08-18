const AUTO_TOOLS = new Set([
  'knowledge.search', 'knowledge.read',
  'task.list', 'task.read',
  'file.list', 'file.read', 'file.search',
  'browser.scan', 'browser.screenshot',
  'update_working_checkpoint', 'memory.propose', 'ask_user',
]);

const CONFIRM_TOOLS = new Set([
  'knowledge.create', 'knowledge.update', 'knowledge.archive', 'knowledge.import',
  'task.create', 'task.update', 'task.complete', 'task.delete',
  'file.write', 'file.patch', 'file.move', 'file.delete',
  'code.run',
  'browser.navigate', 'browser.click', 'browser.type', 'browser.select', 'browser.execute_js',
  'web.search', 'westock.run', 'memory.commit',
]);

function toolResult({ ok, summary, data = null, evidence = [], errorCode = '', retryable = false }) {
  return { ok: Boolean(ok), summary: String(summary || ''), data, evidence, errorCode, retryable };
}

function definitions(available = {}) {
  const all = [
    { name: 'knowledge.search', description: 'Search local knowledge chunks', auto: true },
    { name: 'knowledge.read', description: 'Read a local knowledge document or chunk', auto: true },
    { name: 'knowledge.create', description: 'Create a knowledge note', auto: false },
    { name: 'knowledge.update', description: 'Update a knowledge document', auto: false },
    { name: 'knowledge.archive', description: 'Archive a knowledge document', auto: false },
    { name: 'task.list', description: 'List tasks and countdowns', auto: true },
    { name: 'task.read', description: 'Read a task or countdown', auto: true },
    { name: 'task.create', description: 'Create a task', auto: false },
    { name: 'task.update', description: 'Update a task', auto: false },
    { name: 'task.complete', description: 'Complete a task', auto: false },
    { name: 'task.delete', description: 'Archive or delete a task', auto: false },
    { name: 'web.search', description: 'Search the web via configured providers', auto: false },
    { name: 'westock.run', description: 'Run a WeStock market data tool', auto: false },
    { name: 'file.list', description: 'List files in an allowlisted directory', auto: true },
    { name: 'file.read', description: 'Read a file from an allowlisted directory', auto: true },
    { name: 'file.search', description: 'Search files in an allowlisted directory', auto: true },
    { name: 'file.write', description: 'Write a file in an allowlisted directory', auto: false },
    { name: 'file.patch', description: 'Patch a file in an allowlisted directory', auto: false },
    { name: 'file.move', description: 'Move a file in an allowlisted directory', auto: false },
    { name: 'code.run', description: 'Run PowerShell or Python', auto: false },
    { name: 'browser.scan', description: 'Scan attached Chrome tabs', auto: true },
    { name: 'browser.screenshot', description: 'Capture an attached Chrome tab', auto: true },
    { name: 'browser.navigate', description: 'Navigate an attached Chrome tab', auto: false },
    { name: 'browser.click', description: 'Click in an attached Chrome tab', auto: false },
    { name: 'browser.type', description: 'Type in an attached Chrome tab', auto: false },
    { name: 'browser.select', description: 'Select a value in an attached Chrome tab', auto: false },
    { name: 'browser.execute_js', description: 'Execute approved JavaScript in an attached Chrome tab', auto: false },
    { name: 'update_working_checkpoint', description: 'Update the working checkpoint', auto: true },
    { name: 'memory.propose', description: 'Propose a long-term memory draft', auto: true },
    { name: 'memory.commit', description: 'Commit a memory proposal after confirmation', auto: false },
    { name: 'ask_user', description: 'Ask the user a clarifying question', auto: true },
  ];
  return all.filter(tool => available[tool.name] !== false);
}

function requiresConfirmation(name) {
  return CONFIRM_TOOLS.has(name);
}

function isAuto(name) {
  return AUTO_TOOLS.has(name);
}

module.exports = {
  AUTO_TOOLS,
  CONFIRM_TOOLS,
  toolResult,
  definitions,
  requiresConfirmation,
  isAuto,
};
