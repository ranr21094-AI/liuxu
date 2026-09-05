const fs = require('fs');
const path = require('path');

const ACTIVE_RUN_STATUSES = new Set([
  'queued', 'running', 'waiting_approval', 'waiting_client_tool', 'waiting_user',
]);

function sqliteHasActiveAgentRuns(db) {
  try {
    const sqlite = db.sqlite;
    if (!sqlite) return null;
    const placeholders = [...ACTIVE_RUN_STATUSES].map(() => '?').join(', ');
    const row = sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_runs WHERE status IN (${placeholders})
    `).get(...ACTIVE_RUN_STATUSES);
    return Number(row?.count) > 0;
  } catch {
    return null;
  }
}

// Legacy pre-SQLite layout; kept as a secondary signal so a not-yet-migrated
// data directory still blocks a destructive restore.
function legacyJsonHasActiveAgentRuns(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-runs.json'), 'utf8'));
    return (Array.isArray(raw.runs) ? raw.runs : []).some(run => ACTIVE_RUN_STATUSES.has(run?.status));
  } catch {
    return false;
  }
}

function hasActiveAgentRuns(db) {
  const dataDir = typeof db === 'string' ? db : db?.dataDir;
  if (typeof db !== 'string' && sqliteHasActiveAgentRuns(db) === true) return true;
  return legacyJsonHasActiveAgentRuns(dataDir);
}

module.exports = { hasActiveAgentRuns };
