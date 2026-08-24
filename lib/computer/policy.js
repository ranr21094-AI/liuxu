const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteJson, readJsonIfExists } = require('../util/json-file');
const { encryptSecret, decryptSecret, isEncryptedSecret } = require('../../secret-store');

const SENSITIVE_SEGMENTS = [
  '.ssh', 'appdata\\local\\google\\chrome', 'appdata\\local\\microsoft\\edge',
  'cookies', 'login data', 'credentials', 'ntds.dit', 'ai-secrets.key',
];

const PREFERRED_ALLOWLIST = ['D:\\新桌面'];

function policyFile(dataDir) {
  return path.join(dataDir, 'agent-policy.json');
}

function policySecretAad(dataDir) {
  return `work-log-agent-policy:v1:${path.resolve(dataDir)}`;
}

function existingDirectories(candidates) {
  const found = [];
  for (const item of candidates) {
    try {
      const resolved = fs.realpathSync(path.resolve(String(item)));
      if (!fs.statSync(resolved).isDirectory()) continue;
      if (isSensitivePath(resolved)) continue;
      if (!found.includes(resolved)) found.push(resolved);
    } catch {}
  }
  return found;
}

function defaultPolicy() {
  return {
    computerToolsEnabled: true,
    // Only the preferred workspace directory is allowlisted by default; the
    // previous os.homedir() fallback exposed the whole user profile.
    allowedDirectories: existingDirectories(PREFERRED_ALLOWLIST),
    chromePaired: false,
  };
}

function loadPolicy(dataDir) {
  const saved = readJsonIfExists(policyFile(dataDir), defaultPolicy());
  const encryptedKey = typeof saved.chromeKey === 'string' ? saved.chromeKey : '';
  const chromeKey = isEncryptedSecret(encryptedKey) ? decryptSecret(encryptedKey, policySecretAad(dataDir)) : encryptedKey;
  const pendingPairing = saved.pendingPairing && typeof saved.pendingPairing === 'object'
    ? { ...saved.pendingPairing }
    : undefined;
  if (pendingPairing?.key && isEncryptedSecret(pendingPairing.key)) {
    pendingPairing.key = decryptSecret(pendingPairing.key, `${policySecretAad(dataDir)}:pending`);
  }
  return {
    computerToolsEnabled: saved.computerToolsEnabled === true,
    allowedDirectories: Array.isArray(saved.allowedDirectories) ? saved.allowedDirectories.map(String) : [],
    chromePaired: saved.chromePaired === true,
    chromeKey,
    ...(pendingPairing ? { pendingPairing } : {}),
  };
}

function savePolicy(dataDir, policy) {
  const next = { ...policy };
  if (Array.isArray(next.allowedDirectories)) {
    next.allowedDirectories = next.allowedDirectories.map(item => {
      const resolved = fs.realpathSync(path.resolve(String(item)));
      if (!fs.statSync(resolved).isDirectory()) throw new Error('Allowlist entries must be directories');
      if (isSensitivePath(resolved)) throw new Error('Sensitive directory cannot be allowlisted');
      return resolved;
    }).filter((item, index, list) => list.indexOf(item) === index);
  }
  const serialized = { ...next };
  if (typeof serialized.chromeKey === 'string' && serialized.chromeKey && !isEncryptedSecret(serialized.chromeKey)) {
    serialized.chromeKey = encryptSecret(serialized.chromeKey, policySecretAad(dataDir));
  }
  if (serialized.pendingPairing?.key && !isEncryptedSecret(serialized.pendingPairing.key)) {
    serialized.pendingPairing = { ...serialized.pendingPairing, key: encryptSecret(serialized.pendingPairing.key, `${policySecretAad(dataDir)}:pending`) };
  }
  atomicWriteJson(policyFile(dataDir), serialized);
  return loadPolicy(dataDir);
}

function isLoopback(req) {
  const addr = req.ip || req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const reauthAt = new Map();

function markReauth(userId) {
  reauthAt.set(String(userId), Date.now());
}

function recentlyReauthed(userId) {
  const at = reauthAt.get(String(userId)) || 0;
  return Date.now() - at < 15 * 60 * 1000;
}

function computerToolsAllowed(req, dataDir) {
  const policy = loadPolicy(dataDir);
  if (!policy.computerToolsEnabled) return { ok: false, error: 'Computer tools are disabled' };
  return { ok: true, policy };
}

function isSensitivePath(resolved) {
  const lower = resolved.toLowerCase();
  return SENSITIVE_SEGMENTS.some(segment => lower.includes(segment));
}

const IS_WINDOWS = process.platform === 'win32';

function samePath(a, b) {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithinDirectory(candidate, directory) {
  if (samePath(candidate, directory)) return true;
  if (IS_WINDOWS) {
    return candidate.toLowerCase().startsWith(directory.toLowerCase() + path.sep);
  }
  return candidate.startsWith(directory + path.sep);
}

function resolveAllowed(target, allowedDirectories) {
  const requested = path.resolve(String(target || ''));
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = fs.realpathSync(path.dirname(requested));
    resolved = path.join(parent, path.basename(requested));
  }
  if (isSensitivePath(resolved)) throw new Error('Sensitive path is blocked');
  const allowed = [];
  for (const dir of allowedDirectories) {
    let real;
    try {
      real = fs.realpathSync(path.resolve(String(dir)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      continue;
    }
    if (!allowed.some(entry => samePath(entry, real))) allowed.push(real);
  }
  if (!allowed.length) {
    throw new Error(allowedDirectories.length
      ? 'Allowlisted directories no longer exist'
      : 'Path is outside the allowlist');
  }
  if (!allowed.some(dir => isWithinDirectory(resolved, dir))) {
    throw new Error('Path is outside the allowlist');
  }
  return resolved;
}

module.exports = {
  PREFERRED_ALLOWLIST,
  loadPolicy,
  savePolicy,
  defaultPolicy,
  isLoopback,
  markReauth,
  recentlyReauthed,
  computerToolsAllowed,
  resolveAllowed,
  isSensitivePath,
};
