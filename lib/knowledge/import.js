const path = require('node:path');
const yauzl = require('yauzl');
const JSZip = require('jszip');
const { MAX_FILE_BYTES, MAX_PARSE_BYTES, IMAGE_TYPES, TEXT_TYPES, ALL_TYPES, fileKind, inferPreviewKind } = require('./file-formats');

const MAX_TEXT_CHARS = 500000;
const MAX_PREVIEW_HTML_CHARS = 800000;
const MAX_PDF_PAGES = 500;
const MAX_OFFICE_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_OFFICE_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_OFFICE_ENTRIES = 20000;
const IMAGE_EXTENSIONS = IMAGE_TYPES;
const ALLOWED = ALL_TYPES;

function clipText(text, max = MAX_TEXT_CHARS) {
  const value = String(text || '').replace(/\u0000/g, '');
  return value.length <= max ? value : value.slice(0, max);
}

function isImageKind(kind) { return Boolean(IMAGE_TYPES[kind.ext]); }

function sniffKind(filename, mimeType) {
  const kind = fileKind(filename, mimeType);
  if (kind.previewKind === 'unsupported' && !ALL_TYPES[kind.ext]) return null;
  return { ext: kind.ext, mimeType: kind.mimeType, previewKind: kind.previewKind };
}

function decodeXml(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function validateOfficeArchive(filePath, filename, { verifyData = true } = {}) {
  const supplied = String(filename || '').toLowerCase();
  const ext = /^\.(docx|xlsx|pptx|ods)$/.test(supplied) ? supplied : path.extname(supplied).toLowerCase();
  const expected = ext === '.docx' ? ['word/document.xml']
    : ext === '.xlsx' ? ['xl/workbook.xml']
      : ext === '.pptx' ? ['ppt/presentation.xml']
        : ext === '.ods' ? ['content.xml', 'mimetype'] : null;
  if (!expected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (openError, zip) => {
      if (openError) return reject(new Error('Office 文件容器损坏或格式不匹配'));
      const names = new Set();
      let count = 0;
      let declared = 0;
      let actual = 0;
      let settled = false;
      const timer = setTimeout(() => fail(new Error('Office 文件检查超时')), 60000);
      timer.unref?.();
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        zip.close();
        reject(error);
      };
      zip.on('error', error => fail(new Error(`Office 文件读取失败：${error.message}`)));
      zip.on('entry', entry => {
        const name = String(entry.fileName || '').replace(/\\/g, '/');
        const unixMode = (Number(entry.externalFileAttributes) >>> 16) & 0xf000;
        const size = Number(entry.uncompressedSize) || 0;
        count += 1;
        declared += size;
        if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')
          || unixMode === 0xa000 || (entry.generalPurposeBitFlag & 1)) return fail(new Error('Office 文件包含不安全或加密条目'));
        if (count > MAX_OFFICE_ENTRIES || declared > MAX_OFFICE_EXPANDED_BYTES || size > MAX_OFFICE_ENTRY_BYTES) {
          return fail(new Error('Office 文件解压内容超出预览安全限制'));
        }
        names.add(name);
        if (!verifyData || entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError);
          let entryBytes = 0;
          stream.on('data', chunk => {
            entryBytes += chunk.length;
            actual += chunk.length;
            if (entryBytes > MAX_OFFICE_ENTRY_BYTES || actual > MAX_OFFICE_EXPANDED_BYTES) {
              stream.destroy(new Error('Office 文件解压内容超出预览安全限制'));
            }
          });
          stream.on('error', fail);
          stream.on('end', () => {
            if (entryBytes !== size) return fail(new Error(`Office 文件条目大小校验失败：${name}`));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        if (settled) return;
        if (!expected.every(name => names.has(name))) return fail(new Error('Office 文件类型与扩展名不匹配'));
        settled = true;
        clearTimeout(timer);
        resolve({ entries: count, expandedBytes: actual || declared });
      });
      zip.readEntry();
    });
  });
}

function decodeTextBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    return new TextDecoder('utf-16le').decode(swapped);
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return new TextDecoder('utf-8').decode(buffer.subarray(3));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { try { return new TextDecoder('gb18030').decode(buffer); } catch { return buffer.toString('utf8'); } }
}

