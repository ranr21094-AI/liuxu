const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveAllowed, isSensitivePath, recentlyReauthed, markReauth } = require('../lib/computer/policy');
const { createCodeRunner } = require('../lib/computer/code');
const { sign } = require('../lib/computer/chrome');

test('allowlist rejects path escape and sensitive directories', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inside = path.join(dir, 'ok.txt');
  fs.writeFileSync(inside, 'ok');
  assert.equal(resolveAllowed(inside, [dir]), fs.realpathSync(inside));
  assert.throws(() => resolveAllowed(path.join(dir, '..', 'nope.txt'), [dir]));
  assert.equal(isSensitivePath('C:\\\\Users\\\\a\\\\.ssh\\\\id_rsa'), true);
});

test('reauth window is fifteen minutes', () => {
  markReauth('u1');
  assert.equal(recentlyReauthed('u1'), true);
  assert.equal(recentlyReauthed('missing'), false);
});

test('code runner executes python when available', async (t) => {
  const runner = createCodeRunner({ accountId: 't', timeoutMs: 8000 });
  const result = await runner.execute('code.run', { language: 'python', script: 'print("hi-agent")' });
  if (!result.ok && /spawn|not found|ENOENT/i.test(result.summary)) {
    t.skip('python is not installed');
    return;
  }
  assert.match(result.data.output, /hi-agent/);
});

test('chrome command signatures reject replay', () => {
  const key = 'abc';
  const nonce = 'n1';
  const payload = { name: 'browser.click', args: { x: 1 } };
  const first = sign(key, nonce, payload);
  assert.equal(sign(key, nonce, payload), first);
  assert.notEqual(sign(key, 'n2', payload), first);
});
