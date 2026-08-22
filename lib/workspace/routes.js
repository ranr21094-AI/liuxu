const multer = require('multer');
const { exportWorkspace, restoreWorkspace } = require('./zip');
const { ensureLogsMigrated } = require('../knowledge/migrate-logs');
const { invalidateKnowledgeCache } = require('../knowledge/routes');
const { hasActiveAgentRuns } = require('../agent/active-runs');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024, fields: 4, fieldNestingDepth: 0 },
});

function registerWorkspaceRoutes(app, { db, hasDiaryAccess, rejectLockedDiary }) {
  app.get('/api/workspace/export', async (req, res) => {
    try {
      if (!hasDiaryAccess(req)) return rejectLockedDiary(res);
      const buffer = await exportWorkspace(db);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename=work-log-workspace.zip');
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/workspace/restore', (req, res) => {
    const contentType = String(req.headers['content-type'] || '');
    const mode = req.query.mode === 'merge' ? 'merge' : 'replace';
    if (contentType.includes('application/json')) {
      if (!hasDiaryAccess(req)) return rejectLockedDiary(res);
      if (hasActiveAgentRuns(db.dataDir)) return res.status(409).json({ error: 'Agent run in progress — stop it before restoring' });
      const result = db.restore(req.body, mode);
      if (result.error) return res.status(400).json(result);
      invalidateKnowledgeCache(db.dataDir);
      ensureLogsMigrated(db);
      invalidateKnowledgeCache(db.dataDir);
      return res.json(result);
    }
    upload.single('archive')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!hasDiaryAccess(req)) return rejectLockedDiary(res);
      if (hasActiveAgentRuns(db.dataDir)) return res.status(409).json({ error: 'Agent run in progress — stop it before restoring' });
      try {
        const buffer = req.file?.buffer;
        if (!buffer) return res.status(400).json({ error: 'ZIP archive is required' });
        const result = await restoreWorkspace(db, buffer, mode);
        if (result.error) return res.status(400).json(result);
        invalidateKnowledgeCache(db.dataDir);
        ensureLogsMigrated(db);
        invalidateKnowledgeCache(db.dataDir);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  });
}

module.exports = { registerWorkspaceRoutes };
