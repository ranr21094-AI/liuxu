const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  collectKnownUploadUrls,
  dedupeImageMarkdown,
  isSafeImageSrc,
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

test('knowledge folder image assets pass the image allowlist with path validation', () => {
  assert.equal(isSafeImageSrc('/api/knowledge/assets/note%3A329/岗位职责.png'), true);
  assert.equal(isSafeImageSrc('/api/knowledge/assets/file%3A12/附件/photo.jpg'), true);
  assert.equal(isSafeImageSrc('/api/knowledge/assets/note%3A329/../secret.png'), false);
  assert.equal(isSafeImageSrc('/api/knowledge/assets/note%3A329/%2e%2e/secret.png'), false);
  assert.equal(isSafeImageSrc('/api/knowledge/assets/agent%3A1/photo.png'), false);
  assert.equal(isSafeImageSrc('/api/knowledge/documents/note%3A329/photo.png'), false);
});

test('knowledge preview normalizes dot-relative images before the safety allowlist', async () => {
  const { rewriteRelativeImages } = await import(`../public/js/knowledge/links-history.js?relative-image=${Date.now()}`);
  assert.equal(
    rewriteRelativeImages('![岗位](./岗位职责.png)', 'note:329'),
    '![岗位](/api/knowledge/assets/note%3A329/%E5%B2%97%E4%BD%8D%E8%81%8C%E8%B4%A3.png)',
  );
  assert.equal(rewriteRelativeImages('![越界](../secret.png)', 'note:329'), '![越界](../secret.png)');
});
