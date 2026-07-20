const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENCRYPTED_PREFIX = 'enc:v1:';
let cachedKey = null;
let cachedKeyFile = '';

function defaultKeyFile() {
  if (process.env.AI_SECRETS_KEY_FILE) return path.resolve(process.env.AI_SECRETS_KEY_FILE);
  const configRoot = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(configRoot, 'work-log', 'ai-secrets.key');
}

function secretError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseKeyFile(content, keyFile) {
  const match = /^v1:([A-Za-z0-9+/]{43}=)$/.exec(String(content || '').trim());
  if (!match) throw secretError('AI_SECRET_KEY_INVALID', `AI secrets key file is invalid: ${keyFile}`);
  const key = Buffer.from(match[1], 'base64');
  if (key.length !== 32) throw secretError('AI_SECRET_KEY_INVALID', `AI secrets key file is invalid: ${keyFile}`);
  return key;
}

function readKeyFile(keyFile) {
  try {
    return parseKeyFile(fs.readFileSync(keyFile, 'utf8'), keyFile);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw secretError('AI_SECRET_KEY_MISSING', `AI secrets key file is missing: ${keyFile}`);
    }
    if (error?.code === 'AI_SECRET_KEY_INVALID') throw error;
    throw secretError('AI_SECRET_KEY_INVALID', `Failed to read AI secrets key file ${keyFile}: ${error.message}`);
  }
}

function createKeyFile(keyFile) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  const key = crypto.randomBytes(32);
  const tempFile = `${keyFile}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempFile, 'wx', 0o600);
    fs.writeFileSync(fd, `v1:${key.toString('base64')}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.renameSync(tempFile, keyFile);
    } catch (error) {
      if (!fs.existsSync(keyFile)) throw error;
      fs.unlinkSync(tempFile);
      return readKeyFile(keyFile);
    }
    try { fs.chmodSync(keyFile, 0o600); } catch {}
    return key;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempFile); } catch {}
    if (error?.code === 'AI_SECRET_KEY_INVALID') throw error;
    throw secretError('AI_SECRET_KEY_INVALID', `Failed to create AI secrets key file ${keyFile}: ${error.message}`);
  }
}

function getKey({ create = false } = {}) {
  const keyFile = defaultKeyFile();
  if (cachedKey && cachedKeyFile === keyFile) return cachedKey;
  cachedKey = fs.existsSync(keyFile) ? readKeyFile(keyFile) : (create ? createKeyFile(keyFile) : null);
  cachedKeyFile = keyFile;
  if (!cachedKey) throw secretError('AI_SECRET_KEY_MISSING', `AI secrets key file is missing: ${keyFile}`);
  return cachedKey;
}

function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

function encryptSecret(value, associatedData) {
  if (typeof value !== 'string' || !value) return '';
  const key = getKey({ create: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(associatedData || ''), 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(value, associatedData) {
  if (!isEncryptedSecret(value)) return value;
  const parts = value.slice(ENCRYPTED_PREFIX.length).split(':');
  if (parts.length !== 3) throw secretError('AI_SECRET_DECRYPT_FAILED', 'Encrypted AI secret has an invalid format');
  try {
    const key = getKey();
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const encrypted = Buffer.from(parts[2], 'base64');
    if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) throw new Error('invalid encrypted payload');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(String(associatedData || ''), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (error) {
    if (['AI_SECRET_KEY_MISSING', 'AI_SECRET_KEY_INVALID'].includes(error?.code)) throw error;
    throw secretError('AI_SECRET_DECRYPT_FAILED', 'Failed to decrypt an AI secret; the key file may be incorrect or the settings may be damaged');
  }
}

function resetSecretStoreForTests() {
  cachedKey = null;
  cachedKeyFile = '';
}

module.exports = {
  decryptSecret,
  defaultKeyFile,
  encryptSecret,
  isEncryptedSecret,
  resetSecretStoreForTests,
};
