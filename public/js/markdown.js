import { escHtml, isSafeImageSrc, normalizeUploadSrc } from './helpers.js';

let initialized = false;
let librariesPromise = null;
let sanitizerHookInstalled = false;

function loadScript(src, globalName) {
  if (globalThis[globalName]) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`无法加载 Markdown 资源：${src}`));
    document.head.appendChild(script);
  });
}

function installSanitizerHook() {
  const purifier = globalThis.DOMPurify;
  if (sanitizerHookInstalled || !purifier?.addHook) return;
  sanitizerHookInstalled = true;
  purifier.addHook('afterSanitizeAttributes', node => {
    if (node.tagName !== 'IMG') return;
    const normalized = normalizeUploadSrc(node.getAttribute('src'));
    if (normalized && isSafeImageSrc(normalized)) node.setAttribute('src', normalized);
    else node.removeAttribute('src');
  });
}

export function preloadMarkdownLibraries() {
  if (librariesPromise) return librariesPromise;
  librariesPromise = Promise.all([
    loadScript('/vendor/marked/marked.umd.js', 'marked'),
    loadScript('/vendor/dompurify/purify.min.js', 'DOMPurify'),
    loadScript('/vendor/katex/katex.min.js', 'katex'),
  ]).then(() => {
    const link = document.getElementById('katexStylesheet') || document.createElement('link');
    if (!link.parentNode) {
      link.id = 'katexStylesheet';
      link.rel = 'stylesheet';
      link.href = '/vendor/katex/katex.min.css';
      document.head.appendChild(link);
    }
    installSanitizerHook();
    initMarked();
    window.dispatchEvent(new CustomEvent('liuxu:markdown-ready'));
  }).catch(() => {
    // Keep the escaped plain-text fallback when a vendor asset is unavailable.
  });
  return librariesPromise;
}

const PURIFY_OPTIONS = {
  ADD_TAGS: [
    'img',
    'input',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'semantics',
    'annotation',
    'math',
    'mrow',
    'mi',
    'mo',
    'mn',
    'msup',
    'msub',
    'mfrac',
    'mtable',
    'mtr',
    'mtd',
    'mspace',
    'mtext',
    'menclose',
    'mpadded',
    'mphantom',
    'mstyle',
    'munder',
    'mover',
    'munderover',
    'mmultiscripts',
    'msqrt',
    'mroot',
    'mfenced',
  ],
  ADD_ATTR: [
    'src',
    'alt',
    'title',
    'loading',
    'type',
    'checked',
    'disabled',
    'encoding',
    'class',
    'style',
    'aria-hidden',
    'xmlns',
  ],
};

function initMarked() {
  const markedApi = globalThis.marked;
  if (initialized || !markedApi) return;
  initialized = true;

  function renderMath(token, displayMode = false) {
    if (!globalThis.katex) return escHtml(token.raw);
    const html = globalThis.katex.renderToString(token.text, {
      displayMode,
      throwOnError: false,
      strict: false,
    });
    return displayMode
      ? `<div class="math-block">${html}</div>`
      : `<span class="math-inline">${html}</span>`;
  }

  const inlineMath = {
    name: 'inlineMath',
    level: 'inline',
    start(src) {
      let idx = src.indexOf('$');
      while (idx !== -1 && src[idx + 1] === '$') idx = src.indexOf('$', idx + 2);
      return idx;
    },
    tokenizer(src) {
      if (src.startsWith('$$')) return;
      const match = src.match(/^\$((?:\\.|[^$\n\\])+?)\$(?!\$)/);
      if (match && match[1].trim() && !/^\s*\d+([.,]\d+)?\s*$/.test(match[1])) {
        return { type: 'inlineMath', raw: match[0], text: match[1].trim() };
      }
    },
    renderer(token) {
      return renderMath(token, false);
    },
  };

  const blockMath = {
    name: 'blockMath',
    level: 'block',
    start(src) { return src.indexOf('$$'); },
    tokenizer(src) {
      const match = src.match(/^\$\$[ \t]*\n?([\s\S]*?)\n?[ \t]*\$\$(?:\n|$)/);
      if (match && match[1].trim()) {
        return { type: 'blockMath', raw: match[0], text: match[1].trim() };
      }
    },
    renderer(token) {
      return renderMath(token, true);
    },
  };

  const inlineMathParen = {
    name: 'inlineMathParen',
    level: 'inline',
    start(src) { return src.indexOf('\\('); },
    tokenizer(src) {
      const match = src.match(/^\\\(([\s\S]+?)\\\)/);
      if (match && match[1].trim()) {
        return { type: 'inlineMathParen', raw: match[0], text: match[1].trim() };
      }
    },
    renderer(token) {
      return renderMath(token, false);
    },
  };

  const blockMathParen = {
    name: 'blockMathParen',
    level: 'block',
    start(src) { return src.indexOf('\\['); },
    tokenizer(src) {
      const match = src.match(/^\\\[([\s\S]+?)\\\]/);
      if (match && match[1].trim()) {
        return { type: 'blockMathParen', raw: match[0], text: match[1].trim() };
      }
    },
    renderer(token) {
      return renderMath(token, true);
    },
  };

  markedApi.use({ breaks: true, gfm: true, extensions: [blockMath, blockMathParen, inlineMathParen, inlineMath] });
}

const CACHE_MAX = 500;
const cache = new Map();

function cacheGet(key) { return cache.get(key); }

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

function parse(md) {
  if (!globalThis.marked) preloadMarkdownLibraries();
  initMarked();
  if (!globalThis.marked || !initialized) return null;
  return globalThis.marked.parse(md || '');
}

function sanitize(html) {
  installSanitizerHook();
  if (globalThis.DOMPurify) return globalThis.DOMPurify.sanitize(html, PURIFY_OPTIONS);
  return escHtml(html);
}

export function renderToHtml(md) {
  if (!md) return '';

  if (!globalThis.marked) preloadMarkdownLibraries();
  const cacheKey = (!globalThis.katex ? 'plain:' : 'katex:') + md;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const raw = parse(md);
  if (raw === null) return escHtml(md || '').replace(/\n/g, '<br>');

  const result = sanitize(raw);
  cacheSet(cacheKey, result);
  return result;
}

export function renderToHtmlUncached(md) {
  if (!md) return '';

  if (!globalThis.marked) preloadMarkdownLibraries();

  const raw = parse(md);
  if (raw === null) return escHtml(md || '').replace(/\n/g, '<br>');

  return sanitize(raw);
}

export function renderToText(md) {
  if (!md) return '';
  const html = renderToHtml(md);
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('.katex-mathml').forEach(el => el.remove());
  return div.textContent || '';
}

export function clearMdCache() {
  cache.clear();
}
