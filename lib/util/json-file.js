const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function atomicWriteFile(file, contents, { encoding = 'utf8', mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    if (Buffer.isBuffer(contents)) fs.writeFileSync(fd, contents);
    else fs.writeFileSync(fd, contents, encoding);
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

function atomicWriteJson(file, value) {
  atomicWriteFile(file, JSON.stringify(value, null, 2), { encoding: 'utf8' });
}

function readJsonIfExists(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { atomicWriteFile, atomicWriteJson, readJsonIfExists };
