const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { extractText } = require('../knowledge/import');

const MAX_AGENT_ATTACHMENTS = 14;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_NATIVE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;
const MAX_TOTAL_TEXT_CHARS = 600000;

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

const TEXT_MIME = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.toml': 'text/plain',
};

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.vue', '.svelte',
  '.py', '.pyw', '.java', '.kt', '.kts', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.cxx',
  '.hpp', '.cs', '.rb', '.php', '.swift', '.m', '.mm', '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gql', '.css', '.scss', '.less', '.ini',
  '.conf', '.dockerfile', '.makefile',
]);

const DOCUMENT_MIME = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const ALLOWED_EXTENSIONS = new Set([
  ...Object.keys(IMAGE_MIME),
  ...Object.keys(TEXT_MIME),
  ...CODE_EXTENSIONS,
  ...Object.keys(DOCUMENT_MIME),
]);

function extensionFor(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext) return ext;
  const base = path.basename(String(filename || '')).toLowerCase();
  if (base === 'dockerfile') return '.dockerfile';
  if (base === 'makefile') return '.makefile';
  return '';
}

function classifyAttachment(filename, mimeType = '') {
  const ext = extensionFor(filename);
  if (IMAGE_MIME[ext]) return { kind: 'image', ext, mimeType: IMAGE_MIME[ext] };
  if (TEXT_MIME[ext]) return { kind: 'text', ext, mimeType: TEXT_MIME[ext] };
  if (CODE_EXTENSIONS.has(ext) || ext === '.dockerfile' || ext === '.makefile') {
    return { kind: 'code', ext, mimeType: String(mimeType || 'text/plain').split(';')[0] || 'text/plain' };
  }
  if (DOCUMENT_MIME[ext]) return { kind: ext === '.pdf' ? 'pdf' : 'docx', ext, mimeType: DOCUMENT_MIME[ext] };
  if (ext === '.doc') return { error: '暂不支持 .doc，请转换为 .docx 或 PDF' };
  const normalizedMime = String(mimeType || '').toLowerCase().split(';')[0];
  if (normalizedMime.startsWith('image/')) return { kind: 'image', ext: ext || '.png', mimeType: normalizedMime };
  return { error: `不支持的附件格式：${ext || normalizedMime || 'unknown'}` };
}

function imageMagicMatches(filePath, ext) {
  const header = Buffer.alloc(16);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const bytes = fs.readSync(fd, header, 0, header.length, 0);
    if (bytes < 2) return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (ext === '.png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.jpg' || ext === '.jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (ext === '.gif') return header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (ext === '.webp') return header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
  if (ext === '.bmp') return header.subarray(0, 2).toString('ascii') === 'BM';
  if (ext === '.tif' || ext === '.tiff') {
    const value = header.subarray(0, 4).toString('ascii');
    return value === 'II*\0' || value === 'MM\0*';
  }
  if (ext === '.heic' || ext === '.heif') return header.subarray(4, 8).toString('ascii') === 'ftyp';
  return false;
}

function documentMagicMatches(filePath, ext) {
  const header = Buffer.alloc(8);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const bytes = fs.readSync(fd, header, 0, header.length, 0);
    if (ext === '.pdf') return bytes >= 5 && header.subarray(0, 5).toString('ascii') === '%PDF-';
    if (ext === '.docx') return bytes >= 4 && header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function clipText(value, max = MAX_TEXT_CHARS) {
  const text = String(value || '').replace(/\u0000/g, '');
  return text.length > max ? text.slice(0, max) : text;
}

function safeDisplayName(value, fallback = 'attachment') {
  const name = String(value || fallback).replace(/[\u0000-\u001f\u007f\r\n]/g, ' ').trim();
  return (name || fallback).slice(0, 240);
}

function createAttachmentStorage(getUploadsDirectory) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      const directory = getUploadsDirectory();
      fs.mkdirSync(directory, { recursive: true });
      cb(null, directory);
    },
    filename: (_req, file, cb) => {
      const ext = extensionFor(file.originalname);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });
}

function createAgentAttachmentUploader({ getUploadsDirectory }) {
  return multer({
    storage: createAttachmentStorage(getUploadsDirectory),
    limits: {
      fileSize: MAX_IMAGE_BYTES,
      files: MAX_AGENT_ATTACHMENTS,
      fields: 4,
      parts: MAX_AGENT_ATTACHMENTS + 4,
      fieldNameSize: 64,
      fieldSize: 64,
    },
    fileFilter: (_req, file, cb) => {
      const classified = classifyAttachment(file.originalname, file.mimetype);
      if (classified.error) return cb(new Error(classified.error));
      cb(null, true);
    },
  });
}

