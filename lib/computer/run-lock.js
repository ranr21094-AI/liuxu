const runningByAccount = new Map();

function tryAcquireRunnerSlot(accountId) {
  const key = String(accountId || '');
  if (!key || runningByAccount.get(key)) return false;
  runningByAccount.set(key, true);
  return true;
}

function releaseRunnerSlot(accountId) {
  runningByAccount.delete(String(accountId || ''));
}

module.exports = {
  tryAcquireRunnerSlot,
  releaseRunnerSlot,
};
