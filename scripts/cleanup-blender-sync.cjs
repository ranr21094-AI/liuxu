// Explicit, offline maintenance only. Never run from application startup.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { atomicWriteJson } = require('../lib/util/json-file');
const PREFIX = 'Agent/设计/haibara-card/tools/Blender.app/';

async function cleanupBlenderSync({ dataDir, backupDir, apply = false }) {
  const configPath = path.join(dataDir, '.knowledge-folder.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (apply && config.enabled) throw new Error('Pause folder sync and quit LiuXu before cleanup');
  const root = fs.realpathSync(config.rootPath);
  const manifestPath = path.join(root, '.liuxu', 'manifest.json');
  if (fs.lstatSync(manifestPath).isSymbolicLink()
    || fs.realpathSync(manifestPath) !== path.join(root, '.liuxu', 'manifest.json')) {
    throw new Error('Unsafe sync manifest path');
  }
  const originalManifest = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(originalManifest);
  const sqlite = new Database(path.join(dataDir, 'schedule.db'), { readonly: !apply, fileMustExist: true });
  try {
    const rows = sqlite.prepare("SELECT id, body FROM knowledge_documents WHERE json_extract(body, '$.sourceType') = 'file'").all();
    const children = new Set(sqlite.prepare("SELECT json_extract(body, '$.parentDocumentId') parent FROM knowledge_documents").all().map(row => row.parent).filter(Boolean));
    const candidates = rows.map(row => ({ id: row.id, document: JSON.parse(row.body) }))
      .filter(({ document }) => String(document.fileSync?.relativePath || '').replace(/\\/g, '/').startsWith(PREFIX))
      .map(({ id, document }) => ({ id, title: document.title, relativePath: document.fileSync.relativePath }));
    const report = {
      prefix: PREFIX,
      remove: candidates.filter(row => !children.has(row.id)),
      retainedWithChildren: candidates.filter(row => children.has(row.id)),
      applied: false,
    };
    if (!apply) return report;
    if (!backupDir) throw new Error('An empty backup directory is required');
    fs.mkdirSync(backupDir, { recursive: false }); // Refuse to overwrite earlier backups.
    await sqlite.backup(path.join(backupDir, 'schedule.db'));
    fs.copyFileSync(configPath, path.join(backupDir, 'knowledge-folder.json'));
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), originalManifest);
    atomicWriteJson(path.join(backupDir, 'cleanup-plan.json'), report);
    sqlite.pragma('foreign_keys = ON');
    try {
      sqlite.transaction(() => {
        const remove = sqlite.prepare('DELETE FROM knowledge_documents WHERE id = ?');
        const removeTarget = sqlite.prepare('DELETE FROM knowledge_link_targets WHERE document_id = ?');
        const unresolve = sqlite.prepare('UPDATE knowledge_links SET target_document_id = NULL, resolved = 0 WHERE target_document_id = ?');
        const version = Number(sqlite.prepare('SELECT version FROM knowledge_index_state WHERE id = 1').get()?.version || 0) + 1;
        const change = sqlite.prepare("INSERT INTO knowledge_index_changes(version, document_id, operation) VALUES (?, ?, 'delete')");
        for (const row of report.remove) {
          unresolve.run(row.id);
          removeTarget.run(row.id);
          remove.run(row.id);
          change.run(version, row.id);
          delete manifest.documents[row.id];
        }
        if (report.remove.length) {
          sqlite.prepare('UPDATE knowledge_index_state SET version = ?, updated_at = ? WHERE id = 1').run(version, Date.now());
          // Force the link resolver to reconcile surviving incoming references.
          sqlite.prepare("UPDATE meta SET value = '0' WHERE key = 'knowledge_links_index_built'").run();
          manifest.updatedAt = new Date().toISOString();
          atomicWriteJson(manifestPath, manifest);
        }
      }).immediate();
    } catch (error) {
      // SQLite rolls back; restore the associated file if it was already replaced.
      atomicWriteJson(manifestPath, JSON.parse(originalManifest));
      throw error;
    }
    report.applied = true;
    report.backupDir = path.resolve(backupDir);
    atomicWriteJson(path.join(backupDir, 'cleanup-result.json'), report);
    return report;
  } finally { sqlite.close(); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--data-dir')) throw new Error('--data-dir is required');
  cleanupBlenderSync({ dataDir: path.resolve(value('--data-dir')), backupDir: args.includes('--backup-dir') ? path.resolve(value('--backup-dir')) : undefined, apply: args.includes('--apply') })
    .then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { cleanupBlenderSync, PREFIX };