async function inspectUploadedAttachment(file) {
  const classified = classifyAttachment(file.originalname, file.mimetype);
  if (classified.error) throw new Error(classified.error);
  const stat = fs.statSync(file.path);
  const maxBytes = classified.kind === 'image' ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
  if (stat.size > maxBytes) throw new Error(`附件不能超过 ${Math.round(maxBytes / (1024 * 1024))}MB`);
  if (classified.kind === 'image' && !imageMagicMatches(file.path, classified.ext)) {
    throw new Error('文件内容与图片格式不匹配');
  }
  if ((classified.kind === 'pdf' || classified.kind === 'docx') && !documentMagicMatches(file.path, classified.ext)) {
    throw new Error('文件内容与文档格式不匹配');
  }
  if (classified.kind === 'text' || classified.kind === 'code') {
    const sample = fs.readFileSync(file.path).subarray(0, 8192);
    if (isLikelyBinary(sample)) throw new Error('该文件包含二进制内容，无法作为文本附件读取');
  }
  const item = {
    url: `/uploads/${path.basename(file.filename)}`,
    filename: path.basename(file.filename),
    displayName: String(file.originalname || file.filename).slice(0, 240),
    kind: classified.kind,
    mimeType: classified.mimeType,
    size: stat.size,
    sha256: sha256File(file.path),
    extractionStatus: classified.kind === 'image' ? 'active' : 'pending',
    truncated: false,
  };
  if (classified.kind === 'text' || classified.kind === 'code') {
    const text = clipText(fs.readFileSync(file.path, 'utf8'));
    item.extractionStatus = 'active';
    item.truncated = text.length >= MAX_TEXT_CHARS;
    item.extractedChars = text.length;
  } else if (classified.kind === 'pdf' || classified.kind === 'docx') {
    const extracted = await extractText(fs.readFileSync(file.path), item.displayName, item.mimeType);
    item.extractionStatus = extracted.status || 'parse_error';
    item.truncated = String(extracted.text || '').length >= MAX_TEXT_CHARS;
    item.extractedChars = String(extracted.text || '').length;
  }
  return item;
}

function resolveAttachmentPath(url, dataDir, isSafeUploadFilename) {
  const value = String(url || '');
  if (!value.startsWith('/uploads/')) return null;
  const filename = value.slice('/uploads/'.length);
  if (!filename || (typeof isSafeUploadFilename === 'function' && !isSafeUploadFilename(filename))) return null;
  const root = path.resolve(path.join(dataDir, 'uploads'));
  const resolved = path.resolve(path.join(root, filename));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

async function readAttachmentForProvider(attachment, mediaContext, { maxChars = MAX_TEXT_CHARS } = {}) {
  const filePath = resolveAttachmentPath(attachment?.url, mediaContext?.dataDir, mediaContext?.isSafeUploadFilename);
  if (!filePath || !fs.existsSync(filePath)) return null;
  // The generated stored filename is authoritative.  Client-provided labels
  // and MIME metadata are presentation-only and must never change parsing.
  const classified = classifyAttachment(attachment?.filename || path.basename(filePath), undefined);
  if (classified.error) return null;
  if (mediaContext?.allowPrivate === false && typeof mediaContext.isPrivateUpload === 'function') {
    const filename = path.basename(filePath);
    if (mediaContext.isPrivateUpload(filename)) return null;
  }
  const buffer = fs.readFileSync(filePath);
  if (classified.kind === 'image') {
    return { ...classified, filename: safeDisplayName(attachment.displayName || attachment.filename || path.basename(filePath)), buffer };
  }
  let text = '';
  let status = 'active';
  if (classified.kind === 'text' || classified.kind === 'code') {
    text = clipText(buffer.toString('utf8'), maxChars);
    if (buffer.toString('utf8').length > text.length) status = 'truncated';
  } else {
    const extracted = await extractText(buffer, path.basename(filePath), classified.mimeType);
    text = clipText(extracted.text || '', maxChars);
    status = extracted.status || 'parse_error';
    if (String(extracted.text || '').length > text.length) status = 'truncated';
  }
  return {
    ...classified,
    filename: safeDisplayName(attachment.displayName || attachment.filename || path.basename(filePath)),
    text,
    status,
    buffer,
  };
}

module.exports = {
  MAX_AGENT_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_TOTAL_BYTES,
  MAX_NATIVE_BYTES,
  MAX_TEXT_CHARS,
  MAX_TOTAL_TEXT_CHARS,
  ALLOWED_EXTENSIONS,
  classifyAttachment,
  createAgentAttachmentUploader,
  inspectUploadedAttachment,
  resolveAttachmentPath,
  readAttachmentForProvider,
};
