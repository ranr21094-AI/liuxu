const fs = require('fs');
const path = require('path');
const { toolResult } = require('./tools');
const { serviceFor } = require('../knowledge/routes');
const { extractText } = require('../knowledge/import');
const { loadPolicy, resolveAllowed } = require('../computer/policy');
const { normalizeMemoryProposalArgs } = require('./memory');

function createToolAdapters({ db, knowledgeSearch, hasDiaryAccessFlag, webSearch, westockRun, imageGenerate, computer, chrome, memory }) {
  function diaryUnlocked() {
    return typeof hasDiaryAccessFlag === 'function' ? Boolean(hasDiaryAccessFlag()) : Boolean(hasDiaryAccessFlag);
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
        const todos = db.getAllTodos();
        const item = todos.find(todo => String(todo.id) === String(args.id));
        if (!item) return toolResult({ ok: false, summary: 'Task not found', errorCode: 'not_found' });
        return toolResult({ ok: true, summary: item.title, data: item, evidence: [{ type: 'task', id: item.id }] });
      }
      case 'task.create': {
        const item = db.createTodo({
          title: args.title,
          due_date: args.due_date,
          priority: args.priority,
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
      case 'web.search':
        if (!webSearch) return toolResult({ ok: false, summary: 'Web search unavailable', errorCode: 'unavailable' });
        return webSearch(args);
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
      case 'ask_user':
        return toolResult({ ok: true, summary: String(args.question || 'Need input'), data: args, evidence: [] });
      case 'update_working_checkpoint':
        return toolResult({ ok: true, summary: 'Working checkpoint updated', data: args, evidence: [{ type: 'checkpoint' }] });
      case 'memory.propose':
        if (!memory) return toolResult({ ok: false, summary: 'Memory service unavailable', errorCode: 'unavailable' });
        {
          const result = memory.propose(normalizeMemoryProposalArgs({ ...args, evidence: args.evidence, runId: args.runId || '' }));
          return result.error
            ? toolResult({ ok: false, summary: result.error, errorCode: 'memory_proposal_failed' })
            : toolResult({ ok: true, summary: 'Memory proposal created', data: result.proposal, evidence: result.proposal?.evidence || [] });
        }
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

module.exports = { createToolAdapters };
