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
      if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', `#${id}`);
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
