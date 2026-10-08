// UI ordering metadata is deliberately independent of content versions/history.
let lastPinTime = 0;
function nextPinTime() { lastPinTime = Math.max(Date.now(), lastPinTime + 1); return new Date(lastPinTime).toISOString(); }
function pinValue(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : ''; }
function comparePins(a, b) { return pinValue(b.pinnedAt).localeCompare(pinValue(a.pinnedAt)); }
function normalDirectory(filters) {
  return !!filters.knowledgeBase && filters.folder !== undefined && filters.status !== 'archived'
    && !filters.search && !filters.tag && !filters.date && !filters.from && !filters.to && !filters.type;
}
module.exports = { nextPinTime, pinValue, comparePins, normalDirectory };
