const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PANEL_HTML = `
<div id="documentWorkspace"><textarea id="documentContent"></textarea></div>
<button id="assistantToggleButton"></button>
<aside class="note-assistant-panel" id="noteAssistantPanel" hidden>
  <div class="note-assistant-head">
    <strong>AI 助手</strong>
    <button type="button" data-note-assistant-action="sessions">历史</button>
    <button type="button" data-note-assistant-action="new">新对话</button>
    <button type="button" data-note-assistant-action="close">✕</button>
  </div>
  <div class="note-assistant-session-list" id="noteAssistantSessionList" hidden></div>
  <div class="note-assistant-batch" id="noteAssistantBatch" hidden>
    <span><strong id="noteAssistantBatchCount">0</strong> 条提案待应用</span>
    <span>
      <button type="button" data-note-assistant-action="apply-all">全部应用</button>
      <button type="button" data-note-assistant-action="ignore-all">全部忽略</button>
    </span>
  </div>
  <div class="note-assistant-messages" id="noteAssistantMessages"></div>
  <div class="note-assistant-status" id="noteAssistantStatus" hidden></div>
  <div class="note-assistant-composer">
    <textarea id="noteAssistantInput"></textarea>
    <button type="button" id="noteAssistantSend" data-note-assistant-action="send">发送</button>
    <button type="button" id="noteAssistantStop" data-note-assistant-action="stop" hidden>停止</button>
  </div>
</aside>
<div id="toast"></div>
`;

function stubDom() {
  const dom = new JSDOM(`<!doctype html><body>${PANEL_HTML}</body>`, { url: 'http://127.0.0.1/' });
  const previous = {
    window: global.window, document: global.document, crypto: global.crypto,
    CSS: global.CSS, fetch: global.fetch, EventSource: global.EventSource, confirm: global.confirm,
    raf: global.requestAnimationFrame, caf: global.cancelAnimationFrame,
  };
  global.requestAnimationFrame = global.requestAnimationFrame || (cb => setTimeout(cb, 0));
  global.cancelAnimationFrame = global.cancelAnimationFrame || (id => clearTimeout(id));
  global.window = dom.window;
  global.document = dom.window.document;
  global.crypto = dom.window.crypto;
  global.CSS = dom.window.CSS || { escape: value => String(value) };
  global.confirm = () => true;
  return { dom, previous };
}

function restore(previous) {
  global.window = previous.window;
  global.document = previous.document;
  global.crypto = previous.crypto;
  global.CSS = previous.CSS;
  global.fetch = previous.fetch;
  global.EventSource = previous.EventSource;
  global.confirm = previous.confirm;
  if (previous.raf === undefined) delete global.requestAnimationFrame;
  else global.requestAnimationFrame = previous.raf;
  if (previous.caf === undefined) delete global.cancelAnimationFrame;
  else global.cancelAnimationFrame = previous.caf;
}

test('batch apply applies every pending proposal in order and updates the editor', async () => {
  const { dom, previous } = stubDom();
  try {
    // fetch stub: 消息发送 → 202；会话拉取 → 404
    global.fetch = async (url) => {
      const response = {
        ok: false, status: 404, json: async () => ({}),
      };
      if (String(url).includes('/messages')) {
        Object.assign(response, {
          ok: true, status: 202,
          json: async () => ({ runId: 'run-1', sessionId: 'sess-1', status: 'queued' }),
        });
      }
      return response;
    };
    // 事件源 stub：记录处理器，供测试注入事件
    const sources = [];
    global.EventSource = class {
      constructor(url) {
        this.url = url;
        this.handlers = {};
        sources.push(this);
      }
      addEventListener(type, handler) {
        this.handlers[type] = handler;
      }
      close() {
        this.closed = true;
      }
      emit(type, event) {
        this.handlers[type]?.({ data: JSON.stringify(event) });
      }
    };

    const url = pathToFileURL(path.join(__dirname, '../public/js/knowledge/note-assistant.js'));
    url.search = `test=${Date.now()}`;
    const ui = await import(url.href);

    const editor = document.querySelector('#documentContent');
    editor.value = 'A 第一段。B 第二段。';
    const applied = [];
    ui.initNoteAssistant({
      applyEdit: ({ find, replace, append, content }) => {
        if (append) {
          editor.value += content;
          applied.push({ append: true, content });
          return;
        }
        const start = editor.value.indexOf(find);
        assert.ok(start >= 0, `find should match: ${find}`);
        editor.value = editor.value.slice(0, start) + replace + editor.value.slice(start + find.length);
        applied.push({ find, replace });
      },
    });

    // 打开面板 → 发送消息 → 订阅运行
    ui.noteAssistantSetActiveDocument({ id: 'note:1', status: 'active' });
    document.querySelector('#assistantToggleButton').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    const input = document.querySelector('#noteAssistantInput');
    input.value = '请提出两处修改';
    document.querySelector('#noteAssistantSend').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sources.length, 1, 'run events subscribed');
    const source = sources[0];

    // 两条提案 + 完成
    source.emit('note.edit_proposed', { type: 'note.edit_proposed', payload: {
      id: 'p1', documentId: 'note:1', find: 'A', replace: 'AA-', proposedContent: 'AA- 第一段。B 第二段。',
    } });
    source.emit('note.edit_proposed', { type: 'note.edit_proposed', payload: {
      id: 'p2', documentId: 'note:1', find: 'B', replace: 'BB-', proposedContent: 'A 第一段。BB- 第二段。',
    } });
    source.emit('run.completed', { type: 'run.completed', payload: { text: '已提出两处修改' } });

    assert.equal(document.querySelectorAll('.note-assistant-proposal').length, 2);
    assert.equal(document.querySelector('#noteAssistantBatch').hidden, false, 'batch bar shows with 2 pending');
    assert.equal(document.querySelector('#noteAssistantBatchCount').textContent, '2');

    // 全部应用：按到达顺序逐条套用
    document.querySelector('[data-note-assistant-action="apply-all"]').click();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(applied, [
      { find: 'A', replace: 'AA-' },
      { find: 'B', replace: 'BB-' },
    ], 'proposals applied in arrival order');
    assert.equal(editor.value, 'AA- 第一段。BB- 第二段。');
    assert.equal(document.querySelectorAll('.note-assistant-proposal.is-applied').length, 2);
    assert.equal(document.querySelector('#noteAssistantBatch').hidden, true, 'batch bar hides when nothing pending');

    // 忽略路径：单条提案忽略后批量条不出现
    source.emit('note.edit_proposed', { type: 'note.edit_proposed', payload: {
      id: 'p3', documentId: 'note:1', find: 'AA-', replace: 'AB-',
    } });
    source.emit('run.completed', { type: 'run.completed', payload: { text: '' } });
    assert.equal(document.querySelector('#noteAssistantBatch').hidden, true, 'single pending proposal does not show batch bar');
    document.querySelector('[data-note-assistant-action="ignore-all"]').click();
    assert.equal(document.querySelectorAll('.note-assistant-proposal.is-ignored').length, 1);
  } finally {
    dom.window.close();
    restore(previous);
  }
});

