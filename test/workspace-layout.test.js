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
});

test('mode nav collapse is independent from desktop sidebar collapse', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/workspace-ui.css'), 'utf8');
  const document = new JSDOM(html).window.document;
  const brand = document.querySelector('#workspaceBrand');
  const nav = document.querySelector('#workspaceModeNav');
  assert.equal(brand?.tagName, 'BUTTON');
  assert.equal(brand?.getAttribute('aria-controls'), 'workspaceModeNav');
  assert.equal(nav?.querySelectorAll('[data-mode]').length, 4);
  assert.equal(document.querySelector('#agentSidebarPanel') !== null, true);
  assert.match(source, /const MODE_NAV_COLLAPSED_KEY = 'workbenchModeNavCollapsed'/);
  assert.match(source, /const SIDEBAR_COLLAPSED_KEY = 'workbenchSidebarCollapsed'/);
  assert.match(source, /function toggleModeNav/);
  assert.match(source, /function toggleDesktopSidebar/);
  assert.match(source, /\$\('#workspaceBrand'\)\.addEventListener\('click', \(\) => toggleModeNav\(\)\)/);
  assert.match(source, /\$\('#sidebarToggle'\)\.addEventListener\('click', \(\) => toggleDesktopSidebar\(\)\)/);
  assert.doesNotMatch(source, /\$\('#workspaceBrand'\)\.addEventListener\('click', \(\) => toggleDesktopSidebar/);
  assert.match(css, /body\.mode-nav-collapsed \.workspace-mode-nav[\s\S]*display:\s*none/);
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
