const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { FileWorkspace, FORMAT, VERSION, digest, decodeMarkdown } = require('./file-workspace');
const { sanitizeSegment } = require('./folder-sync');
const { hasActiveAgentRuns } = require('../agent/active-runs');

const MARKER = '.knowledge-file-workspace.json';
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

async function verifiedCopy(source, target, entries = [], prefix = '') {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`备份不能经过符号链接：${prefix}`);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const name of await fs.readdir(source)) {
      if (prefix === 'data' && (name === '.schedule.lock' || name.endsWith('-wal') || name.endsWith('-shm'))) continue;
      await verifiedCopy(path.join(source, name), path.join(target, name), entries, [prefix, name].filter(Boolean).join('/'));
    }
  } else if (stat.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, require('node:fs').constants.COPYFILE_EXCL);
    const hashFile = async file => {
      const hash = crypto.createHash('sha256');
      for await (const chunk of require('node:fs').createReadStream(file)) hash.update(chunk);
      return hash.digest('hex');
    };
    const [original, copied] = await Promise.all([hashFile(source), hashFile(target)]);
    const after = await fs.stat(source);
    if (original !== copied || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error(`备份期间源文件发生变化：${prefix}`);
    entries.push({ path: prefix, bytes: stat.size, sha256: copied });
  }
  return entries;
}

async function preflightFileWorkspace(db, root) {
  if (hasActiveAgentRuns(db)) throw new Error('请先结束 Agent 运行，再迁移文件工作区');
  root = path.resolve(root);
  const data = path.resolve(db.dataDir);
  if (root === data || root.startsWith(`${data}${path.sep}`) || data.startsWith(`${root}${path.sep}`)) throw new Error('文件工作区与应用数据目录不能互相包含');
  const legacy = require('./documents').createKnowledgeService(db, { indexOnly: true, startFolderSync: false });
  try {
    const documents = legacy.nativeDocuments();
    const byPath = new Map();
    for (const document of documents) {
      const relative = document.fileSync?.relativePath;
      if (!relative) continue;
      if (!byPath.has(relative)) byPath.set(relative, []);
      byPath.get(relative).push(document.id);
    }
    const duplicatePaths = [...byPath.entries()].filter(([, ids]) => ids.length > 1)
      .map(([relativePath, ids]) => ({ relativePath, ids }));
    const report = { format: FORMAT, version: VERSION, rootPath: root, documents: documents.length, missing: [], divergent: [], duplicatePaths, errors: [] };
    if (await exists(root)) {
      const reader = new FileWorkspace({ root }); await reader.safe();
      for (const doc of documents) {
        const relative = doc.fileSync?.relativePath;
        if (!relative) { report.missing.push(doc.id); continue; }
        try {
          const data = await reader.readBytes(relative);
          if (doc.sourceType === 'note' && decodeMarkdown(data.bytes, relative).content !== doc.content) report.divergent.push(doc.id);
        } catch (error) { if (error.code === 'ENOENT') report.missing.push(doc.id); else report.errors.push({ id: doc.id, error: error.message }); }
      }
    } else report.missing = documents.map(doc => doc.id);
    return report;
  } finally { await legacy.folderSync.stop(); }
}

