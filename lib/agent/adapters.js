const fs = require('fs');
const path = require('path');
const { toolResult } = require('./tools');
const { serviceFor, treeForDocuments, documentSummary, filterDocuments } = require('../knowledge/routes');
const { extractText } = require('../knowledge/import');
const { loadPolicy, resolveAllowed } = require('../computer/policy');
const { normalizeMemoryProposalArgs } = require('./memory');
const { resolveAgentSettings } = require('./agent-settings');

const MEMORY_SEARCH_SNIPPET_MAX = 120;

function buildMemorySearchSnippet(item, needle, max = MEMORY_SEARCH_SNIPPET_MAX) {
  const haystack = `${item.title || ''}\n${item.content || ''}`;
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = String(needle || '').toLowerCase();
  const index = lowerNeedle ? lowerHaystack.indexOf(lowerNeedle) : -1;
  if (index < 0) {
    const fallback = String(item.title || item.content || '').trim();
    return fallback.length > max ? `${fallback.slice(0, max - 1)}…` : fallback;
  }
  const radius = Math.max(20, Math.floor((max - lowerNeedle.length) / 2));
  const start = Math.max(0, index - radius);
  const end = Math.min(haystack.length, start + max);
  let snippet = haystack.slice(start, end).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < haystack.length) snippet = `${snippet}…`;
  return snippet.length > max ? `${snippet.slice(0, max - 1)}…` : snippet;
}

