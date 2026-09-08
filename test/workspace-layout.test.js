const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('assistant docking respects editor minimum and preserves floating preference', async () => {
  const { resolveAssistantLayout: resolve } = await import('../public/js/knowledge/assistant-layout.js');
  const base = { viewportWidth: 1440, mainWidth: 1152 };
  assert.deepEqual(resolve(base), { mode: 'docked', width: 380 });
  assert.equal(resolve({ ...base, mainWidth: 979 }).mode, 'overlay');
  assert.equal(resolve({ ...base, mainWidth: 980 }).mode, 'docked');
  for (const viewportWidth of [840, 520]) assert.equal(resolve({ ...base, viewportWidth }).mode, 'overlay');
  for (const mode of ['agent','memory','todos']) assert.equal(resolve({ ...base, mode }).mode, 'floating');
  assert.equal(resolve({ ...base, preference: 'floating' }).mode, 'floating');
  assert.equal(resolve({ ...base, width: 900 }).width, 480);
  assert.equal(resolve({ ...base, width: 100 }).width, 320);
});

test('temporary layouts do not overwrite saved docking width or preference', async () => {
  const dom = new JSDOM('<main class="workspace-main"></main><aside><button data-note-assistant-layout></button><div class="note-assistant-dock-resize"></div></aside>', { url: 'http://localhost' });
  const before = { window: global.window, document: global.document };
  global.window = dom.window; global.document = dom.window.document;
  Object.defineProperty(dom.window, 'innerWidth', { value: 1440, writable: true });
  Object.defineProperty(document.querySelector('main'), 'clientWidth', { value: 1152 });
  const { createAssistantLayout } = await import('../public/js/knowledge/assistant-layout.js');
  const host = document.querySelector('aside');
  const controller = createAssistantLayout(host);
  try {
    controller.sync();
    assert.equal(host.dataset.layout, 'docked');
    host.querySelector('.note-assistant-dock-resize').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    const saved = dom.window.localStorage.getItem('liuxu.noteAssistant.layout');
    assert.equal(JSON.parse(saved).width, 396);
    controller.setMode('agent'); assert.equal(host.dataset.layout, 'floating');
    controller.setMode('knowledge'); assert.equal(host.dataset.layout, 'docked');
    dom.window.innerWidth = 520; controller.sync(); assert.equal(host.dataset.layout, 'overlay');
    assert.equal(dom.window.localStorage.getItem('liuxu.noteAssistant.layout'), saved);
    dom.window.innerWidth = 1440; controller.sync(); assert.equal(host.dataset.layout, 'docked');
  } finally { controller.destroy(); dom.window.close(); Object.assign(global, before); }
});

