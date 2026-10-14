const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { recordName, digest, relativePath } = require('../knowledge/file-workspace');

async function prepareFileWorkspaceMerge(archive, documents) {
  // Put each imported tree under its own directory. This preserves relative assets
  // while guaranteeing that a same-named existing file is never overwritten.
  const prefix = `导入-${crypto.randomUUID().slice(0, 8)}`;
  const ids = new Map(documents.map(doc => [doc.id, `${doc.sourceType}:${crypto.randomUUID().replace(/-/g, '')}`]));
  const remapPath = value => value.startsWith('.liuxu/trash/') ? `.liuxu/trash/${prefix}/${value.slice(13)}`
    : value.startsWith('.archive/') ? `.archive/${prefix}/${value.slice(9)}` : `${prefix}/${value}`;
  const bytesFor = async value => typeof value === 'string' ? fs.readFile(value) : value;
  const rewriteLinks = text => text.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g,
    (raw, label, target) => ids.has(target) ? `[[${label}|${ids.get(target)}]]` : raw)
    .replace(/#knowledge\/((?:note|file)(?::|%3A)[a-zA-Z0-9_-]+)/gi, (raw, encoded) => {
      const id = decodeURIComponent(encoded); return ids.has(id) ? `#knowledge/${encodeURIComponent(ids.get(id))}` : raw;
    });
  const records = [];
  for (const [relative, value] of archive.knowledgeFolder) {
    if (/^\.liuxu\/documents\/[a-f0-9-]{36}\.json$/.test(relative)) records.push(JSON.parse((await bytesFor(value)).toString('utf8')));
  }
  for (const record of records) if (!ids.has(record.id)) ids.set(record.id, `${record.sourceType}:${crypto.randomUUID().replace(/-/g, '')}`);
  const tree = new Map();
  for (const [relative, value] of archive.knowledgeFolder) {
    if (relative.startsWith('.liuxu/')) {
      if (relative.startsWith('.liuxu/trash/')) tree.set(remapPath(relative), value);
      else if (relative.startsWith('.liuxu/reading/')) {
        const reading = JSON.parse((await bytesFor(value)).toString('utf8'));
        const id = ids.get(reading.documentId);
        if (id) tree.set(`.liuxu/reading/${recordName(id)}`, Buffer.from(JSON.stringify({ ...reading, documentId: id })));
      }
      else if (/^\.liuxu\/(?:recovery|conflicts)\//.test(relative)) {
        const parts = relative.split('/');
        const target = `.liuxu/${parts[1]}/${prefix}/${parts.slice(2).join('/')}`;
        // Recovery copies remain recoverable artifacts, never executable journals.
        tree.set(target, value);
      }
      continue;
    }
    relativePath(relative);
    let bytes = value;
    if (relative.endsWith('.md')) bytes = Buffer.from(rewriteLinks((await bytesFor(value)).toString('utf8')).replace(/^liuxu_id:.*$/m, line => {
      const id = line.slice(line.indexOf(':') + 1).trim().replace(/^"|"$/g, '');
      return ids.has(id) ? `liuxu_id: "${ids.get(id)}"` : line;
    }));
    tree.set(remapPath(relative), bytes);
  }
  for (const record of records) {
    const id = ids.get(record.id) || `${record.sourceType}:${crypto.randomUUID().replace(/-/g, '')}`;
    const next = { ...record, id, relativePath: remapPath(record.relativePath),
      parentDocumentId: ids.get(record.parentDocumentId) || null };
    const value = tree.get(next.relativePath);
    if (value) next.fingerprint = digest(await bytesFor(value));
    tree.set(`.liuxu/documents/${recordName(id)}`, Buffer.from(JSON.stringify(next)));
  }
  archive.knowledgeFolder = tree;
  archive.fileWorkspaceIdMap = ids;
  archive.knowledgeDirectories = archive.knowledgeDirectories.filter(directory => !directory.startsWith('.liuxu')).map(remapPath);
  return documents.map(doc => {
    const relative = remapPath(doc.relativePath || doc.fileSync?.relativePath);
    const parts = relative.replace(/^\.archive\//, '').split('/'); parts.pop();
    const knowledgeBase = parts.shift() || ':root:';
    return { ...doc, id: ids.get(doc.id), parentDocumentId: ids.get(doc.parentDocumentId) || null,
      relativePath: relative, sourceRef: relative, content: rewriteLinks(doc.content || ''),
      knowledgeBase, folderPath: parts.join('/'), collectionPath: [knowledgeBase, ...parts].join('/'),
      fileSync: { ...doc.fileSync, relativePath: relative },
      fileMeta: doc.fileMeta ? { ...doc.fileMeta, storedName: relative } : null };
  });
}
module.exports = { prepareFileWorkspaceMerge };
