const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { JSDOM } = require('jsdom');

async function loadImageProviderUi(dom) {
  const url = pathToFileURL(path.join(__dirname, '../public/js/settings/image-providers.js'));
  url.search = `test=${Date.now()}-${Math.random()}`;
  return import(url.href);
}

function withDom(fn) {
  return async () => {
    const dom = new JSDOM('<!doctype html><body><div id="imageProvidersSettings"></div><div id="toast"></div></body>', { url: 'http://127.0.0.1/' });
    const previous = { window: global.window, document: global.document, crypto: global.crypto, CSS: global.CSS, confirm: global.confirm };
    global.window = dom.window;
    global.document = dom.window.document;
    global.crypto = dom.window.crypto;
    global.CSS = dom.window.CSS || { escape: value => String(value) };
    global.confirm = () => false;
    try {
      await fn(dom);
    } finally {
      dom.window.close();
      global.window = previous.window;
      global.document = previous.document;
      global.crypto = previous.crypto;
      global.CSS = previous.CSS;
      global.confirm = previous.confirm;
    }
  };
}

function changeAdapter(dom, value) {
  const adapter = document.querySelector('.image-provider-adapter');
  adapter.value = value;
  adapter.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

test('image provider settings render a workspace detail pane with stable selection', withDom(async (dom) => {
  const ui = await loadImageProviderUi();
  ui.loadImageProviderSettings({
    defaultImageModelRef: 'image/ip_test/im_test',
    imageProviders: [{
      id: 'ip_test', name: 'Test Images', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:3001', enabled: true,
      apiKeyConfigured: true,
      models: [{
        id: 'im_test', upstreamId: 'custom-image', name: 'Custom Image', enabled: true,
        capabilities: { textToImage: true, imageEdit: true, maxOutputs: 2, maxReferences: 1, sizes: ['1024x1024'] },
        defaults: { size: '1024x1024', count: 1 },
      }],
    }, {
      id: 'ip_second', name: 'Second Provider', adapter: 'seedream', baseUrl: 'https://ark.example.com/api/v3', enabled: false,
      models: [{ id: 'im_second', upstreamId: 'doubao-seedream-5-0-pro-260628', name: 'Pro', enabled: true }],
    }],
  });

  assert.equal(document.querySelectorAll('.custom-provider-workspace.image-provider-workspace').length, 1);
  assert.equal(document.querySelectorAll('.custom-provider-nav-item').length, 2);
  assert.equal(document.querySelectorAll('.custom-provider-nav-drag').length, 0, 'sidebar has no fake drag handle');
  assert.equal(document.querySelectorAll('[data-image-add]').length, 1);
  assert.match(document.querySelector('[data-image-add]').textContent, /添加供应商/);
  const detail = document.querySelector('.image-provider-detail');
  assert.equal(detail.dataset.providerId, 'ip_test', 'first provider is selected by default');
  assert.equal(detail.querySelectorAll('.image-model-card').length, 1);
  assert.ok(detail.querySelector('.custom-provider-title-wrap'));
  assert.ok(detail.querySelector('[data-toggle-key]'));
  assert.equal(detail.querySelectorAll('[role="switch"]').length, 1);
  const duplicate = detail.querySelector('[data-image-action="duplicate-provider"]');
  assert.ok(duplicate?.querySelector('svg'), 'duplicate is an icon button');
  assert.equal(duplicate.getAttribute('aria-label'), '复制供应商');
  assert.ok(detail.querySelector('[data-image-action="test"]'));
  assert.equal(detail.querySelectorAll('.image-model-card [data-image-action="test"]').length, 0, 'connection test lives on the provider, not each model');
  assert.equal(detail.querySelectorAll('.image-model-card [data-image-action="generate"]').length, 1);

  document.querySelector('[data-select-image-provider="ip_second"]').click();
  assert.equal(document.querySelector('.image-provider-detail').dataset.providerId, 'ip_second');
  assert.equal(document.querySelectorAll('.custom-provider-nav-item.active').length, 1);

  const capability = document.querySelector('.image-model-capabilities');
  capability.open = true;
  capability.dispatchEvent(new dom.window.Event('toggle', { bubbles: false }));
  document.querySelector('[role="switch"]').click();
  assert.equal(document.querySelector('.image-model-capabilities').open, true, 'capability open state persists across re-render');

  document.querySelector('[data-image-action="duplicate-provider"]').click();
  assert.equal(document.querySelectorAll('.custom-provider-nav-item').length, 3);

  const saved = ui.readImageProviderSettings();
  assert.equal(saved.imageProviders.length, 3);
  const copy = saved.imageProviders.find(provider => provider.name === 'Second Provider 副本');
  assert.ok(copy);
  assert.notEqual(copy.id, 'ip_second');
  assert.equal(copy.apiKey, '');
  assert.equal(copy.models[0].upstreamId, 'doubao-seedream-5-0-pro-260628', 'upstream ids are preserved on copy');

  for (let i = 0; i < 3; i += 1) {
    global.confirm = () => true;
    document.querySelector('[data-image-action="remove-provider"]').click();
  }
  const afterRemoval = ui.readImageProviderSettings();
  assert.equal(afterRemoval.imageProviders.length, 0);
  assert.equal(afterRemoval.defaultImageModelRef, '');
  assert.ok(document.querySelector('.custom-provider-detail-empty'), 'empty state renders when no provider remains');
}));

test('image provider test-state slots exist and keep inputs across updates', withDom(async () => {
  const ui = await loadImageProviderUi();
  ui.loadImageProviderSettings({
    imageProviders: [{
      id: 'ip_ui', name: 'UI', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:3002', enabled: true,
      models: [{ id: 'im_ui', upstreamId: 'gpt-image-2', name: 'GPT Image', enabled: true }],
    }],
  });

  assert.equal(document.querySelectorAll('[data-test-state$=":connection"]').length, 1);
  assert.equal(document.querySelectorAll('.image-model-card [data-test-state$=":connection"]').length, 0);
  assert.equal(document.querySelectorAll('.image-model-card [data-test-state$=":generation"]').length, 1);

  const nameInput = document.querySelector('.image-model-name');
  nameInput.focus();
  nameInput.value = '重命名后的模型';
  const focusKey = nameInput.dataset.focusKey;
  document.querySelector('[data-image-action="add-model"]').click();
  const restored = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
  assert.ok(restored, 'focused input survives a structural re-render');
  assert.equal(document.activeElement, restored);
  assert.equal(restored.value, '重命名后的模型');

  document.querySelector('[role="switch"]').click();
  assert.ok(document.querySelector('.custom-provider-status-dot.is-disabled'), 'disabled provider shows status dot');
  document.querySelector('[role="switch"]').click();
  assert.equal(document.querySelector('.custom-provider-status-dot.is-disabled'), null);

  const keyInput = document.querySelector('.image-provider-key');
  assert.equal(keyInput.type, 'password');
  document.querySelector('[data-toggle-key]').click();
  assert.equal(keyInput.type, 'text');

  const saved = ui.readImageProviderSettings();
  assert.equal(saved.imageProviders[0].models[0].name, '重命名后的模型');
  assert.equal(saved.imageProviders[0].models.length, 1);
  assert.equal(document.querySelectorAll('.image-model-card').length, 2, 'the draft still shows both model rows');
}));

test('adding a provider uses one button and Seedream fills presets for blank models', withDom(async (dom) => {
  const ui = await loadImageProviderUi();
  ui.loadImageProviderSettings({ imageProviders: [] });

  document.querySelector('[data-image-add]').click();
  assert.equal(document.querySelectorAll('.custom-provider-nav-item').length, 1);
  const added = document.querySelector('.image-provider-detail');
  assert.equal(added.querySelector('.image-provider-adapter').value, 'openai-images');
  assert.equal(added.querySelectorAll('.image-model-card').length, 1);
  assert.equal(added.querySelector('.image-model-upstream').value, '');

  changeAdapter(dom, 'seedream');

  const seeded = document.querySelector('.image-provider-detail');
  assert.equal(seeded.querySelector('.image-provider-adapter').value, 'seedream');
  assert.equal(seeded.querySelector('.image-provider-name').value, 'Seedream');
  assert.equal(seeded.querySelectorAll('.image-model-card').length, 4);
  assert.equal(seeded.querySelector('.image-provider-base-url').value, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(seeded.querySelector('.image-model-upstream').value, 'doubao-seedream-5-0-pro-260628');
  const defaultRadio = seeded.querySelector('input[name="defaultImageModel"]:checked');
  assert.ok(defaultRadio, 'seeding presets re-points the default model radio');
  const seededSaved = ui.readImageProviderSettings();
  assert.equal(seededSaved.imageProviders[0].name, 'Seedream');
  assert.equal(seededSaved.defaultImageModelRef, defaultRadio.value);
  assert.match(seededSaved.defaultImageModelRef, /^image\/ip_[^/]+\/im_/);

  changeAdapter(dom, 'openai-images');
  const reverted = document.querySelector('.image-provider-detail');
  assert.equal(reverted.querySelector('.image-provider-adapter').value, 'openai-images');
  assert.equal(reverted.querySelector('.image-provider-name').value, 'OpenAI Images');
  assert.equal(reverted.querySelectorAll('.image-model-card').length, 1, 'seedream presets collapse back to one blank OpenAI model');
  assert.equal(reverted.querySelector('.image-model-upstream').value, '');
  assert.equal(reverted.querySelector('.image-provider-base-url').value, '');

  changeAdapter(dom, 'seedream');
  document.querySelector('.image-provider-base-url').value = 'https://api.example.com/v3';
  changeAdapter(dom, 'openai-images');
  assert.equal(document.querySelectorAll('.image-model-card').length, 1);
  assert.equal(document.querySelector('.image-provider-base-url').value, 'https://api.example.com/v3', 'a hand-edited root URL is kept');

  ui.loadImageProviderSettings({
    imageProviders: [{
      id: 'ip_named', name: 'Custom', adapter: 'openai-images', baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'im_named', upstreamId: 'gpt-image-2', name: 'GPT Image', enabled: true }],
    }],
  });
  changeAdapter(dom, 'seedream');
  assert.equal(document.querySelector('.image-provider-name').value, 'Custom', 'a custom name is not rewritten');
  assert.equal(document.querySelectorAll('.image-model-card').length, 1, 'real models are kept when switching protocol');
  assert.equal(document.querySelector('.image-model-upstream').value, 'gpt-image-2');
  assert.equal(document.querySelector('.image-provider-base-url').value, 'https://api.example.com/v1');
}));

