const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

async function loadModule() {
  const url = pathToFileURL(path.join(__dirname, '../public/js/knowledge/markdown-toc.js'));
  url.search = `test=${Date.now()}-${Math.random()}`;
  return import(url.href);
}

function makeDom(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="preview">${html}</div><aside id="toc"></aside></body>`, { url: 'http://127.0.0.1/' });
  const document = dom.window.document;
  return { dom, preview: document.querySelector('#preview'), tocHost: document.querySelector('#toc') };
}

test('builds a sibling toc with heading levels and unique ids', async () => {
  const { renderMarkdownToc } = await loadModule();
  const { dom, preview, tocHost } = makeDom('<h1>重复标题</h1><h2>子标题</h2><h2>重复标题</h2>');
  try {
    renderMarkdownToc(preview, tocHost);
    assert.deepEqual([...preview.querySelectorAll('h1,h2')].map(node => node.id), ['重复标题', '子标题', '重复标题-2']);
    assert.deepEqual([...tocHost.querySelectorAll('[data-markdown-toc] a')].map(node => node.textContent), ['重复标题', '子标题', '重复标题']);
    assert.equal(preview.querySelector('[data-markdown-toc]'), null);
    assert.deepEqual([...tocHost.querySelectorAll('[data-markdown-toc] li')].map(node => node.className), ['markdown-toc-level-1', 'markdown-toc-level-2', 'markdown-toc-level-2']);
    assert.equal(tocHost.querySelector('[data-markdown-toc] summary').textContent, '目录');
  } finally {
    dom.window.close();
  }
});

test('uses textContent safely and clicking a toc link scrolls its preview heading', async () => {
  const { renderMarkdownToc } = await loadModule();
  const { dom, preview, tocHost } = makeDom('<h1><img src=x onerror=alert(1)>安全 & 标题</h1>');
  try {
    const heading = preview.querySelector('h1');
    let scrolled = false;
    heading.scrollIntoView = options => { scrolled = options.behavior === 'smooth'; };
    renderMarkdownToc(preview, tocHost);
    const link = tocHost.querySelector('[data-markdown-toc] a');
    assert.equal(tocHost.querySelector('[data-markdown-toc]').innerHTML.includes('onerror'), false);
    assert.equal(link.textContent, heading.textContent);
    link.click();
    assert.equal(scrolled, true);
  } finally {
    dom.window.close();
  }
});

test('clears old toc in its host and heading ids in preview before rebuilding', async () => {
  const { clearMarkdownToc, renderMarkdownToc } = await loadModule();
  const { dom, preview, tocHost } = makeDom('<h1 id="old-id">标题</h1>');
  tocHost.innerHTML = '<details data-markdown-toc><summary>旧目录</summary></details>';
  try {
    clearMarkdownToc(preview, tocHost);
    assert.equal(tocHost.querySelector('[data-markdown-toc]'), null);
    assert.equal(preview.querySelector('h1').hasAttribute('id'), false);
    renderMarkdownToc(preview, tocHost);
    assert.equal(tocHost.querySelectorAll('[data-markdown-toc]').length, 1);
    assert.equal(preview.querySelector('h1').id, '标题');
  } finally {
    dom.window.close();
  }
});
