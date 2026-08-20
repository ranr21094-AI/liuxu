const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDatabase } = require('../database');
const { ensureAiChatsMigrated } = require('../lib/agent/migrate-ai-chats');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-ai-chats-'));
}

test('ensureAiChatsMigrated converts legacy conversations into archived agent sessions', () => {
  const dir = tempDir();
  const db = createDatabase(dir);
  const legacy = {
    conversations: [{
      id: 'legacy-global-1',
      title: '测试对话',
      scope: 'global',
      updatedAt: 1000,
      messages: [
        { role: 'user', content: '你好' },
        {
          role: 'assistant',
          content: '你好，世界',
          sources: [{ title: '示例', url: 'https://example.com' }],
          imageGeneration: { markdown: '![image](/uploads/test.png)' },
        },
      ],
    }, {
      id: 'legacy-editor-1',
      title: '日志内',
      scope: 'editor',
      logKey: 'log:1',
      updatedAt: 2000,
      messages: [
        { role: 'user', content: '问一句' },
        {
          role: 'assistant',
          content: '准备创建日志',
          toolCall: { skillId: 'logs', tool: 'create', args: { title: '新日志' }, status: 'done' },
        },
      ],
    }],
    activeConversationId: 'legacy-global-1',
  };
  fs.writeFileSync(path.join(dir, 'ai-chats.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(dir, 'ai-media.json'), JSON.stringify([{
    id: 'media-1',
    storedFilename: 'sample.png',
    name: 'sample.png',
    mimeType: 'image/png',
    kind: 'image',
    bytes: 10,
  }]));
  fs.mkdirSync(path.join(dir, 'ai-media'));
  fs.writeFileSync(path.join(dir, 'ai-media', 'sample.png'), Buffer.from('png'));

  const first = ensureAiChatsMigrated(db);
  assert.equal(first.migrated, 2);
  assert.equal(fs.existsSync(path.join(dir, 'ai-media.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'ai-media')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ai-chats.json'), 'utf8')), {
    conversations: [],
    activeConversationId: '',
  });

  const sessions = JSON.parse(fs.readFileSync(path.join(dir, 'agent-sessions.json'), 'utf8')).sessions;
  assert.equal(sessions.length, 2);
  assert.match(sessions[0].title, /^\[旧AI·日志\]/);
  assert.equal(sessions[0].status, 'archived');
  assert.match(sessions[1].title, /^\[旧AI\]/);
  assert.match(sessions[1].messages.at(-1).content, /uploads\/test\.png/);
  assert.match(sessions[1].messages.at(-1).content, /example\.com/);
  assert.equal(sessions[0].messages.some(item => item.role === 'tool' && item.name === 'logs.create'), true);

  const second = ensureAiChatsMigrated(db);
  assert.equal(second.migrated, 0);
});

test('ensureAiChatsMigrated is idempotent when ai-chats.json is already empty', () => {
  const dir = tempDir();
  const db = createDatabase(dir);
  fs.writeFileSync(path.join(dir, 'agent-sessions.json'), JSON.stringify({
    sessions: [{ id: 'existing', title: '已有', messages: [], status: 'active', createdAt: 1, updatedAt: 1 }],
    activeSessionId: 'existing',
  }));
  fs.writeFileSync(path.join(dir, 'ai-chats.json'), JSON.stringify({ conversations: [], activeConversationId: '' }));
  fs.writeFileSync(path.join(dir, '.ai-chats-migrated.json'), JSON.stringify({ version: 1, mappings: {} }));

  const result = ensureAiChatsMigrated(db);
  assert.equal(result.migrated, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'agent-sessions.json'), 'utf8')).sessions.length, 1);
});
