const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
// Precomputed scrypt hash used only to equalize login timing when a username does not
// exist, so the response time cannot be used to enumerate valid usernames.
const DUMMY_PASSWORD_HASH = hashSecret('timing-equalization-dummy');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function failCorrupt(label, file, error) {
  let backup = '';
  try {
    if (fs.existsSync(file)) {
      backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    }
  } catch {}
  const suffix = backup ? `; preserved at ${backup}` : '';
  throw new Error(`Failed to read ${label}: ${error.message}${suffix}`);
}

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  return USERNAME_PATTERN.test(username) ? username : '';
}

function validateDisplayName(value, fallback = '') {
  if (typeof value !== 'string') return null;
  const displayName = value.trim();
  if (!displayName || displayName.length > 50) return null;
  return displayName || fallback;
}

function validateNewPassword(value) {
  return typeof value === 'string' && value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
}

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(secret), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifySecret(secret, encoded) {
  if (typeof secret !== 'string' || typeof encoded !== 'string') return false;
  if (encoded.startsWith('sha256$')) {
    const actual = crypto.createHash('sha256').update(secret).digest('hex');
    const expected = encoded.slice('sha256$'.length);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  }
  const match = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{128})$/i.exec(encoded);
  if (!match) return false;
  const actual = crypto.scryptSync(secret, Buffer.from(match[1], 'hex'), 64);
  const expected = Buffer.from(match[2], 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    must_change_password: user.must_change_password === true,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at || '',
  };
}

function validateStoredUser(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error('Invalid user record');
  if (typeof user.id !== 'string' || !UUID_PATTERN.test(user.id)) throw new Error('Invalid user id');
  if (!validateUsername(user.username)) throw new Error('Invalid stored username');
  if (typeof user.display_name !== 'string' || !user.display_name || user.display_name.length > 50) throw new Error('Invalid stored display name');
  if (!/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/i.test(user.password_hash || '')) throw new Error('Invalid stored password hash');
  if (!['admin', 'member'].includes(user.role)) throw new Error('Invalid stored user role');
  if (!['active', 'disabled'].includes(user.status)) throw new Error('Invalid stored user status');
  if (user.storage_key !== 'legacy' && !UUID_PATTERN.test(user.storage_key || '')) throw new Error('Invalid stored storage key');
  if (typeof user.must_change_password !== 'boolean') throw new Error('Invalid stored password-change flag');
  if (!Number.isFinite(Date.parse(user.created_at)) || !Number.isFinite(Date.parse(user.updated_at))) {
    throw new Error('Invalid stored user timestamps');
  }
  if (user.last_login_at && !Number.isFinite(Date.parse(user.last_login_at))) throw new Error('Invalid stored last login timestamp');
  return {
    ...user,
    username: normalizeUsername(user.username),
    must_change_password: user.must_change_password === true,
    last_login_at: typeof user.last_login_at === 'string' ? user.last_login_at : '',
  };
}