test('a finished connection test does not rebuild another provider being edited', withDom(async () => {
  const ui = await loadImageProviderUi();
  ui.loadImageProviderSettings({
    imageProviders: [{
      id: 'ip_first', name: 'First', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:3001', enabled: true,
      models: [{ id: 'im_first', upstreamId: 'gpt-image-2', name: 'GPT Image', enabled: true }],
    }, {
      id: 'ip_second', name: 'Second', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:3002', enabled: true,
      models: [{ id: 'im_second', upstreamId: 'gpt-image-2', name: 'Other', enabled: true }],
    }],
  });

  const previousFetch = global.fetch;
  let finishTest;
  global.fetch = () => new Promise(resolve => {
    finishTest = () => resolve({
      ok: true,
      json: async () => ({ ok: true, message: '连接成功', durationMs: 2 }),
    });
  });
  try {
    document.querySelector('[data-image-action="test"]').click();
    assert.equal(typeof finishTest, 'function');
    document.querySelector('[data-select-image-provider="ip_second"]').click();
    const nameInput = document.querySelector('.image-provider-name');
    nameInput.value = '正在编辑';
    finishTest();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelector('.image-provider-detail').dataset.providerId, 'ip_second');
    assert.equal(document.querySelector('.image-provider-name').value, '正在编辑', 'background test must not wipe the selected provider');
  } finally {
    global.fetch = previousFetch;
  }
}));

test('incomplete image providers block save instead of dropping existing cards', withDom(async () => {
  const ui = await loadImageProviderUi();
  ui.loadImageProviderSettings({
    imageProviders: [{
      id: 'ip_saved', name: 'Saved', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:1', enabled: true,
      models: [{ id: 'im_saved', upstreamId: 'gpt-image-2', name: 'GPT Image', enabled: true }],
    }],
  });
  document.querySelector('.image-provider-name').value = '';
  document.querySelector('.image-provider-base-url').value = '';
  assert.match(ui.imageProviderSaveError(['ip_saved']), /请先完成/);
}));
