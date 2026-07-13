import { rm, mkdir, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDir = path.join(rootDir, 'public', 'generated');
const outputDir = path.join(generatedDir, 'editor');
const vendorDir = path.join(rootDir, 'public', 'vendor');

await rm(generatedDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await mkdir(path.join(vendorDir, 'marked'), { recursive: true });
await mkdir(path.join(vendorDir, 'dompurify'), { recursive: true });
await mkdir(path.join(vendorDir, 'katex'), { recursive: true });
await copyFile(path.join(rootDir, 'node_modules', 'marked', 'lib', 'marked.umd.js'), path.join(vendorDir, 'marked', 'marked.umd.js'));
await copyFile(path.join(rootDir, 'node_modules', 'dompurify', 'dist', 'purify.min.js'), path.join(vendorDir, 'dompurify', 'purify.min.js'));
await copyFile(path.join(rootDir, 'node_modules', 'katex', 'dist', 'katex.min.js'), path.join(vendorDir, 'katex', 'katex.min.js'));
await copyFile(path.join(rootDir, 'node_modules', 'katex', 'dist', 'katex.min.css'), path.join(vendorDir, 'katex', 'katex.min.css'));
await cp(path.join(rootDir, 'node_modules', 'katex', 'dist', 'fonts'), path.join(vendorDir, 'katex', 'fonts'), { recursive: true, force: true });

await build({
  absWorkingDir: rootDir,
  entryPoints: {
    editor: path.join(rootDir, 'src', 'codemirror', 'editor-entry.js'),
  },
  outdir: outputDir,
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  minify: true,
  entryNames: '[name]',
  logLevel: 'info',
});
