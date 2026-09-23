import { apiFetch } from '../auth.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif']);
const SHEET_EXTENSIONS = new Set(['.xlsx', '.xls', '.ods']);
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.log', '.json', '.xml', '.yaml', '.yml', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.py', '.sh', '.sql', '.ini', '.toml', '.diff', '.patch']);
const LIMIT = 30 * 1024 * 1024;

let previewToken = 0;
let activeCleanup = () => {};
let activeDocument = null;
let fileReaderTab = 'preview';
let cachedModules = {};

function extension(value) {
  const name = String(value || '').split(/[?#]/)[0];
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

export function inferPreviewKind(document) {
  const stored = String(document?.fileMeta?.previewKind || '').trim();
  if (['image', 'pdf', 'docx', 'spreadsheet', 'delimited', 'presentation', 'audio', 'video', 'archive', 'text', 'unsupported'].includes(stored)) return stored;
  const ext = extension(document?.fileMeta?.filename || document?.fileMeta?.storedName || document?.title);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (SHEET_EXTENSIONS.has(ext)) return 'spreadsheet';
  if (['.csv', '.tsv'].includes(ext)) return 'delimited';
  if (ext === '.pptx') return 'presentation';
  if (ext === '.zip') return 'archive';
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)) return 'audio';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unsupported';
}

function contentUrl(doc, download = false) {
  const url = doc?.fileMeta?.url || `/api/knowledge/files/${encodeURIComponent(doc.id)}/content`;
  return download ? `${url}${url.includes('?') ? '&' : '?'}download=1` : url;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function toolbarMarkup(extra = '') {
  return `<div class="file-preview-toolbar" role="toolbar" aria-label="文件预览控制">
    ${extra}
    <button type="button" data-file-action="zoom-out" aria-label="缩小" title="缩小">−</button>
    <button type="button" data-file-action="zoom-in" aria-label="放大" title="放大">＋</button>
    <button type="button" data-file-action="fit" title="适合窗口">适合窗口</button>
    <span class="file-preview-toolbar-spacer"></span>
  </div>`;
}

function setMessage(stage, text, action = '') {
  stage.innerHTML = `<div class="file-preview-message"><p>${esc(text)}</p>${action ? `<button type="button" data-file-action="retry">重试</button>` : ''}</div>`;
}

function loadScript(url, key, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!cachedModules[key]) cachedModules[key] = new Promise((resolve, reject) => {
    const script = window.document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error('预览组件未加载'));
    script.onerror = () => reject(new Error('预览组件加载失败'));
    window.document.head.appendChild(script);
  }).catch(error => { delete cachedModules[key]; throw error; });
  return cachedModules[key];
}

