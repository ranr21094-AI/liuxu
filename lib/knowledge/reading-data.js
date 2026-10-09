const START = '<!-- liuxu-reading:start -->';
const END = '<!-- liuxu-reading:end -->';
const MAX_ENTRIES = 2000;
function normalizeReadingData(input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) throw new Error('阅读数据格式或条目数量无效');
  const ids = new Set();
  const entries = input.entries.map(item => {
    if (!item || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) throw new Error('阅读条目标识无效');
    ids.add(item.id);
    if (!['bookmark', 'highlight'].includes(item.type)) throw new Error('阅读条目类型无效');
    if (typeof item.anchor !== 'string' || !item.anchor || item.anchor.length > 4096) throw new Error('阅读位置无效');
    if (typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint)) throw new Error('文件指纹无效');
    for (const [key, limit] of [['quote', 10000], ['note', 10000], ['label', 300]]) {
      if (item[key] != null && (typeof item[key] !== 'string' || item[key].length > limit)) throw new Error('摘录或想法过长');
    }
    return { id: item.id, type: item.type, anchor: item.anchor, fingerprint: item.fingerprint, quote: item.quote || '', note: item.note || '', label: item.label || '' };
  });
  if (Buffer.byteLength(JSON.stringify(entries)) > 2 * 1024 * 1024) throw new Error('阅读数据超过大小限制');
  return { schemaVersion: 1, entries };
}
function readingNote(content, parentId, entries) {
  const quote = value => String(value).replaceAll(START, '&lt;!-- liuxu-reading:start --&gt;').replaceAll(END, '&lt;!-- liuxu-reading:end --&gt;').replace(/\r/g, '').split('\n').map(line => `> ${line}`).join('\n');
  const text = entries.filter(item => item.type === 'highlight').map(item => {
    const url = `#knowledge/${encodeURIComponent(parentId)}?reading=${encodeURIComponent(item.id)}`;
    return `${quote(item.quote)}\n\n[返回原文 · ${String(item.label || '摘录').replace(/[\[\]<>]/g, '')}](${url})${item.note ? `\n\n${quote(item.note)}` : ''}`;
  }).join('\n\n---\n\n');
  const block = `${START}\n## 阅读摘录\n\n${text}\n${END}`;
  const start = content.indexOf(START), end = content.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new Error('自动摘录区标记不完整，请先修复批注笔记');
  return start < 0 ? `${content}${content ? '\n\n' : ''}${block}` : content.slice(0, start) + block + content.slice(end + END.length);
}
module.exports = { normalizeReadingData, readingNote };
