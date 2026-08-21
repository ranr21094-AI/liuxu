const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  collectKnownUploadUrls,
  dedupeImageMarkdown,
  normalizeUploadSrc,
} = require('../public/js/helpers.js');

test('dedupeImageMarkdown removes lines for already-known upload urls', () => {
  const known = new Set(['/uploads/a.png']);
  const text = '完成。\n\n![旧图](/uploads/a.png)\n\n![新图](/uploads/b.png)';
  const result = dedupeImageMarkdown(text, known);
  assert.match(result, /\/uploads\/b\.png/);
  assert.doesNotMatch(result, /\/uploads\/a\.png/);
});

test('collectKnownUploadUrls gathers message and preview urls', () => {
  const dom = new JSDOM(`
    <div id="list">
      <article class="message assistant">
        <div class="message-content"><img src="/uploads/msg.png"></div>
      </article>
      <section class="agent-image-preview" data-generated-image="/uploads/preview.png" data-run-id="run-2"></section>
    </div>
  `);
  const root = dom.window.document.querySelector('#list');
  const all = collectKnownUploadUrls(root);
  assert.equal(all.has('/uploads/msg.png'), true);
  assert.equal(all.has('/uploads/preview.png'), true);

  const excludingRun = collectKnownUploadUrls(root, { excludeRunId: 'run-2' });
  assert.equal(excludingRun.has('/uploads/msg.png'), true);
  assert.equal(excludingRun.has('/uploads/preview.png'), false);
});

test('normalizeUploadSrc keeps safe relative upload paths', () => {
  assert.equal(normalizeUploadSrc('/uploads/foo.png'), '/uploads/foo.png');
});