async function extractPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false });
  try {
    const pdf = await loadingTask.promise;
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const pages = [];
    for (let i = 1; i <= pageCount; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(' '));
      page.cleanup?.();
    }
    const text = clipText(pages.join('\n\n'));
    const status = pageCount > 0 && text.replace(/\s+/g, '').length < pageCount * 40 ? 'needs_ocr' : 'active';
    return { text, status, previewKind: 'pdf' };
  } finally { await loadingTask.destroy?.(); }
}

function docxConvertOptions(mammoth) {
  return { convertImage: mammoth.images.imgElement(image => image.readAsBase64String().then(base64 => ({ src: `data:${image.contentType};base64,${base64}` }))) };
}

async function extractDocx(buffer, includeHtml = false) {
  const mammoth = require('mammoth');
  const options = docxConvertOptions(mammoth);
  const [textResult, htmlResult] = await Promise.all([
    mammoth.extractRawText({ buffer }),
    includeHtml ? mammoth.convertToHtml({ buffer }, options) : Promise.resolve({ value: '' }),
  ]);
  return { text: clipText(textResult.value), previewHtml: clipText(htmlResult.value, MAX_PREVIEW_HTML_CHARS), status: 'active', previewKind: 'docx' };
}

async function extractDocxPreview(buffer) {
  return (await extractDocx(buffer)).previewHtml;
}

async function extractSpreadsheet(buffer) {
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: true, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, WTF: false });
  const rows = [];
  for (const name of workbook.SheetNames) {
    rows.push(`# ${name}`);
    const sheet = workbook.Sheets[name];
    const values = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false, defval: '' });
    for (const row of values) rows.push(row.map(value => String(value ?? '')).join('\t'));
    if (rows.join('\n').length >= MAX_TEXT_CHARS) break;
  }
  return { text: clipText(rows.join('\n')), previewKind: 'spreadsheet', status: 'active' };
}

async function extractPresentation(buffer) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)[1]) - Number(b.match(/slide(\d+)/i)[1]));
  const text = [];
  for (const name of slides) {
    const xml = await zip.file(name).async('string');
    const bits = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1]));
    text.push(bits.join(' '));
  }
  return { text: clipText(text.join('\n\n')), previewKind: 'presentation', status: 'active' };
}

async function extractText(buffer, filename, mimeType) {
  const kind = sniffKind(filename, mimeType);
  if (!kind) return { error: 'Unsupported file type', status: 400 };
  if (buffer.length > MAX_FILE_BYTES) return { error: 'File exceeds 250 MiB limit', status: 413 };
  const base = { previewKind: kind.previewKind, status: 'active', mimeType: kind.mimeType, filename };
  if (isImageKind(kind) || ['audio', 'video', 'archive', 'unsupported'].includes(kind.previewKind)) return { ...base, text: '' };
  if (kind.ext === '.pdf' && buffer.length > MAX_PARSE_BYTES) return { ...base, text: '', previewLimited: true };
  if (['.docx', '.xlsx', '.xls', '.ods', '.pptx'].includes(kind.ext) && buffer.length > MAX_PARSE_BYTES) {
    return { ...base, text: '', previewLimited: true };
  }
  try {
    if (TEXT_TYPES[kind.ext]) return { ...base, text: clipText(decodeTextBuffer(buffer)) };
    if (kind.ext === '.pdf') return { ...base, ...await extractPdf(buffer) };
    if (kind.ext === '.docx') return { ...base, ...await extractDocx(buffer, false) };
    if (['.xlsx', '.xls', '.ods'].includes(kind.ext)) return { ...base, ...await extractSpreadsheet(buffer) };
    if (kind.ext === '.pptx') return { ...base, ...await extractPresentation(buffer) };
    return { ...base, text: '' };
  } catch {
    return { ...base, text: '', previewHtml: '', status: 'parse_error' };
  }
}

module.exports = { extractText, extractDocxPreview, sniffKind, inferPreviewKind, validateOfficeArchive, MAX_FILE_BYTES, MAX_PARSE_BYTES, MAX_TEXT_CHARS, IMAGE_EXTENSIONS, ALLOWED };
