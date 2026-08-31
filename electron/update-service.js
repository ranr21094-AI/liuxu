const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const UPDATE_REPOSITORY = Object.freeze({ owner: 'ranr21094-AI', name: 'liuxu' });
const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.name}/releases/latest`;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const RELEASES_LATEST_PATH = `/repos/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.name}/releases/latest`;

function assertSafeUrl(value, { api = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('更新地址格式无效');
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error('更新地址不是受信任的 GitHub 地址');
  }
  if (api && url.hostname !== 'api.github.com') {
    throw new Error('更新接口地址不是 GitHub API');
  }
  return url;
}

function parseReleaseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-r(\d+))?$/i.exec(String(value || '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    revision: Number(match[4] || 0),
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
  };
}

function compareReleaseVersions(left, right) {
  const a = typeof left === 'string' ? parseReleaseVersion(left) : left;
  const b = typeof right === 'string' ? parseReleaseVersion(right) : right;
  if (!a || !b) throw new Error('版本号格式无效');
  for (const key of ['major', 'minor', 'patch', 'revision']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

function platformAssetName(platform, arch, version) {
  if (platform === 'win32' && arch === 'x64') return `LiuXu-Setup-${version}-x64.exe`;
  if (platform === 'darwin' && arch === 'arm64') return `LiuXu-${version}-mac-arm64.dmg`;
  return '';
}

function normalizeDigest(value) {
  const digest = String(value || '').trim().replace(/^sha256:/i, '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : '';
}

function parseChecksumText(text, fileName) {
  const expectedName = String(fileName || '').trim();
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /^([a-f0-9]{64})\s+(?:\*|\s)?(.+)$/i.exec(line);
    if (!match) continue;
    if (path.basename(match[2].trim()) !== expectedName) continue;
    return match[1].toLowerCase();
  }
  return '';
}

function assertSafeReleaseAssetUrl(value) {
  const url = assertSafeUrl(value);
  if (url.hostname === 'github.com'
    && !url.pathname.startsWith(`/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.name}/releases/`)) {
    throw new Error('更新文件不是项目 GitHub Release 资产');
  }
  return url;
}

function assertSafeApiUrl(value) {
  const url = assertSafeUrl(value, { api: true });
  if (url.pathname !== RELEASES_LATEST_PATH) throw new Error('更新接口不是项目 GitHub Releases API');
  return url;
}

function releaseAsset(release, name) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find(item => item?.name === name);
  if (!asset || typeof asset.browser_download_url !== 'string') return null;
  const assetUrl = assertSafeReleaseAssetUrl(asset.browser_download_url);
  const size = Number(asset.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_DOWNLOAD_BYTES) {
    throw new Error('更新安装包大小不在允许范围内');
  }
  return {
    name,
    sizeBytes: size,
    url: asset.browser_download_url,
    digest: normalizeDigest(asset.digest),
  };
}

function summarizeRelease(release, { currentVersion, platform, arch }) {
  const current = parseReleaseVersion(currentVersion);
  const rawTag = String(release?.tag_name || '').trim();
  const remote = /^v\d+\.\d+\.\d+(?:-r\d+)?$/i.test(rawTag) ? parseReleaseVersion(rawTag) : null;
  if (!current) throw new Error(`当前版本号无效：${currentVersion}`);
  if (!remote) return { state: 'incompatible', currentVersion: current.version, platform, arch, reason: 'GitHub 发布标签不是标准版本号' };
  if (release.draft || release.prerelease) return { state: 'incompatible', currentVersion: current.version, latestVersion: remote.version, platform, arch, reason: '最新发布仍是草稿或预发布版本' };
  const comparison = compareReleaseVersions(remote, current);
  const result = {
    state: comparison > 0 ? 'available' : 'up-to-date',
    currentVersion: current.version,
    latestVersion: remote.version,
    latestTag: String(release.tag_name),
    title: String(release.name || `留序 LiuXu ${remote.version}`),
    notes: String(release.body || '').trim().slice(0, 12000),
    publishedAt: release.published_at || release.created_at || '',
    releaseUrl: typeof release.html_url === 'string' ? release.html_url : `https://github.com/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.name}/releases/latest`,
    platform,
    arch,
    signature: 'unknown',
  };
  if (comparison <= 0) return result;
  const name = platformAssetName(platform, arch, remote.version);
  if (!name) return { ...result, state: 'unsupported', reason: '当前系统暂不支持该平台架构' };
  const asset = releaseAsset(release, name);
  const checksum = releaseAsset(release, `${name}.sha256`);
  if (!asset || !checksum) return { ...result, state: 'unavailable', reason: '该发布没有当前平台的完整安装包和校验文件' };
  return {
    ...result,
    asset: { name: asset.name, sizeBytes: asset.sizeBytes },
    candidate: { ...asset, checksumUrl: checksum.url, checksumSizeBytes: checksum.sizeBytes },
  };
}

