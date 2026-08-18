const { toolResult } = require('./tools');
const { serviceFor } = require('../knowledge/routes');

function createToolAdapters({ db, knowledgeSearch, hasDiaryAccessFlag, webSearch, westockRun, computer, chrome, memory }) {
  function diaryUnlocked() {
    return typeof hasDiaryAccessFlag === 'function' ? Boolean(hasDiaryAccessFlag()) : Boolean(hasDiaryAccessFlag);
  }
  async function knowledgeSearchTool(args) {
    const { search, knowledge } = knowledgeSearch || serviceFor(db);
    const results = search.search(String(args.query || ''), {
      diaryUnlocked: diaryUnlocked(),
      collectionPath: args.collectionPath || '',
      knowledgeBase: args.knowledgeBase || '',
      folderPath: args.folderPath || '',
      limit: 30,
    }).slice(0, 30);
    return toolResult({
      ok: true,
      summary: results.length ? `Retrieved ${results.length} chunks` : 'No local evidence found',
      data: results,
      evidence: results.slice(0, 8).map(item => ({ type: 'chunk', id: item.id, documentId: item.documentId })),
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

  function listTasks() {
    return {
      todos: db.getAllTodos(),
      countdowns: db.getAllCountdowns(),
    };
  }

  async function execute(name, args = {}) {
    switch (name) {
      case 'knowledge.search':
        return knowledgeSearchTool(args);
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
          const result = memory.propose({ ...args, evidence: args.evidence, runId: args.runId || '' });
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
