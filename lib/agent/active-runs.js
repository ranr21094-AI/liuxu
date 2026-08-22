const fs = require('fs');
const path = require('path');

const ACTIVE_RUN_STATUSES = new Set([
  'queued', 'running', 'waiting_approval', 'waiting_client_tool', 'waiting_user',
]);

function hasActiveAgentRuns(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-runs.json'), 'utf8'));
    return (Array.isArray(raw.runs) ? raw.runs : []).some(run => ACTIVE_RUN_STATUSES.has(run?.status));
  } catch {
    return false;
  }
}

module.exports = { hasActiveAgentRuns };