async function fetchWithRedirects(fetchImpl, initialUrl, options = {}) {
  const { api = false, validateUrl, ...fetchOptions } = options;
  let url = String(initialUrl);
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    (validateUrl || (value => assertSafeUrl(value, api ? { api: true } : {})))(url);
    const response = await fetchImpl(url, {
      ...fetchOptions,
      redirect: 'manual',
      headers: {
        'User-Agent': 'LiuXu-Desktop-Updater',
        Accept: 'application/vnd.github+json',
        ...(fetchOptions.headers || {}),
      },
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers?.get?.('location');
    if (!location) throw new Error('GitHub 更新重定向缺少目标地址');
    url = new URL(location, url).toString();
  }
  throw new Error('GitHub 更新重定向次数过多');
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function readResponseText(response) {
  try { return await response.text(); } catch { return ''; }
}

async function downloadResponseToFile(response, filePath, expectedSize, onProgress, signal) {
  if (!response.ok || !response.body) {
    const message = (await readResponseText(response)).trim();
    throw new Error(message || `下载失败（HTTP ${response.status}）`);
  }
  const contentLength = Number(response.headers?.get?.('content-length')) || expectedSize || 0;
  let received = 0;
  const output = fs.createWriteStream(filePath, { flags: 'w', mode: 0o600 });
  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new Error('下载已取消');
      received += chunk.byteLength || chunk.length || 0;
      if (received > MAX_DOWNLOAD_BYTES || (expectedSize && received > expectedSize)) {
        throw new Error('下载内容超过发布元数据声明的大小');
      }
      if (!output.write(Buffer.from(chunk))) await new Promise(resolve => output.once('drain', resolve));
      onProgress?.({ receivedBytes: received, totalBytes: contentLength, progress: contentLength ? Math.min(1, received / contentLength) : 0 });
    }
    await new Promise((resolve, reject) => {
      output.once('error', reject);
      output.end(resolve);
    });
  } catch (error) {
    output.destroy();
    throw error;
  }
  if (expectedSize && received !== expectedSize) throw new Error('下载内容大小与发布元数据不一致');
  return { received, total: contentLength };
}