test('workspace density nits keep 36px controls, 24px narrow padding, and title ellipsis', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/workspace-ui.css'), 'utf8');
  const workbench = fs.readFileSync(path.join(__dirname, '../public/css/workbench.css'), 'utf8');
  assert.match(css, /\.workspace-sidebar \.search-field[\s\S]*height:\s*36px/);
  assert.match(css, /@media \(max-width: 840px\)[\s\S]*--doc-pad-x:\s*24px/);
  assert.match(css, /\.workspace-topbar \.run-status[\s\S]*display:\s*inline-flex/);
  assert.match(css, /\.document-title-input[\s\S]*text-overflow:\s*ellipsis/);
  assert.doesNotMatch(workbench, /\.topbar-mode-switch/);
  assert.doesNotMatch(workbench, /\.run-status \{ display: none !important; \}/);
  assert.match(workbench, /\.agent-composer textarea:focus-visible \{ outline: none/);
  assert.match(workbench, /\.note-assistant-composer textarea:focus-visible \{ outline: none/);
  assert.match(css, /\.agent-view \.agent-composer textarea:focus-visible/);
  assert.match(css, /\.note-assistant-panel \.note-assistant-composer textarea:focus-visible \{ outline: none/);
});

test('compact mode nav stays visible and keeps independent sidebar controls', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/workspace-ui.css'), 'utf8');
  const document = new JSDOM(html).window.document;
  const brand = document.querySelector('#workspaceBrand');
  const nav = document.querySelector('#workspaceModeNav');
  assert.equal(brand?.tagName, 'DIV');
  assert.equal(brand?.getAttribute('aria-controls'), null);
  assert.equal(brand?.getAttribute('aria-expanded'), null);
  assert.equal(brand?.querySelector('svg'), null);
  assert.equal(nav.hidden, false);
  const buttons = [...nav.querySelectorAll('[data-mode]')];
  assert.deepEqual(buttons.map(button => button.textContent), ['Agent', '知识库', 'Memory', '待办']);
  assert.deepEqual(buttons.map(button => button.dataset.mode), ['agent', 'knowledge', 'memory', 'todos']);
  assert.ok(buttons.every(button => button.type === 'button'));
  assert.equal(nav.querySelector('svg'), null);
  assert.equal(buttons[0].getAttribute('aria-current'), 'page');
  assert.equal(document.querySelector('#agentSidebarPanel') !== null, true);
  assert.doesNotMatch(source, /workbenchModeNavCollapsed|MODE_NAV_COLLAPSED_KEY|syncModeNav|toggleModeNav/);
  assert.match(source, /const SIDEBAR_COLLAPSED_KEY = 'workbenchSidebarCollapsed'/);
  assert.match(source, /function toggleDesktopSidebar/);
  assert.match(source, /\$\('#sidebarToggle'\)\.addEventListener\('click', \(\) => toggleDesktopSidebar\(\)\)/);
  assert.doesNotMatch(source, /\$\('#workspaceBrand'\)\.addEventListener\('click', \(\) => toggleDesktopSidebar/);
  assert.doesNotMatch(css, /mode-nav-collapsed|brand-toggle-caret/);
  assert.match(css, /\.workspace-brand \{[^}]*height:\s*48px/);
  assert.match(css, /\.workspace-mode-nav \{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.workspace-mode-nav \{[^}]*margin:\s*0 12px 12px; padding:\s*0/);
  assert.match(css, /\.workspace-mode-nav button \{[^}]*min-height:\s*36px[^}]*font-size:\s*13px[^}]*white-space:\s*nowrap/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*\.workspace-mode-nav button[\s\S]*min-height:\s*44px/);
  assert.match(css, /\.workspace-mode-nav button:focus-visible/);
  assert.match(css, /\.workspace-mode-nav \.mode-pending-badge \{[^}]*position:\s*absolute/);
});

test('Memory badge caps visual count without losing the full accessible count', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/workbench.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const start = source.indexOf('function updateMemoryPendingBadge(');
  const end = source.indexOf('\nfunction renderMemorySidebar()', start);
  assert.ok(start >= 0 && end > start);
  const context = { document, $: selector => document.querySelector(selector) };
  vm.runInNewContext(source.slice(start, end) + '\nthis.update = updateMemoryPendingBadge;', context);
  const badge = document.querySelector('#memoryPendingBadge');
  const button = document.querySelector('[data-mode="memory"]');
  try {
    for (const count of [1, 9, 10, 125, 0]) {
      context.update(count);
      assert.equal(badge.hidden, count === 0);
      assert.equal(badge.textContent, count === 0 ? '' : count > 9 ? '9+' : String(count));
      assert.equal(badge.getAttribute('aria-hidden'), 'true');
      assert.equal(button.getAttribute('aria-label'), count ? `Memory，${count} 条记忆待确认` : 'Memory');
      assert.equal(button.classList.contains('has-pending'), count > 0);
    }
  } finally { dom.window.close(); }
});

test('message follower keeps history position and resumes only at bottom or explicit jump', async () => {
  const dom = new JSDOM('<div id="list"></div><button hidden></button>');
  const list = dom.window.document.querySelector('div');
  const button = dom.window.document.querySelector('button');
  Object.defineProperties(list, { scrollHeight: { value: 2000, writable: true }, clientHeight: { value: 500 } });
  const before = { requestAnimationFrame: global.requestAnimationFrame, cancelAnimationFrame: global.cancelAnimationFrame };
  let callback;
  global.requestAnimationFrame = cb => { callback = cb; return 1; };
  global.cancelAnimationFrame = () => { callback = null; };
  const { createMessageFollower } = await import('../public/js/app/workspace-ui.js');
  const follower = createMessageFollower(list, button);
  try {
    follower.follow(); callback(); assert.equal(list.scrollTop, 2000);
    list.scrollTop = 200; list.dispatchEvent(new dom.window.Event('scroll'));
    list.scrollHeight = 2200; follower.follow(); assert.equal(list.scrollTop, 200); assert.equal(button.hidden, false);
    button.click(); callback(); assert.equal(list.scrollTop, 2200); assert.equal(button.hidden, true);
  } finally { follower.destroy(); dom.window.close(); Object.assign(global, before); }
});