function createToolAdapters({ db, knowledgeSearch, hasDiaryAccessFlag, webSearch, webFetch, westockRun, imageGenerate, computer, chrome, memory, agentSettingsFor }) {
  function agentSettings() {
    if (typeof agentSettingsFor === 'function') return resolveAgentSettings(agentSettingsFor());
    return resolveAgentSettings({});
  }
  function diaryUnlocked() {
    return typeof hasDiaryAccessFlag === 'function' ? Boolean(hasDiaryAccessFlag()) : Boolean(hasDiaryAccessFlag);
  }
  async function knowledgeSearchTool(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return toolResult({ ok: false, summary: 'query is required', errorCode: 'invalid' });
    }
    const { search } = knowledgeSearch || serviceFor(db);
    const limits = agentSettings();
    const limit = Math.min(
      limits.agentKnowledgeSearchMaxLimit,
      Math.max(1, Number(args.limit) || limits.agentKnowledgeSearchLimit),
    );
    const filters = { status: 'active' };
    if (typeof args.knowledgeBase === 'string' && args.knowledgeBase.trim()) {
      filters.knowledgeBase = args.knowledgeBase.trim();
    }
    if (typeof args.folderPath === 'string' && args.folderPath.trim()) {
      filters.folderPath = args.folderPath.trim();
    }
    const documents = search.searchDocuments(query, filters, {
      diaryUnlocked: diaryUnlocked(),
      limit,
      summarize: documentSummary,
    });
    return toolResult({
      ok: true,
      summary: documents.length ? `Found ${documents.length} document(s)` : 'No matching documents',
      data: { query, total: documents.length, documents },
      evidence: documents.slice(0, 8).map(item => ({ type: 'document', id: item.id })),
    });
  }

  async function knowledgeTreeTool() {
    const { knowledge } = knowledgeSearch || serviceFor(db);
    const unlocked = diaryUnlocked();
    const categories = db.getAllCategories(unlocked, unlocked);
    const documents = knowledge.allDocuments({ diaryUnlocked: unlocked })
      .filter(document => document.documentRole !== 'annotation');
    const knowledgeBases = treeForDocuments(categories, documents, db);
    return toolResult({
      ok: true,
      summary: `Listed ${knowledgeBases.length} knowledge base(s)`,
      data: { knowledgeBases },
      evidence: [{ type: 'knowledge-tree' }],
    });
  }

  async function knowledgeListTool(args = {}) {
    const { knowledge } = knowledgeSearch || serviceFor(db);
    const unlocked = diaryUnlocked();
    const limits = agentSettings();
    const limit = Math.min(
      limits.agentKnowledgeListMaxLimit,
      Math.max(1, Number(args.limit) || limits.agentKnowledgeListLimit),
    );
    const offset = Math.max(0, Number(args.offset) || 0);
    const filters = { status: 'active', includeAnnotations: false };
    if (typeof args.knowledgeBase === 'string' && args.knowledgeBase.trim()) {
      filters.knowledgeBase = args.knowledgeBase.trim();
    }
    if (typeof args.folderPath === 'string' && args.folderPath.trim()) {
      filters.folderPath = args.folderPath.trim();
    }
    let documents = knowledge.allDocuments({ diaryUnlocked: unlocked });
    documents = filterDocuments(documents, filters);
    documents.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    const page = documents.slice(offset, offset + limit).map(documentSummary);
    const nextOffset = offset + page.length < documents.length ? offset + limit : null;
    return toolResult({
      ok: true,
      summary: page.length ? `Listed ${page.length} document(s)` : 'No documents in scope',
      data: { total: documents.length, offset, limit, nextOffset, documents: page },
      evidence: page.slice(0, 8).map(item => ({ type: 'document', id: item.id })),
    });
  }

  async function memoryListTool(args = {}) {
    if (!memory) return toolResult({ ok: false, summary: 'Memory service unavailable', errorCode: 'unavailable' });
    const layer = args.layer === 'L2' || args.layer === 'L3' ? args.layer : '';
    const limits = agentSettings();
    const limit = Math.min(
      limits.agentMemoryListMaxLimit,
      Math.max(1, Number(args.limit) || limits.agentMemoryListLimit),
    );
    const offset = Math.max(0, Number(args.offset) || 0);
    const all = memory.list(layer ? { layer } : {});
    const page = all.slice(offset, offset + limit).map(item => ({
      id: item.id,
      layer: item.layer,
      title: item.title,
    }));
    const nextOffset = offset + page.length < all.length ? offset + limit : null;
    return toolResult({
      ok: true,
      summary: page.length ? `Listed ${page.length} memory item(s)` : 'No memories in scope',
      data: { total: all.length, offset, limit, nextOffset, items: page },
      evidence: page.slice(0, 8).map(item => ({ type: 'memory', id: item.id })),
    });
  }

  async function memoryReadTool(args = {}) {
    if (!memory) return toolResult({ ok: false, summary: 'Memory service unavailable', errorCode: 'unavailable' });
    const id = String(args.id || '').trim();
    if (!id) return toolResult({ ok: false, summary: 'id is required', errorCode: 'invalid' });
    const item = memory.list().find(entry => entry.id === id);
    if (!item) return toolResult({ ok: false, summary: 'Memory not found', errorCode: 'not_found' });
    return toolResult({
      ok: true,
      summary: `Read ${item.title}`,
      data: {
        id: item.id,
        layer: item.layer,
        title: item.title,
        content: item.content,
        evidence: item.evidence,
      },
      evidence: [{ type: 'memory', id: item.id }],
    });
  }

  async function memorySearchTool(args = {}) {
    if (!memory) return toolResult({ ok: false, summary: 'Memory service unavailable', errorCode: 'unavailable' });
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return toolResult({ ok: false, summary: 'query is required', errorCode: 'invalid' });
    const layer = args.layer === 'L2' || args.layer === 'L3' ? args.layer : '';
    const limits = agentSettings();
    const limit = Math.min(
      limits.agentMemorySearchMaxLimit,
      Math.max(1, Number(args.limit) || limits.agentMemorySearchLimit),
    );
    const needle = query.toLowerCase();
    const items = memory.list(layer ? { layer } : {})
      .filter(item => `${item.title}\n${item.content}`.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(item => ({
        id: item.id,
        layer: item.layer,
        title: item.title,
        snippet: buildMemorySearchSnippet(item, needle),
      }));
    return toolResult({
      ok: true,
      summary: items.length
        ? `Found ${items.length} memory item(s). Use memory.read for full content.`
        : 'No matching memories',
      data: { query, total: items.length, items },
      evidence: items.slice(0, 5).map(item => ({ type: 'memory', id: item.id })),
    });
  }

  async function knowledgeReadTool(args) {
    const { knowledge } = knowledgeSearch || serviceFor(db);
    const doc = knowledge.getDocument(String(args.id || ''), { diaryUnlocked: diaryUnlocked() });
    if (!doc) return toolResult({ ok: false, summary: 'Document not found or locked', errorCode: 'not_found' });
    return toolResult({
      ok: true,
      summary: `Read ${doc.title}`,
      data: doc,
      evidence: [{ type: 'document', id: doc.id }],
    });
  }

  async function knowledgeCreateTool(args) {
    const { knowledge } = knowledgeSearch || serviceFor(db);
    const result = knowledge.createNote(args || {}, { diaryUnlocked: diaryUnlocked() });
    if (result.error) return toolResult({ ok: false, summary: result.error, errorCode: 'create_failed' });
    return toolResult({
      ok: true,
      summary: `Created ${result.document.id}`,
      data: result.document,
      evidence: [{ type: 'document', id: result.document.id }],
    });
  }

  async function knowledgeImportTool(args) {
    const { knowledge } = knowledgeSearch || serviceFor(db);
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const knowledgeBase = typeof args.knowledgeBase === 'string' ? args.knowledgeBase : '';
    const folderPath = typeof args.folderPath === 'string' ? args.folderPath : '';
    const sourcePath = typeof args.path === 'string' ? args.path.trim() : '';
    const inlineContent = typeof args.content === 'string' ? args.content : null;
    const namedFile = typeof args.filename === 'string' ? args.filename.trim() : '';
    let buffer;
    let filename;

    if (sourcePath) {
      const policy = loadPolicy(db.dataDir);
      if (!policy.computerToolsEnabled) {
        return toolResult({ ok: false, summary: 'Computer tools are disabled', errorCode: 'denied' });
      }
      if (!policy.allowedDirectories.length) {
        return toolResult({ ok: false, summary: 'No allowlisted directories', errorCode: 'denied' });
      }
      let file;
      try {
        file = resolveAllowed(sourcePath, policy.allowedDirectories);
      } catch (err) {
        return toolResult({ ok: false, summary: err.message, errorCode: 'denied' });
      }
      buffer = fs.readFileSync(file);
      filename = namedFile || path.basename(file);
    } else if (inlineContent !== null) {
      filename = namedFile || 'imported.md';
      buffer = Buffer.from(inlineContent, 'utf8');
    } else {
      return toolResult({ ok: false, summary: 'Provide path or content', errorCode: 'invalid' });
    }

    const extracted = await extractText(buffer, filename, '');
    if (extracted.error) {
      return toolResult({ ok: false, summary: extracted.error, errorCode: 'import_failed' });
    }
    const result = knowledge.saveImportedFile({
      buffer,
      filename,
      mimeType: extracted.mimeType,
      title: title || filename,
      knowledgeBase,
      folderPath,
      text: extracted.text,
      status: extracted.status,
      previewHtml: extracted.previewHtml || '',
      previewKind: extracted.previewKind || '',
      diaryUnlocked: diaryUnlocked(),
    });
    if (result.error) {
      return toolResult({
        ok: false,
        summary: result.error,
        errorCode: result.status === 403 ? 'denied' : 'import_failed',
      });
    }
    return toolResult({
      ok: true,
      summary: result.duplicate ? `Already imported ${result.document.id}` : `Imported ${result.document.id}`,
      data: { id: result.document.id, title: result.document.title, duplicate: Boolean(result.duplicate) },
      evidence: [{ type: 'document', id: result.document.id }],
    });
  }

  function listTasks() {
    return {
      todos: db.getAllTodos(),
      countdowns: db.getAllCountdowns(),
    };
  }

  async function execute(name, args = {}) {
    switch (name) {
      case 'knowledge.read':
        return knowledgeReadTool(args);
      case 'knowledge.search':
        return knowledgeSearchTool(args);
      case 'knowledge.tree':
        return knowledgeTreeTool(args);
      case 'knowledge.list':
        return knowledgeListTool(args);
      case 'knowledge.create':
        return knowledgeCreateTool(args);
      case 'knowledge.update': {
        const { knowledge } = knowledgeSearch || serviceFor(db);
        const result = knowledge.updateDocument(String(args.id || ''), args, { diaryUnlocked: diaryUnlocked() });
        if (result.error) return toolResult({ ok: false, summary: result.error, errorCode: 'update_failed' });
        return toolResult({ ok: true, summary: `Updated ${result.document.id}`, data: result.document, evidence: [{ type: 'document', id: result.document.id }] });
      }
      case 'knowledge.archive': {
        const { knowledge } = knowledgeSearch || serviceFor(db);
        const result = knowledge.archiveDocument(String(args.id || ''), { diaryUnlocked: diaryUnlocked() });
        if (result.error) return toolResult({ ok: false, summary: result.error, errorCode: 'archive_failed' });
        return toolResult({ ok: true, summary: `Archived ${result.document.id}`, data: result.document, evidence: [{ type: 'document', id: result.document.id }] });
      }
      case 'knowledge.restore': {
        const { knowledge } = knowledgeSearch || serviceFor(db);
        const result = knowledge.restoreDocument(String(args.id || ''), { diaryUnlocked: diaryUnlocked() });
        if (result.error) return toolResult({ ok: false, summary: result.error, errorCode: 'restore_failed' });
        return toolResult({ ok: true, summary: `Restored ${result.document.id}`, data: result.document, evidence: [{ type: 'document', id: result.document.id }] });
      }
      case 'knowledge.delete': {
        const { knowledge } = knowledgeSearch || serviceFor(db);
        const result = knowledge.deleteDocument(String(args.id || ''), { diaryUnlocked: diaryUnlocked() });
        if (result.error) return toolResult({ ok: false, summary: result.error, errorCode: 'delete_failed' });
        return toolResult({ ok: true, summary: `Deleted ${result.document.id}`, data: { id: result.document.id }, evidence: [{ type: 'document', id: result.document.id }] });
      }
      case 'knowledge.import':
        return knowledgeImportTool(args);
      case 'task.list':
        return toolResult({ ok: true, summary: 'Listed tasks', data: listTasks(), evidence: [{ type: 'task-list' }] });
      case 'task.read': {
        const id = String(args.id || '').trim();
        const todos = db.getAllTodos();
        const todo = todos.find(item => String(item.id) === id);
        if (todo) {
          return toolResult({ ok: true, summary: todo.title, data: { kind: 'todo', ...todo }, evidence: [{ type: 'task', id: todo.id }] });
        }
        const countdown = db.getAllCountdowns().find(item => String(item.id) === id);
        if (countdown) {
          return toolResult({ ok: true, summary: countdown.title, data: { kind: 'countdown', ...countdown }, evidence: [{ type: 'countdown', id: countdown.id }] });
        }
        return toolResult({ ok: false, summary: 'Task or countdown not found', errorCode: 'not_found' });
      }
      case 'task.create': {
        const item = db.createTodo({
          title: args.title,
          due_date: args.due_date,
          priority: args.priority,
          recurrence: args.recurrence,
          notes: args.notes,
          category: args.category,
        });
        return toolResult({ ok: true, summary: `Created task ${item.id}`, data: item, evidence: [{ type: 'task', id: item.id }] });
      }
      case 'task.update': {
        const item = db.updateTodo(Number(args.id), args);
        if (!item) return toolResult({ ok: false, summary: 'Task not found', errorCode: 'not_found' });
        return toolResult({ ok: true, summary: `Updated task ${item.id}`, data: item, evidence: [{ type: 'task', id: item.id }] });
      }
      case 'task.complete': {
        const item = db.updateTodo(Number(args.id), { done: true });
        if (!item) return toolResult({ ok: false, summary: 'Task not found', errorCode: 'not_found' });
        return toolResult({ ok: true, summary: `Completed task ${item.id}`, data: item, evidence: [{ type: 'task', id: item.id }] });
      }
      case 'task.delete': {
        const ok = db.removeTodo(Number(args.id));
        return toolResult({ ok: Boolean(ok), summary: ok ? `Deleted task ${args.id}` : 'Task not found', evidence: ok ? [{ type: 'task', id: args.id }] : [] });
      }
      case 'countdown.create': {
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        const targetDate = typeof args.target_date === 'string' ? args.target_date.trim() : '';
        if (!title) return toolResult({ ok: false, summary: 'Title is required', errorCode: 'invalid' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
          return toolResult({ ok: false, summary: 'target_date must be YYYY-MM-DD', errorCode: 'invalid' });
        }
        const item = db.createCountdown({
          title,
          target_date: targetDate,
          repeat_yearly: args.repeat_yearly === true,
          notes: typeof args.notes === 'string' ? args.notes : '',
        });
        return toolResult({ ok: true, summary: `Created countdown ${item.id}`, data: item, evidence: [{ type: 'countdown', id: item.id }] });
      }
      case 'countdown.update': {
        const id = Number(args.id);
        if (!Number.isInteger(id) || id <= 0) return toolResult({ ok: false, summary: 'Invalid countdown id', errorCode: 'invalid' });
        const payload = {};
        if (args.title !== undefined) payload.title = args.title;
        if (args.target_date !== undefined) payload.target_date = args.target_date;
        if (args.repeat_yearly !== undefined) payload.repeat_yearly = args.repeat_yearly;
        if (args.notes !== undefined) payload.notes = args.notes;
        const item = db.updateCountdown(id, payload);
        if (!item) return toolResult({ ok: false, summary: 'Countdown not found', errorCode: 'not_found' });
        return toolResult({ ok: true, summary: `Updated countdown ${item.id}`, data: item, evidence: [{ type: 'countdown', id: item.id }] });
      }
      case 'countdown.delete': {
        const id = Number(args.id);
        if (!Number.isInteger(id) || id <= 0) return toolResult({ ok: false, summary: 'Invalid countdown id', errorCode: 'invalid' });
        const ok = db.removeCountdown(id);
        return toolResult({ ok: Boolean(ok), summary: ok ? `Deleted countdown ${id}` : 'Countdown not found', evidence: ok ? [{ type: 'countdown', id }] : [] });
      }
      case 'web.search':
        if (!webSearch) return toolResult({ ok: false, summary: 'Web search unavailable', errorCode: 'unavailable' });
        return webSearch(args);
      case 'web.fetch':
        if (!webFetch) return toolResult({ ok: false, summary: 'Web fetch unavailable', errorCode: 'unavailable' });
        return webFetch(args);
      case 'westock.run':
        if (!westockRun) return toolResult({ ok: false, summary: 'WeStock unavailable', errorCode: 'unavailable' });
        return westockRun(args);
      case 'image.generate':
        if (!imageGenerate) return toolResult({ ok: false, summary: 'Image generation unavailable', errorCode: 'unavailable' });
        return imageGenerate(args);
      case 'file.list':
      case 'file.read':
      case 'file.search':
      case 'file.write':
      case 'file.patch':
      case 'file.move':
      case 'file.delete':
        if (!computer) return toolResult({ ok: false, summary: 'Computer tools disabled', errorCode: 'denied' });
        return computer.execute(name, args);
      case 'code.run':
        if (!computer) return toolResult({ ok: false, summary: 'Computer tools disabled', errorCode: 'denied' });
        return computer.execute(name, args);
      case 'browser.scan':
      case 'browser.screenshot':
      case 'browser.navigate':
      case 'browser.click':
      case 'browser.type':
      case 'browser.select':
      case 'browser.execute_js':
        if (!chrome) return toolResult({ ok: false, summary: 'Chrome bridge unavailable', errorCode: 'denied' });
        return chrome.request(name, args);
      case 'memory.propose':
        if (!memory) return toolResult({ ok: false, summary: 'Memory service unavailable', errorCode: 'unavailable' });
        {
          const normalized = typeof memory.normalizeProposalArgs === 'function'
            ? memory.normalizeProposalArgs({ ...args, evidence: args.evidence, runId: args.runId || '' })
            : normalizeMemoryProposalArgs({ ...args, evidence: args.evidence, runId: args.runId || '' });
          const result = memory.propose(normalized);
          return result.error
            ? toolResult({ ok: false, summary: result.error, errorCode: 'memory_proposal_failed' })
            : toolResult({ ok: true, summary: 'Memory proposal created', data: result.proposal, evidence: result.proposal?.evidence || [] });
        }
      case 'memory.search':
        return memorySearchTool(args);
      case 'memory.list':
        return memoryListTool(args);
      case 'memory.read':
        return memoryReadTool(args);
      case 'memory.commit':
        if (!memory) return toolResult({ ok: false, summary: 'Memory service unavailable', errorCode: 'unavailable' });
        {
          const result = memory.approve(String(args.proposalId || args.id || ''));
          return result.error
            ? toolResult({ ok: false, summary: result.error, errorCode: 'memory_commit_failed' })
            : toolResult({ ok: true, summary: 'Memory committed', data: result.memory, evidence: result.memory?.evidence || [] });
        }
      default:
        return toolResult({ ok: false, summary: `Unknown tool ${name}`, errorCode: 'unknown_tool' });
    }
  }

  return { execute };
}

module.exports = { createToolAdapters, buildMemorySearchSnippet, MEMORY_SEARCH_SNIPPET_MAX };
