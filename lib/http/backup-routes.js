const { businessDateString } = require('../../business-date');
const { ensureLogsMigrated } = require('../knowledge/migrate-logs');
const { invalidateKnowledgeCache } = require('../knowledge/routes');

function registerBackupRoutes(app, {
  db,
  hasDiaryAccess,
  rejectLockedDiary,
  restoreRequiresDiaryAccess,
}) {
  app.get('/api/backup', (req, res) => {
    try {
      if (restoreRequiresDiaryAccess(req) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
      const data = db.backup();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=work-log-backup-${businessDateString()}.json`);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/restore', (req, res) => {
    try {
      if (restoreRequiresDiaryAccess(req) && !hasDiaryAccess(req)) return rejectLockedDiary(res);
      const mode = req.query.mode === 'merge' ? 'merge' : 'replace';
      const result = db.restore(req.body, mode);
      if (result.error) return res.status(400).json(result);
      invalidateKnowledgeCache(db.dataDir);
      ensureLogsMigrated(db);
      invalidateKnowledgeCache(db.dataDir);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerBackupRoutes };
