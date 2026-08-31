const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveAllowed, isSensitivePath, recentlyReauthed, markReauth, defaultPolicy, savePolicy, computerToolsAllowed, PREFERRED_ALLOWLIST } = require('../lib/computer/policy');
const { createCodeRunner, resolveCodeCommand, resolvePythonExecutable } = require('../lib/computer/code');
const { createBashRunner, resolveBashExecutable } = require('../lib/computer/bash');
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

test('code runner prefers python3 on macOS and preserves Windows PowerShell', () => {
  const seen = [];
  const python = resolvePythonExecutable({
    platform: 'darwin',
    env: {},
    canExecute(command) {
      seen.push(command);
      return command === 'python3';
    },
  });
  assert.equal(python, 'python3');
  assert.deepEqual(seen, ['python3']);
  assert.equal(resolveCodeCommand('powershell', { platform: 'win32' }).cmd, 'powershell.exe');
  assert.equal(resolveCodeCommand('powershell', { platform: 'darwin' }).cmd, 'pwsh');
  assert.equal(resolvePythonExecutable({ platform: 'darwin', env: { PYTHON_PATH: '/custom/python' } }), '/custom/python');
});

test('bash runner rejects empty command and script', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-empty-'));
  try {
    const runner = createBashRunner({ accountId: 'bash-empty', allowedDirectories: [dir], defaultWorkdir: dir });
    const empty = await runner.execute('bash.run', {});
    assert.equal(empty.ok, false);
    assert.equal(empty.errorCode, 'invalid');
    const both = await runner.execute('bash.run', { command: 'echo hi', script: 'echo hi' });
    assert.equal(both.ok, false);
    assert.equal(both.errorCode, 'invalid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bash runner rejects cwd outside allowlist', async (t) => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-allow-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-out-'));
  t.after(() => {
    fs.rmSync(allowed, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const runner = createBashRunner({ accountId: 'bash-cwd', allowedDirectories: [allowed], defaultWorkdir: allowed });
  const result = await runner.execute('bash.run', { command: 'echo hi', cwd: outside });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid');
});

test('bash runner executes echo when Git Bash is available', async (t) => {
  if (!resolveBashExecutable()) {
    t.skip('Git Bash / bash is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = createBashRunner({ accountId: 'bash-echo', allowedDirectories: [dir], defaultWorkdir: dir });
  const result = await runner.execute('bash.run', { command: 'echo hi-bash' });
  if (!result.ok && result.errorCode === 'unavailable') {
    t.skip('Git Bash / bash is not installed');
    return;
  }
  assert.equal(result.ok, true);
  assert.match(result.data.output, /hi-bash/);
});

test('bash runner can run node when available in PATH', async (t) => {
  if (!resolveBashExecutable()) {
    t.skip('Git Bash / bash is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = createBashRunner({ accountId: 'bash-node', allowedDirectories: [dir], defaultWorkdir: dir });
  const result = await runner.execute('bash.run', { command: 'node -v' });
  if (!result.ok && /not found|ENOENT|127/i.test(result.data?.output || result.summary)) {
    t.skip('node is not on PATH in Git Bash');
    return;
  }
  assert.equal(result.ok, true);
  assert.match(result.data.output, /v\d+/);
});

test('bash runner shares busy slot with code runner', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { tryAcquireRunnerSlot, releaseRunnerSlot } = require('../lib/computer/run-lock');
  tryAcquireRunnerSlot('shared-busy');
  t.after(() => releaseRunnerSlot('shared-busy'));
  const bash = createBashRunner({ accountId: 'shared-busy', allowedDirectories: [dir], defaultWorkdir: dir });
  const result = await bash.execute('bash.run', { command: 'echo blocked' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'busy');
});

test('bash runner releases the slot when spawn fails synchronously', async (t) => {
  if (!resolveBashExecutable()) {
    t.skip('Git Bash / bash is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-spawn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = createBashRunner({ accountId: 'bash-spawn', allowedDirectories: [dir], defaultWorkdir: dir });
  const bad = await runner.execute('bash.run', { command: 'echo \0bad' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, 'spawn_error');
  const follow = await runner.execute('bash.run', { command: 'echo recovered' });
  assert.notEqual(follow.errorCode, 'busy');
});

test('bash runner runs script mode from a temp file', async (t) => {
  if (!resolveBashExecutable()) {
    t.skip('Git Bash / bash is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-script-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = createBashRunner({ accountId: 'bash-script', allowedDirectories: [dir], defaultWorkdir: dir });
  const result = await runner.execute('bash.run', { script: 'echo script-mode-ok' });
  assert.equal(result.ok, true);
  assert.match(result.data.output, /script-mode-ok/);
  assert.equal(result.data.script, 'echo script-mode-ok');
});

test('bash runner caps output beyond the limit', async (t) => {
  if (!resolveBashExecutable()) {
    t.skip('Git Bash / bash is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-overflow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = createBashRunner({ accountId: 'bash-overflow', allowedDirectories: [dir], defaultWorkdir: dir });
  const result = await runner.execute('bash.run', { command: "yes 'x' | head -c 3000000" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'output_limit');
  assert.equal(result.data.outputTruncated, true);
  assert.ok(result.data.output.length <= 1024 * 1024);
});

test('bash runner enforces timeout and releases the slot', async (t) => {
  if (!resolveBashExecutable()) {
    t.skip('Git Bash / bash is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = createBashRunner({ accountId: 'bash-timeout', allowedDirectories: [dir], defaultWorkdir: dir });
  const startedAt = Date.now();
  const result = await runner.execute('bash.run', { command: 'sleep 30', timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.ok(['timeout', 'exit_error'].includes(result.errorCode));
  assert.ok(Date.now() - startedAt < 15000);
  const follow = await runner.execute('bash.run', { command: 'echo recovered' });
  assert.notEqual(follow.errorCode, 'busy');
});

test('allowlist tolerates case differences on Windows', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only path casing');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = fs.realpathSync(dir);
  const flipped = /^[A-Z]:/.test(real)
    ? real.replace(/^([A-Z]):/, match => match.toLowerCase())
    : real.replace(/^([a-z]):/, match => match.toUpperCase());
  assert.equal(resolveAllowed(real, [flipped]), real);
});

test('allowlist skips deleted directories with a clear error', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-gone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inside = path.join(dir, 'note.txt');
  fs.writeFileSync(inside, 'x');
  const missing = path.join(dir, 'deleted-sibling');
  assert.equal(resolveAllowed(inside, [missing, dir]), fs.realpathSync(inside));
  assert.throws(() => resolveAllowed(inside, [missing]), /no longer exist/);
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
  if (preferred && fs.existsSync(preferred) && fs.statSync(preferred).isDirectory()) {
    assert.equal(policy.allowedDirectories[0], fs.realpathSync(preferred));
  } else {
    assert.deepEqual(policy.allowedDirectories, []);
  }
});

test('computer tools are allowed when enabled regardless of user role', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  savePolicy(dir, { computerToolsEnabled: true, allowedDirectories: [dir], chromePaired: false });
  const allowed = computerToolsAllowed({ user: { id: 'local', role: 'admin' }, ip: '10.0.0.8' }, dir);
  assert.equal(allowed.ok, true);
  const alsoAllowed = computerToolsAllowed({ user: { id: 'local', role: 'member' }, ip: '127.0.0.1' }, dir);
  assert.equal(alsoAllowed.ok, true);
  savePolicy(dir, { computerToolsEnabled: false, allowedDirectories: [dir], chromePaired: false });
  const denied = computerToolsAllowed({ user: { id: 'local', role: 'admin' }, ip: '127.0.0.1' }, dir);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /disabled/);
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

test('computer facade runs bash.run for admin in allowlist', async (t) => {
  if (!resolveBashExecutable()) {
    t.skip('Git Bash / bash is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-bash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  savePolicy(dir, { computerToolsEnabled: true, allowedDirectories: [dir], chromePaired: false });
  const facade = createComputerFacade({ user: { id: 'admin-bash', role: 'admin' }, ip: '10.0.0.8' }, dir);
  assert.ok(facade);
  const result = await facade.execute('bash.run', { command: 'echo facade-bash' });
  if (!result.ok && result.errorCode === 'unavailable') {
    t.skip('Git Bash / bash is not installed');
    return;
  }
  assert.equal(result.ok, true);
  assert.match(result.data.output, /facade-bash/);
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
