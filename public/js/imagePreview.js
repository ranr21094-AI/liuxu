import { openModal, closeModal } from './helpers.js';

const OVERLAY_ID = 'markdownImagePreviewOverlay';
let escapeHandler = null;

function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'modal-overlay markdown-image-preview-overlay';
  overlay.style.display = 'none';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'markdownImagePreviewTitle');
  overlay.innerHTML = `
    <div class="markdown-image-lightbox">
      <button class="markdown-image-lightbox-close" type="button" aria-label="关闭图片预览" title="关闭">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
      <h2 id="markdownImagePreviewTitle" class="sr-only">日志图片预览</h2>
      <div class="markdown-image-lightbox-frame">
        <img class="markdown-image-lightbox-img" alt="">
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeMarkdownImagePreview();
  });
  overlay.querySelector('.markdown-image-lightbox-close')
    ?.addEventListener('click', closeMarkdownImagePreview);

  return overlay;
}

export function closeMarkdownImagePreview() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;

  closeModal(overlay);
  const image = overlay.querySelector('.markdown-image-lightbox-img');
  if (image) {
    image.removeAttribute('src');
    image.alt = '';
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler);
    escapeHandler = null;
  }
}

function resolvePreviewSource(source) {
  if (typeof source === 'string') {
    const src = source.trim();
    return src ? { src, alt: '附件图片' } : null;
  }
  if (!source || typeof source !== 'object') return null;
  const src = source.currentSrc || source.getAttribute?.('src') || source.src || '';
  if (!src) return null;
  return { src, alt: source.getAttribute?.('alt') || '日志图片' };
}

export function openMarkdownImagePreview(sourceImage, altText = '') {
  const resolved = resolvePreviewSource(sourceImage);
  if (!resolved) return false;
  const alt = typeof altText === 'string' && altText.trim() ? altText.trim() : resolved.alt;

  const overlay = ensureOverlay();
  const previewImage = overlay.querySelector('.markdown-image-lightbox-img');
  previewImage.src = resolved.src;
  previewImage.alt = alt;

  if (escapeHandler) document.removeEventListener('keydown', escapeHandler);
  escapeHandler = (event) => {
    if (event.key === 'Escape') closeMarkdownImagePreview();
  };
  document.addEventListener('keydown', escapeHandler);
  openModal(overlay, '.markdown-image-lightbox-close');
  return true;
}

export function enableMarkdownImagePreview(container, selector = '.markdown-body img') {
  if (!container) return () => {};

  const handleDoubleClick = (event) => {
    const image = event.target?.closest?.(selector);
    if (!image || !container.contains(image) || image.closest('a[href]')) return;
    event.preventDefault();
    event.stopPropagation();
    openMarkdownImagePreview(image);
  };

  container.addEventListener('dblclick', handleDoubleClick);
  return () => container.removeEventListener('dblclick', handleDoubleClick);
}
