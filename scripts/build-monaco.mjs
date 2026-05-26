import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(rootDir, 'public', 'generated', 'monaco');

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await build({
  absWorkingDir: rootDir,
  entryPoints: {
    editor: path.join(rootDir, 'src', 'monaco', 'editor-entry.js'),
    'editor.worker': path.join(rootDir, 'src', 'monaco', 'editor-worker.js'),
  },
  outdir: outputDir,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2020'],
  minify: true,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  loader: {
    '.ttf': 'file',
  },
  logLevel: 'info',
});
