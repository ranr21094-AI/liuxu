const { loadPolicy, savePolicy, computerToolsAllowed, markReauth } = require('./policy');
const { createFileTools } = require('./files');
const { createCodeRunner } = require('./code');
const { createBashRunner } = require('./bash');
const { createChromeBridge } = require('./chrome');

function createComputerFacade(req, dataDir, { fileReadMaxBytes } = {}) {
  const allowed = computerToolsAllowed(req, dataDir);
  if (!allowed.ok) return null;
  const files = createFileTools(allowed.policy, { fileReadMaxBytes });
  const code = createCodeRunner({ accountId: req.user.id, workdir: allowed.policy.allowedDirectories[0] });
  const bash = createBashRunner({
    accountId: req.user.id,
    allowedDirectories: allowed.policy.allowedDirectories,
    defaultWorkdir: allowed.policy.allowedDirectories[0],
  });
  const chrome = createChromeBridge(dataDir);
  return {
    async execute(name, args) {
      if (name === 'code.run') return code.execute(name, args);
      if (name === 'bash.run') return bash.execute(name, args);
      if (name.startsWith('file.')) return files.execute(name, args);
      if (name.startsWith('browser.')) {
        const requested = chrome.command(name, args);
        return requested.result || requested;
      }
      return { ok: false, summary: 'Unknown computer tool', data: null, evidence: [], errorCode: 'unknown_tool', retryable: false };
    },
  };
}

function registerComputerRoutes(app, { db, authStore, requireAdmin }) {
  app.get('/api/admin/agent-policy', requireAdmin, (_req, res) => {
    const dataDir = db.dataDir;
    const policy = loadPolicy(dataDir);
    res.json({
      computerToolsEnabled: policy.computerToolsEnabled,
      allowedDirectories: policy.allowedDirectories,
      chromePaired: policy.chromePaired,
    });
  });

  app.put('/api/admin/agent-policy', requireAdmin, (req, res) => {
    const dataDir = db.dataDir;
    try {
      const current = loadPolicy(dataDir);
      const next = savePolicy(dataDir, {
        ...current,
        computerToolsEnabled: req.body?.computerToolsEnabled === true,
        allowedDirectories: Array.isArray(req.body?.allowedDirectories) ? req.body.allowedDirectories.map(String) : current.allowedDirectories,
      });
      res.json({ computerToolsEnabled: next.computerToolsEnabled, allowedDirectories: next.allowedDirectories, chromePaired: next.chromePaired });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/auth/reauthenticate', (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = authStore.authenticate(req.user.username, password);
    if (!user) return res.status(401).json({ error: 'Password is incorrect' });
    markReauth(req.user.id);
    res.json({ ok: true, expiresInMs: 15 * 60 * 1000 });
  });

  app.post('/api/agent/chrome/pairing', requireAdmin, (_req, res) => {
    const dataDir = db.dataDir;
    const chrome = createChromeBridge(dataDir);
    res.json(chrome.startPairing());
  });

  app.post('/api/agent/chrome/pairing/confirm', requireAdmin, (req, res) => {
    const dataDir = db.dataDir;
    const chrome = createChromeBridge(dataDir);
    const result = chrome.confirmPairing(String(req.body?.pairingCode || ''));
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });
}

module.exports = { registerComputerRoutes, createComputerFacade };
