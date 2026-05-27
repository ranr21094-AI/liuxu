import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDir = path.join(rootDir, 'public', 'generated');
const outputDir = path.join(generatedDir, 'editor');

await rm(generatedDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

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
