const { businessDateString } = require('../../business-date');
const { hasActiveAgentRuns } = require('../agent/active-runs');
const { finalizeWorkspaceRestore } = require('../workspace/restore-effects');

function registerBackupRoutes(app, { db }) {
  app.get('/api/backup', (req, res) => {
    try {
      const data = db.backup();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=liuxu-backup-${businessDateString()}.json`);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/restore', (req, res) => {
    try {
      if (hasActiveAgentRuns(db)) return res.status(409).json({ error: 'Agent run in progress — stop it before restoring' });
      const mode = req.query.mode === 'merge' ? 'merge' : 'replace';
      const result = db.restore(req.body, mode);
      if (result.error) return res.status(400).json(result);
      finalizeWorkspaceRestore(db, mode);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerBackupRoutes };
