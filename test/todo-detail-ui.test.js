const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('task details preserve dirty drafts, lock writes, and close with focus restoration', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'http://localhost' });
  const previous = { document: global.document, window: global.window };
  Object.assign(global, { document: dom.window.document, window: dom.window });
  const doc = dom.window.document;
  doc.getElementById('todoView').getBoundingClientRect = () => ({ width: 900 });
  const { createTodoDetailController } = await import('../public/js/app/todo-detail.js');
  let discard = false, questions = 0, closed = 0;
  const controller = createTodoDetailController({ document: doc, confirm: async () => { questions++; return discard; }, onClose: () => { closed++; } });
  try {
    doc.getElementById('btnTodoNew').focus();
    controller.open('todos', '新建任务');
    assert.equal(doc.getElementById('todoFullForm').hidden, false);
    assert.equal(doc.getElementById('countdownForm').hidden, true);
    assert.equal(await controller.allowDiscard(), true);
    doc.getElementById('todoFullTitle').value = 'unsaved';
    await controller.close();
    assert.equal(closed, 0);
    assert.equal(doc.getElementById('todoFullTitle').value, 'unsaved');
    controller.setSaving(true);
    assert.equal(await controller.allowDiscard(), false);
    assert.equal(doc.getElementById('btnTodoFullSave').disabled, true);
    controller.setSaving(false);
    discard = true;
    await controller.close();
    assert.equal(closed, 1);
    assert.equal(doc.getElementById('todoFullForm').hidden, true);
    assert.equal(doc.activeElement.id, 'btnTodoNew');
    assert.equal(questions, 2);
    doc.getElementById('todoView').getBoundingClientRect = () => ({ width: 390 });
    controller.open('countdowns', '新建倒数日');
    assert.equal(doc.getElementById('countdownForm').getAttribute('aria-modal'), 'true');
    assert.equal(doc.querySelector('.todo-list-column').inert, true);
    controller.discard();
    assert.equal(doc.querySelector('.todo-list-column').inert, false);
    const mobileSource = doc.createElement('button'); mobileSource.dataset.countdownSelect = '1'; doc.body.append(mobileSource); mobileSource.focus();
    dom.window.matchMedia = () => ({ matches: true });
    controller.open('countdowns', '编辑倒数日'); await controller.close();
    assert.equal(doc.activeElement.id, 'btnTodoNew');
  } finally { dom.window.close(); Object.assign(global, previous); }
});

