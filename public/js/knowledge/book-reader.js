import { mountReaderShell } from './reader-shell.js';
import { createTrackpadPageTurn, readerGestureAllowed } from './reader-gestures.js';
import { apiFetch } from '../auth.js';
import { button, esc, readingTools } from './book-tools.js';
const DEFAULTS = { theme: 'warm', size: 20, line: 1.8, width: 760, font: 'serif', flow: 'paginated', columns: 'auto' };
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
  const themeProperties = ['--bg','--surface','--panel','--text','--muted','--line','--hover','--surface-hover','--selection-fill','--accent','--accent-soft','--interaction-border','--accent-text','background-color','color'];
  const originalThemeStyles = themeProperties.map(name => [name, host.style.getPropertyValue(name), host.style.getPropertyPriority(name)]);
  const comic = ext === 'cbz'; let book, view, searchGeneration = 0, pendingSelection = null, tools;
  const fixedDocs = new Map();
  const stop = () => { pendingSelection = null; tools?.hideSelectionAction(); fixedDocs.clear(); searchGeneration++; view?.close(); view?.remove(); book?.destroy?.(); if (host.dataset.bookOwner === owner) { delete host.dataset.bookReady; delete host.dataset.bookDocument; delete host.dataset.theme; for (const [name, value, priority] of originalThemeStyles) { if (value) host.style.setProperty(name, value, priority); else host.style.removeProperty(name); } host.classList.remove('book-reader', 'book-focus'); } };
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
    const body=document.createElement('div'); body.className='reader-body'; toolbar.after(body); body.append(stage);
    view = document.createElement('foliate-view'); stage.append(view);
    const progress = document.createElement('span'); progress.className = 'book-progress'; toolbar.append(progress);
    const nav = document.createElement('aside'); nav.className = 'book-nav'; nav.hidden = true; host.append(nav);
    signal.addEventListener('abort', () => nav.remove(), { once: true });
    const location = () => ({ anchor: comic ? view.getCFI(view.renderer?.index ?? 0) : (view.lastLocation?.cfi || ''), label: view.lastLocation?.tocItem?.label || (comic ? `第 ${(view.renderer?.index ?? 0) + 1} 页` : `进度 ${Math.round((view.lastLocation?.fraction || 0) * 100)}%`) });
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
      if(event.key==='Escape' && event.target.ownerDocument!==document) { host.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); return; }
      if (view.hidden || pendingSelection?.quote || event.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); void view.goRight(); }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); void view.goLeft(); }
    };
    host.addEventListener('keydown', keydown, { signal });
    const trackpadTurn = createTrackpadPageTurn({
      canTurn: event => readerGestureAllowed({ host, view, event, paginated: view.isFixedLayout || view.renderer?.getAttribute('flow') === 'paginated', hasSelection: Boolean(pendingSelection?.quote) }),
      turn: direction => { dismissSelection(); void (direction === 'right' ? view.goRight() : view.goLeft()); },
    });
    stage.addEventListener('wheel', trackpadTurn, { signal, passive:false });
    let selecting = false;
    const dismissSelection = () => { selecting = false; pendingSelection = null; tools?.hideSelectionAction(); };
    stage.addEventListener('scroll', dismissSelection, { signal, passive: true, capture: true });
    stage.addEventListener('pointerdown', event => { if (event.target.closest('.reader-page-arrow')) dismissSelection(); }, { signal });
    document.addEventListener('pointerup', () => { if (selecting) { selecting = false; queueMicrotask(() => tools?.selectionChanged()); } }, { signal });
    document.addEventListener('pointercancel', dismissSelection, { signal });
    view.addEventListener('load', event => {
      const { doc: chapter, index } = event.detail;
      pendingSelection = null; tools?.selectionChanged();
      if (view.isFixedLayout) { fixedDocs.set(chapter, index); const style = chapter.createElement('style'); style.textContent = '::highlight(liuxu-reading) { background: #e9b83f80; }'; chapter.head.append(style); if (tools) void paint(tools.entries); }
      chapter.addEventListener('keydown', keydown);
      chapter.addEventListener('wheel', trackpadTurn, { signal, passive:false });
      chapter.addEventListener('scroll', dismissSelection, { passive: true, capture: true });
      chapter.addEventListener('pointerdown', () => { dismissSelection(); selecting = true; });
      chapter.addEventListener('pointerup', () => { selecting = false; queueMicrotask(() => tools?.selectionChanged()); });
      chapter.addEventListener('pointercancel', () => { selecting = false; dismissSelection(); });
      let touchStart = null;
      chapter.addEventListener('touchstart', event => { touchStart = event.touches.length === 1 ? [event.touches[0].clientX,event.touches[0].clientY] : null; }, { passive:true });
      chapter.addEventListener('touchend', event => { if (!touchStart || pendingSelection?.quote || prefs.flow !== 'paginated' || /INPUT|TEXTAREA|SELECT|A|BUTTON/.test(event.target.tagName)) return; const touch=event.changedTouches[0], dx=touch.clientX-touchStart[0], dy=touch.clientY-touchStart[1]; touchStart=null; if(Math.abs(dx)>70 && Math.abs(dx)>Math.abs(dy)*1.5) void (dx<0 ? view.goRight() : view.goLeft()); }, { passive:true });
      chapter.addEventListener('selectionchange', () => {
        const selected = chapter.getSelection(); pendingSelection = selected?.rangeCount && !selected.isCollapsed
          ? { anchor: view.getCFI(index, textBoundedRange(selected.getRangeAt(0), chapter.body)), quote: selected.toString(), label: view.lastLocation?.tocItem?.label || book.toc?.[index]?.label || '摘录', range: selected.getRangeAt(0).cloneRange() } : null;
        if (!selecting) tools?.selectionChanged();
      });
    });
    view.addEventListener('relocate', event => {
      dismissSelection();
      const { cfi, fraction, tocItem } = event.detail;
      progress.textContent = `${tocItem?.label || ''} · ${Math.round((fraction || 0) * 100)}%`;
      savePosition({ anchor: cfi, fingerprint: meta.sha256 });
    });
    if (book.rendition?.layout === 'pre-paginated') book.rendition = { ...book.rendition, spread: 'none' };
    await view.open(book); signal.throwIfAborted();
    let prefs; try { prefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { prefs = { ...DEFAULTS }; }
    for (const [key, values] of Object.entries({ theme:['warm','light','dark','green'], size:[16,18,20,22,24,28,32], line:[1.4,1.6,1.8,2,2.2], width:[580,760,980], font:['serif','sans-serif'], flow:['scrolled','paginated'], columns:['auto','single'] })) if (!values.includes(prefs[key])) prefs[key] = DEFAULTS[key];
    const apply = () => {
      dismissSelection();
      host.dataset.theme = prefs.theme;
      const palette = {
        warm: { color:'#302b25', bg:'#f8f1e3', surface:'#fffdf8', panel:'#f4ead8', muted:'#7b766c', line:'#e0d7c7', hover:'#efe6d7', selection:'#eee6d8', accent:'#58654f', accentSoft:'#e3e9df', focus:'#60705a', accentText:'#fff' },
        light: { color:'#252525', bg:'#fff', surface:'#fff', panel:'#f7f8f6', muted:'#747874', line:'#e1e4df', hover:'#f1f3f0', selection:'#edf1ed', accent:'#465b4b', accentSoft:'#e6eee7', focus:'#58715d', accentText:'#fff' },
        dark: { color:'#dadbd3', bg:'#232522', surface:'#2d302d', panel:'#353a35', muted:'#a7aca4', line:'#474d47', hover:'#383e39', selection:'#354238', accent:'#a9c8aa', accentSoft:'#344537', focus:'#9abb9c', accentText:'#1b241d' },
        green: { color:'#2d392f', bg:'#edf4ec', surface:'#f7fbf6', panel:'#e8f0e6', muted:'#6f7c71', line:'#d3dfd2', hover:'#e8f0e7', selection:'#dfeade', accent:'#47744f', accentSoft:'#deebdf', focus:'#648c69', accentText:'#fff' },
      }[prefs.theme] || { color:'#302b25', bg:'#f8f1e3', surface:'#fffdf8', panel:'#f4ead8', muted:'#7b766c', line:'#e0d7c7', hover:'#efe6d7', selection:'#eee6d8', accent:'#58654f', accentSoft:'#e3e9df', focus:'#60705a', accentText:'#fff' };
      for (const [name, value] of Object.entries({ bg:palette.bg, surface:palette.surface, panel:palette.panel, text:palette.color, muted:palette.muted, line:palette.line, hover:palette.hover, 'surface-hover':palette.hover, 'selection-fill':palette.selection, accent:palette.accent, 'accent-soft':palette.accentSoft, 'interaction-border':palette.focus, 'accent-text':palette.accentText })) host.style.setProperty(`--${name}`, value);
      host.style.backgroundColor = palette.bg;
      host.style.color = palette.color;
      view.renderer.setAttribute('flow', prefs.flow);
      view.renderer.setAttribute('max-inline-size', `${prefs.width}px`);
      view.renderer.setAttribute('max-column-count', prefs.flow === 'paginated' && prefs.columns === 'auto' && stage.clientWidth >= 1000 ? '2' : '1');
      view.renderer.setStyles?.(`html { --theme-bg-color:${palette.bg}; color:${palette.color}!important; background:${palette.bg}!important; } body { color:${palette.color}!important; font-family:${prefs.font === 'sans-serif' ? 'sans-serif' : 'serif'}!important; font-size:${prefs.size}px!important; line-height:${prefs.line}!important; } p,li,blockquote { font-family:inherit!important; font-size:1em!important; line-height:inherit!important; } img,svg { max-width:100%; }`);
      try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
    };
    const select = (label, key, values) => {
      const el = document.createElement('select'); el.setAttribute('aria-label', label); el.title = label;
      for (const [value, text] of values) { const option = document.createElement('option'); option.value = value; option.textContent = text; el.append(option); }
      el.value = String(prefs[key]); const field=document.createElement('label'); field.append(document.createTextNode(label),el); toolbar.append(field);
      el.onchange = () => { prefs[key] = typeof DEFAULTS[key] === 'number' ? Number(el.value) : el.value; apply(); };
      return el;
    };
    button(toolbar, '目录', () => {
      nav.replaceChildren();
      const add = (items, depth = 0) => { for (const item of items || []) {
        const b = button(nav, item.label || '章节', async () => { await view.goTo(item.href); nav.hidden = true; stage.focus({preventScroll:true}); }); b.dataset.readerJump=''; b.style.paddingLeft = `${8 + depth * 14}px`; add(item.subitems, depth + 1);
      } }; add(book.toc); if(!book.toc?.length) nav.append(document.createTextNode('本书没有目录')); nav.hidden = false;
    });
    if (!view.isFixedLayout) {
      select('字号', 'size', [16,18,20,22,24,28,32].map(n => [n, `${n} px`]));
      select('行距', 'line', [1.4,1.6,1.8,2,2.2].map(n => [n, `${n} 倍行距`]));
      select('正文宽度', 'width', [[580,'窄栏'],[760,'舒适宽度'],[980,'宽栏']]);
      select('字体', 'font', [['serif','宋体 / 衬线'],['sans-serif','黑体 / 无衬线']]);
      select('阅读方式', 'flow', [['scrolled','连续滚动'],['paginated','翻页阅读']]);
      select('分页分栏', 'columns', [['auto','宽屏自动双栏'],['single','始终单栏']]);
    } else {
      const zoom = document.createElement('select'); zoom.setAttribute('aria-label', '缩放');
      zoom.innerHTML = '<option value="fit-page">适合页面</option><option value="fit-width">适宽</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option>';
      zoom.onchange = () => { dismissSelection(); view.renderer.setAttribute('zoom', zoom.value); }; toolbar.append(zoom);
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
      if (comic) button(toolbar, '切换阅读方向', () => { book.dir = book.dir === 'rtl' ? 'ltr' : 'rtl'; void setFixedLayout(); tools.report(book.dir === 'rtl' ? '从右向左阅读' : '从左向右阅读'); });
    }
    select('主题', 'theme', [['warm','暖色'],['light','浅色'],['dark','深色'],['green','绿色']]);
    button(toolbar, '重置排版', () => { prefs = { ...DEFAULTS }; apply(); for (const el of host.querySelectorAll('select')) { const k = { '字号':'size','行距':'line','正文宽度':'width','字体':'font','阅读方式':'flow','主题':'theme','分页分栏':'columns' }[el.getAttribute('aria-label')]; if (k) el.value = String(prefs[k]); } });
    if (!comic) {
      const search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索书内文字'; search.setAttribute('aria-label', '搜索书内文字'); toolbar.append(search);
      host._filePreviewActions = { ...(host._filePreviewActions || {}), find: async () => {
        const generation = ++searchGeneration; const query = search.value.trim(); if (!query) return;
        nav.replaceChildren(); nav.hidden = false; button(nav, '停止搜索 / 关闭', () => { searchGeneration++; view.clearSearch(); nav.hidden = true; });
        tools.report('搜索中…'); let count = 0;
        try { for await (const result of view.search({ query })) {
          if (signal.aborted || generation !== searchGeneration) return;
          for (const hit of result.subitems || []) { if (++count > 300) break; button(nav, `${hit.excerpt?.pre || ''}${hit.excerpt?.match || query}${hit.excerpt?.post || ''}`, () => { void view.goTo(hit.cfi); nav.hidden = true; }); }
          if (count > 300) break;
        } tools.report(count ? `找到 ${Math.min(300,count)} 处${count > 300 ? '（仅显示前 300 处）' : ''}` : '未找到匹配文字'); }
        catch (error) { if (!signal.aborted) tools.report(error.message); }
      }, clearSearch: () => { searchGeneration++; view.clearSearch(); nav.replaceChildren(); tools?.report(''); } };
    }
    if (ext === 'txt') {
      const raw = document.createElement('pre'); raw.className = 'file-preview-text'; raw.textContent = originalText; raw.hidden = true; stage.append(raw);
      button(toolbar, '阅读 / 原文', () => { dismissSelection(); raw.hidden = !raw.hidden; view.hidden = !raw.hidden; raw.style.height = '100%'; raw.style.overflow = 'auto'; });
    }
    tools = await readingTools({ doc, host, toolbar, signal, current: location, selection: comic ? null : () => pendingSelection, navigate, onChange: paint });
    const pageControl = document.createElement('div'); pageControl.className = 'reader-page-control'; pageControl.setAttribute('role', 'group'); pageControl.setAttribute('aria-label', '页面导航');
    const pageInput = document.createElement('input'); pageInput.type = 'number'; pageInput.min = '1'; pageInput.value = '1'; pageControl.append(pageInput);
    const pageTotal = document.createElement('span'); pageTotal.className = 'reader-page-total'; pageControl.append(pageTotal);
    const pageList = Array.isArray(book.pageList) ? book.pageList.filter(item => item?.href) : [];
    const pageState = (position = view.lastLocation) => {
      if (view.isFixedLayout) return { current: (view.renderer?.index ?? 0) + 1, total: Math.max(1, book.sections.length), kind: 'page' };
      if (pageList.length) {
        const index = pageList.findIndex(item => item === position?.pageItem || item.href === position?.pageItem?.href);
        if (index >= 0) return { current: index + 1, total: pageList.length, kind: 'page' };
      }
      const total = Math.max(1, Number(position?.location?.total) || 1);
      return { current: Math.min(total, Math.max(1, Number(position?.location?.current) + 1 || 1)), total, kind: 'location' };
    };
    pageInput.setAttribute('aria-label', '跳转到阅读位置'); pageInput.title = '输入页码或阅读位置并按 Enter 跳转';
    const syncPageControl = (position = view.lastLocation) => {
      const state = pageState(position);
      pageInput.max = String(state.total); pageTotal.textContent = `/ ${state.total}`;
      pageInput.setAttribute('aria-label', state.kind === 'page' ? '跳转到页码' : '跳转到阅读位置');
      pageInput.title = state.kind === 'page' ? '输入页码并按 Enter 跳转' : '输入阅读位置并按 Enter 跳转';
      if (document.activeElement !== pageInput) pageInput.value = String(state.current);
      pageControl.dataset.positionKind = state.kind;
    };
    const jumpToPage = async () => {
      const state = pageState();
      const target = Math.max(1, Math.min(state.total, Math.trunc(Number(pageInput.value) || 1)));
      pageInput.value = String(target);
      if (state.kind === 'page' && view.isFixedLayout) await view.goTo(target - 1);
      else if (state.kind === 'page' && pageList.length) await view.goTo(pageList[target - 1].href);
      else await view.goToFraction((target - 1) / Math.max(1, state.total - 1));
      stage.focus({ preventScroll: true });
    };
    const previous = document.createElement('button'); previous.type = 'button'; previous.className = 'reader-page-step'; previous.textContent = '‹'; previous.setAttribute('aria-label', '上一页'); previous.title = '上一页'; previous.onclick = () => view.prev();
    const next = document.createElement('button'); next.type = 'button'; next.className = 'reader-page-step'; next.textContent = '›'; next.setAttribute('aria-label', '下一页'); next.title = '下一页'; next.onclick = () => view.next();
    pageControl.prepend(previous); pageControl.append(next); toolbar.append(pageControl);
    pageInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void jumpToPage(); } }, { signal });
    view.addEventListener('relocate', event => syncPageControl(event.detail), { signal });
    const shell = mountReaderShell({host,toolbar,stage,signal});
    for (const [label,cls,action] of [['上一页','is-prev',()=>view.prev()],['下一页','is-next',()=>view.next()]]) { const arrow=button(stage,'',action); arrow.textContent=cls==='is-prev'?'‹':'›'; arrow.className='reader-page-arrow '+cls; arrow.setAttribute('aria-label',label); }
    const resize = new ResizeObserver(()=> { dismissSelection(); if(view.renderer && !view.isFixedLayout) { const columns=prefs.flow === 'paginated' && prefs.columns === 'auto' && stage.clientWidth >= 1000 ? '2':'1'; if(view.renderer.getAttribute('max-column-count')!==columns) view.renderer.setAttribute('max-column-count',columns); } }); resize.observe(stage); signal.addEventListener('abort',()=>resize.disconnect(),{once:true});
    host.dataset.readerPhase='initializing';
    apply(); await view.init({ lastLocation: position?.fingerprint === meta.sha256 ? position.anchor : undefined });
    host.dataset.readerPhase='restoring';
    signal.throwIfAborted(); syncPageControl(); await tools.restoreLink(); await paint(tools.entries);
    if (position?.anchor && position.fingerprint !== meta.sha256) tools.report('源文件已变化，已从开头打开；旧摘录仍保留。');
    host.dataset.bookDocument = doc.id;
    host.dataset.bookReady = 'true';
    delete host.dataset.readerPhase;
    return stop;
  } catch (error) { stop(); throw error; }
}
