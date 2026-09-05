const path = require('path');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 500000;
const MAX_PREVIEW_HTML_CHARS = 800000;
// A hostile PDF can declare thousands of mostly-empty pages; extraction stops
// after this many pages so memory and event-loop time stay bounded.
const MAX_PDF_PAGES = 500;

const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const ALLOWED = {
  ...IMAGE_EXTENSIONS,
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function inferPreviewKind(mimeType, filename, storedKind = '') {
  const stored = String(storedKind || '').trim();
  if (stored === 'image' || stored === 'pdf' || stored === 'docx' || stored === 'text') return stored;
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('wordprocessingml') || mime.includes('officedocument')) return 'docx';
  const ext = path.extname(filename || '').toLowerCase();
  if (IMAGE_EXTENSIONS[ext]) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.md' || ext === '.txt') return 'text';
  return 'text';
}

function clipText(text, max = MAX_TEXT_CHARS) {
  const value = String(text || '').replace(/\u0000/g, '');
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function isImageKind(kind) {
  if (!kind) return false;
  return Boolean(IMAGE_EXTENSIONS[kind.ext]) || String(kind.mimeType || '').startsWith('image/');
}

function sniffKind(filename, mimeType) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ALLOWED[ext]) return { ext, mimeType: ALLOWED[ext] };
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('markdown')) return { ext: '.md', mimeType: ALLOWED['.md'] };
  if (mime.includes('text/plain')) return { ext: '.txt', mimeType: ALLOWED['.txt'] };
  if (mime.includes('pdf')) return { ext: '.pdf', mimeType: ALLOWED['.pdf'] };
  if (mime.includes('wordprocessingml') || mime.includes('officedocument')) return { ext: '.docx', mimeType: ALLOWED['.docx'] };
  if (mime.startsWith('image/')) {
    const matched = Object.entries(IMAGE_EXTENSIONS).find(([, value]) => value === mime);
    return { ext: matched?.[0] || '.png', mimeType: mime };
  }
  return null;
}

async function extractPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // isEvalSupported:false is the official mitigation for CVE-2024-4367.
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const pages = [];
  for (let i = 1; i <= pageCount; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
  }
  const text = clipText(pages.join('\n\n'));
  const status = pageCount > 0 && text.replace(/\s+/g, '').length < pageCount * 40 ? 'needs_ocr' : 'active';
  return { text, status, previewKind: 'pdf' };
}

async function extractDocx(buffer) {
  const mammoth = require('mammoth');
  const options = docxConvertOptions(mammoth);
  const [textResult, htmlResult] = await Promise.all([
    mammoth.extractRawText({ buffer }),
    mammoth.convertToHtml({ buffer }, options),
  ]);
  return {
    text: clipText(textResult.value),
    previewHtml: clipText(htmlResult.value, MAX_PREVIEW_HTML_CHARS),
    status: 'active',
    previewKind: 'docx',
  };
}

function docxConvertOptions(mammoth) {
  return {
    convertImage: mammoth.images.imgElement(image => image.readAsBase64String().then(base64 => ({
      src: `data:${image.contentType};base64,${base64}`,
    }))),
  };
}

async function extractDocxPreview(buffer) {
  const mammoth = require('mammoth');
  const htmlResult = await mammoth.convertToHtml({ buffer }, docxConvertOptions(mammoth));
  return clipText(htmlResult.value, MAX_PREVIEW_HTML_CHARS);
}

async function extractText(buffer, filename, mimeType) {
  const kind = sniffKind(filename, mimeType);
  if (!kind) return { error: 'Unsupported file type', status: 400 };
  if (buffer.length > MAX_FILE_BYTES) return { error: 'File exceeds 20MB limit', status: 400 };
  try {
    if (isImageKind(kind)) {
      return {
        text: '',
        previewKind: 'image',
        status: 'active',
        mimeType: kind.mimeType,
        filename,
      };
    }
    if (kind.ext === '.md' || kind.ext === '.txt') {
      return {
        text: clipText(buffer.toString('utf8')),
        previewKind: 'text',
        status: 'active',
        mimeType: kind.mimeType,
        filename,
      };
    }
    if (kind.ext === '.pdf') {
      const extracted = await extractPdf(buffer);
      return { ...extracted, mimeType: kind.mimeType, filename };
    }
    const extracted = await extractDocx(buffer);
    return { ...extracted, mimeType: kind.mimeType, filename };
  } catch {
    return {
      text: '',
      previewHtml: '',
      previewKind: kind.ext === '.pdf' ? 'pdf' : (kind.ext === '.docx' ? 'docx' : 'text'),
      status: 'parse_error',
      mimeType: kind.mimeType,
      filename,
    };
  }
}

module.exports = {
  extractText,
  extractDocxPreview,
  sniffKind,
  inferPreviewKind,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  IMAGE_EXTENSIONS,
};
