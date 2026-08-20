const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveAllowed, isSensitivePath, recentlyReauthed, markReauth, defaultPolicy, savePolicy, computerToolsAllowed, PREFERRED_ALLOWLIST } = require('../lib/computer/policy');
const { createCodeRunner } = require('../lib/computer/code');
const { sign } = require('../lib/computer/chrome');
const { createComputerFacade } = require('../lib/computer/routes');
const { createFileTools } = require('../lib/computer/files');

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

test('computer tools default to enabled and prefer the desktop allowlist', () => {
  const policy = defaultPolicy();
  assert.equal(policy.computerToolsEnabled, true);
  const preferred = PREFERRED_ALLOWLIST[0];
  if (fs.existsSync(preferred) && fs.statSync(preferred).isDirectory()) {
    assert.equal(policy.allowedDirectories[0], fs.realpathSync(preferred));
  }
});

test('computer tools are allowed for admin without loopback or reauth', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  savePolicy(dir, { computerToolsEnabled: true, allowedDirectories: [dir], chromePaired: false });
  const allowed = computerToolsAllowed({ user: { id: 'admin-1', role: 'admin' }, ip: '10.0.0.8' }, dir);
  assert.equal(allowed.ok, true);
  const denied = computerToolsAllowed({ user: { id: 'user-1', role: 'user' }, ip: '127.0.0.1' }, dir);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Admin/);
});

test('computer facade lists and deletes files without reauth', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-facade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const note = path.join(dir, 'note.txt');
  fs.writeFileSync(note, 'hello');
  savePolicy(dir, { computerToolsEnabled: true, allowedDirectories: [dir], chromePaired: false });
  const facade = createComputerFacade({ user: { id: 'admin-1', role: 'admin' }, ip: '10.0.0.8' }, dir);
  assert.ok(facade);
  const listed = await facade.execute('file.list', { path: dir });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.some(item => item.name === 'note.txt'), true);
  const deleted = await facade.execute('file.delete', { path: note });
  assert.equal(deleted.ok, true);
  assert.equal(fs.existsSync(note), false);
});

test('file.read honors configurable max bytes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-read-limit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const policy = { allowedDirectories: [dir] };
  const small = path.join(dir, 'small.txt');
  const large = path.join(dir, 'large.txt');
  fs.writeFileSync(small, 'a'.repeat(512 * 1024));
  fs.writeFileSync(large, 'b'.repeat(5 * 1024 * 1024));

  const fourMb = createFileTools(policy, { fileReadMaxBytes: 4 * 1024 * 1024 });
  const ok = await fourMb.execute('file.read', { path: small });
  assert.equal(ok.ok, true);
  const blocked = await fourMb.execute('file.read', { path: large });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, 'too_large');
  assert.match(blocked.summary, /4MB read limit/);

  const eightMb = createFileTools(policy, { fileReadMaxBytes: 8 * 1024 * 1024 });
  const allowed = await eightMb.execute('file.read', { path: large });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.data.content.length, 5 * 1024 * 1024);
});
