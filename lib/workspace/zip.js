const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { readJsonIfExists, atomicWriteJson } = require('../util/json-file');

function addDirToZip(zip, dir, prefix) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const dest = `${prefix}/${name}`.replace(/\\/g, '/');
    if (fs.statSync(full).isDirectory()) addDirToZip(zip, full, dest);
    else zip.file(dest, fs.readFileSync(full));
  }
}

function addFileToZip(zip, file, name) {
  if (fs.existsSync(file) && fs.statSync(file).isFile()) zip.file(name, fs.readFileSync(file));
}

async function exportWorkspace(db) {
  const zip = new JSZip();
  const backup = db.backup();
  zip.file('workspace.json', JSON.stringify({
    ...backup,
    format: 'workspace-zip',
    includesBinaries: true,
  }, null, 2));
  addDirToZip(zip, path.join(db.dataDir, 'uploads'), 'uploads');
  addDirToZip(zip, path.join(db.dataDir, 'knowledge-files'), 'knowledge-files');
  addDirToZip(zip, path.join(db.dataDir, 'agent-assets'), 'agent-assets');
  for (const name of ['agent-sessions.json', 'agent-runs.json', 'agent-memories.json']) {
    addFileToZip(zip, path.join(db.dataDir, name), name);
  }
  const saved = readJsonIfExists(path.join(db.dataDir, 'knowledge-documents.json'), {
    documents: [],
    nextNoteId: 1,
    nextFileId: 1,
  });
  const documents = Array.isArray(saved.documents) ? saved.documents : [];
  const nextNoteId = Number(saved.nextNoteId) > 0
    ? Number(saved.nextNoteId)
    : documents.reduce((max, item) => {
      const match = /^note:(\d+)$/.exec(item.id || '');
      return match ? Math.max(max, Number(match[1]) + 1) : max;
    }, 1);
  const nextFileId = Number(saved.nextFileId) > 0
    ? Number(saved.nextFileId)
    : documents.reduce((max, item) => {
      const match = /^file:(\d+)$/.exec(item.id || '');
      return match ? Math.max(max, Number(match[1]) + 1) : max;
    }, 1);
  zip.file('knowledge-documents.json', JSON.stringify({ documents, nextNoteId, nextFileId }, null, 2));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function restoreWorkspace(db, buffer, mode = 'replace') {
  const zip = await JSZip.loadAsync(buffer);
  const jsonFile = zip.file('workspace.json');
  if (!jsonFile) throw new Error('ZIP is missing workspace.json');
  const data = JSON.parse(await jsonFile.async('string'));
  const knowledgeFile = zip.file('knowledge-documents.json');
  let knowledgeStore = null;
  if (knowledgeFile) {
    knowledgeStore = JSON.parse(await knowledgeFile.async('string'));
    if (!knowledgeStore || !Array.isArray(knowledgeStore.documents)) {
      throw new Error('Invalid knowledge-documents.json');
    }
    for (const document of knowledgeStore.documents) {
      if (!document || typeof document.id !== 'string' || !['note', 'file'].includes(document.sourceType)) {
        throw new Error('Invalid knowledge document');
      }
      if (typeof document.content !== 'string' || document.content.length > 500000) {
        throw new Error('Knowledge document content is invalid');
      }
      const storedName = document.fileMeta?.storedName;
      if (storedName !== undefined && (!storedName || path.basename(storedName) !== storedName)) {
        throw new Error('Invalid knowledge file reference');
      }
      if (storedName) {
        const binary = zip.file(`knowledge-files/${storedName}`);
        if (!binary) throw new Error('Knowledge file attachment is missing');
        const bytes = await binary.async('nodebuffer');
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        if (document.fileMeta.sha256 && document.fileMeta.sha256 !== hash) throw new Error('Knowledge file checksum mismatch');
        if (document.fileMeta.bytes !== undefined && Number(document.fileMeta.bytes) !== bytes.length) throw new Error('Knowledge file size mismatch');
      }
    }
  }
  // Reject unsafe archive entries before changing any JSON state.
  for (const name of Object.keys(zip.files)) {
    const normalized = name.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error('Unsafe ZIP entry');
    }
  }
  const result = db.restore(data, mode);
  if (result.error) return result;

  async function extractDir(prefix, dest) {
    const files = Object.keys(zip.files).filter(name => name.startsWith(prefix) && !zip.files[name].dir);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of files) {
      const rel = name.slice(prefix.length).replace(/^\/+/, '');
      if (!rel || rel.includes('..')) continue;
      const target = path.resolve(dest, rel);
      if (!target.startsWith(path.resolve(dest) + path.sep) && target !== path.resolve(dest)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await zip.files[name].async('nodebuffer'));
    }
  }

  await extractDir('uploads/', path.join(db.dataDir, 'uploads'));
  await extractDir('knowledge-files/', path.join(db.dataDir, 'knowledge-files'));
  await extractDir('agent-assets/', path.join(db.dataDir, 'agent-assets'));
  if (knowledgeStore) {
    atomicWriteJson(path.join(db.dataDir, 'knowledge-documents.json'), knowledgeStore);
  }
  for (const name of ['agent-sessions.json', 'agent-runs.json', 'agent-memories.json']) {
    const entry = zip.file(name);
    if (entry) {
      const parsed = JSON.parse(await entry.async('string'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid ${name}`);
      atomicWriteJson(path.join(db.dataDir, name), parsed);
    }
  }
  return { ...result, format: 'workspace-zip', includesBinaries: true };
}

module.exports = { exportWorkspace, restoreWorkspace };
