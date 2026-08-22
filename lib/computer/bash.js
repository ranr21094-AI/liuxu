const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { toolResult } = require('../agent/tools');
const { resolveAllowed } = require('./policy');
const { tryAcquireRunnerSlot, releaseRunnerSlot } = require('./run-lock');
const { DEFAULT_TIMEOUT_MS, HARD_TIMEOUT_MS, MAX_OUTPUT, killTree, sanitizeRunnerEnv } = require('./code');

const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

function resolveBashExecutable() {
  if (process.platform === 'win32') {
    const envPath = typeof process.env.GIT_BASH_PATH === 'string' ? process.env.GIT_BASH_PATH.trim() : '';
    if (envPath && fs.existsSync(envPath)) return envPath;
    for (const candidate of GIT_BASH_CANDIDATES) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  return fs.existsSync('/bin/bash') ? '/bin/bash' : null;
}

function createBashRunner({ accountId, allowedDirectories = [], defaultWorkdir, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return {
    async execute(_name, args = {}) {
      if (!tryAcquireRunnerSlot(accountId)) {
        return toolResult({ ok: false, summary: 'Another script is already running', errorCode: 'busy' });
      }
      const command = String(args.command || '').trim();
      const script = String(args.script || '');
      const hasCommand = Boolean(command);
      const hasScript = Boolean(script.trim());
      if (hasCommand === hasScript) {
        releaseRunnerSlot(accountId);
        return toolResult({
          ok: false,
          summary: hasCommand && hasScript ? 'Provide either command or script, not both' : 'Command or script is required',
          errorCode: 'invalid',
        });
      }
      const bash = resolveBashExecutable();
      if (!bash) {
        releaseRunnerSlot(accountId);
        return toolResult({ ok: false, summary: 'Git Bash not found', errorCode: 'unavailable' });
      }
      let cwd;
      try {
        const target = args.cwd || defaultWorkdir || allowedDirectories[0];
        if (!target) throw new Error('Working directory is required');
        cwd = resolveAllowed(target, allowedDirectories);
      } catch (err) {
        releaseRunnerSlot(accountId);
        return toolResult({ ok: false, summary: err.message || 'Invalid working directory', errorCode: 'invalid' });
      }
      const timeout = Math.min(Number(args.timeoutMs) || timeoutMs, HARD_TIMEOUT_MS);
      let tempDir = '';
      let argv;
      try {
        if (hasScript) {
          tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-log-bash-'));
          const file = path.join(tempDir, 'script.sh');
          fs.writeFileSync(file, script, 'utf8');
          argv = [file];
        } else {
          argv = ['-lc', command];
        }
      } catch (err) {
        releaseRunnerSlot(accountId);
        if (tempDir) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
        return toolResult({ ok: false, summary: err.message || 'Failed to prepare bash command', errorCode: 'invalid' });
      }
      const env = sanitizeRunnerEnv(process.env);
      return await new Promise((resolve) => {
        const child = childProcess.spawn(bash, argv, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
        });
        let output = Buffer.alloc(0);
        const append = (chunk) => {
          output = Buffer.concat([output, chunk]);
          if (output.length > MAX_OUTPUT) killTree(child);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const timer = setTimeout(() => killTree(child), timeout);
        child.on('close', (code) => {
          clearTimeout(timer);
          releaseRunnerSlot(accountId);
          if (tempDir) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          }
          const text = output.slice(0, MAX_OUTPUT).toString('utf8');
          resolve(toolResult({
            ok: code === 0,
            summary: code === 0 ? 'Command finished' : `Command exited with ${code}`,
            data: {
              output: text,
              cwd,
              ...(hasCommand ? { command } : { script }),
              risk: 'Bash execution is not a sandbox.',
            },
            evidence: [{ type: 'bash', ...(hasCommand ? { command } : {}) }],
            errorCode: code === 0 ? '' : 'exit_error',
          }));
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          releaseRunnerSlot(accountId);
          if (tempDir) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          }
          resolve(toolResult({ ok: false, summary: err.message, errorCode: 'spawn_error' }));
        });
      });
    },
  };
}

module.exports = {
  createBashRunner,
  resolveBashExecutable,
  GIT_BASH_CANDIDATES,
};
