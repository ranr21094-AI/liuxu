const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseFrontMatter, markdownImageTokens, validManifestDelta } = require('./folder-sync');

function state(stat) {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev };
}

async function safeFile(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('知识库路径越界');
  let current = file;
  while (true) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('知识库路径不能经过符号链接');
    if (current === root) break;
    current = path.dirname(current);
  }
}

async function inspect({ root, file, note, generation, documentVersion }) {
  await safeFile(root, file);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 250 * 1024 * 1024) throw new Error('知识库文件无效或超过 250 MiB');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
    const chunks = [];
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) break;
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      if (note) chunks.push(Buffer.from(bytes));
      offset += bytesRead;
    }
    const after = await handle.stat();
    await safeFile(root, file);
    const current = await fs.stat(file);
    if (offset !== before.size || JSON.stringify(state(before)) !== JSON.stringify(state(after))
      || JSON.stringify(state(after)) !== JSON.stringify(state(current))) return { stale: true, generation };
    const parsed = note ? parseFrontMatter(Buffer.concat(chunks).toString('utf8'), path.basename(file, '.md')) : null;
    return { generation, documentVersion, state: state(after),
      fingerprint: { sha256: hash.digest('hex'), size: after.size, mtimeMs: Math.round(after.mtimeMs) },
      parsed, images: parsed ? markdownImageTokens(parsed.content).tokens.map(token => token.source) : [] };
  } finally { await handle.close(); }
}

async function compact({ root, manifest, deltas, temporary }) {
  await safeFile(root, deltas);
  let saved = { version: 1, sequence: 0, documents: {}, assets: [] };
  try { await safeFile(root, manifest); saved = JSON.parse(await fs.readFile(manifest, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const assets = new Set(saved.assets || []);
  const text = await fs.readFile(deltas, 'utf8');
  const lines = text.split('\n');
  lines.pop(); // Only newline-terminated (durable) records are replayed.
  for (const line of lines) {
    if (!line) continue;
    const delta = JSON.parse(line);
    if (!validManifestDelta(delta)) throw new Error('Invalid manifest delta');
    if (delta.sequence <= (saved.sequence || 0)) continue;
    if (delta.sequence !== (saved.sequence || 0) + 1) throw new Error('Manifest sequence gap');
    if (delta.operation === 'upsert') saved.documents[delta.id] = delta.entry;
    else if (delta.operation === 'delete') delete saved.documents[delta.id];
    else if (delta.operation === 'verified') saved.verifiedAt = delta.verifiedAt;
    else if (delta.operation === 'asset') { if (delta.present) assets.add(delta.relativePath); else assets.delete(delta.relativePath); }
    else throw new Error('Unknown manifest operation');
    saved.sequence = delta.sequence;
  }
  saved.assets = [...assets].sort();
  saved.updatedAt = new Date().toISOString();
  if (path.dirname(temporary) !== path.dirname(manifest) || !temporary.startsWith(`${manifest}.liuxu-`)) throw new Error('Unsafe snapshot path');
  await safeFile(root, path.dirname(manifest));
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(saved)); await handle.sync(); }
    finally { await handle.close(); }
    try { await safeFile(root, manifest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(temporary, manifest);
    return { sequence: saved.sequence || 0 };
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

parentPort.on('message', async ({ id, type, payload }) => {
  try {
    const result = type === 'inspect' ? await inspect(payload) : await compact(payload);
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.message, code: error.code }); }
});
