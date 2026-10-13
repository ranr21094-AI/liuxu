const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const MAX_DEPTH = 9;
const MAX_LINES = 50000;
const DIFF_BUDGET_MS = 30;
const hash = snapshot => crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hashV2 = snapshot => hash(canonical(snapshot));

// Exact UTF-16 offsets into the original JS string. Line anchors retain every
// newline byte; unmatched regions use character prefix/suffix trimming.
function makePatch(before, after, budgetMs = DIFF_BUDGET_MS) {
  const deadline = performance.now() + budgetMs;
  const check = () => { if (performance.now() > deadline) throw new Error('diff budget exceeded'); };
  try {
    check();
    const split = text => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || [];
    const left = split(before), right = split(after);
    if (left.length + right.length > MAX_LINES) return null;
    const unique = lines => {
      const map = new Map();
      let offset = 0;
      for (const line of lines) {
        check();
        map.set(line, map.has(line) ? null : offset);
        offset += line.length;
      }
      return map;
    };
    const oldOffsets = unique(left), newOffsets = unique(right);
    const anchors = [];
    let last = -1;
    for (const line of right) {
      check();
      const oldOffset = oldOffsets.get(line), newOffset = newOffsets.get(line);
      if (oldOffset != null && newOffset != null && oldOffset > last) {
        anchors.push([oldOffset, newOffset, line.length]); last = oldOffset;
      }
    }
    anchors.push([before.length, after.length, 0]);
    let oldStart = 0, newStart = 0;
    const operations = [];
    for (const [oldEnd, newEnd, length] of anchors) {
      check();
      let prefix = 0;
      while (oldStart + prefix < oldEnd && newStart + prefix < newEnd
        && before[oldStart + prefix] === after[newStart + prefix]) { prefix++; if (prefix % 1024 === 0) check(); }
      let suffix = 0;
      while (oldEnd - suffix > oldStart + prefix && newEnd - suffix > newStart + prefix
        && before[oldEnd - suffix - 1] === after[newEnd - suffix - 1]) { suffix++; if (suffix % 1024 === 0) check(); }
      const remove = oldEnd - oldStart - prefix - suffix;
      const insert = after.slice(newStart + prefix, newEnd - suffix);
      if (remove || insert) operations.push([oldStart + prefix, remove, insert]);
      oldStart = oldEnd + length; newStart = newEnd + length;
    }
    check();
    return operations;
  } catch { return null; }
}

function applyPatch(content, operations) {
  if (!Array.isArray(operations)) throw new Error('历史版本差异格式无效');
  let cursor = 0;
  const parts = [];
  for (const op of operations) {
    if (!Array.isArray(op) || op.length !== 3) throw new Error('历史版本差异格式无效');
    const [start, remove, insert] = op;
    if (!Number.isInteger(start) || !Number.isInteger(remove) || start < cursor || remove < 0
      || start + remove > content.length || typeof insert !== 'string') throw new Error('历史版本差异范围无效');
    parts.push(content.slice(cursor, start), insert); cursor = start + remove;
  }
  parts.push(content.slice(cursor));
  return parts.join('');
}

function encode(snapshot, previous) {
  const v2 = Boolean(snapshot.snapshotKind);
  const checksum = v2 ? hashV2 : hash;
  const full = { storage_format: v2 ? 'full-v2' : 'full-v1', snapshot: JSON.stringify(snapshot), base_revision_id: null,
    delta_depth: 0, snapshot_hash: checksum(snapshot), base_hash: null, content_length: snapshot.content.length };
  if (!previous || previous.row.delta_depth >= MAX_DEPTH
    || (previous.snapshot.snapshotKind || 'note') !== (snapshot.snapshotKind || 'note')) return full;
  const patch = makePatch(previous.snapshot.content, snapshot.content);
  if (!patch) return full;
  const { content, ...attributes } = snapshot;
  const payload = JSON.stringify({ ...attributes, contentPatch: patch });
  const delta = { ...full, storage_format: v2 ? 'delta-v2' : 'delta-v1', snapshot: payload,
    base_revision_id: previous.row.id, delta_depth: previous.row.delta_depth + 1,
    base_hash: checksum(previous.snapshot) };
  // Compare serialized UTF-8 column values, including dependency/checksum overhead.
  const byteSize = record => Object.values(record).reduce((size, value) => size + (value == null ? 0 : Buffer.byteLength(String(value))), 0);
  return byteSize(delta) < byteSize(full) ? delta : full;
}

function decode(sqlite, documentId, row, visited = new Set()) {
  if (!row || String(row.document_id) !== String(documentId)) throw new Error('历史版本基准缺失');
  if (visited.has(row.id) || visited.size > MAX_DEPTH) throw new Error('历史版本差异链无效');
  visited.add(row.id);
  let payload;
  try { payload = JSON.parse(row.snapshot); } catch { throw new Error('历史版本数据损坏'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('历史版本数据损坏');
  let snapshot = payload;
  const v2 = ['full-v2', 'delta-v2'].includes(row.storage_format);
  const checksum = v2 ? hashV2 : hash;
  if (['delta-v1', 'delta-v2'].includes(row.storage_format)) {
    if (!Number.isInteger(row.base_revision_id) || row.base_revision_id >= row.id) throw new Error('历史版本基准无效');
    const baseRow = sqlite.prepare('SELECT * FROM knowledge_revisions WHERE id = ? AND document_id = ?').get(row.base_revision_id, documentId);
    const base = decode(sqlite, documentId, baseRow, visited);
    if (checksum(base) !== row.base_hash) throw new Error('历史版本基准校验失败');
    const { contentPatch, ...attributes } = payload;
    // Keep the canonical field order used by editableSnapshot/hash.
    snapshot = v2 ? { ...attributes, content: applyPatch(base.content, contentPatch) } : { title: attributes.title, content: applyPatch(base.content, contentPatch), tags: attributes.tags,
      knowledgeBase: attributes.knowledgeBase, folderPath: attributes.folderPath,
      documentDate: attributes.documentDate, documentRole: attributes.documentRole };
  } else if (!['legacy', 'full-v1', 'full-v2'].includes(row.storage_format)) throw new Error('不支持的历史版本格式');
  if (typeof snapshot.content !== 'string') throw new Error('历史版本正文无效');
  if (row.storage_format !== 'legacy' && (!row.snapshot_hash || checksum(snapshot) !== row.snapshot_hash
    || snapshot.content.length !== row.content_length)) throw new Error('历史版本完整性校验失败');
  return snapshot;
}

function preserveRestoredHistory(sqlite) {
  sqlite.prepare("INSERT INTO meta (key, value) VALUES ('manual_revision_cleanup_done', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
}

module.exports = { makePatch, applyPatch, encode, decode, hash, MAX_DEPTH, preserveRestoredHistory };
