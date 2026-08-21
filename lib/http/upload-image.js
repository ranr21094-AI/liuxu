const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const NOTE_UPLOAD_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const AGENT_UPLOAD_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif',
]);

function createUploadStorage(getUploadsDirectory) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      const directory = getUploadsDirectory();
      fs.mkdirSync(directory, { recursive: true });
      cb(null, directory);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      cb(null, name);
    },
  });
}

function createImageUploader({ getUploadsDirectory, maxFileSize, maxFiles = 1, allowedExtensions = NOTE_UPLOAD_EXTENSIONS }) {
  return multer({
    storage: createUploadStorage(getUploadsDirectory),
    limits: {
      fileSize: maxFileSize,
      files: maxFiles,
      fields: 2,
      parts: maxFiles + 2,
      fieldNameSize: 64,
      fieldSize: 64,
    },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowedExtensions.has(ext)) cb(null, true);
      else cb(new Error(`Unsupported image format: ${ext || 'unknown'}`));
    },
  });
}

function uploadedImageMatchesExtension(file, { allowExtended = false } = {}) {
  const ext = path.extname(file.filename).toLowerCase();
  const header = Buffer.alloc(16);
  const fd = fs.openSync(file.path, 'r');
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (bytesRead < 2) return false;
  if (ext === '.png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.jpg' || ext === '.jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (ext === '.gif') return header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (ext === '.webp') return header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
  if (ext === '.bmp') return header.subarray(0, 2).toString('ascii') === 'BM';
  if (allowExtended) {
    if (ext === '.tif' || ext === '.tiff') {
      const le = header.subarray(0, 4).toString('ascii');
      return le === 'II*\0' || le === 'MM\0*';
    }
    if (ext === '.heic' || ext === '.heif') {
      return bytesRead >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp';
    }
  }
  return false;
}

function buildAbsoluteUploadUrl(req, urlPath) {
  const host = req.get('host');
  if (!host) return urlPath;
  const protocol = req.protocol || 'http';
  return `${protocol}://${host}${urlPath.startsWith('/') ? urlPath : `/${urlPath}`}`;
}

function serializeUploadedFile(req, file) {
  const url = `/uploads/${file.filename}`;
  return {
    url,
    filename: file.filename,
    absoluteUrl: buildAbsoluteUploadUrl(req, url),
  };
}

module.exports = {
  NOTE_UPLOAD_EXTENSIONS,
  AGENT_UPLOAD_EXTENSIONS,
  createImageUploader,
  uploadedImageMatchesExtension,
  buildAbsoluteUploadUrl,
  serializeUploadedFile,
};
