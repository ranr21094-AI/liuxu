import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
const mode = process.argv.includes('--release') ? 'release' : 'adhoc';
const outputDir = path.join(projectRoot, 'dist', 'desktop');
const expectedOutputParent = `${path.join(projectRoot, 'dist')}${path.sep}`;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const require = createRequire(import.meta.url);

function run(label, command, args, { capture = false, env = process.env } = {}) {
  console.log(`\n==> ${label}`);
  return execFileSync(command, args, {
    cwd: projectRoot,
    env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

function assertHost() {
  if (process.platform !== 'darwin') throw new Error('Mac 安装包必须在 macOS 上构建');
  if (process.arch !== 'arm64') throw new Error(`首期 Mac 安装包要求 Apple Silicon，当前架构：${process.arch}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supported = (major === 22 && minor >= 12) || major >= 24;
  if (!supported || major === 23) {
    throw new Error(`需要 Node.js 22.12+（或 24+），当前版本：${process.version}`);
  }
}

function hasNotarizationCredentials(env) {
  return Boolean(
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
    || (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
    || env.APPLE_KEYCHAIN_PROFILE
  );
}

function notarizationOptions(appPath, env) {
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return {
      tool: 'notarytool',
      appPath,
      appleApiKey: env.APPLE_API_KEY,
      appleApiKeyId: env.APPLE_API_KEY_ID,
      appleApiIssuer: env.APPLE_API_ISSUER,
    };
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return {
      tool: 'notarytool',
      appPath,
      appleId: env.APPLE_ID,
      appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: env.APPLE_TEAM_ID,
    };
  }
  return {
    tool: 'notarytool',
    appPath,
    keychainProfile: env.APPLE_KEYCHAIN_PROFILE,
    ...(env.APPLE_KEYCHAIN ? { keychain: env.APPLE_KEYCHAIN } : {}),
  };
}

function releaseEnvironment() {
  const env = { ...process.env };
  if (!env.CSC_LINK && env.MAC_CSC_LINK) env.CSC_LINK = env.MAC_CSC_LINK;
  const xcodePath = run('检查完整 Xcode', 'xcode-select', ['-p'], { capture: true }).trim();
  if (xcodePath.includes('CommandLineTools')) {
    throw new Error('正式发布需要安装完整 Xcode，并用 xcode-select 选中它');
  }
  const identities = run(
    '检查 Developer ID Application',
    'security',
    ['find-identity', '-v', '-p', 'codesigning'],
    { capture: true },
  );
  if (!env.CSC_LINK && !/Developer ID Application/.test(identities)) {
    throw new Error('缺少 Developer ID Application 证书；请导入钥匙串或设置 CSC_LINK/CSC_KEY_PASSWORD');
  }
  if (!hasNotarizationCredentials(env)) {
    throw new Error('缺少 Apple 公证凭据；请配置 App Store Connect API Key、Apple ID 凭据或 notarytool 钥匙串 profile');
  }
  return env;
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

function findFile(root, fileName) {
  if (!root || !fs.existsSync(root)) return '';
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === fileName) return absolute;
      if (entry.isDirectory()) queue.push(absolute);
    }
  }
  return '';
}

function installElectronRuntime() {
  const electronRoot = path.join(projectRoot, 'node_modules', 'electron');
  const electronPackage = JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8'));
  const archiveName = `electron-v${electronPackage.version}-darwin-arm64.zip`;
  const checksums = JSON.parse(fs.readFileSync(path.join(electronRoot, 'checksums.json'), 'utf8'));
  const expectedChecksum = String(checksums[archiveName] || '').toLowerCase();
  const cacheRoots = [
    process.env.ELECTRON_CACHE,
    path.join(os.homedir(), 'Library', 'Caches', 'electron'),
  ].filter(Boolean);

  for (const cacheRoot of cacheRoots) {
    const cachedArchive = findFile(cacheRoot, archiveName);
    if (!cachedArchive || !expectedChecksum || sha256(cachedArchive) !== expectedChecksum) continue;
    const distPath = path.join(electronRoot, 'dist');
    fs.rmSync(distPath, { recursive: true, force: true });
    fs.mkdirSync(distPath, { recursive: true });
    run('复用已校验的 Electron 运行时缓存', 'ditto', ['-x', '-k', cachedArchive, distPath]);
    fs.writeFileSync(path.join(electronRoot, 'path.txt'), 'Electron.app/Contents/MacOS/Electron\n', 'utf8');
    if (!fs.existsSync(path.join(distPath, 'Electron.app', 'Contents', 'MacOS', 'Electron'))) {
      throw new Error('Electron 缓存解压后缺少主可执行文件');
    }
    return;
  }

  run('下载锁定的 Electron 运行时', process.execPath, ['node_modules/electron/install.js']);
}

function verifySqliteCapabilities() {
  const Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  try {
    const options = probe.pragma('compile_options', { simple: false })
      .map(row => String(row.compile_options || ''));
    if (!options.some(option => option.includes('ENABLE_FTS5'))) {
      throw new Error('better-sqlite3 未启用 SQLite FTS5');
    }
  } finally {
    probe.close();
  }
}

function findApp(root) {
  if (!fs.existsSync(root)) return '';
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.app')) return absolute;
      if (entry.isDirectory()) queue.push(absolute);
    }
  }
  return '';
}

function verifyApp(appPath, label, { release = false } = {}) {
  run(`校验 ${label} 代码签名`, 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const executableDir = path.join(appPath, 'Contents', 'MacOS');
  const executable = fs.readdirSync(executableDir)
    .map((name) => path.join(executableDir, name))
    .find((candidate) => fs.statSync(candidate).isFile());
  if (!executable) throw new Error(`${label} 缺少主可执行文件`);
  const architecture = run(`校验 ${label} 架构`, 'file', [executable], { capture: true });
  if (!/arm64/.test(architecture)) throw new Error(`${label} 不是 arm64：${architecture.trim()}`);
  if (release) {
    run(`校验 ${label} Gatekeeper`, 'spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
    run(`校验 ${label} 公证票据`, 'xcrun', ['stapler', 'validate', appPath]);
  }
}

function verifyArchives(dmgPath, zipPath, release) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-mac-verify-'));
  const mountPoint = path.join(tempRoot, 'dmg');
  const zipDir = path.join(tempRoot, 'zip');
  fs.mkdirSync(mountPoint);
  fs.mkdirSync(zipDir);
  let mounted = false;
  try {
    run('挂载并检查 DMG', 'hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint]);
    mounted = true;
    const dmgApp = findApp(mountPoint);
    if (!dmgApp) throw new Error('DMG 中没有应用包');
    verifyApp(dmgApp, 'DMG 应用', { release });
    run('解压并检查 ZIP', 'ditto', ['-x', '-k', zipPath, zipDir]);
    const zipApp = findApp(zipDir);
    if (!zipApp) throw new Error('ZIP 中没有应用包');
    verifyApp(zipApp, 'ZIP 应用', { release });
  } finally {
    if (mounted) {
      try { execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'ignore' }); } catch {}
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function generateChecksums(artifacts) {
  return artifacts.map((artifact) => {
    const digest = sha256(artifact);
    fs.writeFileSync(`${artifact}.sha256`, `${digest} *${path.basename(artifact)}\n`, 'ascii');
    const info = fs.statSync(artifact);
    return { name: path.basename(artifact), sizeBytes: info.size, sha256: digest };
  });
}

function cleanGeneratedIntermediates() {
  const entries = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  for (const name of entries) {
    if (/^mac(?:-arm64)?$/.test(name)
      || /^builder-(?:debug|effective-config)\.(?:yml|yaml)$/.test(name)
      || /^latest-mac\.yml$/.test(name)
      || /\.blockmap$/.test(name)) {
      fs.rmSync(path.join(outputDir, name), { recursive: true, force: true });
    }
  }
}

assertHost();
let buildEnv = { ...process.env };
if (mode === 'release') buildEnv = releaseEnvironment();
else buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

run('安装锁定依赖', npmCommand, ['ci', '--ignore-scripts', '--omit=optional']);
installElectronRuntime();

const sqlitePrebuild = path.join(projectRoot, 'node_modules', 'better-sqlite3', 'prebuilds', 'darwin-arm64.node');
if (!fs.existsSync(sqlitePrebuild)) throw new Error(`缺少 SQLite macOS arm64 原生模块：${sqlitePrebuild}`);
const sqliteArchitecture = run('验证 SQLite macOS arm64 原生模块', 'file', [sqlitePrebuild], { capture: true });
if (!/arm64/.test(sqliteArchitecture)) throw new Error(`SQLite 原生模块架构错误：${sqliteArchitecture.trim()}`);
verifySqliteCapabilities();

const iconPath = path.join(projectRoot, 'electron', 'icon.icns');
const svgPath = path.join(projectRoot, 'electron', 'icon.svg');
if (!fs.existsSync(iconPath) || fs.statSync(iconPath).mtimeMs < fs.statSync(svgPath).mtimeMs) {
  run('生成 macOS Retina 图标', process.execPath, ['scripts/build-mac-icon.mjs']);
}

run('构建前端资源', npmCommand, ['run', 'build']);
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-desktop-tests-'));
try {
  run('运行全量测试', npmCommand, ['test'], {
    env: {
      ...buildEnv,
      DATA_DIR: path.join(testRoot, 'data'),
      AI_SECRETS_KEY_FILE: path.join(testRoot, 'ai-secrets.key'),
    },
  });
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}

if (!path.resolve(outputDir).startsWith(expectedOutputParent)) {
  throw new Error(`拒绝清理项目外的输出目录：${outputDir}`);
}
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const builderArgs = [
  'node_modules/electron-builder/out/cli/cli.js',
  '--mac',
  'dmg',
  'zip',
  '--arm64',
  '-c.electronDist=node_modules/electron/dist',
  mode === 'release' ? '-c.mac.notarize=true' : '-c.mac.identity=-',
];
if (mode !== 'release') builderArgs.push('-c.mac.notarize=false');
run(mode === 'release' ? '生成签名并公证的 macOS 安装包' : '生成 ad-hoc macOS 测试安装包', process.execPath, builderArgs, { env: buildEnv });

const baseName = `LiuXu-${packageJson.version}-mac-arm64`;
const dmgPath = path.join(outputDir, `${baseName}.dmg`);
const zipPath = path.join(outputDir, `${baseName}.zip`);
for (const artifact of [dmgPath, zipPath]) {
  if (!fs.existsSync(artifact)) throw new Error(`构建产物未生成：${artifact}`);
}

const unpackedApp = findApp(outputDir);
if (!unpackedApp) throw new Error('构建目录中没有可校验的 .app');
if (mode === 'release') {
  console.log('\n==> 提交 DMG 公证并 staple ticket');
  const { notarize } = await import('@electron/notarize');
  await notarize(notarizationOptions(dmgPath, buildEnv));
}
verifyApp(unpackedApp, '未打包应用', { release: mode === 'release' });
verifyArchives(dmgPath, zipPath, mode === 'release');
if (mode === 'release') run('校验 DMG 公证票据', 'xcrun', ['stapler', 'validate', dmgPath]);

const artifacts = generateChecksums([dmgPath, zipPath]);
const summary = {
  generatedAt: new Date().toISOString(),
  productName: '留序 LiuXu',
  version: packageJson.version,
  platform: 'darwin',
  arch: 'arm64',
  minimumSystemVersion: '12.0',
  bundleId: 'ai.ranr21094.liuxu',
  signing: mode === 'release' ? 'Developer ID Application' : 'ad-hoc',
  notarized: mode === 'release',
  tests: 'passed',
  node: process.version,
  electron: packageJson.devDependencies.electron,
  electronBuilder: packageLock.packages?.['node_modules/electron-builder']?.version
    || packageJson.devDependencies['electron-builder'],
  artifacts,
};
fs.writeFileSync(
  path.join(outputDir, 'desktop-build-summary-mac.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8',
);
cleanGeneratedIntermediates();

console.log('\nMac 构建完成：');
for (const artifact of artifacts) console.log(`- ${artifact.name} (${artifact.sha256})`);
console.log('- desktop-build-summary-mac.json');
