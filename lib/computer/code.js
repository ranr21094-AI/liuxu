const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { toolResult } = require('../agent/tools');
const { tryAcquireRunnerSlot, releaseRunnerSlot } = require('./run-lock');

const DEFAULT_TIMEOUT_MS = 60000;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT = 1024 * 1024;
const KILL_GRACE_MS = 8000;

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      const attempt = () => childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      const first = attempt();
      if (first.status !== 0) attempt();
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
        let child;
        let timer;
        let killGrace;
        let settled = false;
        let overflowed = false;
        let output = Buffer.alloc(0);
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(killGrace);
          releaseRunnerSlot(accountId);
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
          resolve(result);
        };
        const append = (chunk) => {
          if (overflowed) return;
          output = Buffer.concat([output, chunk]);
          if (output.length >= MAX_OUTPUT) {
            output = output.slice(0, MAX_OUTPUT);
            overflowed = true;
            killTree(child);
          }
        };
        try {
          child = childProcess.spawn(command.cmd, command.argv, {
            cwd: workdir || dir,
            env,
            shell: false,
            windowsHide: true,
          });
        } catch (err) {
          settle(toolResult({ ok: false, summary: err.message || 'Failed to start script', errorCode: 'spawn_error' }));
          return;
        }
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        timer = setTimeout(() => {
          killTree(child);
          killGrace = setTimeout(() => settle(toolResult({
            ok: false,
            summary: `Script timed out after ${timeout}ms`,
            data: {
              language,
              output: output.toString('utf8'),
              cwd: workdir || dir,
              ...(overflowed ? { outputTruncated: true } : {}),
              risk: 'Windows native execution is not a sandbox.',
            },
            errorCode: 'timeout',
          })), KILL_GRACE_MS);
        }, timeout);
        child.on('close', (code) => {
          settle(toolResult({
            ok: code === 0 && !overflowed,
            summary: overflowed
              ? 'Script killed after exceeding the output limit'
              : (code === 0 ? 'Script finished' : `Script exited with ${code}`),
            data: {
              language,
              output: output.toString('utf8'),
              cwd: workdir || dir,
              ...(overflowed ? { outputTruncated: true } : {}),
              risk: 'Windows native execution is not a sandbox.',
            },
            evidence: [{ type: 'code', language }],
            errorCode: overflowed ? 'output_limit' : (code === 0 ? '' : 'exit_error'),
          }));
        });
        child.on('error', (err) => {
          settle(toolResult({ ok: false, summary: err.message, errorCode: 'spawn_error' }));
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
  KILL_GRACE_MS,
  killTree,
  sanitizeRunnerEnv,
};
