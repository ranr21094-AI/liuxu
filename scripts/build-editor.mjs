import { rm, mkdir, copyFile, cp, unlink, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDir = path.join(rootDir, 'public', 'generated');
const vendorDir = path.join(rootDir, 'public', 'vendor');

await rm(generatedDir, { recursive: true, force: true });

// Rebuild vendor dirs from scratch: stale or hand-dropped files would keep
// being served by express.static and packaged into the desktop installers.
for (const vendorSub of ['marked', 'dompurify', 'katex', 'pdfjs', 'docx-preview', 'sheetjs', 'pptx-renderer', 'jszip']) {
  await rm(path.join(vendorDir, vendorSub), { recursive: true, force: true });
}
await mkdir(path.join(vendorDir, 'marked'), { recursive: true });
await mkdir(path.join(vendorDir, 'dompurify'), { recursive: true });
await mkdir(path.join(vendorDir, 'katex'), { recursive: true });
await copyFile(path.join(rootDir, 'node_modules', 'marked', 'lib', 'marked.umd.js'), path.join(vendorDir, 'marked', 'marked.umd.js'));
await copyFile(path.join(rootDir, 'node_modules', 'dompurify', 'dist', 'purify.min.js'), path.join(vendorDir, 'dompurify', 'purify.min.js'));
await copyFile(path.join(rootDir, 'node_modules', 'katex', 'dist', 'katex.min.js'), path.join(vendorDir, 'katex', 'katex.min.js'));
await copyFile(path.join(rootDir, 'node_modules', 'katex', 'dist', 'katex.min.css'), path.join(vendorDir, 'katex', 'katex.min.css'));
await cp(path.join(rootDir, 'node_modules', 'katex', 'dist', 'fonts'), path.join(vendorDir, 'katex', 'fonts'), { recursive: true, force: true });

const pdfjsDir = path.join(vendorDir, 'pdfjs');
await mkdir(pdfjsDir, { recursive: true });
// pdfjs-dist v4 ships ESM only; drop stale v3 UMD copies if present.
for (const stale of ['pdf.min.js', 'pdf.worker.min.js']) {
  await unlink(path.join(pdfjsDir, stale)).catch(() => {});
}
await copyFile(path.join(rootDir, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.min.mjs'), path.join(pdfjsDir, 'pdf.min.mjs'));
await copyFile(path.join(rootDir, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.min.mjs'), path.join(pdfjsDir, 'pdf.worker.min.mjs'));

const docxDir = path.join(vendorDir, 'docx-preview');
await mkdir(docxDir, { recursive: true });
await copyFile(path.join(rootDir, 'node_modules', 'docx-preview', 'dist', 'docx-preview.min.js'), path.join(docxDir, 'docx-preview.min.js'));
await writeFile(path.join(docxDir, 'LICENSE.txt'), (await readFile(path.join(rootDir, 'node_modules', 'docx-preview', 'LICENSE'), 'utf8')).replace(/\r\n/g, '\n'));

const jszipDir = path.join(vendorDir, 'jszip');
await mkdir(jszipDir, { recursive: true });
await copyFile(path.join(rootDir, 'node_modules', 'jszip', 'dist', 'jszip.min.js'), path.join(jszipDir, 'jszip.min.js'));
await copyFile(path.join(rootDir, 'node_modules', 'jszip', 'LICENSE.markdown'), path.join(jszipDir, 'LICENSE.txt'));

const sheetjsDir = path.join(vendorDir, 'sheetjs');
await mkdir(sheetjsDir, { recursive: true });
await copyFile(path.join(rootDir, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'), path.join(sheetjsDir, 'xlsx.full.min.js'));
await copyFile(path.join(rootDir, 'node_modules', 'xlsx', 'LICENSE'), path.join(sheetjsDir, 'LICENSE.txt'));

const pptxDir = path.join(vendorDir, 'pptx-renderer');
await mkdir(pptxDir, { recursive: true });
await copyFile(path.join(rootDir, 'node_modules', '@aiden0z', 'pptx-renderer', 'dist', 'aiden0z-pptx-renderer.browser.es.js'), path.join(pptxDir, 'aiden0z-pptx-renderer.browser.es.js'));
await copyFile(path.join(rootDir, 'node_modules', '@aiden0z', 'pptx-renderer', 'LICENSE'), path.join(pptxDir, 'LICENSE.txt'));
await copyFile(path.join(rootDir, 'node_modules', '@aiden0z', 'pptx-renderer', 'THIRD_PARTY_NOTICES.md'), path.join(pptxDir, 'THIRD_PARTY_NOTICES.txt'));

// Pin Foliate in package-lock; copy only runtime modules and bundled dependencies.
const foliateDir = path.join(vendorDir, 'foliate');
const foliateSource = path.join(rootDir, 'node_modules', 'foliate-js');
await rm(foliateDir, { recursive: true, force: true });
await mkdir(foliateDir, { recursive: true });
for (const entry of await readdir(foliateSource)) {
  if (entry.endsWith('.js') && !['reader.js', 'eslint.config.js', 'rollup.config.js'].includes(entry)) {
    let source = await readFile(path.join(foliateSource, entry), 'utf8');
    // Book frames must never execute book scripts, including inline handlers.
    source = source.replaceAll('allow-same-origin allow-scripts', 'allow-same-origin').replace("import 'construct-style-sheets-polyfill'", '');
    if (entry === 'comic-book.js') source = source.replace('.sort()', ".sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))");
    if (entry === 'paginator.js') source = source
      .replace('const { style } = el', 'if (!el) return\n    const { style } = el')
      .replace('const { documentElement } = this.document', 'if (!this.document?.body || !this.document?.documentElement) return\n        const { documentElement } = this.document')
      .replace('doc.fonts.ready.then(() => this.expand())', 'doc.fonts.ready.then(() => this.document === doc && doc.body?.isConnected && this.expand())')
      .replaceAll('this.#view.docBackground', 'this.#view?.docBackground')
      .replaceAll('this.#view.expand()', 'this.#view?.expand()')
      .replaceAll('this.#view.destroy()', 'this.#view?.destroy()');
    await writeFile(path.join(foliateDir, entry), source);
  }
}
await cp(path.join(foliateSource, 'vendor'), path.join(foliateDir, 'vendor'), { recursive: true });
await copyFile(path.join(foliateSource, 'LICENSE'), path.join(foliateDir, 'LICENSE'));
await copyFile(path.join(foliateSource, 'README.md'), path.join(foliateDir, 'THIRD_PARTY_NOTICES.md'));
