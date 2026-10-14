const test = require('node:test');
const assert = require('node:assert/strict');

test('managed excerpts split from personal notes and malformed markers preserve the full draft', async () => {
  const { splitAnnotation } = await import('../public/js/knowledge/annotation-sections.js');
  const valid = splitAnnotation('我的手写内容\n\n<!-- liuxu-reading:start -->\n## 阅读摘录\n摘录 A\n<!-- liuxu-reading:end -->\n\n后续笔记');
  assert.equal(valid.valid, true);
  assert.match(valid.personal, /我的手写内容/);
  assert.match(valid.personal, /后续笔记/);
  assert.match(valid.summary, /摘录 A/);
  const damaged = splitAnnotation('我的手写内容\n<!-- liuxu-reading:start -->\n保留全文');
  assert.equal(damaged.valid, false);
  assert.equal(damaged.personal, '我的手写内容\n<!-- liuxu-reading:start -->\n保留全文');
  assert.equal(damaged.summary, '');
});