async function responseFor(doc, { maxBytes = LIMIT, signal } = {}) {
  const response = await apiFetch(contentUrl(doc), { signal, headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` } });
  if (!response.ok && response.status !== 206) throw new Error('原文件读取失败');
  const bytes = Number(response.headers.get('Content-Length')) || Number(doc.fileMeta?.bytes) || 0;
  if (bytes > maxBytes && response.status !== 206) throw new Error('文件较大，暂不在应用内完整解析；可以下载或用系统应用打开。');
  return response;
}

async function fetchArrayBuffer(doc, token, controller, limit = LIMIT) {
  const response = await responseFor(doc, { maxBytes: limit, signal: controller.signal });
  if (!response.ok) throw new Error('原文件读取失败');
  const buffer = await response.arrayBuffer();
  if (token !== previewToken) throw new DOMException('Preview changed', 'AbortError');
  if (buffer.byteLength > limit) throw new Error('文件较大，暂不在应用内完整解析；可以下载或用系统应用打开。');
  return buffer;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value === '') quoted = true;
    else if (char === delimiter) { row.push(value); value = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (value !== '' || row.length) { row.push(value); rows.push(row); }
  return rows;
}

function decodeBytes(buffer, encoding = 'utf-8') {
  let bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (encoding === 'utf-8' && bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.slice(3);
  if (encoding === 'utf-16le' && bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) bytes = bytes.slice(2);
  if (encoding === 'utf-16be' && bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    bytes = bytes.slice(2);
    const swap = new Uint8Array(bytes);
    for (let i = 0; i + 1 < swap.length; i += 2) [swap[i], swap[i + 1]] = [swap[i + 1], swap[i]];
    bytes = swap.buffer;
    encoding = 'utf-16le';
  }
  return new TextDecoder(encoding).decode(bytes);
}

function renderGrid(host, rows, options = {}) {
  const maxColumns = Math.min(160, rows.reduce((width, row) => Math.max(width, row.length), 1));
  const searchable = rows.map(row => row.slice(0, maxColumns));
  let query = '';
  let scrollTop = 0;
  let start = 0;
  const viewport = host.querySelector('.file-grid-viewport');
  const table = host.querySelector('.file-grid-table');
  const summary = host.querySelector('.file-grid-summary');
  const valueView = host.querySelector('[data-grid-cell-value]');
  const copyButton = host.querySelector('[data-grid-copy]');
  const copyState = host.querySelector('[data-grid-copy-state]');
  let selectedValue = '';
  const mergeOrigins = new Map();
  const mergeCovered = new Set();
  for (const range of options.merges || []) {
    const startRow = Number(range.s?.r); const endRow = Number(range.e?.r);
    const startColumn = Number(range.s?.c); const endColumn = Number(range.e?.c);
    if (![startRow, endRow, startColumn, endColumn].every(Number.isFinite)) continue;
    mergeOrigins.set(`${startRow},${startColumn}`, { rows: endRow - startRow + 1, columns: endColumn - startColumn + 1 });
    // Keep row geometry stable for virtual scrolling; horizontal merged cells
    // retain their column span, while vertical merges are identified in the
    // cell details and tooltip without adding variable-height table rows.
    if (startRow === endRow) {
      for (let column = startColumn + 1; column <= endColumn; column += 1) mergeCovered.add(`${startRow},${column}`);
    }
  }
  const renderRows = () => {
    const matched = searchable.map((row, index) => ({ row, index })).filter(item => !query || item.row.some(cell => String(cell).toLocaleLowerCase().includes(query)));
    const rowHeight = 31;
    const count = Math.min(160, Math.ceil(viewport.clientHeight / rowHeight) + 8);
    start = Math.max(0, Math.min(matched.length - count, Math.floor(scrollTop / rowHeight)));
    const visible = matched.slice(start, start + count);
    const offsetTop = start * rowHeight;
    const offsetBottom = Math.max(0, (matched.length - start - visible.length) * rowHeight);
    const header = `<thead><tr><th></th>${Array.from({ length: maxColumns }, (_, column) => `<th>${esc(options.columnLabel?.(column) || column + 1)}</th>`).join('')}</tr></thead>`;
    const body = visible.map(({ row, index }) => `<tr><th>${esc(options.rowLabel?.(index) || index + 1)}</th>${Array.from({ length: maxColumns }, (_, column) => {
      if (mergeCovered.has(`${index},${column}`)) return '';
      const value = String(row[column] ?? '');
      const merge = mergeOrigins.get(`${index},${column}`);
      const span = merge?.rows === 1 && merge.columns > 1 ? ` colspan="${merge.columns}"` : '';
      const title = merge ? `${merge.rows} 行 × ${merge.columns} 列合并单元格：${value}` : value;
      return `<td${span} title="${esc(title)}">${esc(value)}</td>`;
    }).join('')}</tr>`).join('');
    table.innerHTML = `${header}<tbody><tr class="file-grid-spacer"><td colspan="${maxColumns + 1}" style="height:${offsetTop}px"></td></tr>${body}<tr class="file-grid-spacer"><td colspan="${maxColumns + 1}" style="height:${offsetBottom}px"></td></tr></tbody>`;
    summary.textContent = `${matched.length.toLocaleString()} 行 · ${maxColumns} 列`;
  };
  host.querySelector('[data-grid-search]')?.addEventListener('input', event => { query = event.target.value.toLocaleLowerCase(); scrollTop = 0; viewport.scrollTop = 0; renderRows(); });
  table.addEventListener('click', event => {
    const cell = event.target.closest('td');
    if (!cell || cell.closest('.file-grid-spacer')) return;
    table.querySelectorAll('td.selected').forEach(item => item.classList.remove('selected'));
    cell.classList.add('selected');
    selectedValue = cell.textContent || '';
    if (valueView) valueView.textContent = selectedValue || '（空白单元格）';
    if (copyButton) copyButton.disabled = false;
    if (copyState) copyState.textContent = '';
  });
  copyButton?.addEventListener('click', async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(selectedValue);
      else {
        const temporary = window.document.createElement('textarea');
        temporary.value = selectedValue; temporary.style.position = 'fixed'; temporary.style.opacity = '0';
        window.document.body.appendChild(temporary); temporary.select();
        if (!window.document.execCommand('copy')) throw new Error('复制失败');
        temporary.remove();
      }
      if (copyState) copyState.textContent = '已复制';
    } catch { if (copyState) copyState.textContent = '复制失败'; }
  });
  viewport.addEventListener('scroll', () => { scrollTop = viewport.scrollTop; renderRows(); }, { passive: true });
  renderRows();
}

async function renderDelimited(doc, host, token, controller) {
  const data = await fetchArrayBuffer(doc, token, controller);
  const ext = extension(doc.fileMeta?.filename || doc.title);
  const defaultDelimiter = ext === '.tsv' ? '\t' : ',';
  const toolbar = host.querySelector('.file-preview-toolbar');
  toolbar.insertAdjacentHTML('afterbegin', `<select data-file-encoding aria-label="文件编码"><option value="utf-8">UTF-8</option><option value="gb18030">GB18030</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select><select data-file-delimiter aria-label="分隔符"><option value=",">逗号</option><option value="\t">制表符</option><option value=";">分号</option><option value="|">竖线</option></select><input data-grid-search type="search" placeholder="搜索单元格" aria-label="搜索单元格"><span class="file-grid-summary"></span>`);
  toolbar.querySelector('[data-file-delimiter]').value = defaultDelimiter;
  const stage = host.querySelector('.file-preview-stage');
  stage.innerHTML = '<div class="file-grid-viewport"><table class="file-grid-table"></table></div>';
  const draw = () => {
    if (token !== previewToken) return;
    const text = decodeBytes(data, toolbar.querySelector('[data-file-encoding]').value);
    const rows = parseDelimited(text, toolbar.querySelector('[data-file-delimiter]').value);
    renderGrid(host, rows);
  };
  toolbar.querySelector('[data-file-encoding]').addEventListener('change', draw);
  toolbar.querySelector('[data-file-delimiter]').addEventListener('change', draw);
  draw();
}

async function renderSpreadsheet(doc, host, token, controller) {
  const buffer = await fetchArrayBuffer(doc, token, controller);
  const XLSX = await loadScript('/vendor/sheetjs/xlsx.full.min.js', 'xlsx', 'XLSX');
  if (token !== previewToken) return;
  const book = XLSX.read(buffer, { type: 'array', raw: true, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, WTF: false });
  const toolbar = host.querySelector('.file-preview-toolbar');
  toolbar.insertAdjacentHTML('afterbegin', `<select data-sheet aria-label="工作表"></select><input data-grid-search type="search" placeholder="搜索单元格" aria-label="搜索单元格"><span class="file-grid-summary"></span><span class="file-grid-cell-value" data-grid-cell-value>选择单元格查看内容</span><button type="button" data-grid-copy disabled>复制单元格</button><small data-grid-copy-state aria-live="polite"></small>`);
  const select = toolbar.querySelector('[data-sheet]');
  for (const name of book.SheetNames) select.add(new Option(name, name));
  const stage = host.querySelector('.file-preview-stage');
  stage.innerHTML = '<div class="file-grid-viewport"><table class="file-grid-table"></table></div>';
  const draw = () => {
    if (token !== previewToken) return;
    const sheet = book.Sheets[select.value];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, blankrows: true, defval: '' });
    renderGrid(host, rows, {
      rowLabel: index => XLSX.utils.encode_row((XLSX.utils.decode_range(sheet['!ref'] || 'A1').s.r) + index),
      columnLabel: index => XLSX.utils.encode_col((XLSX.utils.decode_range(sheet['!ref'] || 'A1').s.c) + index),
      merges: (sheet['!merges'] || []).map(range => {
        const bounds = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
        return { s: { r: range.s.r - bounds.s.r, c: range.s.c - bounds.s.c }, e: { r: range.e.r - bounds.s.r, c: range.e.c - bounds.s.c } };
      }),
    });
  };
  select.addEventListener('change', draw);
  draw();
}

function appendPdfPage(stage, pageNumber) {
  const shell = window.document.createElement('section');
  shell.className = 'file-pdf-page-shell';
  shell.dataset.pageNumber = String(pageNumber);
  shell.innerHTML = `<div class="file-pdf-page-label">第 ${pageNumber} 页</div><div class="file-pdf-canvas-wrap"><canvas></canvas><div class="file-pdf-text-layer"></div></div>`;
  stage.appendChild(shell);
  return shell;
}

async function renderPdf(doc, host, token, controller) {
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  if (token !== previewToken) return;
  const loadingTask = pdfjs.getDocument({ url: contentUrl(doc), withCredentials: true, isEvalSupported: false, rangeChunkSize: 65536 });
  activeCleanup = () => loadingTask.destroy?.();
  const pdf = await loadingTask.promise;
  if (token !== previewToken) return;
  const toolbar = host.querySelector('.file-preview-toolbar');
  toolbar.insertAdjacentHTML('afterbegin', `<label>页码 <input data-pdf-page type="number" min="1" max="${pdf.numPages}" value="1"></label><span>/${pdf.numPages}</span><button type="button" data-file-action="pdf-go">跳转</button><button type="button" data-file-action="rotate">旋转</button><input data-pdf-search type="search" placeholder="搜索 PDF" aria-label="搜索 PDF"><button type="button" data-file-action="pdf-find">查找</button><span data-pdf-result aria-live="polite"></span>`);
  const stage = host.querySelector('.file-preview-stage');
  stage.classList.add('file-preview-pdf-pages');
  const pages = Array.from({ length: pdf.numPages }, (_, index) => appendPdfPage(stage, index + 1));
  let scale = 1;
  let rotation = 0;
  const rendering = new Map();
  const renderPage = async pageNumber => {
    if (token !== previewToken || rendering.has(pageNumber)) return;
    rendering.set(pageNumber, true);
    const page = await pdf.getPage(pageNumber);
    if (token !== previewToken) { page.cleanup?.(); return; }
    const shell = pages[pageNumber - 1];
    const wrap = shell.querySelector('.file-pdf-canvas-wrap');
    const baseViewport = page.getViewport({ scale: 1, rotation: (rotation + page.rotate) % 360 });
    const fit = Math.max(.3, Math.min(2.5, (stage.clientWidth - 32) / baseViewport.width));
    const viewport = page.getViewport({ scale: fit * scale, rotation: (rotation + page.rotate) % 360 });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const canvas = shell.querySelector('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise;
    if (token !== previewToken) return;
    const textContent = await page.getTextContent();
    const textLayer = shell.querySelector('.file-pdf-text-layer');
    textLayer.replaceChildren();
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    try { await new pdfjs.TextLayer({ textContentSource: textContent, container: textLayer, viewport }).render(); } catch {}
    wrap.style.width = `${viewport.width}px`;
    shell.dataset.rendered = 'true';
    rendering.delete(pageNumber);
    page.cleanup?.();
  };
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) renderPage(Number(entry.target.dataset.pageNumber)).catch(() => {});
  }), { root: stage, rootMargin: '800px 0px' });
  pages.forEach(page => observer.observe(page));
  controller.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  const rerender = () => {
    rendering.clear();
    pages.forEach(page => { page.dataset.rendered = ''; page.querySelector('.file-pdf-text-layer').replaceChildren(); });
    const visible = pages.filter(page => {
      const rect = page.getBoundingClientRect(); const hostRect = stage.getBoundingClientRect();
      return rect.bottom >= hostRect.top - 800 && rect.top <= hostRect.bottom + 800;
    });
    visible.forEach(page => renderPage(Number(page.dataset.pageNumber)).catch(() => {}));
  };
  const resizeObserver = new ResizeObserver(() => rerender());
  resizeObserver.observe(stage);
  const search = async () => {
    const query = toolbar.querySelector('[data-pdf-search]').value.trim().toLocaleLowerCase();
    const result = toolbar.querySelector('[data-pdf-result]');
    if (!query) { result.textContent = ''; return; }
    result.textContent = '搜索中…';
    const hits = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      if (token !== previewToken) return;
      const page = await pdf.getPage(i);
      const text = await page.getTextContent();
      if (text.items.some(item => String(item.str || '').toLocaleLowerCase().includes(query))) hits.push(i);
      page.cleanup?.();
    }
    result.textContent = hits.length ? `共 ${hits.length} 页匹配` : '未找到';
    if (hits.length) {
      toolbar.querySelector('[data-pdf-page]').value = String(hits[0]);
      pages[hits[0] - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  host._filePreviewActions = {
    zoom(delta) { scale = Math.max(.5, Math.min(3, scale + delta)); rerender(); },
    fit() { scale = 1; rerender(); },
    rotate() { rotation = (rotation + 90) % 360; rerender(); },
    go() {
      const number = Math.max(1, Math.min(pdf.numPages, Number(toolbar.querySelector('[data-pdf-page]').value) || 1));
      pages[number - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
      renderPage(number).catch(() => {});
    },
    find: search,
  };
  if (doc.status === 'needs_ocr') host.querySelector('.file-preview-toolbar').insertAdjacentHTML('beforeend', '<span class="file-preview-note">扫描件暂不可搜索</span>');
  stage.addEventListener('click', event => {
    const shell = event.target.closest('.file-pdf-page-shell');
    if (shell) toolbar.querySelector('[data-pdf-page]').value = shell.dataset.pageNumber;
  });
  activeCleanup = () => { observer.disconnect(); resizeObserver.disconnect(); loadingTask.destroy?.(); host._filePreviewActions = null; };
  await renderPage(1);
}

async function renderDocx(doc, host, token, controller) {
  const buffer = await fetchArrayBuffer(doc, token, controller);
  await loadScript('/vendor/jszip/jszip.min.js', 'jszip', 'JSZip');
  const docx = await loadScript('/vendor/docx-preview/docx-preview.min.js', 'docx', 'docx');
  const purify = await loadScript('/vendor/dompurify/purify.min.js', 'purify', 'DOMPurify');
  if (token !== previewToken) return;
  const stage = host.querySelector('.file-preview-stage');
  const rendered = window.document.createElement('div');
  await docx.renderAsync(buffer, rendered, rendered, { className: 'docx', inWrapper: true, breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, useBase64URL: true });
  if (token !== previewToken) return;
  const css = [...rendered.querySelectorAll('style')].map(style => style.textContent || '').join('\n')
    .replace(/@import[^;]+;/gi, '')
    .replace(/url\(\s*(['"]?)(?!data:|blob:)[^)]+\)/gi, 'url("")')
    .replace(/<\/style/gi, '<\\/style');
  const html = purify.sanitize(rendered.innerHTML, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'a', 'link', 'meta'],
  });
  const frame = window.document.createElement('iframe');
  frame.className = 'file-docx-frame';
  frame.title = `${doc.title || doc.fileMeta?.filename || 'Word 文件'}预览`;
  frame.setAttribute('sandbox', '');
  frame.referrerPolicy = 'no-referrer';
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline' data: blob:; media-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>${css}</style><style>html,body{margin:0;min-height:100%;background:#e9ebee}body{padding:20px;box-sizing:border-box}.docx-wrapper{min-height:100%;padding:0;background:transparent}.docx-wrapper>section.docx{margin:0 auto 20px;box-shadow:0 2px 14px rgba(0,0,0,.12)}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
  stage.replaceChildren(frame);
  let zoom = 1;
  host._filePreviewActions = {
    zoom(delta) { zoom = Math.max(.65, Math.min(1.6, zoom + delta * .1)); frame.style.zoom = String(zoom); },
    fit() { zoom = 1; frame.style.zoom = '1'; },
  };
  controller.signal.addEventListener('abort', () => { frame.removeAttribute('srcdoc'); frame.remove(); host._filePreviewActions = null; }, { once: true });
}

async function renderPresentation(doc, host, token, controller) {
  const buffer = await fetchArrayBuffer(doc, token, controller);
  const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('/vendor/pptx-renderer/aiden0z-pptx-renderer.browser.es.js');
  if (token !== previewToken) return;
  const stage = host.querySelector('.file-preview-stage');
  const viewer = await PptxViewer.open(buffer, stage, { renderMode: 'list', fitMode: 'contain', lazySlides: true, lazyMedia: true, listOptions: { windowed: true, initialSlides: 4, batchSize: 4 }, zipLimits: RECOMMENDED_ZIP_LIMITS, pdfjs: false, signal: controller.signal });
  if (token !== previewToken) { viewer.destroy(); return; }
  host._filePreviewActions = { zoom: delta => viewer.setZoom(Math.max(40, Math.min(200, viewer.zoomPercent + delta * 10))), fit: () => viewer.setFitMode('contain') };
  activeCleanup = () => { viewer.destroy(); stage.replaceChildren(); };
  controller.signal.addEventListener('abort', () => viewer.destroy(), { once: true });
}

function renderImage(doc, host, controller) {
  const stage = host.querySelector('.file-preview-stage');
  stage.classList.add('file-image-stage');
  stage.innerHTML = `<div class="file-image-scroller"><img class="file-preview-image" src="${esc(contentUrl(doc))}" alt="${esc(doc.title || doc.fileMeta?.filename || '图片')}" draggable="false"></div>`;
  const image = stage.querySelector('img');
  let scale = 1;
  let rotation = 0;
  let pan = { x: 0, y: 0 };
  const paint = () => { image.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale}) rotate(${rotation}deg)`; };
  host._filePreviewActions = {
    zoom: delta => { scale = Math.max(.1, Math.min(8, scale + delta * .2)); paint(); },
    fit: () => { scale = 1; rotation = 0; pan = { x: 0, y: 0 }; paint(); },
    rotate: () => { rotation = (rotation + 90) % 360; paint(); },
    natural: () => { scale = 2; paint(); },
  };
  let pointer = null;
  image.addEventListener('pointerdown', event => { if (scale <= 1) return; pointer = { x: event.clientX - pan.x, y: event.clientY - pan.y }; image.setPointerCapture(event.pointerId); });
  image.addEventListener('pointermove', event => { if (!pointer) return; pan = { x: event.clientX - pointer.x, y: event.clientY - pointer.y }; paint(); });
  image.addEventListener('pointerup', () => { pointer = null; });
  image.addEventListener('error', () => setMessage(stage, '图片读取失败或格式无法解码。'));
  controller.signal.addEventListener('abort', () => { image.removeAttribute('src'); host._filePreviewActions = null; }, { once: true });
}

function renderMedia(doc, host) {
  const stage = host.querySelector('.file-preview-stage');
  const isVideo = inferPreviewKind(doc) === 'video';
  const media = window.document.createElement(isVideo ? 'video' : 'audio');
  media.controls = true;
  media.preload = 'metadata';
  media.src = contentUrl(doc);
  media.className = isVideo ? 'file-preview-video' : 'file-preview-audio';
  const error = window.document.createElement('p');
  error.className = 'file-preview-note';
  error.textContent = '此格式可能不受当前系统支持。请下载后使用系统应用打开。';
  error.hidden = true;
  media.addEventListener('error', () => { error.hidden = false; });
  stage.replaceChildren(media, error);
  return () => { media.pause(); media.removeAttribute('src'); media.load(); };
}

async function renderArchive(doc, host, token, controller) {
  const stage = host.querySelector('.file-preview-stage');
  stage.innerHTML = '<input class="file-archive-search" type="search" placeholder="搜索文件名"><div class="file-archive-list" aria-live="polite"></div><button type="button" data-archive-more>加载更多</button>';
  const list = stage.querySelector('.file-archive-list');
  const search = stage.querySelector('.file-archive-search');
  const more = stage.querySelector('[data-archive-more]');
  let cursor = '';
  let entries = [];
  let finished = false;
  const paint = () => {
    const term = search.value.toLocaleLowerCase();
    const matched = entries.filter(entry => entry.name.toLocaleLowerCase().includes(term));
    list.innerHTML = matched.map(entry => `<div class="file-archive-row"><span>▤ ${esc(entry.name)}</span><small>${(Number(entry.bytes) || 0).toLocaleString()} B</small></div>`).join('') || '<p class="file-preview-note">没有匹配的文件。</p>';
    more.hidden = finished;
  };
  const load = async () => {
    more.disabled = true;
    try {
      const url = `/api/knowledge/files/${encodeURIComponent(doc.id)}/archive-entries?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await apiFetch(url, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'ZIP 目录读取失败');
      if (token !== previewToken) return;
      entries.push(...(data.entries || []));
      cursor = data.nextCursor || '';
      finished = !cursor;
      paint();
    } catch (error) { if (error.name !== 'AbortError') setMessage(stage, error.message, 'retry'); }
    finally { more.disabled = false; }
  };
  search.addEventListener('input', paint);
  more.addEventListener('click', load);
  await load();
}

function renderText(doc, host) {
  const stage = host.querySelector('.file-preview-stage');
  stage.innerHTML = `<div class="file-text-controls"><input type="search" data-text-search placeholder="搜索文本"><label><input type="checkbox" data-text-wrap checked> 自动换行</label></div><pre class="file-preview-code"></pre>`;
  const pre = stage.querySelector('pre');
  const lines = String(doc.content || '').split('\n');
  const query = stage.querySelector('[data-text-search]');
  const paint = () => {
    const needle = query.value.toLocaleLowerCase();
    const wrap = stage.querySelector('[data-text-wrap]').checked;
    pre.classList.toggle('no-wrap', !wrap);
    pre.innerHTML = lines.map((line, index) => {
      const escaped = esc(line);
      if (!needle) return `<span class="file-code-line"><b>${index + 1}</b><code>${escaped}</code></span>`;
      const regex = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
      const marked = escaped.replace(regex, match => `<mark>${match}</mark>`);
      return `<span class="file-code-line"><b>${index + 1}</b><code>${marked}</code></span>`;
    }).join('');
  };
  query.addEventListener('input', paint);
  stage.querySelector('[data-text-wrap]').addEventListener('change', paint);
  paint();
}

function renderUnsupported(doc, host) {
  const ext = extension(doc.fileMeta?.filename || doc.title) || '未知格式';
  setMessage(host.querySelector('.file-preview-stage'), `暫不支持 ${ext} 的内嵌预览。可以下载文件或使用系统应用打开。`);
}

function bindToolbar(host, doc, token, controller) {
  const listener = async event => {
    const button = event.target.closest('[data-file-action]');
    if (!button || token !== previewToken) return;
    const action = button.dataset.fileAction;
    const actions = host._filePreviewActions || {};
    if (action === 'zoom-in') actions.zoom?.(1);
    else if (action === 'zoom-out') actions.zoom?.(-1);
    else if (action === 'fit') actions.fit?.();
    else if (action === 'rotate') actions.rotate?.();
    else if (action === 'natural') actions.natural?.();
    else if (action === 'pdf-go') actions.go?.();
    else if (action === 'pdf-find') await actions.find?.();
    else if (action === 'retry') void renderKind(doc, host, token, controller);
  };
  host.addEventListener('click', listener);
  controller.signal.addEventListener('abort', () => host.removeEventListener('click', listener), { once: true });
}

async function renderKind(doc, host, token, controller) {
  const kind = inferPreviewKind(doc);
  const stage = host.querySelector('.file-preview-stage');
  if (doc.fileMeta?.previewLimited && ['spreadsheet', 'delimited', 'docx', 'presentation', 'text'].includes(kind)) {
    setMessage(stage, '文件大于本地预览解析预算。原文件仍已保存，请下载后使用系统应用打开。');
    return;
  }
  try {
    if (kind === 'image') return renderImage(doc, host, controller);
    if (kind === 'pdf') return await renderPdf(doc, host, token, controller);
    if (kind === 'docx') return await renderDocx(doc, host, token, controller);
    if (kind === 'spreadsheet') return await renderSpreadsheet(doc, host, token, controller);
    if (kind === 'delimited') return await renderDelimited(doc, host, token, controller);
    if (kind === 'presentation') return await renderPresentation(doc, host, token, controller);
    if (kind === 'archive') return await renderArchive(doc, host, token, controller);
    if (kind === 'audio' || kind === 'video') return renderMedia(doc, host);
    if (kind === 'text') return renderText(doc, host);
    return renderUnsupported(doc, host);
  } catch (error) {
    if (token !== previewToken || error?.name === 'AbortError') return;
    setMessage(stage, error.message || '预览失败，请下载文件后使用系统应用打开。', 'retry');
  }
}

export function destroyFilePreview() {
  previewToken += 1;
  try { activeCleanup(); } catch {}
  activeCleanup = () => {};
  const host = window.document.querySelector('#filePreviewHost');
  if (host) {
    host._filePreviewActions = null;
    host.replaceChildren();
  }
}

export function shouldCollapseExtractText(doc) {
  return ['image', 'pdf', 'docx', 'spreadsheet', 'delimited', 'presentation', 'audio', 'video', 'archive'].includes(inferPreviewKind(doc));
}

export function setFileReaderTab(tab) {
  fileReaderTab = ['preview', 'annotation', 'text'].includes(tab) ? tab : 'preview';
  const panes = { preview: '#filePreviewPane', annotation: '#fileAnnotationPane', text: '#fileTextPane' };
  for (const [key, selector] of Object.entries(panes)) {
    const pane = window.document.querySelector(selector);
    if (pane) pane.hidden = key !== fileReaderTab;
  }
  window.document.querySelectorAll('[data-file-reader-tab]').forEach(button => {
    const active = button.dataset.fileReaderTab === fileReaderTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

export function renderFilePreview(doc, host) {
  destroyFilePreview();
  if (!host || !doc) return Promise.resolve();
  activeDocument = doc;
  const kind = inferPreviewKind(doc);
  const token = previewToken;
  const controller = new AbortController();
  activeCleanup = () => controller.abort();
  host.dataset.previewKind = kind;
  const extra = kind === 'image' ? '<button type="button" data-file-action="rotate">旋转</button><button type="button" data-file-action="natural">原始尺寸</button>' : '';
  host.innerHTML = `${toolbarMarkup(extra)}<div class="file-preview-stage" tabindex="0"></div>`;
  bindToolbar(host, doc, token, controller);
  setFileReaderTab(fileReaderTab);
  const textHost = window.document.querySelector('#fileExtractedText');
  if (textHost) textHost.textContent = String(doc.content || '').trim() || '没有提取到正文。';
  const search = window.document.querySelector('#fileTextSearch');
  if (search) search.oninput = () => {
    const text = String(doc.content || '');
    const query = search.value.trim();
    if (!textHost) return;
    if (!query) textHost.textContent = text || '没有提取到正文。';
    else {
      const lines = text.split('\n');
      textHost.textContent = lines.map((line, index) => line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? `${index + 1}: ${line}` : '').filter(Boolean).join('\n') || '没有匹配内容。';
    }
  };
  void renderKind(doc, host, token, controller).then(dispose => {
    if (token !== previewToken || typeof dispose !== 'function') return;
    const previous = activeCleanup;
    activeCleanup = () => { previous(); dispose(); };
  });
  return Promise.resolve();
}
