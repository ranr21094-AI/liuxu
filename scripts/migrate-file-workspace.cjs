const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index < 0 ? '' : args[index + 1]; };
async function main() {
  const directory = value('--data-dir');
  const root = value('--root');
  if (!directory || !root) throw new Error('用法：node scripts/migrate-file-workspace.cjs --data-dir <应用数据目录> --root <文件目录> [--preflight] [--backup <独立备份目录>] [--user-data <桌面配置目录>]');
  const dataDir = path.resolve(directory);
  const lock = path.join(dataDir, '.schedule.lock');
  if (fs.existsSync(lock)) {
    const pid = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10);
    if (pid > 0) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
      if (alive) throw new Error('留序仍在运行，请保存草稿并完全退出后迁移');
    }
  }
  process.env.DATA_DIR = dataDir;
  const { createDatabase } = require('../database');
  const db = createDatabase(dataDir);
  try {
    const { preflightFileWorkspace, migrateFileWorkspace } = require('../lib/knowledge/file-workspace-migration');
    const report = args.includes('--preflight') ? await preflightFileWorkspace(db, root)
      : await migrateFileWorkspace(db, { root, backupPath: value('--backup'), userDataPath: value('--user-data') });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { db.close(); }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
