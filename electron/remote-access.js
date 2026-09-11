const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function executableCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return [
      'tailscale.exe',
      env.ProgramFiles ? path.join(env.ProgramFiles, 'Tailscale', 'tailscale.exe') : '',
      env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'Tailscale', 'tailscale.exe') : '',
    ].filter(Boolean);
  }
  return [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
  ];
}

function run(executable, args, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || '');
        return reject(error);
      }
      resolve(String(stdout || ''));
    });
  });
}

async function findTailscale(options = {}) {
  for (const candidate of executableCandidates(options.platform, options.env)) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    try {
      await run(candidate, ['version'], { timeout: 4000 });
      return candidate;
    } catch {}
  }
  return '';
}

function serveStatusHasConfiguration(raw) {
  const text = String(raw || '').trim();
  if (!text || text === '{}' || text === 'null') return false;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed && typeof parsed === 'object' && Object.keys(parsed).length);
  } catch {
    return true;
  }
}

async function inspectTailscale({ executable } = {}) {
  const command = executable || await findTailscale();
  if (!command) {
    return { state: 'not_installed', message: '未找到 Tailscale，请先安装并登录', dnsName: '', publicUrl: '', serveConfigured: false };
  }
  try {
    const status = JSON.parse(await run(command, ['status', '--json']));
    const dnsName = String(status?.Self?.DNSName || '').replace(/\.$/, '');
    const online = status?.BackendState === 'Running' && Boolean(dnsName);
    let serveStatus = '';
    try { serveStatus = await run(command, ['serve', 'status', '--json']); } catch (error) { serveStatus = error.stderr || ''; }
    const serveConfigured = serveStatusHasConfiguration(serveStatus);
    return {
      executable: command,
      state: online ? 'connected' : 'signed_out',
      message: online ? (serveConfigured ? 'Tailscale 已连接，Serve 已配置' : 'Tailscale 已连接，尚未配置 Serve') : 'Tailscale 尚未登录或未连接',
      dnsName,
      publicUrl: dnsName ? `https://${dnsName}` : '',
      serveConfigured,
      serveStatus,
    };
  } catch (error) {
    return { executable: command, state: 'error', message: error.message || '无法读取 Tailscale 状态', dnsName: '', publicUrl: '', serveConfigured: false };
  }
}

async function configureTailscaleServe({ port, executable } = {}) {
  const status = await inspectTailscale({ executable });
  if (status.state !== 'connected') throw new Error(status.message || 'Tailscale 尚未连接');
  if (status.serveConfigured) {
    throw new Error('检测到已有 Tailscale Serve 配置。为避免覆盖，请先在终端检查并调整现有配置。');
  }
  await run(status.executable, ['serve', '--bg', '--yes', `http://127.0.0.1:${port}`], { timeout: 20000 });
  return inspectTailscale({ executable: status.executable });
}

function tailscaleServeCommand(port) {
  return `tailscale serve --bg --yes http://127.0.0.1:${Number(port) || 43140}`;
}

module.exports = {
  executableCandidates,
  findTailscale,
  inspectTailscale,
  configureTailscaleServe,
  serveStatusHasConfiguration,
  tailscaleServeCommand,
};
