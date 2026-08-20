import { rm, mkdir, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDir = path.join(rootDir, 'public', 'generated');
const vendorDir = path.join(rootDir, 'public', 'vendor');

await rm(generatedDir, { recursive: true, force: true });

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
await copyFile(path.join(rootDir, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.min.js'), path.join(pdfjsDir, 'pdf.min.js'));
await copyFile(path.join(rootDir, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.min.js'), path.join(pdfjsDir, 'pdf.worker.min.js'));
