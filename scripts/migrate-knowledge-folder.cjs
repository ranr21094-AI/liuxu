#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : fallback;
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function assertIdle(dataDir) {
  const lock = path.join(dataDir, '.schedule.lock');
  if (fs.existsSync(lock)) {
    const pid = Number.parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
    if (isPidAlive(pid)) throw new Error(`留序仍在运行（进程 ${pid}）。请先让草稿保存完成并完全退出留序。`);
  }
  const sqlite = new Database(path.join(dataDir, 'schedule.db'), { readonly: true, fileMustExist: true });
  try {
    const active = sqlite.prepare(`SELECT COUNT(*) AS count FROM agent_runs
      WHERE COALESCE(json_extract(body, '$.status'), '') IN ('queued','running','waiting_approval','waiting_client_tool','waiting_user')`).get().count;
    if (Number(active) > 0) throw new Error(`仍有 ${active} 个 Agent 任务未结束，请先处理或取消后再迁移。`);
  } finally { sqlite.close(); }
}

function walk(root, relative = '', output = []) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (!relative && entry.name === '.schedule.lock') continue;
    const child = relative ? path.join(relative, entry.name) : entry.name;
    const full = path.join(root, child);
    if (entry.isSymbolicLink()) throw new Error(`备份不允许符号链接：${full}`);
    if (entry.isDirectory()) walk(root, child, output);
    else if (entry.isFile()) output.push({ path: child.split(path.sep).join('/'), bytes: fs.statSync(full).size, sha256: hashFile(full) });
  }
  return output;
}

function verifySqlite(file) {
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = sqlite.pragma('integrity_check', { simple: true });
    if (String(result).toLowerCase() !== 'ok') throw new Error(`数据库完整性检查失败：${result}`);
    sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_documents').get();
  } finally { sqlite.close(); }
}

function copyTree(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    filter: entry => path.basename(entry) !== '.schedule.lock',
  });
}

function createBackup({ dataDir, userDataDir, backupDir }) {
  if (fs.existsSync(backupDir)) throw new Error(`备份目录已存在：${backupDir}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const dataBackup = path.join(backupDir, 'data');
  copyTree(dataDir, dataBackup);
  for (const name of ['desktop-config.json', 'ai-secrets.key']) {
    const source = path.join(userDataDir, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backupDir, name), fs.constants.COPYFILE_EXCL);
  }
  verifySqlite(path.join(dataBackup, 'schedule.db'));
  const files = walk(backupDir);
  fs.writeFileSync(path.join(backupDir, 'backup-manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), dataDir, files }, null, 2));
  // Restore validation uses an isolated copy and opens the copied database.
  const validation = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-migration-restore-check-'));
  try {
    copyTree(dataBackup, path.join(validation, 'data'));
    verifySqlite(path.join(validation, 'data', 'schedule.db'));
    const copied = walk(path.join(validation, 'data'));
    const expected = files.filter(item => item.path.startsWith('data/')).map(item => ({ ...item, path: item.path.slice(5) }));
    if (JSON.stringify(copied) !== JSON.stringify(expected)) throw new Error('隔离恢复校验的文件清单或哈希不一致');
  } finally {
    fs.rmSync(validation, { recursive: true, force: true });
  }
  return { backupDir, dataBackup, files: files.length };
}

function restoreBackup(dataDir, dataBackup) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  copyTree(dataBackup, dataDir);
}

function main() {
  const userDataDir = argument('user-data', path.join(os.homedir(), 'Library', 'Application Support', 'work-log'));
  const dataDir = argument('data-dir', path.join(userDataDir, 'data'));
  const root = argument('root', path.join(os.homedir(), 'Documents', '留序知识库'));
  const backupDir = argument('backup-dir', path.join(os.homedir(), 'Documents', '留序迁移备份', `knowledge-folder-${stamp()}`));
  if (!fs.existsSync(path.join(dataDir, 'schedule.db'))) throw new Error(`找不到桌面数据库：${dataDir}`);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`目标目录不是空目录，未执行迁移：${root}`);
  assertIdle(dataDir);
  const backup = createBackup({ dataDir, userDataDir, backupDir });
  const stage = path.join(path.dirname(root), `.${path.basename(root)}.migrating-${Date.now()}-${process.pid}`);
  const rootPreviouslyExisted = fs.existsSync(root);
  let db;
  let knowledge;
  let report;
  let rootInstalled = false;
  try {
    process.env.DATA_DIR = dataDir;
    process.env.AI_SECRETS_KEY_FILE = path.join(userDataDir, 'ai-secrets.key');
    const { createDatabase } = require('../database.js');
    const { createKnowledgeService } = require('../lib/knowledge/documents');
    db = createDatabase(dataDir);
    knowledge = createKnowledgeService(db);
    const before = knowledge.nativeDocuments();
    report = knowledge.folderSync.migrateAll({ rootPath: stage });
    knowledge.folderSync.stop();
    if (report.documents !== before.length) throw new Error(`迁移数量不一致：数据库 ${before.length}，文件 ${report.documents}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, '.liuxu', 'manifest.json'), 'utf8'));
    if (Object.keys(manifest.documents || {}).length !== before.length) throw new Error('映射清单数量不一致');
    for (const [id, entry] of Object.entries(manifest.documents || {})) {
      const file = path.resolve(stage, entry.relativePath);
      if (!file.startsWith(`${path.resolve(stage)}${path.sep}`) || !fs.existsSync(file)) throw new Error(`迁移文件缺失：${id}`);
      if (hashFile(file) !== entry.fingerprint.sha256) throw new Error(`迁移文件哈希不一致：${id}`);
    }
    db.close(); db = null;
    if (fs.existsSync(root)) fs.rmdirSync(root);
    fs.renameSync(stage, root);
    rootInstalled = true;
    fs.writeFileSync(path.join(dataDir, '.knowledge-folder.json'), JSON.stringify({ version: 1, enabled: true, rootPath: root, scanIntervalMs: 30000 }, null, 2));
    verifySqlite(path.join(dataDir, 'schedule.db'));
    const finalReport = {
      success: true,
      completedAt: new Date().toISOString(),
      backupDir,
      backupFiles: backup.files,
      ...report,
      rootPath: root,
    };
    fs.writeFileSync(path.join(backupDir, 'migration-report.json'), JSON.stringify(finalReport, null, 2));
    fs.writeFileSync(path.join(root, '.liuxu', 'migration-report.json'), JSON.stringify(finalReport, null, 2));
    process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`);
  } catch (error) {
    try { knowledge?.folderSync.stop(); } catch {}
    try { db?.close(); } catch {}
    try { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    if (error.report) {
      try {
        fs.writeFileSync(path.join(backupDir, 'migration-preflight-report.json'), JSON.stringify({
          success: false,
          completedAt: new Date().toISOString(),
          backupDir,
          ...error.report,
        }, null, 2));
      } catch { /* retain the original migration error */ }
    }
    if (rootInstalled && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    if (rootPreviouslyExisted && !fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    restoreBackup(dataDir, backup.dataBackup);
    throw Object.assign(new Error(`迁移失败，已恢复原数据：${error.message}`), { cause: error });
  }
}

try { main(); } catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
