const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { app, BrowserWindow } = require('electron');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-file-reader-electron-'));
process.env.DATA_DIR = dataDir;
process.env.AI_SECRETS_KEY_FILE = path.join(dataDir, 'ai-secrets.key');
process.env.LIUXU_DESKTOP = '0';

function makePdf() {
  const stream = 'BT /F1 24 Tf 72 700 Td (PDF preview sample) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'ascii');
}

function makeWav() {
  const sampleRate = 8000;
  const sampleCount = 800;
  const data = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 5000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文 Word preview sample</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function makePptx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>');
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="6000000" cy="2000000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="ctr" wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Presentation preview sample</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function waitFor(webContents, expression, label, timeout = 15000) {
  const start = Date.now();
  let last = null;
  let lastError = '';
  return new Promise(async (resolve, reject) => {
    while (Date.now() - start < timeout) {
      try {
        last = await webContents.executeJavaScript(expression);
        if (last) return resolve();
      } catch (error) { lastError = error.message; }
      await new Promise(done => setTimeout(done, 100));
    }
    reject(new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(last)}; eval error: ${lastError}`));
  });
}

async function main() {
  const db = require('../database');
  const { createKnowledgeService } = require('../lib/knowledge/documents');
  const knowledge = createKnowledgeService(db);
  const add = (filename, mimeType, buffer, text = '') => knowledge.saveImportedFile({
    buffer, filename, mimeType, title: filename, collectionPath: '预览测试', text, diaryUnlocked: false,
  }).document;

  const sheet = XLSX.utils.aoa_to_sheet([
    ['表格预览', ''],
    ['编号', '00000123'],
    ['金额', 1234.5],
  ]);
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  sheet.B2 = { t: 'n', v: 123, z: '00000000' };
  sheet.B3.z = '#,##0.00';
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, sheet, '数据');
  const xlsx = add('季度数据.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const csv = add('导入清单.csv', 'text/csv', Buffer.from('名称,编号,说明\r\n"咖啡","00001234","第一行\r\n第二行"\r\n'), '名称,编号,说明');
  const docx = add('检查报告.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', await makeDocx(), '中文 Word preview sample');
  const pdf = add('合同.pdf', 'application/pdf', makePdf(), 'PDF preview sample');
  const png = add('透明图.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const text = add('代码.py', 'text/x-python', Buffer.from('print("安全文本")\n'), 'print("安全文本")\n');
  const audio = add('提示音.wav', 'audio/wav', makeWav());
  const brokenVideo = add('损坏视频.mp4', 'video/mp4', Buffer.from('not a valid mp4'), '');
  const archiveZip = new JSZip(); archiveZip.file('docs/readme.txt', '压缩包只读目录');
  const archive = add('样本.zip', 'application/zip', await archiveZip.generateAsync({ type: 'nodebuffer' }));
  const pptx = add('演示.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', await makePptx(), 'Presentation preview sample');

  const { startServer } = require('../server');
  const server = await startServer(0, '127.0.0.1');
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: true, width: 1240, height: 820, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => process.stderr.write(`renderer[${level}] ${message} (${sourceId}:${line})\n`));
    window.webContents.on('did-fail-load', (_event, code, description, failedUrl) => process.stderr.write(`did-fail-load ${code}: ${description} ${failedUrl}\n`));
    window.webContents.on('did-finish-load', () => process.stdout.write(`loaded ${window.webContents.getURL()}\n`));
    window.webContents.on('render-process-gone', (_event, details) => process.stderr.write(`renderer gone ${JSON.stringify(details)}\n`));
    const url = `http://127.0.0.1:${server.address().port}/#knowledge/${encodeURIComponent(xlsx.id)}`;
    await window.loadURL(url);
    await waitFor(window.webContents, "document.querySelector('#fileOriginalPanel')?.hidden === false && document.querySelector('.file-grid-table tbody tr:not(.file-grid-spacer) td')?.textContent.includes('表格预览')", 'spreadsheet preview');
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('#assistantToggleButton')?.hidden === false"), true, 'assistant remains available');
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('#filePreviewHost')?.getBoundingClientRect().height > 250"), true, 'reader fills the document area');
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.file-grid-cell-value') !== null && document.querySelector('[data-grid-copy]') !== null"), true, 'spreadsheet cell details and copy action are present');
    window.webContents.executeJavaScript("document.querySelector('.file-grid-table tbody tr:not(.file-grid-spacer) td')?.click()");
    await waitFor(window.webContents, "document.querySelector('[data-grid-cell-value]')?.textContent === '表格预览'", 'selected cell details');
    const desktopShot = await window.webContents.capturePage();
    fs.writeFileSync('/private/tmp/liuxu-file-reader-desktop.png', desktopShot.toPNG());

    await window.webContents.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(csv.id)}'`);
    await waitFor(window.webContents, "document.querySelector('#fileName')?.textContent === '导入清单.csv' && document.querySelector('.file-grid-table tbody')?.textContent.includes('第二行')", 'quoted CSV with a newline');
    assert.equal(await window.webContents.executeJavaScript("[...document.querySelectorAll('.file-grid-table td')].some(cell => cell.textContent === '00001234')"), true, 'CSV keeps leading zeros');

    await window.webContents.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(docx.id)}'`);
    await waitFor(window.webContents, "document.querySelector('#fileName')?.textContent === '检查报告.docx' && document.querySelector('.file-docx-frame')?.srcdoc.includes('中文 Word preview sample')", 'sandboxed Word preview');
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.file-docx-frame')?.hasAttribute('sandbox')"), true, 'Word preview is isolated');

    await window.webContents.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(pdf.id)}'`);
    await waitFor(window.webContents, "document.querySelector('#fileName')?.textContent === '合同.pdf' && document.querySelector('.file-pdf-page-shell[data-rendered=true]')", 'PDF page rendering', 30000);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-pdf-page]')?.max"), '1', 'PDF page navigation is present');

    await window.webContents.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(png.id)}'`);
    await waitFor(window.webContents, "document.querySelector('#fileName')?.textContent === '透明图.png' && document.querySelector('.file-preview-image')?.naturalWidth === 1", 'image preview');
    await window.webContents.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(text.id)}'`);
    await waitFor(window.webContents, "document.querySelector('#fileName')?.textContent === '代码.py' && document.querySelector('.file-preview-code')?.textContent.includes('安全文本')", 'safe code text preview');
    await window.webContents.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(audio.id)}'`);
    await waitFor(window.webContents, "document.querySelector('#fileName')?.textContent === '提示音.wav' && document.querySelector('.file-preview-audio')?.controls && document.querySelector('.file-preview-audio')?.readyState >= 1", 'native audio metadata');
    await window.webContents.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(brokenVideo.id)}'`);
    await waitFor(window.webContents, "document.querySelector('#fileName')?.textContent === '损坏视频.mp4' && document.querySelector('.file-preview-video')?.controls", 'native video player');
    await waitFor(window.webContents, "document.querySelector('.file-preview-video')?.error", 'invalid video reports decode failure');
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.file-preview-video')?.parentElement?.textContent.includes('不受当前系统支持')"), true, 'unsupported media reports a clear fallback');
    await window.webContents.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(archive.id)}'`);
    await waitFor(window.webContents, "document.querySelector('#fileName')?.textContent === '样本.zip' && document.querySelector('.file-archive-row')?.textContent.includes('readme.txt')", 'ZIP read-only listing');
    await window.webContents.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(pptx.id)}'`);
    await waitFor(window.webContents, "document.querySelector('#fileName')?.textContent === '演示.pptx' && document.querySelector('.file-preview-stage')?.textContent.includes('Presentation preview sample')", 'PPTX preview', 30000);
    await waitFor(window.webContents, "[...document.querySelectorAll('.file-preview-stage *')].some(element => element.textContent.trim() === 'Presentation preview sample' && element.getBoundingClientRect().width > 50)", 'visible PPTX text');

    await window.webContents.executeJavaScript(`location.hash = '#knowledge/${encodeURIComponent(xlsx.id)}'`);
    await waitFor(window.webContents, "document.querySelector('#fileName')?.textContent === '季度数据.xlsx' && document.querySelector('.file-grid-table tbody tr:not(.file-grid-spacer) td')?.textContent.includes('表格预览')", 'mobile spreadsheet restore');
    window.setSize(390, 844);
    await new Promise(resolve => setTimeout(resolve, 250));
    const mobileLayout = await window.webContents.executeJavaScript("({ width: document.querySelector('#fileOriginalPanel')?.getBoundingClientRect().width, reader: document.querySelector('#filePreviewHost')?.getBoundingClientRect().height, clipped: document.querySelector('#fileOriginalPanel')?.scrollWidth > document.querySelector('#fileOriginalPanel')?.clientWidth })");
    assert.ok(mobileLayout.width > 0 && mobileLayout.reader > 200 && !mobileLayout.clipped, JSON.stringify(mobileLayout));
    const mobileShot = await window.webContents.capturePage();
    fs.writeFileSync('/private/tmp/liuxu-file-reader-mobile.png', mobileShot.toPNG());
    process.stdout.write(JSON.stringify({ result: 'ok', desktopScreenshot: '/private/tmp/liuxu-file-reader-desktop.png', mobileScreenshot: '/private/tmp/liuxu-file-reader-mobile.png', documents: [xlsx.id, csv.id, docx.id, pdf.id, png.id, text.id, audio.id, brokenVideo.id, archive.id, pptx.id] }) + '\n');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    await new Promise(resolve => server.close(resolve));
    knowledge.folderSync.stop();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

app.whenReady().then(main).then(() => app.quit()).catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  app.exit(1);
});