test('session switcher lists, switches, and deletes document sessions', async () => {
  const { dom, previous } = stubDom();
  try {
    const sessions = [
      { id: 'sess-2', title: '文档助手', documentId: 'note:1', messageCount: 2, preview: '第二个问题', updatedAt: 200 },
      { id: 'sess-1', title: '文档助手', documentId: 'note:1', messageCount: 2, preview: '第一个问题', updatedAt: 100 },
    ];
    global.fetch = async (url, options = {}) => {
      const target = String(url);
      const response = { ok: true, status: 200, json: async () => ({}) };
      if (target.includes('/sessions/sess-1') && options.method === 'DELETE') {
        sessions.splice(sessions.findIndex(item => item.id === 'sess-1'), 1);
        response.json = async () => ({ id: 'sess-1', deleted: true });
        return response;
      }
      if (target.includes('/sessions') && !target.includes('/sessions/sess-1')) {
        response.json = async () => ({ sessions: [...sessions] });
        return response;
      }
      if (target.includes('/session?sessionId=sess-1')) {
        response.json = async () => ({
          session: { id: 'sess-1', title: '文档助手', documentId: 'note:1', messages: [
            { role: 'user', content: '第一个问题' },
            { role: 'assistant', content: '第一个回答' },
          ] },
          activeRun: null,
        });
        return response;
      }
      if (target.includes('/session')) {
        // 无参：返回最新会话 sess-2
        response.json = async () => ({
          session: { id: 'sess-2', title: '文档助手', documentId: 'note:1', messages: [
            { role: 'user', content: '第二个问题' },
            { role: 'assistant', content: '第二个回答' },
          ] },
          activeRun: null,
        });
        return response;
      }
      if (target.includes('/messages')) {
        response.status = 202;
        response.ok = true;
        response.json = async () => ({ runId: 'run-9', sessionId: 'sess-2', status: 'queued' });
        return response;
      }
      return response;
    };
    const sources = [];
    global.EventSource = class {
      constructor() { this.handlers = {}; sources.push(this); }
      addEventListener(type, handler) { this.handlers[type] = handler; }
      close() { this.closed = true; }
      emit(type, event) { this.handlers[type]?.({ data: JSON.stringify(event) }); }
    };

    const url = pathToFileURL(path.join(__dirname, '../public/js/knowledge/note-assistant.js'));
    url.search = `test=${Date.now()}`;
    const ui = await import(url.href);
    ui.initNoteAssistant({ applyEdit: () => {} });
    ui.noteAssistantSetActiveDocument({ id: 'note:1', status: 'active' });

    // 打开面板 → 无参加载最新会话 sess-2
    document.querySelector('#assistantToggleButton').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(document.querySelector('#noteAssistantMessages').textContent, /第二个问题/);

    // 打开历史下拉：两条会话，当前（sess-2）高亮
    document.querySelector('[data-note-assistant-action="sessions"]').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(document.querySelector('#noteAssistantSessionList').hidden, false);
    assert.equal(document.querySelectorAll('.note-assistant-session-row').length, 2);
    assert.ok(document.querySelector('.note-assistant-session-row.is-active[data-session-id="sess-2"]'), 'active session is highlighted');

    // 切换到 sess-1：消息被替换为该会话内容
    document.querySelector('.note-assistant-session-row[data-session-id="sess-1"]').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(document.querySelector('#noteAssistantMessages').textContent, /第一个问题/);
    assert.equal(document.querySelectorAll('.note-assistant-message').length, 2, 'switched session messages render');
    assert.equal(document.querySelector('#noteAssistantSessionList').hidden, true, 'dropdown closes after switching');

    // 删除 sess-1（confirmDialog 动态 overlay 需确认）→ 列表只剩一条
    document.querySelector('[data-note-assistant-action="sessions"]').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    document.querySelector('[data-note-assistant-action="delete-session"][data-session-id="sess-1"]').click();
    await new Promise(resolve => setTimeout(resolve, 10));
    document.querySelector('#genericConfirmOk')?.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(document.querySelectorAll('.note-assistant-session-row').length, 1);
    assert.equal(sessions[0].id, 'sess-2');
  } finally {
    dom.window.close();
    restore(previous);
  }
});
