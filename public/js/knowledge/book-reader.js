import { apiFetch } from '../auth.js';
import { button, esc, readingTools } from './book-tools.js';
const DEFAULTS = { theme: 'warm', size: 20, line: 1.8, width: 760, font: 'serif', flow: 'scrolled' };
const KEY = 'liuxu.reader.preferences.v1';
export function decodeBookText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030').decode(bytes); }
}
export function splitTextChapters(text) {
  const result = []; let lines = [], title = '正文', length = 0;
  const flush = () => { if (lines.length) result.push({ title, text: lines.join('\n') }); lines = []; length = 0; };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(第[零〇一二三四五六七八九十百千万两\d]+[章节卷部回]|chapter\s+\d+|序章|序言|前言|后记|尾声)/i.test(line) && line.trim().length < 100) { flush(); title = line.trim(); }
    if (length > 30000) { flush(); title = `${title.replace(/ · 续$/, '')} · 续`; }
    lines.push(line); length += line.length;
  }
  flush(); return result.length ? result : [{ title: '正文', text: '' }];
}
// CFI element-boundary ranges can collapse to the same path. Normalize selections
// to text-node offsets before persisting so paragraph selections remain ranges.
function textBoundedRange(range, root) {
  const prefix = range.cloneRange(); prefix.selectNodeContents(root); prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length, end = start + range.toString().length;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const result = root.ownerDocument.createRange(); let node, offset = 0, started = false;
  while ((node = walker.nextNode())) {
    const next = offset + node.length;
    if (!started && start < next) { result.setStart(node, start - offset); started = true; }
    if (started && end <= next) { result.setEnd(node, end - offset); return result; }
    offset = next;
  }
  return range;
}
function textBook(text, title) {
  const chapters = splitTextChapters(text); const urls = new Map();
  const html = index => `<html lang="zh"><head><title>${esc(chapters[index].title)}</title></head><body><h2>${esc(chapters[index].title)}</h2>${chapters[index].text.split('\n').map(line => `<p>${esc(line) || '<br>'}</p>`).join('')}</body></html>`;
  return { metadata: { title, language: 'zh' }, sections: chapters.map((chapter, index) => ({ id: String(index), size: chapter.text.length,
    load() { if (!urls.has(index)) urls.set(index, URL.createObjectURL(new Blob([html(index)], { type: 'text/html' }))); return urls.get(index); },
    unload() { URL.revokeObjectURL(urls.get(index)); urls.delete(index); },
    createDocument: () => new DOMParser().parseFromString(html(index), 'text/html'),
  })), toc: chapters.map((chapter, index) => ({ label: chapter.title, href: String(index) })),
  resolveHref: href => ({ index: Number(href) }), splitTOCHref: href => [String(href), null], getTOCFragment: doc => doc.body,
  destroy() { for (const url of urls.values()) URL.revokeObjectURL(url); } };
}
// Sanitize before attaching a chapter to a browsing context, not after its load event.
function protectBook(book, signal) {
  const urls = new Map();
  const displayed = new Set();
  const purifier = window.DOMPurify(window);
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    if (['src', 'poster', 'srcset', 'xlink:href'].includes(data.attrName) || (data.attrName === 'href' && node.localName !== 'a')) {
      if (!/^(?:blob:|data:|#)/i.test(data.attrValue)) data.keepAttr = false;
    }
  });
  const cleanHtml = html => purifier.sanitize(html, { WHOLE_DOCUMENT: true, ALLOWED_URI_REGEXP: /^(?:(?:blob|https?|mailto|tel):|data:(?:image|font)\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i, ADD_TAGS: ['meta', 'link'], ADD_ATTR: ['epub:type', 'content'], FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base'] });
  const sanitize = doc => {
    doc.querySelectorAll('script,iframe,object,embed,form,base,meta[http-equiv]').forEach(node => node.remove());
    for (const node of doc.querySelectorAll('*')) for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || /^(?:javascript|vbscript):/i.test(attr.value.trim())) node.removeAttribute(attr.name);
    }
    const policy = doc.createElement('meta'); policy.setAttribute('http-equiv', 'Content-Security-Policy');
    policy.content = "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob:; script-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
    (doc.head || doc.documentElement).prepend(policy); return doc;
  };
  for (const section of book.sections) {
    const load = section.load.bind(section), unload = section.unload?.bind(section), createDocument = section.createDocument?.bind(section);
    section.load = async () => {
      signal.throwIfAborted();
      displayed.add(section);
      if (urls.has(section)) return urls.get(section);
      const source = await load(); signal.throwIfAborted();
      if (typeof source !== 'string' || !source.startsWith('blob:')) throw new Error('书籍章节地址无效');
      const html = await (await fetch(source, { signal })).text();
      const clean = cleanHtml(html);
      const doc = sanitize(new DOMParser().parseFromString(clean, 'text/html'));
      const url = URL.createObjectURL(new Blob([doc.documentElement.outerHTML], { type: 'text/html' }));
      urls.set(section, url); return url;
    };
    section.unload = () => { displayed.delete(section); URL.revokeObjectURL(urls.get(section)); urls.delete(section); unload?.(); };
    if (createDocument) section.createDocument = async () => {
      try {
        const source = await load(); signal.throwIfAborted();
        const html = await (await fetch(source, { signal })).text();
        return sanitize(new DOMParser().parseFromString(cleanHtml(html), 'text/html'));
      } finally { if (!displayed.has(section)) unload?.(); }
    };
  }
  const destroy = book.destroy?.bind(book);
  book.destroy = () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); destroy?.(); };
  return book;
}
export async function renderBook(doc, host, signal, position, savePosition) {
  const ext = (doc.fileMeta?.filename || '').split('.').pop().toLowerCase();
  const owner = crypto.randomUUID(); host.dataset.bookOwner = owner;
  const comic = ext === 'cbz'; let book, view, searchGeneration = 0, pendingSelection = null, tools;
  const fixedDocs = new Map();
  const stop = () => { fixedDocs.clear(); searchGeneration++; view?.close(); view?.remove(); book?.destroy?.(); if (host.dataset.bookOwner === owner) { delete host.dataset.bookReady; delete host.dataset.bookDocument; host.classList.remove('book-reader', 'book-focus'); } };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const metaResponse = await apiFetch(`/api/knowledge/files/${encodeURIComponent(doc.id)}/preview-meta`, { signal });
    const meta = await metaResponse.json(); if (!metaResponse.ok) throw new Error(meta.error || '书籍检查失败');
    // MOBI/FB2 parsers materialize the book; keep those within the existing parse budget.
    const limit = ['epub', 'cbz'].includes(ext) ? 250 * 1024 * 1024 : 30 * 1024 * 1024;
    if (meta.bytes > limit) throw new Error('书籍超过本地解析预算，请下载或使用系统应用打开。');
    const response = await apiFetch(doc.fileMeta?.url || `/api/knowledge/files/${encodeURIComponent(doc.id)}/content`, { signal });
    if (!response.ok) throw new Error('书籍读取失败');
    const blob = await response.blob(); if (blob.size > limit) throw new Error('书籍超过本地解析预算');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (digest !== meta.sha256) throw new Error('源文件已变化，请同步知识库后重新打开');
    signal.throwIfAborted();
    await import('/vendor/dompurify/purify.min.js');
    const { makeBook } = await import('/vendor/foliate/view.js');
    let originalText = '';
    if (ext === 'txt') { originalText = decodeBookText(await blob.arrayBuffer()); book = textBook(originalText, doc.title); }
    else book = await makeBook(new File([blob], (doc.fileMeta?.filename || 'book.epub').toLowerCase(), { type: meta.mimeType }));
    if (signal.aborted) { book.destroy?.(); signal.throwIfAborted(); }
    if (!book.sections?.length) throw new Error('书籍没有可阅读章节');
    protectBook(book, signal);
    host.classList.add('book-reader');
    const toolbar = host.querySelector('.file-preview-toolbar'); toolbar.replaceChildren();
    const stage = host.querySelector('.file-preview-stage'); stage.replaceChildren();
    view = document.createElement('foliate-view'); stage.append(view);
    const progress = document.createElement('span'); progress.className = 'book-progress'; toolbar.append(progress);
    const nav = document.createElement('aside'); nav.className = 'book-nav'; nav.hidden = true; host.append(nav);
    signal.addEventListener('abort', () => nav.remove(), { once: true });
    const location = () => ({ anchor: view.lastLocation?.cfi || '', label: view.lastLocation?.tocItem?.label || `进度 ${Math.round((view.lastLocation?.fraction || 0) * 100)}%` });
    const navigate = async (anchor, quote) => {
      if (quote) { const resolved = view.resolveNavigation(anchor); if (!resolved) throw new Error('位置失效');
        const d = await book.sections[resolved.index].createDocument();
        if (resolved.anchor(d).toString() !== quote) throw new Error('摘录位置失效'); }
      if (!await view.goTo(anchor)) throw new Error('位置失效');
    };
    const paint = async (entries, old = []) => {
      if (!view.renderer) return;
      if (view.isFixedLayout) {
        for (const [chapter, index] of fixedDocs) {
          if (!chapter.defaultView?.frameElement?.isConnected) { fixedDocs.delete(chapter); continue; }
          const ranges = [];
          for (const item of entries.filter(x => x.type === 'highlight' && x.fingerprint === meta.sha256)) {
            try { const resolved = view.resolveNavigation(item.anchor); if (resolved.index !== index) continue; const range = resolved.anchor(chapter); if (range.toString() === item.quote) ranges.push(range); } catch {}
          }
          chapter.defaultView.CSS.highlights.set('liuxu-reading', new chapter.defaultView.Highlight(...ranges));
        }
        return;
      }
      for (const item of old.filter(x => x.type === 'highlight')) await view.deleteAnnotation({ value: item.anchor }).catch(() => {});
      for (const item of entries.filter(x => x.type === 'highlight' && x.fingerprint === meta.sha256)) await view.addAnnotation({ value: item.anchor }).catch(() => {});
    };
    const { Overlayer } = await import('/vendor/foliate/overlayer.js');
    view.addEventListener('draw-annotation', event => event.detail.draw(Overlayer.highlight, { color: '#e9b83f' }));
    view.addEventListener('create-overlay', () => { if (tools) void paint(tools.entries); });
    view.addEventListener('external-link', event => { event.preventDefault(); tools?.report('外部链接请复制后在浏览器中打开'); });
    const keydown = event => {
      if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); void view.goRight(); }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); void view.goLeft(); }
    };
    host.addEventListener('keydown', keydown, { signal });
    view.addEventListener('load', event => {
      const { doc: chapter, index } = event.detail;
      pendingSelection = null; tools?.selectionChanged();
      if (view.isFixedLayout) { fixedDocs.set(chapter, index); const style = chapter.createElement('style'); style.textContent = '::highlight(liuxu-reading) { background: #e9b83f80; }'; chapter.head.append(style); if (tools) void paint(tools.entries); }
      chapter.addEventListener('keydown', keydown);
      chapter.addEventListener('selectionchange', () => {
        const selected = chapter.getSelection(); pendingSelection = selected?.rangeCount && !selected.isCollapsed
          ? { anchor: view.getCFI(index, textBoundedRange(selected.getRangeAt(0), chapter.body)), quote: selected.toString(), label: view.lastLocation?.tocItem?.label || book.toc?.[index]?.label || '摘录' } : null;
        tools?.selectionChanged();
      });
    });
    view.addEventListener('relocate', event => {
      const { cfi, fraction, tocItem } = event.detail;
      progress.textContent = `${tocItem?.label || ''} · ${Math.round((fraction || 0) * 100)}%`;
      savePosition({ anchor: cfi, fingerprint: meta.sha256 });
    });
    if (book.rendition?.layout === 'pre-paginated') book.rendition = { ...book.rendition, spread: 'none' };
    await view.open(book); signal.throwIfAborted();
    let prefs; try { prefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { prefs = { ...DEFAULTS }; }
    for (const [key, values] of Object.entries({ theme:['warm','light','dark'], size:[16,18,20,22,24,28,32], line:[1.4,1.6,1.8,2,2.2], width:[580,760,980], font:['serif','sans-serif'], flow:['scrolled','paginated'] })) if (!values.includes(prefs[key])) prefs[key] = DEFAULTS[key];
    const apply = () => {
      host.dataset.theme = prefs.theme;
      const color = prefs.theme === 'dark' ? '#dadbd3' : '#302b25', bg = prefs.theme === 'dark' ? '#232522' : prefs.theme === 'light' ? '#ffffff' : '#f8f1e3';
      view.renderer.setAttribute('flow', prefs.flow);
      view.renderer.setAttribute('max-inline-size', `${prefs.width}px`);
      view.renderer.setAttribute('max-column-count', '1');
      view.renderer.setStyles?.(`html { color:${color}!important; background:${bg}!important; } body { font-family:${prefs.font === 'sans-serif' ? 'sans-serif' : 'serif'}!important; font-size:${prefs.size}px!important; line-height:${prefs.line}!important; } p,li,blockquote { font-family:inherit!important; font-size:1em!important; line-height:inherit!important; } img,svg { max-width:100%; }`);
      try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
    };
    const select = (label, key, values) => {
      const el = document.createElement('select'); el.setAttribute('aria-label', label); el.title = label;
      for (const [value, text] of values) { const option = document.createElement('option'); option.value = value; option.textContent = text; el.append(option); }
      el.value = String(prefs[key]); toolbar.append(el);
      el.onchange = () => { prefs[key] = typeof DEFAULTS[key] === 'number' ? Number(el.value) : el.value; apply(); };
      return el;
    };
    button(toolbar, '上一页', () => view.prev()); button(toolbar, '下一页', () => view.next());
    button(toolbar, '目录', () => {
      nav.replaceChildren(); button(nav, '关闭目录', () => { nav.hidden = true; });
      const add = (items, depth = 0) => { for (const item of items || []) {
        const b = button(nav, item.label || '章节', async () => { await view.goTo(item.href); nav.hidden = true; }); b.style.paddingLeft = `${8 + depth * 14}px`; add(item.subitems, depth + 1);
      } }; add(book.toc); nav.hidden = false;
    });
    if (!view.isFixedLayout) {
      select('字号', 'size', [16,18,20,22,24,28,32].map(n => [n, `${n} px`]));
      select('行距', 'line', [1.4,1.6,1.8,2,2.2].map(n => [n, `${n} 倍行距`]));
      select('正文宽度', 'width', [[580,'窄栏'],[760,'舒适宽度'],[980,'宽栏']]);
      select('字体', 'font', [['serif','宋体 / 衬线'],['sans-serif','黑体 / 无衬线']]);
      select('阅读方式', 'flow', [['scrolled','连续滚动'],['paginated','翻页阅读']]);
    } else {
      const zoom = document.createElement('select'); zoom.setAttribute('aria-label', '缩放');
      zoom.innerHTML = '<option value="fit-page">适合页面</option><option value="fit-width">适宽</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option>';
      zoom.onchange = () => view.renderer.setAttribute('zoom', zoom.value); toolbar.append(zoom);
      const setFixedLayout = async () => {
        const index = Math.max(0, view.renderer.index || 0);
        fixedDocs.clear(); view.close(); await view.open(book);
        view.renderer.setAttribute('zoom', zoom.value);
        await view.goTo(index);
      };
      const spread = button(toolbar, '双页', async () => {
        const both = book.rendition.spread !== 'both'; book.rendition.spread = both ? 'both' : 'none';
        spread.textContent = both ? '单页' : '双页'; await setFixedLayout();
      });
      const page = document.createElement('input'); page.type = 'number'; page.min = 1; page.max = book.sections.length; page.value = 1; page.setAttribute('aria-label', '跳到页码'); toolbar.append(page);
      button(toolbar, '跳页', () => view.goTo(Math.max(0, Math.min(book.sections.length - 1, Number(page.value) - 1))));
      if (comic) button(toolbar, '切换阅读方向', () => { book.dir = book.dir === 'rtl' ? 'ltr' : 'rtl'; void setFixedLayout(); tools.report(book.dir === 'rtl' ? '从右向左阅读' : '从左向右阅读'); });
    }
    select('主题', 'theme', [['warm','暖色'],['light','浅色'],['dark','深色']]);
    button(toolbar, '重置排版', () => { prefs = { ...DEFAULTS }; apply(); for (const el of toolbar.querySelectorAll('select')) { const k = { '字号':'size','行距':'line','正文宽度':'width','字体':'font','阅读方式':'flow','主题':'theme' }[el.getAttribute('aria-label')]; if (k) el.value = String(prefs[k]); } });
    if (!comic) {
      const search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索书内文字'; search.setAttribute('aria-label', '搜索书内文字'); toolbar.append(search);
      button(toolbar, '查找', async () => {
        const generation = ++searchGeneration; const query = search.value.trim(); if (!query) return;
        nav.replaceChildren(); nav.hidden = false; button(nav, '停止搜索 / 关闭', () => { searchGeneration++; view.clearSearch(); nav.hidden = true; });
        tools.report('搜索中…'); let count = 0;
        try { for await (const result of view.search({ query })) {
          if (signal.aborted || generation !== searchGeneration) return;
          for (const hit of result.subitems || []) { if (++count > 300) break; button(nav, `${hit.excerpt?.pre || ''}${hit.excerpt?.match || query}${hit.excerpt?.post || ''}`, () => { void view.goTo(hit.cfi); nav.hidden = true; }); }
          if (count > 300) break;
        } tools.report(count ? `找到 ${Math.min(300,count)} 处${count > 300 ? '（仅显示前 300 处）' : ''}` : '未找到匹配文字'); }
        catch (error) { if (!signal.aborted) tools.report(error.message); }
      });
    }
    if (ext === 'txt') {
      const raw = document.createElement('pre'); raw.className = 'file-preview-text'; raw.textContent = originalText; raw.hidden = true; stage.append(raw);
      button(toolbar, '阅读 / 原文', () => { raw.hidden = !raw.hidden; view.hidden = !raw.hidden; raw.style.height = '100%'; raw.style.overflow = 'auto'; });
    }
    tools = await readingTools({ doc, host, toolbar, signal, current: location, selection: comic ? null : () => pendingSelection, navigate, onChange: paint });
    apply(); await view.init({ lastLocation: position?.fingerprint === meta.sha256 ? position.anchor : undefined });
    signal.throwIfAborted(); await tools.restoreLink(); await paint(tools.entries);
    if (position?.anchor && position.fingerprint !== meta.sha256) tools.report('源文件已变化，已从开头打开；旧摘录仍保留。');
    host.dataset.bookDocument = doc.id;
    host.dataset.bookReady = 'true';
    return stop;
  } catch (error) { stop(); throw error; }
}