async function detectSignature(filePath, platform, runner = execFileAsync) {
  try {
    if (platform === 'darwin') {
      await runner('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', filePath]);
      return { trusted: true, label: '已通过 macOS 签名检查' };
    }
    if (platform === 'win32') {
      const escaped = String(filePath).replace(/'/g, "''");
      const { stdout } = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`]);
      if (String(stdout).trim() === 'Valid') return { trusted: true, label: '已通过 Windows 签名检查' };
      return { trusted: false, label: '未通过 Windows 发布者签名检查' };
    }
  } catch {}
  return { trusted: false, label: '未检测到受信任的发布者签名' };
}

function safeCachePath(cacheDir, fileName) {
  const base = path.resolve(cacheDir);
  const target = path.resolve(base, fileName);
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('更新文件路径无效');
  return target;
}

async function cleanupUpdateCache(cacheDir, currentVersion, now = Date.now()) {
  if (!cacheDir || !fs.existsSync(cacheDir)) return;
  const current = parseReleaseVersion(currentVersion);
  for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const target = path.join(cacheDir, entry.name);
    let remove = entry.name.endsWith('.part');
    try {
      const stat = fs.statSync(target);
      remove ||= now - stat.mtimeMs > CACHE_MAX_AGE_MS;
      const match = /^LiuXu(?:-Setup)?-(\d+\.\d+\.\d+)(?:-x64)?(?:-mac-arm64)?\.(?:dmg|exe)$/.exec(entry.name);
      if (!remove && match && current && compareReleaseVersions(match[1], current) <= 0) remove = true;
    } catch { remove = true; }
    if (remove) {
      try { fs.unlinkSync(target); } catch {}
    }
  }
}

function createUpdateService({
  userDataPath,
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  runSignatureCheck = detectSignature,
  now = () => Date.now(),
  onProgress,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持更新网络请求');
  const cacheDir = path.join(userDataPath, 'updates');
  let candidate = null;
  let downloaded = null;
  let controller = null;

  async function check() {
    const response = await fetchWithRedirects(fetchImpl, UPDATE_API_URL, { validateUrl: assertSafeApiUrl });
    if (!response.ok) throw new Error(`GitHub 更新检查失败（HTTP ${response.status}）`);
    const release = await response.json();
    const summary = summarizeRelease(release, { currentVersion, platform, arch });
    candidate = summary.candidate || null;
    downloaded = null;
    return summary;
  }

  async function download() {
    if (!candidate) throw new Error('请先检查更新');
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const target = safeCachePath(cacheDir, candidate.name);
    const part = safeCachePath(cacheDir, `${candidate.name}.part`);
    const checksumPath = safeCachePath(cacheDir, `${candidate.name}.sha256`);
    controller = new AbortController();
    try {
      let checksumResponse = await fetchWithRedirects(fetchImpl, candidate.checksumUrl, {
        validateUrl: assertSafeReleaseAssetUrl,
        signal: controller.signal,
      });
      if (!checksumResponse.ok) throw new Error(`校验文件下载失败（HTTP ${checksumResponse.status}）`);
      const checksumText = await checksumResponse.text();
      if (checksumText.length > 64 * 1024) throw new Error('校验文件过大');
      const checksum = parseChecksumText(checksumText, candidate.name);
      if (!checksum) throw new Error('校验文件格式无效或文件名不匹配');
      if (candidate.digest && candidate.digest !== checksum) throw new Error('GitHub 元数据与校验文件不一致');
      fs.writeFileSync(checksumPath, checksumText, { mode: 0o600 });
      if (fs.existsSync(target) && (await hashFile(target)) === checksum) {
        downloaded = { filePath: target, fileName: candidate.name, sizeBytes: fs.statSync(target).size, sha256: checksum };
      } else {
        const response = await fetchWithRedirects(fetchImpl, candidate.url, {
          validateUrl: assertSafeReleaseAssetUrl,
          signal: controller.signal,
        });
        await downloadResponseToFile(response, part, candidate.sizeBytes, value => onProgress?.({ ...value, fileName: candidate.name }), controller.signal);
        const actual = await hashFile(part);
        if (actual !== checksum) throw new Error('安装包 SHA-256 校验失败');
        fs.renameSync(part, target);
        downloaded = { filePath: target, fileName: candidate.name, sizeBytes: fs.statSync(target).size, sha256: actual };
      }
      const signature = await runSignatureCheck(downloaded.filePath, platform);
      downloaded.signature = signature;
      onProgress?.({ receivedBytes: downloaded.sizeBytes, totalBytes: downloaded.sizeBytes, progress: 1, state: 'verified', fileName: downloaded.fileName });
      return { fileName: downloaded.fileName, sizeBytes: downloaded.sizeBytes, sha256: downloaded.sha256, signature };
    } catch (error) {
      try { fs.unlinkSync(part); } catch {}
      downloaded = null;
      throw error;
    } finally {
      controller = null;
    }
  }

  function cancelDownload() {
    controller?.abort();
  }

  async function openInstaller(shell) {
    if (!downloaded?.filePath || !fs.existsSync(downloaded.filePath)) throw new Error('没有已校验的更新安装包');
    const error = await shell.openPath(downloaded.filePath);
    if (error) throw new Error(error);
    return {
      platform,
      fileName: downloaded.fileName,
      signature: downloaded.signature || { trusted: false, label: '未检测到受信任的发布者签名' },
      macInstallGuide: platform === 'darwin',
    };
  }

  return {
    getCurrentInfo: () => ({ version: parseReleaseVersion(currentVersion)?.version || String(currentVersion), platform, arch }),
    check,
    download,
    cancelDownload,
    openInstaller,
    cleanup: () => cleanupUpdateCache(cacheDir, currentVersion, now()),
    paths: { cacheDir },
  };
}

module.exports = {
  ALLOWED_HOSTS,
  CACHE_MAX_AGE_MS,
  MAX_DOWNLOAD_BYTES,
  UPDATE_API_URL,
  cleanupUpdateCache,
  compareReleaseVersions,
  createUpdateService,
  detectSignature,
  normalizeDigest,
  parseChecksumText,
  parseReleaseVersion,
  platformAssetName,
  summarizeRelease,
};
