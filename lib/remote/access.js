const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PAIRING_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'liuxu_remote_session';
const CSRF_COOKIE = 'liuxu_remote_csrf';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { result[key] = ''; }
  }
  return result;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizePublicUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function normalizeStored(raw = {}) {
  const port = Number(raw.port);
  return {
    version: 1,
    enabled: raw.enabled === true,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 43140,
    publicUrl: normalizePublicUrl(raw.publicUrl),
    devices: Array.isArray(raw.devices) ? raw.devices.filter(Boolean).map(item => ({
      id: String(item.id || ''),
      name: String(item.name || '手机').slice(0, 80),
      createdAt: Number(item.createdAt) || Date.now(),
      lastSeenAt: Number(item.lastSeenAt) || 0,
    })).filter(item => item.id) : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions.filter(Boolean).map(item => ({
      id: String(item.id || ''),
      deviceId: String(item.deviceId || ''),
      tokenHash: String(item.tokenHash || ''),
      csrfHash: String(item.csrfHash || ''),
      createdAt: Number(item.createdAt) || Date.now(),
      expiresAt: Number(item.expiresAt) || 0,
      lastSeenAt: Number(item.lastSeenAt) || 0,
    })).filter(item => item.id && item.deviceId && /^[a-f0-9]{64}$/.test(item.tokenHash)) : [],
  };
}