function createAuthStore({
  dataDir,
  bootstrapPassword = '',
  allowInsecureNoAuth = false,
  now = () => Date.now(),
} = {}) {
  const root = path.resolve(dataDir || path.join(__dirname, 'data'));
  const usersFile = path.join(root, 'users.json');
  const sessionsFile = path.join(root, 'auth-sessions.json');
  const disabled = !fs.existsSync(usersFile) && !bootstrapPassword && allowInsecureNoAuth;
  const localUser = {
    id: 'local-insecure-user',
    username: 'local',
    display_name: '本地用户',
    password_hash: '',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    storage_key: 'legacy',
    created_at: '',
    updated_at: '',
    last_login_at: '',
  };
  let usersCache = null;
  let sessionsCache = null;

  function readUsers() {
    if (disabled) return [clone(localUser)];
    if (usersCache) return clone(usersCache);
    try {
      const parsed = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      const source = Array.isArray(parsed) ? parsed : parsed?.users;
      if (!Array.isArray(source) || !source.length) throw new Error('User registry is empty');
      const users = source.map(validateStoredUser);
      const ids = new Set();
      const usernames = new Set();
      const storageKeys = new Set();
      for (const user of users) {
        if (ids.has(user.id) || usernames.has(user.username) || storageKeys.has(user.storage_key)) {
          throw new Error('Duplicate user id, username, or storage key');
        }
        ids.add(user.id);
        usernames.add(user.username);
        storageKeys.add(user.storage_key);
      }
      usersCache = users;
      return clone(usersCache);
    } catch (err) {
      return failCorrupt('users.json', usersFile, err);
    }
  }

  function writeUsers(users) {
    if (disabled) throw new Error('Account management is disabled');
    const normalized = users.map(validateStoredUser);
    atomicWriteJson(usersFile, { version: 1, users: normalized });
    usersCache = clone(normalized);
    return clone(normalized);
  }

  function readSessions() {
    if (disabled) return [];
    if (sessionsCache) return clone(sessionsCache);
    if (!fs.existsSync(sessionsFile)) {
      sessionsCache = [];
      return [];
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      const source = Array.isArray(parsed) ? parsed : parsed?.sessions;
      if (!Array.isArray(source)) throw new Error('Invalid session registry');
      const tokenHashes = new Set();
      sessionsCache = source.map(session => {
        if (!session || !/^[0-9a-f]{64}$/i.test(session.token_hash || '') || !UUID_PATTERN.test(session.user_id || '')) {
          throw new Error('Invalid session record');
        }
        if (tokenHashes.has(session.token_hash)) throw new Error('Duplicate session token hash');
        tokenHashes.add(session.token_hash);
        const expiresAt = Number(session.expires_at);
        const createdAt = Number(session.created_at);
        if (!Number.isFinite(expiresAt) || !Number.isFinite(createdAt) || expiresAt <= createdAt) {
          throw new Error('Invalid session timestamps');
        }
        return { token_hash: session.token_hash, user_id: session.user_id, created_at: createdAt, expires_at: expiresAt };
      });
      return clone(sessionsCache);
    } catch (err) {
      return failCorrupt('auth-sessions.json', sessionsFile, err);
    }
  }

  function writeSessions(sessions) {
    if (disabled) return [];
    atomicWriteJson(sessionsFile, { version: 1, sessions });
    sessionsCache = clone(sessions);
    return clone(sessions);
  }

  function ensureInitialized() {
    fs.mkdirSync(root, { recursive: true });
    if (disabled) return;
    if (!fs.existsSync(usersFile)) {
      if (!bootstrapPassword) throw new Error('AUTH_TOKEN is required to initialize the first administrator');
      const timestamp = new Date(now()).toISOString();
      writeUsers([{
        id: crypto.randomUUID(),
        username: 'admin',
        display_name: '管理员',
        password_hash: hashSecret(bootstrapPassword),
        role: 'admin',
        status: 'active',
        must_change_password: true,
        storage_key: 'legacy',
        created_at: timestamp,
        updated_at: timestamp,
        last_login_at: '',
      }]);
    } else {
      readUsers();
    }
    if (!fs.existsSync(sessionsFile)) writeSessions([]);
    else cleanupExpiredSessions();
  }

  function cleanupExpiredSessions() {
    if (disabled) return;
    const sessions = readSessions();
    const users = new Map(readUsers().map(user => [user.id, user]));
    const valid = sessions.filter(session => {
      const user = users.get(session.user_id);
      return session.expires_at > now() && user?.status === 'active';
    });
    if (valid.length !== sessions.length) writeSessions(valid);
  }

  function getUserById(id) {
    return readUsers().find(user => user.id === id) || null;
  }

  function getUserByUsername(username) {
    const normalized = normalizeUsername(username);
    return readUsers().find(user => user.username === normalized) || null;
  }

  function authenticate(username, password) {
    if (disabled) return clone(localUser);
    const user = getUserByUsername(username);
    if (!user) {
      // Username does not exist: run a dummy scrypt to keep timing consistent with a
      // real password check, preventing username enumeration through response time.
      verifySecret(password, DUMMY_PASSWORD_HASH);
      return null;
    }
    if (user.status !== 'active' || !verifySecret(password, user.password_hash)) return null;
    const users = readUsers();
    const target = users.find(item => item.id === user.id);
    target.last_login_at = new Date(now()).toISOString();
    target.updated_at = target.updated_at || target.last_login_at;
    writeUsers(users);
    return getUserById(user.id);
  }

  function createSession(userId) {
    if (disabled) return { token: '', expires_at: now() + SESSION_TTL_MS };
    cleanupExpiredSessions();
    const token = crypto.randomBytes(32).toString('hex');
    const session = {
      token_hash: hashSessionToken(token),
      user_id: userId,
      created_at: now(),
      expires_at: now() + SESSION_TTL_MS,
    };
    writeSessions([...readSessions(), session]);
    return { token, expires_at: session.expires_at };
  }

  function getSession(token) {
    if (disabled) return { user: clone(localUser), session: null };
    if (!token) return null;
    const tokenHash = hashSessionToken(token);
    const session = readSessions().find(item => item.token_hash === tokenHash && item.expires_at > now());
    if (!session) return null;
    const user = getUserById(session.user_id);
    if (!user || user.status !== 'active') return null;
    return { user, session };
  }

  function revokeSession(token) {
    if (disabled || !token) return;
    const tokenHash = hashSessionToken(token);
    writeSessions(readSessions().filter(session => session.token_hash !== tokenHash));
  }

  function revokeUserSessions(userId) {
    if (disabled) return;
    writeSessions(readSessions().filter(session => session.user_id !== userId));
  }

  function updateProfile(userId, displayName) {
    const clean = validateDisplayName(displayName);
    if (!clean) return { error: '显示名称必须为 1-50 个字符' };
    const users = readUsers();
    const user = users.find(item => item.id === userId);
    if (!user) return { error: '账户不存在' };
    user.display_name = clean;
    user.updated_at = new Date(now()).toISOString();
    writeUsers(users);
    return { user: publicUser(user) };
  }

  function changePassword(userId, currentPassword, newPassword) {
    if (!validateNewPassword(newPassword)) return { error: '新密码必须为 10-128 个字符' };
    const users = readUsers();
    const user = users.find(item => item.id === userId);
    if (!user || !verifySecret(currentPassword, user.password_hash)) return { error: '当前密码错误' };
    user.password_hash = hashSecret(newPassword);
    user.must_change_password = false;
    user.updated_at = new Date(now()).toISOString();
    writeUsers(users);
    revokeUserSessions(userId);
    return { user: publicUser(user) };
  }

  function createUser(input) {
    const username = validateUsername(input?.username);
    const displayName = validateDisplayName(input?.display_name || input?.username || '');
    const password = input?.temporary_password;
    if (input?.role !== undefined && !['admin', 'member'].includes(input.role)) return { error: '角色无效' };
    const role = input?.role === 'admin' ? 'admin' : 'member';
    if (!username) return { error: '用户名必须为 3-32 位字母、数字、点、下划线或短横线' };
    if (!displayName) return { error: '显示名称必须为 1-50 个字符' };
    if (!validateNewPassword(password)) return { error: '临时密码必须为 10-128 个字符' };
    const users = readUsers();
    if (users.some(user => user.username === username)) return { error: '用户名已存在' };
    const timestamp = new Date(now()).toISOString();
    const user = {
      id: crypto.randomUUID(),
      username,
      display_name: displayName,
      password_hash: hashSecret(password),
      role,
      status: 'active',
      must_change_password: true,
      storage_key: crypto.randomUUID(),
      created_at: timestamp,
      updated_at: timestamp,
      last_login_at: '',
    };
    writeUsers([...users, user]);
    return { user: publicUser(user), storage_key: user.storage_key };
  }

  function activeAdminCount(users, excludingId = '') {
    return users.filter(user => user.id !== excludingId && user.role === 'admin' && user.status === 'active').length;
  }

  function updateUser(userId, patch) {
    const users = readUsers();
    const user = users.find(item => item.id === userId);
    if (!user) return { error: '账户不存在' };
    if (patch?.username !== undefined) {
      const username = validateUsername(patch.username);
      if (!username) return { error: '用户名格式无效' };
      if (users.some(item => item.id !== userId && item.username === username)) return { error: '用户名已存在' };
      user.username = username;
    }
    if (patch?.display_name !== undefined) {
      const displayName = validateDisplayName(patch.display_name);
      if (!displayName) return { error: '显示名称必须为 1-50 个字符' };
      user.display_name = displayName;
    }
    const nextRole = patch?.role === undefined ? user.role : patch.role;
    const nextStatus = patch?.status === undefined ? user.status : patch.status;
    if (!['admin', 'member'].includes(nextRole)) return { error: '角色无效' };
    if (!['active', 'disabled'].includes(nextStatus)) return { error: '账户状态无效' };
    if (user.role === 'admin' && user.status === 'active' && (nextRole !== 'admin' || nextStatus !== 'active') && activeAdminCount(users, userId) === 0) {
      return { error: '不能停用或降级最后一个有效管理员' };
    }
    user.role = nextRole;
    user.status = nextStatus;
    user.updated_at = new Date(now()).toISOString();
    writeUsers(users);
    if (nextStatus === 'disabled') revokeUserSessions(userId);
    return { user: publicUser(user) };
  }

  function resetPassword(userId, temporaryPassword) {
    if (!validateNewPassword(temporaryPassword)) return { error: '临时密码必须为 10-128 个字符' };
    const users = readUsers();
    const user = users.find(item => item.id === userId);
    if (!user) return { error: '账户不存在' };
    user.password_hash = hashSecret(temporaryPassword);
    user.must_change_password = true;
    user.updated_at = new Date(now()).toISOString();
    writeUsers(users);
    revokeUserSessions(userId);
    return { user: publicUser(user) };
  }

  ensureInitialized();

  return {
    disabled,
    sessionTtlMs: SESSION_TTL_MS,
    publicUser,
    listUsers: () => readUsers().map(publicUser),
    listStoredUsers: () => readUsers().map(clone),
    listActiveUsers: () => readUsers().filter(user => user.status === 'active').map(clone),
    getUserById,
    authenticate,
    createSession,
    getSession,
    revokeSession,
    revokeUserSessions,
    updateProfile,
    changePassword,
    createUser,
    updateUser,
    resetPassword,
  };
}

module.exports = {
  createAuthStore,
  hashSecret,
  verifySecret,
  validateNewPassword,
  validateUsername,
  SESSION_TTL_MS,
};
