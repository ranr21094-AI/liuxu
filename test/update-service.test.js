const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CACHE_MAX_AGE_MS,
  compareReleaseVersions,
  createUpdateService,
  parseChecksumText,
  parseReleaseVersion,
  platformAssetName,
  summarizeRelease,
} = require('../electron/update-service');

function fakeResponse({ status = 200, json, text = '', body = null, headers = {} } = {}) {
  const values = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: key => values.get(String(key).toLowerCase()) || null },
    json: async () => json,
    text: async () => text,
    body,
  };
}

function releaseFixture({ version = '1.2.0', digest, assetName = platformAssetName('darwin', 'arm64', version) } = {}) {
  const checksum = digest || crypto.createHash('sha256').update('installer').digest('hex');
  return {
    tag_name: `v${version}`,
    name: `留序 LiuXu ${version}`,
    body: '修复测试问题',
    published_at: '2026-08-28T00:00:00Z',
    html_url: 'https://github.com/ranr21094-AI/liuxu/releases/tag/v1.2.0',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: assetName,
        size: 9,
        digest: `sha256:${checksum}`,
        browser_download_url: `https://github.com/ranr21094-AI/liuxu/releases/download/v${version}/${assetName}`,
      },
      {
        name: `${assetName}.sha256`,
        size: 80,
        browser_download_url: `https://github.com/ranr21094-AI/liuxu/releases/download/v${version}/${assetName}.sha256`,
      },
    ],
  };
}

test('release version parsing and comparison handles revision tags', () => {
  assert.deepEqual(parseReleaseVersion('v1.0.0-r2'), {
    major: 1, minor: 0, patch: 0, revision: 2, version: '1.0.0',
  });
  assert.equal(compareReleaseVersions('1.0.0-r2', '1.0.0'), 1);
  assert.equal(compareReleaseVersions('1.1.0', '1.0.0-r2'), 1);
  assert.equal(compareReleaseVersions('1.0.0', '1.0.0-r2'), -1);
  assert.equal(parseReleaseVersion('latest'), null);
});