async function migrateFileWorkspace(db, { root, backupPath, userDataPath = '' }) {
  root = path.resolve(root);
  const report = await preflightFileWorkspace(db, root);
  if (report.errors.length) throw Object.assign(new Error('迁移预检失败'), { report });
  const statePath = path.join(db.dataDir, '.file-workspace-migration.json');
  let state;
  if (await exists(statePath)) {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (state.rootPath !== root) throw new Error('已有迁移任务使用其他根目录，请先处理该任务');
  } else {
    backupPath = path.resolve(backupPath || path.join(path.dirname(root), `liuxu-before-files-${Date.now()}`));
    const data = path.resolve(db.dataDir);
    if ([root, data].some(source => backupPath === source || backupPath.startsWith(`${source}${path.sep}`) || source.startsWith(`${backupPath}${path.sep}`))) throw new Error('迁移备份目录必须独立于应用数据与工作区');
    await fs.mkdir(backupPath, { recursive: false });
    await db.sqlite.backup(path.join(backupPath, 'schedule.db'));
    const entries = [];
    await verifiedCopy(data, path.join(backupPath, 'data'), entries, 'data');
    // The raw database file may lag its WAL. Install the consistent SQLite
    // snapshot into the data backup too, rather than relying on excluded WALs.
    const snapshotPath = path.join(backupPath, 'schedule.db');
    const snapshot = new (require('better-sqlite3'))(snapshotPath, { readonly: true });
    try { if (snapshot.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('迁移备份数据库校验失败'); }
    finally { snapshot.close(); }
    await fs.copyFile(snapshotPath, path.join(backupPath, 'data', 'schedule.db'));
    const databaseEntry = entries.find(entry => entry.path === 'data/schedule.db');
    if (databaseEntry) {
      const bytes = await fs.readFile(snapshotPath);
      databaseEntry.bytes = bytes.length; databaseEntry.sha256 = digest(bytes);
    }
    if (await exists(root)) await verifiedCopy(root, path.join(backupPath, 'knowledge-folder'), entries, 'knowledge-folder');
    if (userDataPath) await verifiedCopy(path.resolve(userDataPath), path.join(backupPath, 'user-data'), entries, 'user-data');
    if (process.env.AI_SECRETS_KEY_FILE && await exists(process.env.AI_SECRETS_KEY_FILE)) {
      await verifiedCopy(path.resolve(process.env.AI_SECRETS_KEY_FILE), path.join(backupPath, 'secrets', 'ai-secrets.key'), entries, 'secrets/ai-secrets.key');
    }
    await fs.writeFile(path.join(backupPath, 'backup-checksums.json'), JSON.stringify(entries, null, 2), { flag: 'wx', mode: 0o600 });
    state = { format: FORMAT, version: VERSION, rootPath: root, backupPath, completed: [], conflicts: [], startedAt: new Date().toISOString() };
    await writeState(statePath, state);
  }
  await fs.mkdir(root, { recursive: true });
  const workspace = await new FileWorkspace({ root }).open();
  const legacy = require('./documents').createKnowledgeService(db, { indexOnly: true, startFolderSync: false });
  try {
    const documents = legacy.nativeDocuments();
    state.resolvedDuplicates ||= [];
    const pathGroups = new Map();
    for (const document of documents) {
      const relative = document.fileSync?.relativePath;
      if (!relative) continue;
      if (!pathGroups.has(relative)) pathGroups.set(relative, []);
      pathGroups.get(relative).push(document);
    }
    let manifest = {};
    try {
      const manifestPath = await workspace.safe('.liuxu/manifest.json');
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')).documents || {};
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const archivedDuplicates = new Set();
    const archiveDuplicate = async (document, originalPath) => {
      const filename = path.basename(originalPath);
      const archivedPath = `.archive/migration-duplicates/${sanitizeSegment(document.id)}/${sanitizeSegment(filename)}`;
      let bytes;
      if (document.sourceType === 'file') {
        const storedName = String(document.fileMeta?.storedName || '');
        if (!storedName || path.basename(storedName) !== storedName) throw new Error(`旧附件路径无效：${document.id}`);
        const source = path.join(db.dataDir, 'knowledge-files', storedName);
        const stat = await fs.lstat(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 250 * 1024 * 1024) throw new Error(`旧附件不能安全恢复：${document.id}`);
        bytes = await fs.readFile(source);
        if (document.fileMeta?.sha256 && digest(bytes) !== document.fileMeta.sha256) throw new Error(`旧附件校验失败：${document.id}`);
      } else bytes = Buffer.from(String(document.content || ''));
      let existing;
      try { existing = await workspace.readBytes(archivedPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing && digest(existing.bytes) !== digest(bytes)) throw new Error(`迁移归档路径已有不同内容：${archivedPath}`);
      if (!existing) await workspace.atomic(archivedPath, bytes);
      const fingerprint = digest(bytes);
      const current = workspace.records.get(document.id);
      const next = { ...(current || {}), id: document.id, relativePath: archivedPath,
        sourceType: document.sourceType, version: Math.max(1, current?.version || document.version || 1),
        fingerprint, status: 'archived', title: document.title || '', tags: document.tags || [],
        documentDate: document.documentDate || '', documentRole: document.documentRole || 'normal',
        parentDocumentId: document.parentDocumentId || null, createdAt: document.createdAt, updatedAt: document.updatedAt };
      if (current?.relativePath !== archivedPath || current?.status !== 'archived' || current?.fingerprint !== fingerprint) {
        await workspace.persist({ ...next, version: current ? current.version + 1 : next.version });
      }
      document.fileSync = { ...(document.fileSync || {}), relativePath: archivedPath };
      legacy.cacheFileDocument(document);
      archivedDuplicates.add(document.id);
      if (!state.resolvedDuplicates.some(item => item.id === document.id && item.originalPath === originalPath)) {
        state.resolvedDuplicates.push({ id: document.id, originalPath, archivedPath, sourceType: document.sourceType });
      }
    };
    for (const [relative, group] of pathGroups) {
      if (group.length < 2) continue;
      const manifestMatches = group.filter(document => manifest[document.id]?.relativePath === relative);
      const existingRecords = group.filter(document => workspace.records.get(document.id)?.relativePath === relative);
      // A prior migration attempt may already have established the identity
      // for this path. Prefer that signal only when the old manifest itself is
      // ambiguous; otherwise the old manifest remains authoritative.
      const primary = manifestMatches.length === 1 ? manifestMatches[0]
        : existingRecords.length === 1 ? existingRecords[0]
          : group[0];
      for (const duplicate of group) if (duplicate.id !== primary.id) await archiveDuplicate(duplicate, relative);
    }
    // Repair a sidecar if a previous run stopped after updating its database path.
    for (const document of documents) {
      const relative = document.fileSync?.relativePath || '';
      if (!relative.startsWith('.archive/migration-duplicates/') || archivedDuplicates.has(document.id)) continue;
      const current = workspace.records.get(document.id);
      if (!current || current.relativePath === relative && current.status === 'archived') continue;
      const bytes = await workspace.readBytes(relative);
      await workspace.persist({ ...current, relativePath: relative, fingerprint: bytes.fingerprint,
        status: 'archived', version: current.version + 1 });
    }
    if (state.resolvedDuplicates.length) await writeState(statePath, state);
    for (const doc of documents.sort((a, b) => Number(Boolean(a.parentDocumentId)) - Number(Boolean(b.parentDocumentId)))) {
      if (state.completed.includes(doc.id)) continue;
      let record = workspace.records.get(doc.id);
      if (record) {
        const file = await workspace.read(doc.id);
        if (!file) throw new Error(`已迁移文件缺失：${doc.id}`);
      } else {
        let relative = doc.fileSync?.relativePath;
        let disk;
        if (relative) {
          try { disk = await workspace.readBytes(relative); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (disk) {
          if ([...workspace.records.values()].some(item => item.relativePath === relative)) throw new Error(`多个文档映射到同一路径：${relative}`);
          record = { id: doc.id, relativePath: relative, sourceType: doc.sourceType, version: Math.max(1, doc.version || 1),
            fingerprint: disk.fingerprint, status: relative.startsWith('.archive/') ? 'archived' : 'active',
            title: doc.title || '', tags: doc.tags || [], documentDate: doc.documentDate || '',
            documentRole: doc.documentRole || 'normal', parentDocumentId: doc.parentDocumentId || null,
            pinnedAt: doc.pinnedAt || '', createdAt: doc.createdAt, updatedAt: doc.updatedAt };
          await workspace.persist(record);
          if (doc.sourceType === 'note' && decodeMarkdown(disk.bytes, relative).content !== doc.content) {
            const name = `${sanitizeSegment(doc.id)}-database.md`;
            await workspace.atomic(`.liuxu/recovery/${name}`, Buffer.from(String(doc.content || '')));
            state.conflicts.push({ id: doc.id, diskPath: relative, recoveryPath: `.liuxu/recovery/${name}` });
          }
        } else {
          let bytes;
          if (doc.sourceType === 'file') {
            const storedName = String(doc.fileMeta?.storedName || '');
            if (!storedName || path.basename(storedName) !== storedName) throw new Error(`旧附件路径无效：${doc.id}`);
            const source = path.join(db.dataDir, 'knowledge-files', storedName);
            if ((await fs.lstat(source)).isSymbolicLink()) throw new Error('附件不能经过符号链接');
            bytes = await fs.readFile(source);
            if (doc.fileMeta?.sha256 && digest(bytes) !== doc.fileMeta.sha256) throw new Error(`旧附件校验失败：${doc.id}`);
          } else bytes = Buffer.from(String(doc.content || ''));
          const filename = doc.sourceType === 'file' ? doc.fileMeta.filename : `${sanitizeSegment(doc.title || '未命名笔记')}.md`;
          relative ||= [doc.status === 'archived' ? '.archive' : '', doc.knowledgeBase, doc.folderPath, filename].filter(Boolean).join('/');
          const saved = await workspace.create({ ...doc, id: doc.id, relativePath: relative, bytes, sourceType: doc.sourceType });
          record = workspace.records.get(saved.document.id);
          await workspace.persist({ ...record, version: doc.version || 1, createdAt: doc.createdAt || record.createdAt,
            updatedAt: doc.updatedAt || record.updatedAt, status: doc.status === 'archived' ? 'archived' : 'active' });
        }
      }
      state.completed.push(doc.id); await writeState(statePath, state);
    }
    await workspace.scan();
    await workspace.json('.liuxu/storage.json', { format: FORMAT, version: VERSION });
    state.finishedAt = new Date().toISOString();
    require('./revision-storage').preserveRestoredHistory(db.sqlite);
    await workspace.json('.liuxu/migration-report.json', state);
    await fs.writeFile(path.join(state.backupPath, 'migration-report.json'), JSON.stringify(state, null, 2));
    // Switch only after all originals and identity records have been verified.
    await writeState(path.join(db.dataDir, MARKER), { format: FORMAT, version: VERSION, rootPath: root });
    await writeState(path.join(db.dataDir, '.knowledge-folder.json'), { version: 2, enabled: true, rootPath: root, storage: FORMAT });
    await writeState(statePath, state);
    return state;
  } finally { await workspace.close(); await legacy.folderSync.stop(); }
}
async function writeState(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
}
module.exports = { preflightFileWorkspace, migrateFileWorkspace, verifiedCopy, MARKER };
