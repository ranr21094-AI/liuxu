const path = require('node:path');

const MAX_FILE_BYTES = 250 * 1024 * 1024;
const MAX_PARSE_BYTES = 30 * 1024 * 1024;

const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
});
const TEXT_TYPES = Object.freeze({
  '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.ts': 'text/typescript', '.tsx': 'text/typescript', '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.c': 'text/plain', '.h': 'text/plain', '.cpp': 'text/plain', '.cc': 'text/plain', '.hpp': 'text/plain',
  '.go': 'text/plain', '.rs': 'text/plain', '.java': 'text/plain', '.swift': 'text/plain', '.kt': 'text/plain',
  '.kts': 'text/plain', '.rb': 'text/plain', '.php': 'text/plain', '.r': 'text/plain', '.lua': 'text/plain',
  '.vue': 'text/plain', '.jsx': 'text/plain', '.svelte': 'text/plain', '.bat': 'text/plain', '.ps1': 'text/plain',
  '.ipynb': 'application/json', '.tex': 'text/plain',
  '.sql': 'application/sql', '.ini': 'text/plain', '.toml': 'text/plain', '.diff': 'text/plain', '.patch': 'text/plain',
});
const OFFICE_TYPES = Object.freeze({
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});
const MEDIA_TYPES = Object.freeze({
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
});
const UNSUPPORTED_TYPES = Object.freeze({
  '.doc': 'application/msword', '.ppt': 'application/vnd.ms-powerpoint', '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic',
});
const EBOOK_TYPES = Object.freeze({ '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook', '.azw3': 'application/vnd.amazon.mobi8-ebook', '.fb2': 'application/x-fictionbook+xml', '.cbz': 'application/vnd.comicbook+zip' });
const ALL_TYPES = Object.freeze({ ...EBOOK_TYPES, ...IMAGE_TYPES, ...TEXT_TYPES, ...OFFICE_TYPES, ...MEDIA_TYPES, ...UNSUPPORTED_TYPES, '.zip': 'application/zip' });
const OFFICE_MIME_TO_EXT = new Map(Object.entries(OFFICE_TYPES).map(([ext, mime]) => [mime, ext]));

function fileKind(filename, mimeType = '') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  let resolvedExt = ALL_TYPES[ext] ? ext : '';
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!resolvedExt && OFFICE_MIME_TO_EXT.has(mime)) resolvedExt = OFFICE_MIME_TO_EXT.get(mime);
  if (!resolvedExt && mime.startsWith('image/')) {
    resolvedExt = Object.entries(IMAGE_TYPES).find(([, value]) => value === mime)?.[0] || '';
  }
  if (!resolvedExt) return { ext, mimeType: mime || 'application/octet-stream', previewKind: 'unsupported' };
  const type = ALL_TYPES[resolvedExt];
  const previewKind = EBOOK_TYPES[resolvedExt] ? 'ebook' : UNSUPPORTED_TYPES[resolvedExt] ? 'unsupported'
    : IMAGE_TYPES[resolvedExt] ? 'image'
    : resolvedExt === '.pdf' ? 'pdf'
      : resolvedExt === '.docx' ? 'docx'
        : ['.xlsx', '.xls', '.ods'].includes(resolvedExt) ? 'spreadsheet'
          : ['.csv', '.tsv'].includes(resolvedExt) ? 'delimited'
            : resolvedExt === '.pptx' ? 'presentation'
              : resolvedExt === '.zip' ? 'archive'
                : ['.mp4', '.webm', '.mov'].includes(resolvedExt) ? 'video'
                  : ['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(resolvedExt) ? 'audio'
                  : 'text';
  return { ext: resolvedExt, mimeType: type || mime || 'application/octet-stream', previewKind };
}

function inferPreviewKind(mimeType, filename, storedKind = '') {
  const detected = fileKind(filename, mimeType).previewKind;
  // Never trust an old ambiguous Office MIME-derived "docx" classification.
  if (storedKind && storedKind === detected) return storedKind;
  return detected;
}

module.exports = { MAX_FILE_BYTES, MAX_PARSE_BYTES, EBOOK_TYPES, IMAGE_TYPES, TEXT_TYPES, OFFICE_TYPES, MEDIA_TYPES, UNSUPPORTED_TYPES, ALL_TYPES, fileKind, inferPreviewKind };