function createRemoteAccessService({ statePath, now = () => Date.now() } = {}) {
  if (!statePath || !path.isAbsolute(statePath)) throw new Error('remote access statePath must be absolute');
  let state = normalizeStored();
  const pairingTokens = new Map();
  const pairingRequests = new Map();
  let connection = { state: 'unavailable', message: '尚未检测 Tailscale', dnsName: '', serveConfigured: false };

  try { state = normalizeStored(JSON.parse(fs.readFileSync(statePath, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }

  function save() {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, statePath);
    try { fs.chmodSync(statePath, 0o600); } catch {}
  }

  function prune() {
    const time = now();
    const before = state.sessions.length;
    state.sessions = state.sessions.filter(item => item.expiresAt > time && state.devices.some(device => device.id === item.deviceId));
    for (const [key, value] of pairingTokens) if (value.expiresAt <= time || value.used) pairingTokens.delete(key);
    for (const [key, value] of pairingRequests) if (value.expiresAt <= time) pairingRequests.delete(key);
    if (before !== state.sessions.length) save();
  }

  function snapshot() {
    prune();
    return {
      enabled: state.enabled,
      port: state.port,
      publicUrl: state.publicUrl,
      connection: { ...connection },
      devices: state.devices.map(device => ({
        ...device,
        activeSessions: state.sessions.filter(session => session.deviceId === device.id).length,
      })),
      pending: [...pairingRequests.values()].filter(item => item.status === 'pending').map(item => ({
        id: item.id,
        name: item.name,
        userAgent: item.userAgent,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
      })),
    };
  }

  function configure(input = {}) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('远程端口必须在 1024–65535 之间');
    const publicUrl = input.publicUrl === undefined ? state.publicUrl : normalizePublicUrl(input.publicUrl);
    if (input.publicUrl && !publicUrl) throw new Error('手机访问地址必须是 HTTPS 根地址');
    const disabling = state.enabled && input.enabled !== true;
    state.enabled = input.enabled === true;
    state.port = port;
    state.publicUrl = publicUrl;
    if (disabling) {
      state.sessions = [];
      pairingTokens.clear();
      pairingRequests.clear();
    }
    save();
    return snapshot();
  }

  function setConnectionStatus(value = {}) {
    connection = {
      state: String(value.state || 'unavailable'),
      message: String(value.message || ''),
      dnsName: String(value.dnsName || ''),
      serveConfigured: value.serveConfigured === true,
    };
    if (Object.prototype.hasOwnProperty.call(value, 'publicUrl')) {
      const normalized = normalizePublicUrl(value.publicUrl) || '';
      if (normalized !== state.publicUrl) {
        state.publicUrl = normalized;
        save();
      }
    }
    return snapshot();
  }

  function createPairing() {
    prune();
    if (!state.enabled) throw new Error('请先开启远程访问');
    if (!state.publicUrl) throw new Error('尚未取得 Tailscale HTTPS 地址');
    const token = randomToken();
    const expiresAt = now() + PAIRING_TTL_MS;
    pairingTokens.set(sha256(token), { expiresAt, used: false });
    return { url: `${state.publicUrl}/?pair=${encodeURIComponent(token)}`, token, expiresAt };
  }

  function requestPair({ token, name, userAgent } = {}) {
    prune();
    if (!state.enabled) return { error: '远程访问未开启', status: 503 };
    const key = sha256(token);
    const pairing = pairingTokens.get(key);
    if (!pairing || pairing.used || pairing.expiresAt <= now()) return { error: '配对码无效、已使用或已过期', status: 410 };
    pairing.used = true;
    pairingTokens.delete(key);
    const id = crypto.randomUUID();
    const pollToken = randomToken();
    const createdAt = now();
    pairingRequests.set(id, {
      id,
      pollHash: sha256(pollToken),
      name: String(name || '手机浏览器').trim().slice(0, 80) || '手机浏览器',
      userAgent: String(userAgent || '').slice(0, 240),
      status: 'pending',
      createdAt,
      expiresAt: Math.min(pairing.expiresAt, createdAt + PAIRING_TTL_MS),
    });
    return { requestId: id, pollToken, expiresAt: pairing.expiresAt };
  }

  function approvePairing(id) {
    prune();
    const request = pairingRequests.get(String(id || ''));
    if (!request || request.status !== 'pending') throw new Error('配对请求不存在或已处理');
    const device = { id: crypto.randomUUID(), name: request.name, createdAt: now(), lastSeenAt: now() };
    const sessionToken = randomToken();
    const csrfToken = randomToken(24);
    const session = {
      id: crypto.randomUUID(),
      deviceId: device.id,
      tokenHash: sha256(sessionToken),
      csrfHash: sha256(csrfToken),
      createdAt: now(),
      expiresAt: now() + SESSION_TTL_MS,
      lastSeenAt: now(),
    };
    state.devices.push(device);
    state.sessions.push(session);
    request.status = 'approved';
    request.sessionToken = sessionToken;
    request.csrfToken = csrfToken;
    request.deviceId = device.id;
    save();
    return snapshot();
  }

  function denyPairing(id) {
    const request = pairingRequests.get(String(id || ''));
    if (!request || request.status !== 'pending') throw new Error('配对请求不存在或已处理');
    request.status = 'denied';
    return snapshot();
  }

  function pairingStatus(id, pollToken) {
    prune();
    const request = pairingRequests.get(String(id || ''));
    if (!request || !safeEqual(request.pollHash, sha256(pollToken))) return { error: '配对请求不存在', status: 404 };
    if (request.status === 'denied') return { state: 'denied' };
    if (request.status !== 'approved') return { state: 'pending', expiresAt: request.expiresAt };
    const device = state.devices.find(item => item.id === request.deviceId);
    return {
      state: 'approved',
      sessionToken: request.sessionToken,
      csrfToken: request.csrfToken,
      expiresAt: state.sessions.find(item => item.deviceId === request.deviceId)?.expiresAt || 0,
      device: device ? { ...device } : null,
    };
  }

  function authenticate(cookieHeader) {
    prune();
    const token = parseCookies(cookieHeader)[SESSION_COOKIE] || '';
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = state.sessions.find(item => safeEqual(item.tokenHash, tokenHash));
    if (!session) return null;
    const device = state.devices.find(item => item.id === session.deviceId);
    if (!device) return null;
    const time = now();
    if (time - session.lastSeenAt > 60 * 1000) {
      session.lastSeenAt = time;
      device.lastSeenAt = time;
      save();
    }
    return { session, device };
  }

  function verifyCsrf(auth, cookieHeader, headerToken) {
    const cookieToken = parseCookies(cookieHeader)[CSRF_COOKIE] || '';
    return Boolean(auth?.session && cookieToken && headerToken
      && safeEqual(cookieToken, headerToken)
      && safeEqual(auth.session.csrfHash, sha256(headerToken)));
  }

  function revokeDevice(id) {
    const deviceId = String(id || '');
    state.devices = state.devices.filter(item => item.id !== deviceId);
    state.sessions = state.sessions.filter(item => item.deviceId !== deviceId);
    save();
    return snapshot();
  }

  function revokeSessionFromCookie(cookieHeader) {
    const token = parseCookies(cookieHeader)[SESSION_COOKIE] || '';
    if (!token) return;
    const tokenHash = sha256(token);
    state.sessions = state.sessions.filter(item => !safeEqual(item.tokenHash, tokenHash));
    save();
  }

  function revokeAll() {
    state.sessions = [];
    state.devices = [];
    pairingTokens.clear();
    pairingRequests.clear();
    save();
    return snapshot();
  }

  function clearSessions() {
    state.sessions = [];
    pairingTokens.clear();
    pairingRequests.clear();
    save();
    return snapshot();
  }

  return {
    snapshot, configure, setConnectionStatus, createPairing, requestPair, approvePairing, denyPairing,
    pairingStatus, authenticate, verifyCsrf, revokeDevice, revokeSessionFromCookie, revokeAll, clearSessions,
  };
}

module.exports = {
  createRemoteAccessService,
  normalizePublicUrl,
  parseCookies,
  SESSION_COOKIE,
  CSRF_COOKIE,
  PAIRING_TTL_MS,
  SESSION_TTL_MS,
};