test('task workspace renders modes once, filters counts, saves once, and preserves failed edits', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'http://localhost' });
  const previous = Object.fromEntries(['document','window','localStorage','fetch','requestAnimationFrame','Event'].map(key => [key, global[key]]));
  Object.assign(global, { document: dom.window.document, window: dom.window, localStorage: dom.window.localStorage, requestAnimationFrame: fn => fn(), Event: dom.window.Event });
  const doc = dom.window.document;
  doc.getElementById('todoView').getBoundingClientRect = () => ({ width: 900 });
  let resolveWrite, writes = 0;
  const todos = [{ id: 1, title: 'Task A', category: '待办', notes: 'summary', priority: 'normal', due_date: '2026-10-08' }];
  global.fetch = async (url, options) => {
    if (options.method === 'POST') { writes++; return new Promise(resolve => { resolveWrite = resolve; }); }
    const body = url === '/api/todos' ? todos : url === '/api/countdowns' ? [{ id: 1, title: 'Birthday', target_date: '2026-12-01', repeat_yearly: true, notes: 'memo' }] : url === '/api/todo-categories' ? ['待办'] : {};
    return { ok: true, json: async () => body };
  };
  try {
    const module = await import('../public/js/todos.js?task-redesign-test');
    module.initTodos(); await module.loadTodos(); module.showTodoView(); module.showTodoView();
    assert.equal(doc.getElementById('todoListHeading').textContent, '待办');
    assert.equal(doc.getElementById('todoListCount').textContent, '1 条');
    assert.equal(doc.getElementById('todoFullForm').hidden, true);
    assert.equal(doc.getElementById('todoSearchInput').closest('#todoSidebarPanel') !== null, true);
    assert.equal(doc.querySelector('#todoView #todoSearchInput'), null);
    assert.equal(doc.getElementById('todoReminderEnabled').closest('#todoReminderDialog').id, 'todoReminderDialog');
    assert.equal(doc.getElementById('btnTodoCategoryOpen').hidden, false);
    assert.equal(doc.querySelector('#btnTodoNew [data-todo-new-icon="todo"]').hidden, false);
    assert.equal(doc.querySelector('#btnTodoNew [data-todo-new-icon="countdown"]').hidden, true);
    const filterNames = [...doc.querySelectorAll('#todoFilterTabs [data-filter]')].map(button => button.textContent.trim());
    assert.deepEqual(filterNames.slice(0, 2), ['待办', '已完成']);
    doc.getElementById('todoModeCountdowns').click(); await tick();
    assert.equal(doc.getElementById('todoListHeading').textContent, '倒数日');
    assert.match(doc.getElementById('countdownGrid').textContent, /下一次/);
    assert.equal(doc.getElementById('btnTodoCategoryOpen').hidden, true);
    assert.equal(doc.querySelector('#btnTodoNew [data-todo-new-icon="todo"]').hidden, true);
    assert.equal(doc.querySelector('#btnTodoNew [data-todo-new-icon="countdown"]').hidden, false);
    assert.equal(doc.getElementById('btnTodoNew').getAttribute('aria-label'), '新建倒数日');
    const directory = doc.querySelector('[data-countdown-select]');
    assert.match(directory.textContent, /Birthday.*下一次/);
    directory.focus(); directory.click(); await tick();
    assert.equal(doc.getElementById('countdownTitle').value, 'Birthday');
    assert.equal(doc.querySelector('[data-countdown-select]').getAttribute('aria-current'), 'true');
    doc.getElementById('btnCountdownCancel').click(); await tick();
    assert.equal(doc.getElementById('countdownForm').hidden, true);
    assert.equal(doc.activeElement.dataset.countdownSelect, '1');
    doc.getElementById('todoModeTodos').click(); await tick();
    const search = doc.getElementById('todoSearchInput'); search.value = 'missing'; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.match(doc.getElementById('todoFullList').textContent, /没有匹配/);
    assert.equal(doc.getElementById('todoSearchClear').hidden, false);
    doc.getElementById('todoSearchClear').click();
    assert.equal(search.value, '');
    assert.equal(doc.getElementById('todoSearchClear').hidden, true);
    search.value = 'missing'; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    doc.querySelector('[data-todo-empty-action]').click();
    assert.equal(doc.getElementById('todoListCount').textContent, '1 条');
    doc.getElementById('btnTodoNew').click(); await tick();
    doc.getElementById('todoFullTitle').value = 'new task';
    const save = doc.getElementById('btnTodoFullSave'); save.click(); save.click(); await tick();
    assert.equal(writes, 1);
    resolveWrite({ ok: false, status: 500, json: async () => ({ error: 'write failed' }) }); await tick();
    assert.equal(doc.getElementById('todoFullTitle').value, 'new task');
    assert.match(doc.getElementById('todoFullFormError').textContent, /write failed/);
    assert.equal(save.disabled, false);
    save.click(); await tick();
    resolveWrite({ ok: true, json: async () => ({}) }); await tick(); await tick();
    assert.equal(doc.getElementById('todoFullForm').hidden, true);
    assert.equal(doc.activeElement.id, 'btnTodoNew');
  } finally { dom.window.close(); Object.assign(global, previous); }
});

