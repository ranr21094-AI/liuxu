import { rm, mkdir, copyFile, cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDir = path.join(rootDir, 'public', 'generated');
const outputDir = path.join(generatedDir, 'editor');
const vendorDir = path.join(rootDir, 'public', 'vendor');
const editorEntry = path.join(rootDir, 'src', 'codemirror', 'editor-entry.js');

// Pass the entry source over stdin because OneDrive exposes hydrated files as
// Windows reparse points that esbuild can intermittently fail to open directly.
const editorSource = await readFile(editorEntry, 'utf8');
const oneDriveFsPlugin = {
  name: 'onedrive-fs',
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return null;
      if (args.path.startsWith('node:')) return { path: args.path, external: true };
      const importer = args.importer || editorEntry;
      const resolved = import.meta.resolve(args.path, pathToFileURL(importer).href);
      if (!resolved.startsWith('file:')) return { path: resolved, external: true };
      return { path: fileURLToPath(resolved) };
    });
    build.onLoad({ filter: /.*/ }, async args => {
      const extension = path.extname(args.path).toLowerCase();
      const loader = extension === '.json' ? 'json' : (extension === '.css' ? 'css' : 'js');
      return { contents: await readFile(args.path), loader, resolveDir: path.dirname(args.path) };
    });
  },
};

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
  stdin: {
    contents: editorSource,
    resolveDir: path.dirname(editorEntry),
    sourcefile: 'editor-entry.js',
    loader: 'js',
  },
  outfile: path.join(outputDir, 'editor.js'),
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  minify: true,
  plugins: [oneDriveFsPlugin],
  logLevel: 'info',
});
