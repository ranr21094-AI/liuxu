const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('image provider settings render a workspace detail pane with stable selection', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="imageProvidersSettings"></div><div id="toast"></div></body>', { url: 'http://127.0.0.1/' });
  const previous = { window: global.window, document: global.document, crypto: global.crypto, CSS: global.CSS, confirm: global.confirm };
  global.window = dom.window;
  global.document = dom.window.document;
  global.crypto = dom.window.crypto;
  global.CSS = dom.window.CSS || { escape: value => String(value) };
  global.confirm = () => false;
  try {
    const url = pathToFileURL(path.join(__dirname, '../public/js/settings/image-providers.js'));
    url.search = `test=${Date.now()}`;
    const ui = await import(url.href);
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

    // Workspace layout: the sidebar lists every provider, the detail pane
    // shows the selected one only.
    assert.equal(document.querySelectorAll('.custom-provider-workspace.image-provider-workspace').length, 1);
    assert.equal(document.querySelectorAll('.custom-provider-nav-item').length, 2);
    const detail = document.querySelector('.image-provider-detail');
    assert.equal(detail.dataset.providerId, 'ip_test', 'first provider is selected by default');
    assert.equal(detail.querySelectorAll('.image-model-card').length, 1);

    // Selecting the second provider swaps the detail pane.
    document.querySelector('[data-select-image-provider="ip_second"]').click();
    assert.equal(document.querySelector('.image-provider-detail').dataset.providerId, 'ip_second');
    assert.equal(document.querySelectorAll('.custom-provider-nav-item.active').length, 1);

    // Capability expansion state survives re-renders: toggling the provider
    // re-renders the same provider+model, so the capability key is unchanged.
    const capability = document.querySelector('.image-model-capabilities');
    capability.open = true;
    capability.dispatchEvent(new dom.window.Event('toggle', { bubbles: false }));
    document.querySelector('[data-image-action="toggle-provider"]').click();
    assert.equal(document.querySelector('.image-model-capabilities').open, true, 'capability open state persists across re-render');

    // Duplicating a provider selects the copy; the copy gets fresh model ids
    // (its capability expansion state intentionally starts closed).
    document.querySelector('[data-image-action="duplicate-provider"]').click();
    assert.equal(document.querySelectorAll('.custom-provider-nav-item').length, 3);

    // Duplicated provider gets fresh ids and a cleared key.
    const saved = ui.readImageProviderSettings();
    assert.equal(saved.imageProviders.length, 3);
    const copy = saved.imageProviders.find(provider => provider.name === 'Second Provider 副本');
    assert.ok(copy);
    assert.notEqual(copy.id, 'ip_second');
    assert.equal(copy.apiKey, '');
    assert.equal(copy.models[0].upstreamId, 'doubao-seedream-5-0-pro-260628', 'upstream ids are preserved on copy');

    // Removing every provider falls back to the empty detail pane and clears
    // the default model ref.
    for (let i = 0; i < 3; i += 1) {
      document.querySelector('[data-image-action="remove-provider"]').click();
    }
    const afterRemoval = ui.readImageProviderSettings();
    assert.equal(afterRemoval.imageProviders.length, 0);
    assert.equal(afterRemoval.defaultImageModelRef, '');
    assert.ok(document.querySelector('.custom-provider-detail-empty'), 'empty state renders when no provider remains');
  } finally {
    dom.window.close();
    global.window = previous.window;
    global.document = previous.document;
    global.crypto = previous.crypto;
    global.CSS = previous.CSS;
    global.confirm = previous.confirm;
  }
});

test('image provider test-state slots exist and keep inputs across updates', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="imageProvidersSettings"></div><div id="toast"></div></body>', { url: 'http://127.0.0.1/' });
  const previous = { window: global.window, document: global.document, crypto: global.crypto, CSS: global.CSS };
  global.window = dom.window;
  global.document = dom.window.document;
  global.crypto = dom.window.crypto;
  global.CSS = dom.window.CSS || { escape: value => String(value) };
  try {
    const url = pathToFileURL(path.join(__dirname, '../public/js/settings/image-providers.js'));
    url.search = `test=${Date.now()}`;
    const ui = await import(url.href);
    ui.loadImageProviderSettings({
      imageProviders: [{
        id: 'ip_ui', name: 'UI', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:3002', enabled: true,
        models: [{ id: 'im_ui', upstreamId: 'gpt-image-2', name: 'GPT Image', enabled: true }],
      }],
    });

    // Every model exposes always-present slots for connection and generation
    // states so async outcomes patch in place instead of re-rendering.
    assert.equal(document.querySelectorAll('[data-test-state$=":connection"]').length, 1);
    assert.equal(document.querySelectorAll('[data-test-state$=":generation"]').length, 1);

    // Structural re-render keeps focus and typed value via data-focus-key.
    const nameInput = document.querySelector('.image-model-name');
    nameInput.focus();
    nameInput.value = '重命名后的模型';
    const focusKey = nameInput.dataset.focusKey;
    document.querySelector('[data-image-action="add-model"]').click();
    const restored = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    assert.ok(restored, 'focused input survives a structural re-render');
    assert.equal(document.activeElement, restored);
    assert.equal(restored.value, '重命名后的模型');

    // Toggling the provider flips the enabled state (status dot in sidebar).
    // The button node is re-queried after every re-render because the detail
    // pane (and its buttons) is rebuilt.
    document.querySelector('[data-image-action="toggle-provider"]').click();
    assert.ok(document.querySelector('.custom-provider-status-dot.is-disabled'), 'disabled provider shows status dot');
    document.querySelector('[data-image-action="toggle-provider"]').click();
    assert.equal(document.querySelector('.custom-provider-status-dot.is-disabled'), null);

    // readImageProviderSettings keeps the typed name; the blank model added
    // above is filtered out of the saved payload until it has an upstream id.
    const saved = ui.readImageProviderSettings();
    assert.equal(saved.imageProviders[0].models[0].name, '重命名后的模型');
    assert.equal(saved.imageProviders[0].models.length, 1);
    assert.equal(document.querySelectorAll('.image-model-card').length, 2, 'the draft still shows both model rows');
  } finally {
    dom.window.close();
    global.window = previous.window;
    global.document = previous.document;
    global.crypto = previous.crypto;
    global.CSS = previous.CSS;
  }
});
