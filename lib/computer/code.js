const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { toolResult } = require('../agent/tools');
const { tryAcquireRunnerSlot, releaseRunnerSlot } = require('./run-lock');

const DEFAULT_TIMEOUT_MS = 60000;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT = 1024 * 1024;

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {}
}

function sanitizeRunnerEnv(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/key|token|secret|password|auth/i.test(key)) delete env[key];
  }
  return env;
}

function createCodeRunner({ accountId, workdir, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return {
    async execute(_name, args = {}) {
      if (!tryAcquireRunnerSlot(accountId)) {
        return toolResult({ ok: false, summary: 'Another script is already running', errorCode: 'busy' });
      }
      const language = args.language === 'python' ? 'python' : 'powershell';
      const script = String(args.script || '');
      if (!script.trim()) {
        releaseRunnerSlot(accountId);
        return toolResult({ ok: false, summary: 'Script is required', errorCode: 'invalid' });
      }
      const timeout = Math.min(Number(args.timeoutMs) || timeoutMs, HARD_TIMEOUT_MS);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-log-code-'));
      const file = path.join(dir, language === 'python' ? 'script.py' : 'script.ps1');
      fs.writeFileSync(file, script, 'utf8');
      const command = language === 'python'
        ? { cmd: 'python', argv: ['-I', file] }
        : { cmd: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-File', file] };
      const env = sanitizeRunnerEnv(process.env);
      return await new Promise((resolve) => {
        const child = childProcess.spawn(command.cmd, command.argv, {
          cwd: workdir || dir,
          env,
          shell: false,
          windowsHide: true,
        });
        let output = Buffer.alloc(0);
        const append = (chunk) => {
          output = Buffer.concat([output, chunk]);
          if (output.length > MAX_OUTPUT) {
            killTree(child);
          }
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const timer = setTimeout(() => killTree(child), timeout);
        child.on('close', (code) => {
          clearTimeout(timer);
          releaseRunnerSlot(accountId);
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
          const text = output.slice(0, MAX_OUTPUT).toString('utf8');
          resolve(toolResult({
            ok: code === 0,
            summary: code === 0 ? 'Script finished' : `Script exited with ${code}`,
            data: { language, output: text, cwd: workdir || dir, risk: 'Windows native execution is not a sandbox.' },
            evidence: [{ type: 'code', language }],
            errorCode: code === 0 ? '' : 'exit_error',
          }));
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          releaseRunnerSlot(accountId);
          resolve(toolResult({ ok: false, summary: err.message, errorCode: 'spawn_error' }));
        });
      });
    },
  };
}

module.exports = {
  createCodeRunner,
  DEFAULT_TIMEOUT_MS,
  HARD_TIMEOUT_MS,
  MAX_OUTPUT,
  killTree,
  sanitizeRunnerEnv,
};
