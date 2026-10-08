const TOC_SELECTOR = '[data-markdown-toc]';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

function normalizeId(text) {
  const value = String(text || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || 'heading';
}

function clearMarkdownToc(preview, tocHost) {
  tocHost?.querySelectorAll(TOC_SELECTOR).forEach(toc => toc.remove());
  preview?.querySelectorAll(HEADING_SELECTOR).forEach(heading => heading.removeAttribute('id'));
}

function createToc(preview, tocHost) {
  const headings = [...(preview?.querySelectorAll(HEADING_SELECTOR) || [])];
  if (!headings.length || !tocHost) return null;
  const used = new Set();
  const document = tocHost.ownerDocument;
  const details = document.createElement('details');
  details.className = 'markdown-toc';
  details.dataset.markdownToc = 'true';
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = '目录';
  details.append(summary);
  const list = document.createElement('ol');
  list.className = 'markdown-toc-list';

  headings.forEach(heading => {
    const base = normalizeId(heading.textContent);
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    heading.id = id;

    const item = document.createElement('li');
    item.className = `markdown-toc-level-${heading.tagName.slice(1)}`;
    const link = document.createElement('a');
    link.href = `#${id}`;
    link.textContent = heading.textContent || '无标题';
    link.addEventListener('click', event => {
      event.preventDefault();
      heading.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      heading.focus?.({ preventScroll: true });
    });
    item.append(link);
    list.append(item);
  });
  details.append(list);
  tocHost.append(details);
  return details;
}

function renderMarkdownToc(preview, tocHost) {
  if (!preview || !tocHost) return null;
  clearMarkdownToc(preview, tocHost);
  return createToc(preview, tocHost);
}

export { clearMarkdownToc, renderMarkdownToc };

export function sourceHeadings(value) {
  const lines = String(value || '').split('\n');
  const headings = [];
  let offset = 0, fence = null, previous = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      previous = null;
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length }; previous = null;
    } else if (/^(?: {4}|\t)/.test(line) || !line.trim()) {
      previous = null;
    } else {
      const atx = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/);
      const setext = line.match(/^ {0,3}(=+|-+)[ \t]*$/);
      if (atx) {
        headings.push({ text: (atx[2] || '').replace(/[ \t]+#+[ \t]*$/, '').trim() || '无标题', level: atx[1].length, offset });
        previous = null;
      } else if (setext && previous) {
        headings.push({ text: previous.text, level: setext[1][0] === '=' ? 1 : 2, offset: previous.offset });
        previous = null;
      } else if (/^ {0,3}(?:>|[-+*]\s|\d+[.)]\s|<[!/a-zA-Z])/.test(line)) previous = null;
      else previous = { text: previous ? `${previous.text} ${line.trim()}` : line.trim(), offset: previous?.offset ?? offset };
    }
    offset += raw.length + 1;
  }
  return headings;
}

export function locateEditorHeading(textarea, offset) {
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(offset, offset);
  const doc = textarea.ownerDocument;
  const style = doc.defaultView.getComputedStyle(textarea);
  const mirror = doc.createElement('div');
  for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'tabSize']) mirror.style[key] = style[key];
  Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', width: `${textarea.clientWidth}px`, boxSizing: 'border-box', top: '0', left: '0' });
  mirror.textContent = textarea.value.slice(0, offset);
  const marker = doc.createElement('span'); marker.textContent = '\u200b'; mirror.append(marker);
  doc.body.append(mirror);
  textarea.scrollTop = Math.max(0, marker.offsetTop - textarea.clientHeight / 3);
  mirror.remove();
}

export function renderSourceToc(source, tocHost, onNavigate) {
  tocHost.replaceChildren();
  const doc = tocHost.ownerDocument;
  const headings = sourceHeadings(source);
  const details = doc.createElement('details'); details.className = 'markdown-toc'; details.dataset.markdownToc = 'true'; details.open = true;
  const summary = doc.createElement('summary'); summary.textContent = '目录'; details.append(summary);
  const list = doc.createElement('ol'); list.className = 'markdown-toc-list';
  for (const heading of headings) {
    const item = doc.createElement('li'); item.className = `markdown-toc-level-${heading.level}`;
    const link = doc.createElement('a'); link.href = '#'; link.textContent = heading.text;
    link.addEventListener('click', event => { event.preventDefault(); onNavigate(heading.offset); });
    item.append(link); list.append(item);
  }
  if (!headings.length) { const empty = doc.createElement('p'); empty.className = 'markdown-toc-empty'; empty.textContent = '暂无标题'; details.append(empty); }
  details.append(list); tocHost.append(details);
  return details;
}
