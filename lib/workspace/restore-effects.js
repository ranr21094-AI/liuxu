const { ensureLogsMigrated } = require('../knowledge/migrate-logs');
const { invalidateKnowledgeCache } = require('../knowledge/routes');
const { invalidateAgentRuntime } = require('../agent/routes');
const { clearNoteBrowserState } = require('../computer/note-browser');
const { clearReadingPositionState } = require('../knowledge/reading-position-state');
const { getRemoteAccessService } = require('../remote/context');

function finalizeWorkspaceRestore(db, mode) {
  const dataDir = db.dataDir;
  if (mode === 'replace') {
    clearNoteBrowserState(dataDir);
    clearReadingPositionState(dataDir);
    getRemoteAccessService()?.clearSessions();
  }

  // Migration reads the restored database through the knowledge service.
  // Drop the previous service first, then drop the migration's cached view.
  invalidateKnowledgeCache(dataDir);
  ensureLogsMigrated(db);
  invalidateKnowledgeCache(dataDir);
  invalidateAgentRuntime(dataDir);
}

module.exports = { finalizeWorkspaceRestore };
