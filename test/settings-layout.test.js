const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('settings categories are grouped by purpose without dropping existing destinations', () => {
  const document = new JSDOM(read('public/index.html')).window.document;
  const groups = [...document.querySelectorAll('[data-settings-group-panel]')].map(group => ({
    id: group.dataset.settingsGroupPanel,
    panels: [...group.querySelectorAll('[data-settings-nav]')].map(button => button.dataset.settingsNav),
  }));

  assert.deepEqual(groups, [
    { id: 'basic', panels: ['appearance', 'sessions', 'updates'] },
    { id: 'ai', panels: ['model', 'agent', 'memory', 'network', 'image', 'skills'] },
    { id: 'workspace', panels: ['knowledge', 'data', 'computer', 'remote'] },
  ]);
  assert.equal(document.querySelectorAll('[data-settings-panel]').length, 13);
  assert.equal(document.querySelector('[data-settings-nav="knowledge"]').textContent.trim(), '知识库');
  assert.match(read('public/js/workbench.js'), /function setSettingsGroup\(group\)/);
  assert.match(read('public/js/workbench.js'), /SETTINGS_PANEL_GROUP\[next\]/);
  assert.match(read('public/js/workbench.js'), /settingsActionFooter\.hidden = saveButton\.hidden/);
});

test('advanced agent and memory limits start collapsed while core memory controls stay visible', () => {
  const document = new JSDOM(read('public/index.html')).window.document;
  const agentDetails = document.querySelector('[data-settings-panel="agent"] details.settings-advanced');
  const memoryDetails = document.querySelector('[data-settings-panel="memory"] details.settings-advanced');

  assert.equal(agentDetails.hasAttribute('open'), false);
  assert.equal(memoryDetails.hasAttribute('open'), false);
  assert.equal(agentDetails.querySelector('#agentMaxToolFailures') !== null, true);
  assert.equal(memoryDetails.querySelector('#memoryRefreshSessionLimit') !== null, true);
  assert.equal(document.querySelector('.settings-memory-common #memoryRefreshMaxRounds') !== null, true);
  assert.equal(document.querySelector('.settings-memory-common #memoryRefreshMaxProposals') !== null, true);
});

test('settings preserve mobile group navigation, remote touch targets, and independent content scrolling', () => {
  const css = read('public/css/workbench.css');
  assert.match(css, /\.settings-group-switcher \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 840px\)[\s\S]*\.settings-group-switcher \{ display: grid/);
  assert.match(css, /\.settings-nav-group\.active \{[^}]*display: flex;[^}]*overflow-x: auto/);
  assert.match(css, /body\.remote-client \.settings-nav-group button \{ min-height: 44px; \}/);
  assert.match(css, /\.settings-nav-groups \{ min-height: 0; overflow: auto/);
  assert.match(css, /\.settings-content \{ min-height: 0; overflow: auto/);
});
