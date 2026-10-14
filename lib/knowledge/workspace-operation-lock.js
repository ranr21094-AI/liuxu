// Maintenance blocks HTTP requests while switching file storage or taking a snapshot.
const operations = new Map();
function operationFor(dataDir) { return operations.get(dataDir) || ''; }
async function withWorkspaceOperation(dataDir, label, callback) {
  if (operations.has(dataDir)) throw Object.assign(new Error(`工作区正在${operations.get(dataDir)}`), { status: 409 });
  operations.set(dataDir, label);
  try { return await callback(); } finally { operations.delete(dataDir); }
}
module.exports = { operationFor, withWorkspaceOperation };
