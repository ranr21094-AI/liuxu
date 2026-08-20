import { escHtml } from './helpers.js';

let initialized = false;

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
  if (initialized || typeof marked === 'undefined') return;
  initialized = true;

  function renderMath(token, displayMode = false) {
    if (typeof katex === 'undefined') return escHtml(token.raw);
    const html = katex.renderToString(token.text, {
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

  marked.use({ breaks: true, gfm: true, extensions: [blockMath, blockMathParen, inlineMathParen, inlineMath] });
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
  initMarked();
  if (typeof marked === 'undefined' || !initialized) return null;
  return marked.parse(md || '');
}

function sanitize(html) {
  if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(html, PURIFY_OPTIONS);
  return escHtml(html);
}

export function renderToHtml(md) {
  if (!md) return '';

  const cacheKey = (typeof katex === 'undefined' ? 'plain:' : 'katex:') + md;
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
