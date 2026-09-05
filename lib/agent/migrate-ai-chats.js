const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, readJsonIfExists } = require('../util/json-file');
const { createAgentStore } = require('./store');

const MARKER_FILE = '.ai-chats-migrated.json';
const BACKUP_FILE = 'ai-chats.migrated.json';
const LEGACY_CHATS_FILE = 'ai-chats.json';
const LEGACY_MEDIA_FILE = 'ai-media.json';
const LEGACY_MEDIA_DIR = 'ai-media';

function emptyMarker() {
  return { version: 1, migratedAt: null, mappings: {} };
}

function emptyLegacyChats() {
  return { conversations: [], activeConversationId: '' };
}

function decodeLegacyFilename(value) {
  const raw = String(value || '').trim();
  if (!raw) return '附件';
  try {
    return Buffer.from(raw, 'latin1').toString('utf8');
  } catch {
    return raw;
  }
}

function appendSources(content, sources) {
  if (!Array.isArray(sources) || !sources.length) return content;
  const links = sources
    .filter(item => item?.url)
    .map(item => `- [${String(item.title || item.url).trim()}](${item.url})`)
    .join('\n');
  if (!links) return content;
  return `${content}\n\n**来源**\n${links}`.trim();
}

function appendImageGeneration(content, imageGeneration) {
  if (!imageGeneration || typeof imageGeneration !== 'object') return content;
  if (imageGeneration.markdown) return `${content}\n\n${imageGeneration.markdown}`.trim();
  if (imageGeneration.url) return `${content}\n\n![image](${imageGeneration.url})`.trim();
  if (imageGeneration.error) return `${content}\n\n（生图失败：${imageGeneration.error}）`.trim();
  return content;
}

function appendAttachments(content, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return content;
  const lines = attachments.map(attachment => `- 附件 ${decodeLegacyFilename(attachment?.name)}（旧版 ai-media，已退役）`);
  return `${content}\n\n**附件**\n${lines.join('\n')}`.trim();
}

function appendEditorSuggestion(content, editorSuggestion) {
  if (!editorSuggestion || typeof editorSuggestion !== 'object') return content;
  const parts = [];
  if (editorSuggestion.insertText) parts.push(`**建议插入**\n${editorSuggestion.insertText}`);
  if (editorSuggestion.suggestedContent) parts.push(`**建议正文**\n${editorSuggestion.suggestedContent}`);
  if (!parts.length) return content;
  return `${content}\n\n${parts.join('\n\n')}`.trim();
}

function legacyToolMessages(message) {
  const output = [];
  if (message?.toolCall?.skillId && message?.toolCall?.tool) {
    output.push({
      role: 'tool',
      name: `${message.toolCall.skillId}.${message.toolCall.tool}`,
      content: JSON.stringify({
        legacy: true,
        status: message.toolCall.status || 'done',
        args: message.toolCall.args || {},
        error: message.toolCall.error || '',
      }),
    });
  }
  if (message?.toolResult?.skillId && message?.toolResult?.tool && message.toolResult.content) {
    output.push({
      role: 'tool',
      name: `${message.toolResult.skillId}.${message.toolResult.tool}`,
      content: String(message.toolResult.content).slice(0, 60000),
    });
  }
  return output;
}

function convertLegacyMessage(message) {
  const role = message?.role;
  if (!['user', 'assistant'].includes(role)) return [];

  let content = typeof message.content === 'string' ? message.content.trim() : '';
  if (role === 'user' && Array.isArray(message.attachments) && message.attachments.length && !content) {
    content = '（发送了附件）';
  }
  content = appendAttachments(content, message.attachments);
  if (!content.trim()) return legacyToolMessages(message);

  if (role === 'assistant') {
    content = appendSources(content, message.sources);
    content = appendImageGeneration(content, message.imageGeneration);
    content = appendEditorSuggestion(content, message.editorSuggestion);
  }

  return [{ role, content: content.slice(0, 120000) }].concat(legacyToolMessages(message));
}

function sessionTitle(conversation) {
  const base = typeof conversation.title === 'string' && conversation.title.trim()
    ? conversation.title.trim()
    : '旧版对话';
  const prefix = conversation.scope === 'editor' ? '[旧AI·日志] ' : '[旧AI] ';
  return `${prefix}${base}`.slice(0, 80);
}

