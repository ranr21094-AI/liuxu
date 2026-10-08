// Source ranges bind edits to one occurrence, rather than a shared image URL.
export const escapeAttr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function imageHtml(src, alt = '') { return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`; }
export function imageTokens(source) {
  const tokens = [], excluded = [];
  let fence = null, offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence || mark) {
      excluded.push([offset, offset + line.length]);
      if (!fence) fence = mark[1]; else if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
    }
    offset += line.length;
  }
  const regex = /(`+)[\s\S]*?\1|<img\b[^>]*>|!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>\n]+>|[^\s()]+)(?:\s+["'][^\n]*?["'])?\s*\)/gi;
  for (const match of source.matchAll(regex)) {
    if (match[1] || excluded.some(([a,b]) => match.index >= a && match.index < b)) continue;
    const raw = match[0], html = /^<img/i.test(raw);
    const src = html ? raw.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) : null;
    if (html && !src) continue;
    tokens.push({ start: match.index, end: match.index + raw.length, raw, html, src: html ? src[1] ?? src[2] ?? src[3] : match[3].replace(/^<|>$/g, ''), alt: html ? '' : match[2].replace(/\\(.)/g, '$1') });
  }
  return tokens;
}
export function resizedImage(token, size, alt = token.alt) {
  const attrs = token.html ? token.raw.replace(/\s+(?:width|height|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '') : imageHtml(token.src, alt);
  const suffix = size === 'auto' ? '' : typeof size === 'string' && /^\d+%$/.test(size) && Number(size.slice(0,-1)) >= 1 && Number(size.slice(0,-1)) <= 100 ? ` style="width:${size};height:auto"` : Number.isInteger(Number(size)) && Number(size) >= 16 && Number(size) <= 10000 ? ` width="${Number(size)}"` : null;
  if (suffix === null) throw new Error('请输入 16–10000 像素或 1%–100% 的宽度');
  return attrs.replace(/\s*\/?\s*>$/, `${suffix}>`);
}
export function bindNoteImageSizing({ host, getSource, getDocumentId, getVersion = () => undefined, canEdit, onChange, openOriginal }) {
  const doc = host.ownerDocument, win = doc.defaultView, renderSource = getSource(), renderId = getDocumentId(), tokens = imageTokens(renderSource);
  host.querySelectorAll('img').forEach(image => {
    const width = image.getAttribute('width'), styleWidth = image.style.width;
    image.removeAttribute('height');
    if (width && (!/^\d+$/.test(width) || Number(width) < 16 || Number(width) > 10000)) image.removeAttribute('width');
    if (!/^([1-9]\d?|100)%$/.test(styleWidth) && !/^(?:[1-9]\d{1,3}|10000)px$/.test(styleWidth)) image.style.removeProperty('width');
    image.style.height = 'auto'; image.style.maxWidth = '100%'; image.style.minWidth = '0';
  });
  const images = [...host.querySelectorAll('img')];
  // Unsupported Markdown syntax remains viewable, but cannot risk editing another occurrence.
  if (images.length !== tokens.length) return () => {};
  let selected, bar, handle, gesture;
  function finishDrag(event) { if (!gesture || gesture.id !== event.pointerId) return; const next = gesture.next; selected.image.style.width = gesture.original; gesture = null; if (next) apply(next); }
  const removers = [], listen = (node, type, fn, options) => { node.addEventListener(type, fn, options); removers.push(() => node.removeEventListener(type, fn, options)); };
  const valid = () => selected && canEdit() && getDocumentId() === selected.id && getVersion() === selected.version && getSource() === selected.source;
  function clear() { if (gesture) selected.image.style.width = gesture.original; gesture = null; bar?.remove(); handle?.remove(); selected = null; }
  function apply(size) {
    if (!valid()) { clear(); return; }
    const { token, source, image } = selected;
    let html; try { html = resizedImage(token, size, image.alt); } catch (error) { bar.querySelector('[role=status]').textContent = error.message; return; }
    clear(); onChange(source.slice(0, token.start) + html + source.slice(token.end));
  }
  function place() {
    if (!selected) return;
    const rect = selected.image.getBoundingClientRect();
    handle.style.left = `${Math.max(0, Math.min(win.innerWidth - 28, rect.right - 14))}px`; handle.style.top = `${Math.max(0, Math.min(win.innerHeight - 28, rect.bottom - 14))}px`;
  }
  function choose(image, index) {
    clear(); if (getSource() !== renderSource || getDocumentId() !== renderId) return; if (!canEdit()) { openOriginal(image); return; }
    selected = { image, token: tokens[index], source: getSource(), id: getDocumentId(), version: getVersion() };
    bar = doc.createElement('div'); bar.className = 'note-image-size-bar'; bar.setAttribute('role', 'group'); bar.setAttribute('aria-label','图片尺寸');
    bar.innerHTML = '<label>宽度 <input type="number" min="16" max="10000" aria-label="图片像素宽度"></label><button data-size="pixels">应用</button><select aria-label="图片百分比宽度"><option value="">百分比</option><option>25%</option><option>50%</option><option>75%</option><option>100%</option></select><button data-size="auto">原始尺寸</button><button data-size="original">查看原图</button><button data-size="close" aria-label="关闭图片调整">关闭</button><span role="status"></span>';
    bar.querySelector('input').value = Math.round(image.getBoundingClientRect().width);
    handle = doc.createElement('button'); handle.className = 'note-image-resize-handle'; handle.setAttribute('aria-label', '拖动等比调整图片宽度');
    doc.body.append(bar, handle); place();
    bar.onclick = event => { const action = event.target.dataset.size; if (action === 'pixels') apply(bar.querySelector('input').value); else if (action === 'auto') apply('auto'); else if (action === 'original') openOriginal(image); else if (action === 'close') clear(); };
    bar.querySelector('select').onchange = event => apply(event.target.value);
    bar.querySelector('input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); apply(event.target.value); } };
    handle.onpointerdown = event => { if (!valid()) return clear(); event.preventDefault(); gesture = { id: event.pointerId, x: event.clientX, width: image.getBoundingClientRect().width, original: image.style.width }; try { handle.setPointerCapture?.(event.pointerId); } catch { /* Document release handler remains available. */ } };
    handle.onpointermove = event => { if (!gesture || gesture.id !== event.pointerId) return; if (!valid()) return clear(); gesture.next = Math.max(16, Math.min(10000, Math.round(gesture.width + event.clientX - gesture.x))); image.style.width = `${gesture.next}px`; image.style.height = 'auto'; place(); };
    handle.onpointerup = finishDrag;
    handle.onpointercancel = clear;
  }
  images.forEach((image, index) => listen(image, 'click', event => { if (image.closest('a')) return; event.preventDefault(); choose(image, index); }));
  listen(doc, 'pointerup', finishDrag);
  listen(doc, 'pointercancel', () => { if (gesture) clear(); });
  listen(win, 'blur', clear);
  listen(host, 'scroll', place, { passive: true }); listen(win, 'resize', clear);
  listen(doc, 'keydown', event => { if (event.key === 'Escape') clear(); });
  listen(doc, 'pointerdown', event => { if (selected && !bar.contains(event.target) && event.target !== handle && event.target !== selected.image) clear(); });
  return () => { clear(); removers.forEach(remove => remove()); };
}
