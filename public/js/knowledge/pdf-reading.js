import { button, readingTools } from './book-tools.js';
function textRange(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node, offset = 0, first = null, last = null;
  while ((node = walker.nextNode())) {
    const next = offset + node.length;
    if (!first && start >= offset && start <= next) first = [node, start - offset];
    if (end >= offset && end <= next) { last = [node, end - offset]; break; }
    offset = next;
  }
  if (!first || !last) throw new Error('文字位置已失效');
  const range = document.createRange(); range.setStart(...first); range.setEnd(...last); return range;
}
export async function pdfReading({ doc, host, toolbar, stage, pages, pdf, renderPage, rerender, signal, position }) {
  let selected = null, tools, searchRun = 0;
  const visiblePage = () => Number((pages.find(page => page.getBoundingClientRect().bottom > stage.getBoundingClientRect().top + 8) || pages[0]).dataset.pageNumber);
  const selectionChanged = () => {
    const selection = document.getSelection(); selected = null;
    if (selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const layer = start.closest('.file-pdf-text-layer');
      if (layer && host.contains(layer) && layer.contains(range.endContainer)) {
        const before = range.cloneRange(); before.selectNodeContents(layer); before.setEnd(range.startContainer, range.startOffset);
        const page = Number(layer.closest('[data-page-number]').dataset.pageNumber);
        selected = { anchor: JSON.stringify({ page, start: before.toString().length, end: before.toString().length + range.toString().length }), quote: range.toString(), label: `第 ${page} 页` };
      }
    }
    tools?.selectionChanged();
  };
  document.addEventListener('selectionchange', selectionChanged, { signal });
  function paint() {
    host.querySelectorAll('.book-pdf-highlight').forEach(el => el.remove());
    for (const item of tools?.entries || []) {
      if (item.type !== 'highlight' || item.fingerprint !== tools.fingerprint) continue;
      try {
        const anchor = JSON.parse(item.anchor); const shell = pages[anchor.page - 1];
        if (shell?.dataset.rendered !== 'true') continue;
        const layer = shell.querySelector('.file-pdf-text-layer'); const range = textRange(layer, anchor.start, anchor.end);
        if (range.toString() !== item.quote) continue;
        const wrap = shell.querySelector('.file-pdf-canvas-wrap'), box = wrap.getBoundingClientRect();
        for (const rect of range.getClientRects()) {
          const mark = document.createElement('span'); mark.className = 'book-pdf-highlight';
          Object.assign(mark.style, { left:`${rect.left-box.left}px`, top:`${rect.top-box.top}px`, width:`${rect.width}px`, height:`${rect.height}px` }); wrap.append(mark);
        }
      } catch { /* Old or malformed anchors never highlight unrelated text. */ }
    }
  }
  tools = await readingTools({ doc, host, toolbar, signal,
    current: () => ({ anchor: JSON.stringify({ page: visiblePage() }), label: `第 ${visiblePage()} 页` }),
    selection: () => selected,
    navigate: async (value, quote) => {
      const anchor = JSON.parse(value); const shell = pages[anchor.page - 1]; if (!shell) throw new Error('页码失效');
      await renderPage(anchor.page);
      if (quote && textRange(shell.querySelector('.file-pdf-text-layer'), anchor.start, anchor.end).toString() !== quote) throw new Error('摘录失效');
      shell.scrollIntoView({ block: 'start' }); paint();
    }, onChange: paint,
  });
  const spread = button(toolbar, '双页', () => { stage.classList.toggle('book-pdf-spread'); spread.textContent = stage.classList.contains('book-pdf-spread') ? '单页' : '双页'; rerender(); });
  const outline = await pdf.getOutline();
  if (signal.aborted) return { paint };
  if (outline?.length) {
    const list = document.createElement('select'); list.setAttribute('aria-label', 'PDF 目录');
    const destinations = []; const first = document.createElement('option'); first.textContent = '目录'; list.append(first);
    const add = (items, depth = 0) => { for (const item of items) { const option = document.createElement('option'); option.value = destinations.length; option.textContent = `${'　'.repeat(depth)}${item.title}`; destinations.push(item.dest); list.append(option); add(item.items || [], depth + 1); } }; add(outline);
    list.onchange = async () => { try { let dest = destinations[Number(list.value)]; if (typeof dest === 'string') dest = await pdf.getDestination(dest); const i = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]); pages[i]?.scrollIntoView({ block:'start' }); } catch { tools.report('此目录项无法跳转'); } }; toolbar.append(list);
  }
  const progress = document.createElement('span'); progress.className = 'book-progress'; toolbar.append(progress);
  const updateProgress = () => { const page = visiblePage(); progress.textContent = `${page} / ${pdf.numPages} · ${Math.round(page/pdf.numPages*100)}%`; };
  stage.addEventListener('scroll', updateProgress, { signal, passive:true }); updateProgress();
  const search = toolbar.querySelector('[data-pdf-search]');
  button(toolbar, '停止搜索', () => { searchRun++; tools.report('已停止搜索'); });
  host._filePreviewActions.find = async () => {
    const run = ++searchRun, query = search.value.trim().toLocaleLowerCase(); if (!query) return;
    tools.report('搜索中…'); const matches = [];
    for (let i=1; i<=pdf.numPages; i++) {
      if (signal.aborted || run !== searchRun) return;
      const page = await pdf.getPage(i), text = await page.getTextContent();
      if (text.items.map(item => item.str || '').join(' ').toLocaleLowerCase().includes(query)) matches.push(i);
      page.cleanup?.();
    }
    if (signal.aborted || run !== searchRun) return;
    tools.report(matches.length ? `匹配页：${matches.slice(0,30).join('、')}` : '未找到可搜索文字');
    if (matches.length) pages[matches[0]-1].scrollIntoView({ block:'start' });
  };
  signal.addEventListener('abort', () => { searchRun++; }, { once:true });
  await tools.restoreLink(); paint();
  return { paint };
}