function conversationHasContent(conversation) {
  return (conversation.messages || []).some((message) => {
    const role = message?.role;
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    const hasAttachments = Array.isArray(message?.attachments) && message.attachments.length > 0;
    const hasTools = Boolean(message?.toolCall || message?.toolResult);
    const hasImage = Boolean(message?.imageGeneration?.markdown || message?.imageGeneration?.url);
    return ['user', 'assistant'].includes(role) && (content || hasAttachments || hasTools || hasImage);
  });
}

function removeLegacyMedia(dataDir) {
  const mediaFile = path.join(dataDir, LEGACY_MEDIA_FILE);
  const mediaDir = path.join(dataDir, LEGACY_MEDIA_DIR);
  if (fs.existsSync(mediaFile)) fs.unlinkSync(mediaFile);
  if (fs.existsSync(mediaDir)) fs.rmSync(mediaDir, { recursive: true, force: true });
}

function backupLegacyChats(dataDir, payload) {
  const backupPath = path.join(dataDir, BACKUP_FILE);
  const existing = readJsonIfExists(backupPath, emptyLegacyChats());
  const merged = new Map();
  for (const item of existing.conversations || []) merged.set(item.id, item);
  for (const item of payload.conversations || []) merged.set(item.id, item);
  atomicWriteJson(backupPath, {
    conversations: [...merged.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    activeConversationId: payload.activeConversationId || existing.activeConversationId || '',
    archivedAt: new Date().toISOString(),
  });
}

function ensureAiChatsMigrated(db) {
  const dataDir = db.dataDir;
  const chatsPath = path.join(dataDir, LEGACY_CHATS_FILE);
  const markerPath = path.join(dataDir, MARKER_FILE);
  const marker = readJsonIfExists(markerPath, emptyMarker());
  const mappings = { ...(marker.mappings || {}) };

  if (!fs.existsSync(chatsPath)) {
    removeLegacyMedia(dataDir);
    return { migrated: 0, skipped: true, mappings };
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(chatsPath, 'utf8'));
  } catch {
    return { migrated: 0, skipped: true, error: 'invalid ai-chats.json' };
  }

  const conversations = Array.isArray(payload?.conversations) ? payload.conversations : [];
  const pending = conversations.filter(item => item?.id && !mappings[item.id] && conversationHasContent(item));

  if (!pending.length) {
    if (conversations.length) backupLegacyChats(dataDir, payload);
    atomicWriteJson(chatsPath, emptyLegacyChats());
    removeLegacyMedia(dataDir);
    atomicWriteJson(markerPath, {
      version: 1,
      migratedAt: marker.migratedAt || new Date().toISOString(),
      mappings,
      backupFile: BACKUP_FILE,
    });
    return { migrated: 0, cleared: conversations.length, mappings };
  }

  const store = createAgentStore(db);
  let migrated = 0;

  for (const conversation of pending.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))) {
    const messages = [];
    for (const message of conversation.messages || []) {
      messages.push(...convertLegacyMessage(message));
    }
    if (!messages.length) continue;

    const updatedAt = Number.isFinite(Number(conversation.updatedAt))
      ? Number(conversation.updatedAt)
      : Date.now();
    const session = {
      id: crypto.randomUUID(),
      title: sessionTitle(conversation),
      messages,
      checkpoint: null,
      status: 'archived',
      createdAt: updatedAt,
      updatedAt,
      legacyConversationId: conversation.id,
    };
    // Persist straight into SQLite: the legacy agent-sessions.json import only
    // runs on first database creation, so writing JSON here would strand the
    // conversations in a file nobody reads. Timestamps are preserved so the
    // sessions sort like they did in the legacy UI.
    store.saveSession(session, { preserveTimestamps: true });
    mappings[conversation.id] = session.id;
    migrated += 1;
  }

  backupLegacyChats(dataDir, payload);
  atomicWriteJson(chatsPath, emptyLegacyChats());
  removeLegacyMedia(dataDir);
  atomicWriteJson(markerPath, {
    version: 1,
    migratedAt: new Date().toISOString(),
    mappings,
    backupFile: BACKUP_FILE,
    migratedCount: Object.keys(mappings).length,
  });

  return { migrated, total: conversations.length, mappings };
}

module.exports = { ensureAiChatsMigrated };
