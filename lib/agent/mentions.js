const DOC_CHAR_LIMIT = 8000;
const TOTAL_CHAR_LIMIT = 60000;
const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})/;

function documentDate(doc) {
  return String(doc?.documentDate || doc?.logDate || '').slice(0, 10);
}

function listKnowledgeBaseNames(db, knowledge) {
  const names = new Set();
  try {
    for (const category of db?.getAllCategories?.(true, true) || []) {
      if (category?.name) names.add(String(category.name));
    }
  } catch { /* categories are optional for mention matching */ }
  try {
    for (const doc of knowledge?.allDocuments?.({ diaryUnlocked: true }) || []) {
      if (doc?.knowledgeBase) names.add(String(doc.knowledgeBase));
    }
  } catch { /* knowledge listing is optional for mention matching */ }
  return [...names].sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh-CN'));
}

function matchKnowledgeBase(token, knowledgeBases) {
  const value = String(token || '');
  return (knowledgeBases || []).find(name => value === name || value.startsWith(name)) || '';
}

function parseMentions(text, knowledgeBases = []) {
  const source = String(text || '');
  const bases = [...knowledgeBases].filter(Boolean).sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh-CN'));
  const mentions = [];
  const seen = new Set();
  const pattern = /@([^\s@]+)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const token = match[1];
    const dateMatch = token.match(DATE_PATTERN);
    if (dateMatch) {
      const key = `date:${dateMatch[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push({ type: 'date', value: dateMatch[1] });
      }
      continue;
    }
    const base = matchKnowledgeBase(token, bases);
    if (!base) continue;
    const key = `base:${base}`;
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push({ type: 'knowledgeBase', value: base });
    }
  }
  return mentions;
}

function selectableDocuments(knowledge, { diaryUnlocked = false } = {}) {
  return (knowledge?.allDocuments?.({ diaryUnlocked }) || []).filter(doc => {
    if ((doc.status || 'active') === 'archived') return false;
    if (doc.documentRole === 'annotation') return false;
    return true;
  });
}

function expandMentions(text, { knowledge, db, diaryUnlocked = false } = {}) {
  const knowledgeBases = listKnowledgeBaseNames(db, knowledge);
  const mentions = parseMentions(text, knowledgeBases);
  if (!mentions.length) return { mentions, context: '', documents: [], truncated: false };

  const docs = selectableDocuments(knowledge, { diaryUnlocked });
  const selected = [];
  const seenIds = new Set();
  const add = (doc) => {
    if (!doc?.id || seenIds.has(doc.id)) return;
    seenIds.add(doc.id);
    selected.push(doc);
  };

  for (const mention of mentions) {
    if (mention.type === 'knowledgeBase') {
      docs.filter(doc => doc.knowledgeBase === mention.value).forEach(add);
    } else if (mention.type === 'date') {
      docs.filter(doc => documentDate(doc) === mention.value).forEach(add);
    }
  }

  const parts = [];
  const included = [];
  let used = 0;
  let truncated = false;
  for (const doc of selected) {
    const body = String(doc.content || '').trim();
    const slice = body.length > DOC_CHAR_LIMIT ? `${body.slice(0, DOC_CHAR_LIMIT)}\n…(已截断)` : body;
    const block = [
      `# ${doc.title || doc.id}`,
      `知识库: ${doc.knowledgeBase || ''} | 日期: ${documentDate(doc) || '无'} | id: ${doc.id}`,
      slice || '（无正文）',
    ].join('\n');
    if (used + block.length > TOTAL_CHAR_LIMIT) {
      truncated = true;
      break;
    }
    parts.push(block);
    included.push(doc);
    used += block.length;
  }

  let context = '';
  if (parts.length) {
    context = `用户通过 @ 指定了以下本地知识，请只依据这些材料回答。\n\n${parts.join('\n\n---\n\n')}`;
    if (truncated) context += '\n\n(后续文档因长度限制未全部注入。)';
  } else {
    context = '用户指定了 @ 知识库或日期，但没有可注入的未归档文档（日记可能仍锁定）。';
  }
  return { mentions, context, documents: included, truncated };
}

function messagesWithMentionContext(messages, options) {
  return (messages || []).map(message => {
    if (message?.role !== 'user') return message;
    const { context } = expandMentions(message.content, options);
    if (!context) return message;
    return { ...message, content: `${message.content}\n\n${context}` };
  });
}

module.exports = {
  DOC_CHAR_LIMIT,
  TOTAL_CHAR_LIMIT,
  listKnowledgeBaseNames,
  parseMentions,
  expandMentions,
  messagesWithMentionContext,
};
