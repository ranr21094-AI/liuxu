function readingTime(sqlite, documentId, input) {
  const id = require('./reading-position-state').cleanDocumentId(documentId);
  if (!id) { const error = new Error('文档标识无效'); error.status = 400; throw error; }
  const total = () => sqlite.prepare('SELECT milliseconds FROM reading_time WHERE document_id=?').get(id)?.milliseconds || 0;
  if (!input) return { milliseconds: total() };
  const { sessionId, sequence, milliseconds } = input;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId || '') || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 365 * 86400000) {
    const error = new Error('阅读计时数据无效'); error.status = 400; throw error;
  }
  return sqlite.transaction(() => {
    const previous = sqlite.prepare('SELECT * FROM reading_time_sessions WHERE document_id=? AND session_id=?').get(id, sessionId);
    if (previous && sequence <= previous.sequence) return { milliseconds: total() };
    if (previous && milliseconds < previous.milliseconds) { const error = new Error('阅读计时不能倒退'); error.status = 409; throw error; }
    const delta = milliseconds - (previous?.milliseconds || 0);
    sqlite.prepare('INSERT INTO reading_time VALUES (?,?) ON CONFLICT(document_id) DO UPDATE SET milliseconds=milliseconds+excluded.milliseconds').run(id, delta);
    sqlite.prepare('INSERT INTO reading_time_sessions VALUES (?,?,?,?) ON CONFLICT(document_id,session_id) DO UPDATE SET sequence=excluded.sequence,milliseconds=excluded.milliseconds').run(id, sessionId, sequence, milliseconds);
    return { milliseconds: total() };
  })();
}
module.exports = { readingTime };
