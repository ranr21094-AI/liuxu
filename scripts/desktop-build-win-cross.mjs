import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const outputDir = path.join(projectRoot, 'dist', 'desktop');
const version = packageJson.version;
const artifactName = `LiuXu-Setup-${version}-x64.exe`;
const artifactPath = path.join(outputDir, artifactName);
const sqlitePrebuild = path.join(projectRoot, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, command, args, { env = process.env, capture = false } = {}) {
  console.log(`\n==> ${label}`);
  return execFileSync(command, args, {
    cwd: projectRoot,
    env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function findWine() {
  const configured = String(process.env.WINE || '').trim();
  if (configured) return configured;
  try { return run('查找 Wine', 'which', ['wine'], { capture: true }).trim(); } catch { return ''; }
}

function assertHost(winePath) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Windows 交叉构建要求 Apple Silicon macOS 主机');
  }
  if (winePath && !fs.existsSync(winePath)) {
    throw new Error(`WINE 指向的文件不存在：${winePath}`);
  }
  if (!fs.existsSync(sqlitePrebuild)) {
    throw new Error(`缺少 better-sqlite3 Windows x64 原生模块：${sqlitePrebuild}`);
  }
  const sqliteArchitecture = run('验证 SQLite Windows x64 原生模块', 'file', [sqlitePrebuild], { capture: true });
  if (!/x86-64|x86_64|PE32\+/.test(sqliteArchitecture)) {
    throw new Error(`SQLite 原生模块架构错误：${sqliteArchitecture.trim()}`);
  }
}

function removeGeneratedWindowsFiles() {
  fs.mkdirSync(outputDir, { recursive: true });
  const names = [
    'win-unpacked',
    '.icon-ico',
    'builder-debug.yml',
    'latest.yml',
    `${artifactName}.blockmap`,
    artifactName,
    `${artifactName}.sha256`,
    'desktop-build-summary.json',
  ];
  for (const name of names) {
    const target = path.join(outputDir, name);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
}

const winePath = findWine();
assertHost(winePath);
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-win-cross-tests-'));
const buildEnv = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  WIN_CSC_LINK: '',
  WIN_CSC_KEY_PASSWORD: '',
  DATA_DIR: path.join(testRoot, 'data'),
  AI_SECRETS_KEY_FILE: path.join(testRoot, 'ai-secrets.key'),
};
if (winePath) {
  buildEnv.WINE = winePath;
  buildEnv.WINEPREFIX = process.env.WINEPREFIX || path.join(os.tmpdir(), `liuxu-wineprefix-${version}`);
  buildEnv.WINEARCH = process.env.WINEARCH || 'win64';
  buildEnv.WINEDEBUG = process.env.WINEDEBUG || '-all';
} else {
  console.log('未找到 Wine，使用 electron-builder 的本机 Windows 交叉打包器继续构建');
}

try {
  run('构建前端资源', npmCommand, ['run', 'build'], { env: buildEnv });
  run('运行全量测试', npmCommand, ['test'], { env: buildEnv });
  removeGeneratedWindowsFiles();
  run('生成 Windows x64 NSIS 测试安装包', process.execPath, [
    'node_modules/electron-builder/out/cli/cli.js',
    '--win', 'nsis', '--x64',
  ], { env: buildEnv });
  if (!fs.existsSync(artifactPath)) throw new Error(`Windows 安装包未生成：${artifactPath}`);
  const digest = sha256(artifactPath);
  fs.writeFileSync(`${artifactPath}.sha256`, `${digest} *${artifactName}\n`, 'ascii');
  const stat = fs.statSync(artifactPath);
  const summary = {
    generatedAt: new Date().toISOString(),
    productName: '留序 LiuXu',
    version,
    platform: 'win32',
    arch: 'x64',
    artifact: artifactName,
    sizeBytes: stat.size,
    sha256: digest,
    electron: packageJson.devDependencies.electron,
    electronBuilder: packageJson.devDependencies['electron-builder'],
    optionalDependencies: 'omitted',
    tests: 'passed',
    signed: false,
    notarized: false,
    buildMethod: winePath ? 'wine-cross-build' : 'electron-builder-cross-build',
  };
  fs.writeFileSync(path.join(outputDir, 'desktop-build-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  for (const name of ['win-unpacked', '.icon-ico', 'builder-debug.yml', 'latest.yml', `${artifactName}.blockmap`]) {
    const target = path.join(outputDir, name);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  console.log(`\nWindows 构建完成：${artifactName}`);
  console.log(`SHA-256：${digest}`);
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
