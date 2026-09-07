const test = require('node:test');
const assert = require('node:assert/strict');
const { joinSystemPromptLines, buildAgentSystemText, factorySystemBody } = require('../lib/agent/system-prompt');

test('joinSystemPromptLines joins sections into a single string', () => {
  const text = joinSystemPromptLines([
    'You are the AI assistant embedded in the LiuXu knowledge editor, helping with the one document the user has open (note or imported file).',
    '',
    'Work only from note.read results',
  ]);
  assert.equal(typeof text, 'string');
  assert.equal(Array.isArray(text), false);
  assert.match(text, /^You are the AI assistant embedded/);
  assert.match(text, /\nWork only from note.read results$/);
});

test('buildAgentSystemText returns a string system prompt for note_assist', () => {
  const text = buildAgentSystemText({
    systemPreset: 'note_assist',
    toolList: 'note.read: Read the open document',
    checkpointBlock: 'Working checkpoint:\n{}',
    systemAddition: '',
  });
  assert.equal(typeof text, 'string');
  assert.equal(Array.isArray(text), false);
  assert.match(text, /^You are the AI assistant embedded in the LiuXu knowledge editor/);
  assert.match(text, /Available tools:\nnote.read: Read the open document/);
  assert.equal(text.includes('You are the local LiuXu Agent.'), false);
});

test('buildAgentSystemText still joins the agent preset into one string', () => {
  const text = buildAgentSystemText({
    systemPreset: 'agent',
    toolList: 'knowledge.read: Read a note',
    memories: { l0: [] },
    profile: { supportsMedia: true },
  });
  assert.equal(typeof text, 'string');
  assert.match(text, /^You are the local LiuXu Agent\./);
  assert.match(text, /If the user attached images/);
});

test('factorySystemBody returns static note_assist and memory_refresh text', () => {
  const note = factorySystemBody('note_assist');
  assert.equal(typeof note, 'string');
  assert.match(note, /^You are the AI assistant embedded/);
  assert.equal(note.includes('Available tools:'), false);
  const refresh = factorySystemBody('memory_refresh');
  assert.match(refresh, /\{maxProposals\}/);
  assert.equal(refresh.includes('Current memories:'), false);
});

test('buildAgentSystemText uses a custom body when provided', () => {
  const text = buildAgentSystemText({
    systemPreset: 'agent',
    body: 'Custom agent persona.',
    toolList: 'knowledge.read: Read',
    memories: { l0: [] },
  });
  assert.match(text, /^Custom agent persona\./);
  assert.equal(text.includes('You are the local LiuXu Agent.'), false);
  assert.match(text, /Available tools:\nknowledge.read: Read/);
});
