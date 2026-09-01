const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('image provider cards keep stable ids and expanded capability state across rerenders', async () => {
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
      defaultImageModelRef: 'image/ip_test/im_test',
      imageProviders: [{
        id: 'ip_test', name: 'Test Images', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:3001', enabled: true,
        apiKeyConfigured: true,
        models: [{
          id: 'im_test', upstreamId: 'custom-image', name: 'Custom Image', enabled: true,
          capabilities: { textToImage: true, imageEdit: true, maxOutputs: 2, maxReferences: 1, sizes: ['1024x1024'] },
          defaults: { size: '1024x1024', count: 1 },
        }],
      }],
    });
    const firstCard = document.querySelector('.image-provider-card');
    assert.equal(firstCard.open, true);
    const capability = document.querySelector('.image-model-capabilities');
    capability.open = true;
    capability.dispatchEvent(new dom.window.Event('toggle', { bubbles: false }));
    firstCard.querySelector('[data-image-action="duplicate-provider"]').click();
    assert.equal(document.querySelectorAll('.image-provider-card').length, 2);
    assert.equal(document.querySelector('.image-provider-card[data-provider-id="ip_test"]').open, true);
    assert.equal(document.querySelector('[data-capability-key="ip_test:im_test"]').open, true);
    const saved = ui.readImageProviderSettings();
    assert.equal(saved.imageProviders[0].id, 'ip_test');
    assert.equal(saved.imageProviders[0].models[0].id, 'im_test');
    assert.equal(saved.defaultImageModelRef, 'image/ip_test/im_test');
  } finally {
    dom.window.close();
    global.window = previous.window;
    global.document = previous.document;
    global.crypto = previous.crypto;
    global.CSS = previous.CSS;
  }
});
