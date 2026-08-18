import { apiFetch } from '../auth.js';
import { enableMarkdownImagePreview } from '../imagePreview.js';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

let cleanupPreview = null;
let pdfRenderToken = 0;

function fileExtension(value) {
  const name = String(value || '').split(/[?#]/)[0];
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

export function inferPreviewKind(document) {
  const stored = String(document?.fileMeta?.previewKind || '').trim();
  if (stored === 'image' || stored === 'pdf' || stored === 'docx' || stored === 'text') return stored;
  const mime = String(document?.fileMeta?.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('wordprocessingml') || mime.includes('officedocument')) return 'docx';
  const ext = fileExtension(document?.fileMeta?.filename || document?.fileMeta?.storedName || document?.title);
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  return 'text';
}

function fileContentUrl(doc) {
  return doc?.fileMeta?.url || `/api/knowledge/files/${encodeURIComponent(doc.id)}/content`;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-preview-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.dataset.previewSrc = src;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await loadScript('/vendor/pdfjs/pdf.min.js');
  if (!window.pdfjsLib) throw new Error('pdf.js unavailable');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
  return window.pdfjsLib;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function renderImagePreview(host, doc) {
  host.innerHTML = `
    <div class="file-preview-image-wrap">
      <img class="file-preview-image" src="${fileContentUrl(doc)}" alt="${escapeAttr(doc.title || doc.fileMeta?.filename || '图片')}" loading="lazy">
      <p class="file-preview-hint">双击图片可放大查看</p>
    </div>`;
  return enableMarkdownImagePreview(host, '.file-preview-image');
}

function renderDocxPreview(host, doc) {
  const html = doc.previewHtml || '';
  if (!html.trim()) {
    host.innerHTML = '<p class="file-preview-empty">暂时无法生成 Word 预览，请打开原文件查看。</p>';
    return () => {};
  }
  const sanitized = window.DOMPurify
    ? window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
    : html;
  host.innerHTML = `<div class="file-preview-docx prose">${sanitized}</div>`;
  return () => {};
}

function renderTextPreview(host, doc) {
  const text = String(doc.content || '').trim();
  host.innerHTML = text
    ? `<pre class="file-preview-text">${escapeHtml(text)}</pre>`
    : '<p class="file-preview-empty">没有提取到正文。</p>';
  return () => {};
}

async function loadPdfData(doc) {
  const response = await apiFetch(fileContentUrl(doc));
  if (!response.ok) throw new Error('PDF file unavailable');
  return new Uint8Array(await response.arrayBuffer());
}

async function renderPdfPreview(host, doc, token) {
  host.innerHTML = '<p class="file-preview-loading">正在加载 PDF 预览…</p>';
  try {
    const [pdfjsLib, data] = await Promise.all([loadPdfJs(), loadPdfData(doc)]);
    if (token !== pdfRenderToken) return () => {};
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdf = await loadingTask.promise;
    if (token !== pdfRenderToken) {
      loadingTask.destroy?.();
      return () => {};
    }
    host.innerHTML = '<div class="file-preview-pdf-pages"></div>';
    const pagesHost = host.querySelector('.file-preview-pdf-pages');
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (token !== pdfRenderToken) return () => {};
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.25 });
      const canvas = window.document.createElement('canvas');
      canvas.className = 'file-preview-pdf-page';
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const label = window.document.createElement('div');
      label.className = 'file-preview-pdf-label';
      label.textContent = `第 ${pageNumber} 页`;
      pagesHost.append(canvas, label);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
    return () => {
      loadingTask.destroy?.();
      host.innerHTML = '';
    };
  } catch {
    if (token !== pdfRenderToken) return () => {};
    host.innerHTML = '<p class="file-preview-empty">PDF 预览加载失败，请尝试打开原文件。</p>';
    return () => {};
  }
}

export function destroyFilePreview() {
  pdfRenderToken += 1;
  if (cleanupPreview) cleanupPreview();
  cleanupPreview = null;
}

export function shouldCollapseExtractText(doc) {
  const kind = inferPreviewKind(doc);
  return kind === 'image' || kind === 'pdf' || kind === 'docx';
}

export async function renderFilePreview(doc, host) {
  destroyFilePreview();
  if (!host || !doc) return;
  const kind = inferPreviewKind(doc);
  host.dataset.previewKind = kind;
  if (kind === 'image') {
    cleanupPreview = renderImagePreview(host, doc);
    return;
  }
  if (kind === 'docx') {
    cleanupPreview = renderDocxPreview(host, doc);
    return;
  }
  if (kind === 'pdf') {
    const token = pdfRenderToken;
    cleanupPreview = await renderPdfPreview(host, doc, token);
    return;
  }
  cleanupPreview = renderTextPreview(host, doc);
}
