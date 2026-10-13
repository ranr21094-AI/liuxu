import { mountReaderShell } from './reader-shell.js';
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
  let selected = null, tools, searchRun = 0, searchHit = null, selecting = false;
  const dismissSelection = () => { selected = null; tools?.hideSelectionAction(); };
  const visiblePage = () => Number((pages.find(page => !page.hidden && page.getBoundingClientRect().bottom > stage.getBoundingClientRect().top + 8) || pages[0]).dataset.pageNumber);
  const selectionChanged = () => {
    const selection = document.getSelection(); selected = null;
    if (selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const layer = start.closest('.file-pdf-text-layer');
      if (layer && host.contains(layer) && layer.contains(range.endContainer)) {
        const before = range.cloneRange(); before.selectNodeContents(layer); before.setEnd(range.startContainer, range.startOffset);
        const page = Number(layer.closest('[data-page-number]').dataset.pageNumber);
        selected = { anchor: JSON.stringify({ page, start: before.toString().length, end: before.toString().length + range.toString().length }), quote: range.toString(), label: `第 ${page} 页`, range: range.cloneRange() };
      }
    }
    if (!selecting) tools?.selectionChanged();
  };
  document.addEventListener('selectionchange', selectionChanged, { signal });
  stage.addEventListener('pointerdown', () => { selecting = true; dismissSelection(); }, { signal });
  document.addEventListener('pointerup', () => { if (selecting) { selecting = false; queueMicrotask(selectionChanged); } }, { signal });
  document.addEventListener('pointercancel', () => { selecting = false; dismissSelection(); }, { signal });
  function paint() {
    host.querySelectorAll('.book-pdf-highlight,.book-pdf-search-highlight').forEach(el => el.remove());
    if(searchHit) { try { const shell=pages[searchHit.page-1],layer=shell.querySelector('.file-pdf-text-layer'),box=layer.getBoundingClientRect(); if(shell.dataset.rendered==='true') for(const rect of textRange(layer,searchHit.start,searchHit.end).getClientRects()) { const mark=document.createElement('span'); mark.className='book-pdf-search-highlight'; Object.assign(mark.style,{left:`${rect.left-box.left}px`,top:`${rect.top-box.top}px`,width:`${rect.width}px`,height:`${rect.height}px`}); layer.parentElement.append(mark); } } catch {} }
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
  const layout=document.createElement('label'); layout.append(document.createTextNode('阅读方式')); const flow=document.createElement('select'); flow.setAttribute('aria-label','PDF 阅读方式'); flow.innerHTML='<option value="scrolled">连续滚动</option><option value="single">单页翻页</option><option value="spread">双页阅读</option>'; layout.append(flow); toolbar.append(layout); host.dataset.pdfFlow='scrolled';
  flow.onchange=()=> { dismissSelection(); const page=visiblePage(); host.dataset.pdfFlow=flow.value; stage.classList.toggle('book-pdf-spread',flow.value==='spread'); host.querySelector('[data-pdf-page]').value=String(page); host._filePreviewActions.go(); void rerender(); };
  const fitLabel=document.createElement('label'); fitLabel.append(document.createTextNode('页面缩放')); const fit=document.createElement('select'); fit.setAttribute('aria-label','PDF 页面缩放'); fit.innerHTML='<option value="width">适应宽度</option><option value="page">适应页面</option>'; fitLabel.append(fit); toolbar.append(fitLabel); fit.onchange=()=> { dismissSelection(); host.dataset.pdfFit=fit.value; host._filePreviewActions.fit(); };
  const pageInput=host.querySelector('[data-pdf-page]');
  const pageLabel=pageInput?.closest('label');
  const pageTotal=pageLabel?.nextElementSibling;
  const oldJump=toolbar.querySelector('[data-file-action="pdf-go"]');
  const goPage=async number=> { dismissSelection(); pageInput.value=String(Math.max(1,Math.min(pdf.numPages,Math.trunc(Number(number)||1)))); host._filePreviewActions.go(); };
  const pageControl=document.createElement('div'); pageControl.className='reader-page-control'; pageControl.setAttribute('role','group'); pageControl.setAttribute('aria-label','页面导航');
  const previous=button(pageControl,'‹',()=>goPage(visiblePage()-1)); previous.className='reader-page-step'; previous.setAttribute('aria-label','上一页'); previous.title='上一页';
  pageInput.setAttribute('aria-label','跳转到页码'); pageInput.title='输入页码并按 Enter 跳转';
  const denominator=document.createElement('span'); denominator.className='reader-page-total'; denominator.textContent=`/ ${pdf.numPages}`;
  pageLabel?.remove(); pageTotal?.remove(); oldJump?.remove();
  pageControl.append(pageInput,denominator);
  const next=button(pageControl,'›',()=>goPage(visiblePage()+1)); next.className='reader-page-step'; next.setAttribute('aria-label','下一页'); next.title='下一页';
  toolbar.append(pageControl);
  pageInput.addEventListener('keydown',event=>{ if(event.key==='Enter'&&!event.isComposing) { event.preventDefault(); void goPage(pageInput.value); pageInput.blur(); } },{signal});
  stage.addEventListener('keydown',event=> { if(selected?.quote || event.ctrlKey || event.metaKey || event.target!==stage) return; if(['ArrowRight','PageDown','ArrowLeft','PageUp'].includes(event.key)) { event.preventDefault(); void goPage(visiblePage()+(['ArrowRight','PageDown'].includes(event.key)?1:-1)); } },{signal});
  const nav=document.createElement('aside'); nav.className='book-nav'; nav.hidden=true; host.append(nav);
  const outline = await pdf.getOutline();
  if (signal.aborted) return { paint };
  button(toolbar,'目录',()=> {
    nav.replaceChildren();
    const add=(items,depth=0)=> { for(const item of items||[]) { const row=button(nav,item.title,async()=> { try { let dest=item.dest; if(typeof dest==='string') dest=await pdf.getDestination(dest); const i=typeof dest[0]==='number'?dest[0]:await pdf.getPageIndex(dest[0]); await goPage(i+1); await renderPage(i+1); pages[i].scrollIntoView({block:'start'}); nav.hidden=true; stage.focus({preventScroll:true}); } catch { tools.report('此目录项无法跳转'); } }); row.style.paddingLeft=`${8+depth*12}px`; row.dataset.readerJump=''; add(item.items,depth+1); } }; add(outline); if(!outline?.length) nav.append(document.createTextNode('此 PDF 没有目录')); nav.hidden=false;
  });
  const thumbs=document.createElement('section'); thumbs.className='reader-thumbnails';
  const thumbnailTasks=new Set(); let thumbQueue=Promise.resolve();
  const thumbButtons=pages.map((page,index)=> { const b=document.createElement('button'); b.type='button'; b.className='reader-thumbnail'; b.dataset.page=String(index+1); b.dataset.readerJump=''; b.setAttribute('aria-label',`第 ${index+1} 页`); b.innerHTML=`<canvas></canvas><span>${index+1}</span>`; b.onclick=async()=> { await goPage(index+1); await renderPage(index+1); page.scrollIntoView({block:'start'}); }; thumbs.append(b); return b; });
  const shell=mountReaderShell({host,toolbar,stage,signal,thumbnails:thumbs});
  const thumbObserver=new IntersectionObserver(entries=> { for(const entry of entries) if(!entry.isIntersecting && entry.target.dataset.ready==='true') { const canvas=entry.target.querySelector('canvas');canvas.width=canvas.height=0;delete entry.target.dataset.ready; } else if(entry.isIntersecting && !entry.target.dataset.ready) {
    entry.target.dataset.ready='pending'; thumbQueue=thumbQueue.then(async()=> { if(signal.aborted) return; const number=Number(entry.target.dataset.page),canvas=entry.target.querySelector('canvas'),large=pages[number-1].querySelector('canvas');
      if(large.width && pages[number-1].dataset.rendered==='true') { canvas.width=112; canvas.height=Math.round(112*large.height/large.width); canvas.getContext('2d').drawImage(large,0,0,canvas.width,canvas.height); }
      else { const page=await pdf.getPage(number); if(signal.aborted) return; const base=page.getViewport({scale:1}),viewport=page.getViewport({scale:112/base.width}); canvas.width=Math.round(viewport.width); canvas.height=Math.round(viewport.height); const task=page.render({canvasContext:canvas.getContext('2d'),viewport}); thumbnailTasks.add(task); try { await task.promise; } finally { thumbnailTasks.delete(task); } }
      entry.target.dataset.ready='true';
    }).catch(()=> { delete entry.target.dataset.ready; });
  } },{root:shell.side.querySelector('.reader-side-content'),rootMargin:'160px'});
  thumbButtons.forEach(b=>thumbObserver.observe(b));
  const updateProgress = () => {
    const page = visiblePage();
    thumbButtons.forEach((b,i)=> { if(i===page-1) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
    if(document.activeElement !== pageInput) pageInput.value=String(page);
    // Retain page geometry while releasing off-screen pixel buffers.
    pages.forEach((el,i)=> { if(Math.abs(i+1-page)>4 && el.dataset.rendered==='true') { el.style.minHeight=`${el.offsetHeight}px`; const canvas=el.querySelector('canvas'); canvas.width=canvas.height=0; el.querySelector('.file-pdf-text-layer').replaceChildren(); el.dataset.rendered=''; } });
  };
  stage.addEventListener('scroll', () => { dismissSelection(); updateProgress(); }, { signal, passive:true }); updateProgress();
  const search = host.querySelector('[data-pdf-search]');
  host._filePreviewActions.find = async () => {
    const run=++searchRun,query=search.value.trim().toLocaleLowerCase(); if(!query) return;
    nav.replaceChildren(); nav.hidden=false; button(nav,'停止搜索 / 关闭',()=> { searchRun++; searchHit=null; paint(); nav.hidden=true; });
    tools.report('搜索中…'); let count=0;
    try { for(let i=1;i<=pdf.numPages && count<300;i++) {
      if(signal.aborted || run!==searchRun) return;
      const page=await pdf.getPage(i),text=await page.getTextContent(); if(signal.aborted || run!==searchRun) return;
      const full=text.items.map(item=>item.str||'').join(''),lower=full.toLocaleLowerCase(); let offset=0,index;
      while((index=lower.indexOf(query,offset))>=0 && count<300) {
        const hit={page:i,start:index,end:index+query.length}; count++;
        const row=button(nav,`第 ${i} 页 · ${full.slice(Math.max(0,index-24),index+query.length+48)}`,async()=> { searchHit=hit; await goPage(i); await renderPage(i); pages[i-1].scrollIntoView({block:'start'}); paint(); stage.focus({preventScroll:true}); }); row.dataset.readerJump=''; offset=index+Math.max(1,query.length);
      }
    } if(run!==searchRun || signal.aborted) return; tools.report(count ? `找到 ${count} 处${count===300?'（最多显示 300 处）':''}` : '未找到可搜索文字'); }
    catch(error) { if(!signal.aborted && run===searchRun) tools.report(error.message); }
  };
  host._filePreviewActions.clearSearch = () => { searchRun++; searchHit=null; paint(); };
  signal.addEventListener('abort',()=> { searchRun++; thumbObserver.disconnect(); thumbnailTasks.forEach(task=>task.cancel()); nav.remove(); },{once:true});
  await tools.restoreLink(); paint();
  return { paint, hideSelectionAction: dismissSelection };
}