test('category menu supports keyboard rename and updates an open task without losing its draft', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'http://localhost' });
  const doc = dom.window.document;
  const previous = Object.fromEntries(['document', 'window', 'localStorage', 'fetch', 'requestAnimationFrame', 'Event'].map(key => [key, global[key]]));
  Object.assign(global, { document: doc, window: dom.window, localStorage: dom.window.localStorage, requestAnimationFrame: fn => fn(), Event: dom.window.Event });
  dom.window.localStorage.setItem('todoFilter', '阅读');
  const categoryOverlay = doc.getElementById('todoCategoryOverlay');
  categoryOverlay.showModal = () => categoryOverlay.setAttribute('open', '');
  categoryOverlay.close = () => { categoryOverlay.removeAttribute('open'); categoryOverlay.dispatchEvent(new dom.window.Event('close')); };
  let categories = ['待办', '阅读'];
  let todos = [{ id: 8, title: '原任务', category: '阅读', due_date: '', priority: 'none', recurrence: 'none', notes: '' }];
  global.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') {
      const original = decodeURIComponent(url.split('/').at(-1));
      const name = JSON.parse(options.body).name;
      if (name !== original && categories.includes(name)) return { ok: false, status: 409, json: async () => ({ error: 'Todo category already exists' }) };
      categories = ['待办', name];
      todos = todos.map(todo => ({ ...todo, category: name }));
      return { ok: true, json: async () => ({ category: name, categories }) };
    }
    const body = url === '/api/todos' ? todos
      : url === '/api/countdowns' ? []
        : url === '/api/todo-categories' ? categories
          : url === '/api/todo-reminder-settings' ? { enabled: false, recipientEmail: '', sendTime: '08:00', mailReady: false, smtp: {}, lastStatus: 'idle' }
            : {};
    return { ok: true, json: async () => body };
  };
  try {
    const module = await import('../public/js/todos.js?todo-category-keyboard-rename-test');
    module.initTodos(); await module.loadTodos();
    doc.querySelector('.todo-item[data-id="8"]').click(); await tick();
    assert.equal(doc.getElementById('todoFullCategory').value, '阅读');
    doc.getElementById('todoFullTitle').value = '尚未保存的标题';
    const toggle = doc.querySelector('[data-category-more="阅读"]');
    toggle.click();
    const moveDown = new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    toggle.dispatchEvent(moveDown);
    assert.equal(doc.activeElement.dataset.action, 'rename-category');
    doc.activeElement.click();
    assert.equal(categoryOverlay.open, true);
    assert.equal(doc.getElementById('todoCategoryInput').value, '阅读');
    assert.equal(doc.getElementById('todoFullCategory').value, '阅读');
    doc.getElementById('todoCategoryInput').value = '待办';
    doc.getElementById('todoCategoryAddForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(categoryOverlay.open, true);
    assert.equal(doc.getElementById('todoCategoryInput').value, '待办');
    assert.match(doc.getElementById('todoCategoryError').textContent, /同名/);
    doc.getElementById('todoCategoryInput').value = '读书';
    doc.getElementById('todoCategoryInput').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    doc.getElementById('todoCategoryAddForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(categoryOverlay.open, false);
    assert.deepEqual(categories, ['待办', '读书']);
    assert.equal(doc.getElementById('todoFullCategory').value, '读书');
    assert.equal(doc.getElementById('todoFullTitle').value, '尚未保存的标题');
    assert.equal(doc.activeElement.dataset.filter, '读书');
    const renamedMore = doc.querySelector('[data-category-more="读书"]');
    renamedMore.focus(); renamedMore.click();
    const menu = renamedMore.parentElement.querySelector('.todo-category-menu');
    const menuItem = menu.querySelector('[role="menuitem"]');
    menuItem.focus();
    menuItem.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(menu.hidden, true);
    assert.equal(doc.activeElement, renamedMore);
    renamedMore.click();
    doc.getElementById('todoListHeading').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    assert.equal(menu.hidden, true);
  } finally { dom.window.close(); Object.assign(global, previous); }
});

test('reminder pop-up stays open for nested dialogs and closes on Escape, outside click and mode changes', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'http://localhost' });
  const doc = dom.window.document;
  const { initTodoReminderPanel } = await import('../public/js/app/todo-reminder-panel.js');
  const sidebar = doc.getElementById('todoSidebarPanel'); sidebar.hidden = false;
  const dock = doc.getElementById('todoSearchDock'); dock.getBoundingClientRect = () => ({ top: 400 });
  const panel = doc.getElementById('todoReminderDialog'), toggle = doc.getElementById('todoReminderOpen');
  initTodoReminderPanel(doc);
  const escape = () => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  try {
    toggle.click();
    assert.equal(panel.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.style.maxHeight, '380px');
    assert.equal(doc.activeElement.id, 'todoReminderEnabled');
    doc.getElementById('todoSmtpSettings').open = true;
    doc.getElementById('todoSmtpSettings').click(); assert.equal(panel.hidden, false);
    const nested = doc.getElementById('todoTestEmailDialog'); nested.setAttribute('open', '');
    escape(); assert.equal(panel.hidden, false);
    nested.removeAttribute('open');
    doc.getElementById('todoTestEmailCancel').click(); assert.equal(panel.hidden, false);
    escape(); assert.equal(panel.hidden, true); assert.equal(doc.activeElement, toggle);
    toggle.click(); doc.getElementById('todoListHeading').click(); assert.equal(panel.hidden, true);
    toggle.click(); sidebar.hidden = true; await tick(); assert.equal(panel.hidden, true);
    sidebar.hidden = false; await tick(); toggle.click();
    dom.window.matchMedia = () => ({ matches: true });
    doc.body.classList.add('sidebar-visible'); await tick();
    doc.body.classList.remove('sidebar-visible'); await tick(); assert.equal(panel.hidden, true);
  } finally { dom.window.close(); }
});