test('release summary selects exact platform asset and rejects missing assets', () => {
  const release = releaseFixture();
  const summary = summarizeRelease(release, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' });
  assert.equal(summary.state, 'available');
  assert.equal(summary.candidate.name, 'LiuXu-1.2.0-mac-arm64.dmg');
  assert.equal(summary.candidate.checksumSizeBytes, 80);
  assert.equal(summarizeRelease({ ...release, prerelease: true }, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' }).state, 'incompatible');
  assert.equal(summarizeRelease({ ...release, assets: [] }, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' }).state, 'unavailable');
  assert.equal(summarizeRelease(release, { currentVersion: '1.1.0', platform: 'win32', arch: 'arm64' }).state, 'unsupported');
});

test('checksum parsing requires the expected file name', () => {
  const digest = 'a'.repeat(64);
  assert.equal(parseChecksumText(`${digest} *installer.dmg\n`, 'installer.dmg'), digest);
  assert.equal(parseChecksumText(`${digest} *other.dmg\n`, 'installer.dmg'), '');
});

test('update service downloads, verifies, reports progress, and detects signatures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-update-test-'));
  const bytes = Buffer.from('installer');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const release = releaseFixture({ digest });
  const assetName = 'LiuXu-1.2.0-mac-arm64.dmg';
  const progress = [];
  const fetchImpl = async url => {
    if (url.includes('/releases/latest')) return fakeResponse({ json: release });
    if (url.endsWith('.sha256')) return fakeResponse({ text: `${digest} *${assetName}\n` });
    return fakeResponse({ body: (async function* () { yield bytes; })(), headers: { 'content-length': bytes.length } });
  };
  const service = createUpdateService({
    userDataPath: root,
    currentVersion: '1.1.0',
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl,
    runSignatureCheck: async () => ({ trusted: false, label: '测试包' }),
    onProgress: value => progress.push(value),
  });
  const checked = await service.check();
  assert.equal(checked.state, 'available');
  const downloaded = await service.download();
  assert.equal(downloaded.fileName, assetName);
  assert.equal(downloaded.sha256, digest);
  assert.equal(downloaded.signature.trusted, false);
  assert.ok(progress.some(item => item.progress === 1));
  assert.equal(fs.readFileSync(path.join(root, 'updates', assetName), 'utf8'), 'installer');
  fs.rmSync(root, { recursive: true, force: true });
});

test('update service rejects unsafe URLs and checksum mismatches', async () => {
  assert.throws(() => summarizeRelease({
    ...releaseFixture(),
    assets: [{ ...releaseFixture().assets[0], browser_download_url: 'https://example.com/file.dmg' }],
  }, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' }), /受信任的 GitHub/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-update-bad-'));
  const release = releaseFixture({ digest: 'b'.repeat(64) });
  const fetchImpl = async url => {
    if (url.includes('/releases/latest')) return fakeResponse({ json: release });
    if (url.endsWith('.sha256')) return fakeResponse({ text: `${'a'.repeat(64)} *LiuXu-1.2.0-mac-arm64.dmg\n` });
    return fakeResponse({ body: (async function* () { yield Buffer.from('installer'); })(), headers: { 'content-length': 9 } });
  };
  const service = createUpdateService({ userDataPath: root, currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64', fetchImpl });
  await service.check();
  await assert.rejects(service.download(), /元数据与校验文件不一致/);
  assert.equal(fs.existsSync(path.join(root, 'updates', 'LiuXu-1.2.0-mac-arm64.dmg.part')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('update service rejects redirects outside the project release path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-update-redirect-'));
  const release = releaseFixture();
  const fetchImpl = async url => {
    if (url.includes('/releases/latest')) return fakeResponse({ json: release });
    if (url.endsWith('.sha256')) return fakeResponse({
      status: 302,
      headers: { location: 'https://github.com/another-owner/another-repo/file.sha256' },
    });
    return fakeResponse({ body: (async function* () { yield Buffer.from('installer'); })(), headers: { 'content-length': 9 } });
  };
  const service = createUpdateService({ userDataPath: root, currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64', fetchImpl });
  await service.check();
  await assert.rejects(service.download(), /不是项目 GitHub Release 资产/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('update check rejects redirects to another GitHub API resource', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-update-api-redirect-'));
  const fetchImpl = async url => {
    if (url.includes('/releases/latest')) {
      return fakeResponse({
        status: 302,
        headers: { location: 'https://api.github.com/repos/another-owner/another-repo/releases/latest' },
      });
    }
    return fakeResponse({ json: releaseFixture() });
  };
  const service = createUpdateService({ userDataPath: root, currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64', fetchImpl });
  await assert.rejects(service.check(), /不是项目 GitHub Releases API/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('update cache cleanup removes partial and expired files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-update-clean-'));
  const cache = path.join(root, 'updates');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'old.part'), 'partial');
  const old = path.join(cache, 'LiuXu-1.0.0-mac-arm64.dmg');
  fs.writeFileSync(old, 'old');
  const oldTime = Date.now() - CACHE_MAX_AGE_MS - 1;
  fs.utimesSync(old, oldTime / 1000, oldTime / 1000);
  const service = createUpdateService({ userDataPath: root, currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64', fetchImpl: async () => fakeResponse({}) });
  await service.cleanup();
  assert.equal(fs.existsSync(path.join(cache, 'old.part')), false);
  assert.equal(fs.existsSync(old), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('update cache cleanup recognizes Windows x64 installers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-update-win-clean-'));
  const cache = path.join(root, 'updates');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'LiuXu-Setup-1.1.0-x64.exe'), 'current');
  const service = createUpdateService({ userDataPath: root, currentVersion: '1.1.0', platform: 'win32', arch: 'x64', fetchImpl: async () => fakeResponse({}) });
  await service.cleanup();
  assert.equal(fs.existsSync(path.join(cache, 'LiuXu-Setup-1.1.0-x64.exe')), false);
  fs.rmSync(root, { recursive: true, force: true });
});
