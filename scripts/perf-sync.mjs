import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const count = Math.min(10000, Math.max(1000, Number(process.env.PERF_DOCS) || 1000));
const samples = 30;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-sync-perf-db-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-sync-perf-root-'));
process.env.DATA_DIR = directory;
process.env.AI_SECRETS_KEY_FILE = path.join(directory, 'ai-secrets.key');
const { createDatabase } = require('../database');
const { registerKnowledgeRoutes, serviceFor, shutdownKnowledgeServices } = require('../lib/knowledge/routes');
const { serializeMarkdown, fileFingerprint } = require('../lib/knowledge/folder-sync');
const express = require('express');
const db = createDatabase(directory);
const documents = {};
let server;
const p95 = values => Number(values.slice().sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1].toFixed(2));
const p50 = values => Number(values.slice().sort((a, b) => a - b)[Math.ceil(values.length * 0.5) - 1].toFixed(2));
try {
  const insert = db.sqlite.prepare('INSERT INTO knowledge_documents (id, body) VALUES (?, ?)');
  db.addCategory('性能'); db.addCategory('附件');
  db.sqlite.transaction(() => {
    for (let i = 1; i <= count; i++) {
      const folderPath = `父${i % 20}/子${i % 50}`;
      const relativePath = `性能/${folderPath}/${i}.md`;
      const doc = { id: `note:${i}`, sourceType: 'note', sourceRef: `note:${i}`, title: `文档 ${i}`,
        content: `alpha ${i}\n` + '用于模拟知识库较长正文。'.repeat(80), tags: [], status: 'active',
        knowledgeBase: '性能', folderPath, collectionPath: `性能/${folderPath}`, version: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const bytes = Buffer.from(serializeMarkdown(doc));
      const file = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
      doc.fileSync = { relativePath, sourceType: 'note', assets: [], fingerprint: {
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
        mtimeMs: Math.round(fs.statSync(file).mtimeMs) } };
      documents[doc.id] = doc.fileSync; insert.run(doc.id, JSON.stringify(doc));
    }
    for (const mib of [8, 64, 250]) {
      const relativePath = `附件/${mib}MiB.png`, file = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'w');
      const chunk = crypto.randomBytes(1024 * 1024);
      try { for (let i = 0; i < mib; i++) fs.writeSync(fd, chunk); }
      finally { fs.closeSync(fd); }
      const fileSync = { relativePath, sourceType: 'file', fingerprint: fileFingerprint(file) };
      const doc = { id: `file:${mib}`, sourceType: 'file', title: `${mib}MiB.png`, content: '', tags: [], status: 'active', version: 1,
        knowledgeBase: '附件', folderPath: '', collectionPath: '附件', fileSync,
        fileMeta: { filename: `${mib}MiB.png`, mimeType: 'image/png', previewKind: 'image', bytes: mib * 1024 * 1024, sha256: fileSync.fingerprint.sha256 } };
      documents[doc.id] = fileSync; insert.run(doc.id, JSON.stringify(doc));
    }
  })();
  db.sqlite.prepare("INSERT OR REPLACE INTO knowledge_index_state (id, version, updated_at) VALUES (1, 1, ?)").run(Date.now());
  db.sqlite.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('next_note_id', ?)").run(String(count + 1));
  fs.mkdirSync(path.join(root, '.liuxu'));
  fs.writeFileSync(path.join(root, '.liuxu', 'manifest.json'), JSON.stringify({ version: 1, sequence: 0, documents, assets: [], verifiedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(directory, '.knowledge-folder.json'), JSON.stringify({ version: 2, enabled: true, rootPath: root, scanIntervalMs: 300000 }));
  const app = express(); app.use(express.json()); registerKnowledgeRoutes(app, { db });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const startupStarted = performance.now();
  const { knowledge, search } = serviceFor(db);
  const trace = {};
  let traceScenario = 'baseline';
  const originals = [];
  const instrument = (object, name, label = name) => {
    const original = object[name];
    object[name] = function (...args) {
      const started = performance.now();
      try { return original.apply(this, args); }
      finally {
        const values = (trace[traceScenario] ||= {})[label] ||= [];
        values.push(performance.now() - started);
      }
    };
    originals.push(() => { object[name] = original; });
  };
  await knowledge.folderSync.syncNow({ reason: 'interval' });
  const startupScanMs = Number((performance.now() - startupStarted).toFixed(2));
  await knowledge.folderSync.stop();
  search.search('alpha'); // Warm the index outside the measured scenarios.
  const validation = {};
  const rootReadDirectory = fs.promises.readdir;
  let rootTraversals = 0;
  fs.promises.readdir = async function (directoryPath, ...args) {
    if (path.resolve(String(directoryPath)) === path.resolve(root)) rootTraversals++;
    return rootReadDirectory.call(this, directoryPath, ...args);
  };
  try {
    const relative = knowledge.getDocument('note:1').fileSync.relativePath;
    fs.appendFileSync(path.join(root, relative), '\nexternal update');
    knowledge.folderSync.enqueuePath(relative);
    await knowledge.folderSync.syncNow({ reason: 'watch' });
    assert.match(knowledge.getDocument('note:1').content, /external update/);
    assert.equal(rootTraversals, 0);
    validation.singleExternalChangeRootTraversals = rootTraversals;
    const current = knowledge.getDocument('note:1');
    knowledge.updateDocument(current.id, { content: current.content + '\napp update', baseVersion: current.version });
    knowledge.folderSync.enqueuePath(relative); // Replay the notification from an application write.
    const selfWrite = await knowledge.folderSync.syncNow({ reason: 'watch' });
    assert.equal(selfWrite.report.updated, 0);
    assert.equal(rootTraversals, 0);
    validation.applicationSaveRootTraversals = rootTraversals;
  } finally { fs.promises.readdir = rootReadDirectory; }
  await knowledge.folderSync.compactManifest();
  const manifestPath = knowledge.folderSync.paths().manifest;
  const snapshotBefore = fs.statSync(manifestPath).mtimeMs;
  await knowledge.folderSync.syncNow({ reason: 'interval' });
  assert.equal(fs.statSync(manifestPath).mtimeMs, snapshotBefore);
  validation.unchangedScanPreservesSnapshot = true;
  const request = async (url, options) => {
    const start = performance.now(); const response = await fetch(origin + url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || response.statusText);
    return performance.now() - start;
  };
  await request('/api/knowledge/documents/note:1');
  if (process.env.PERF_TRACE === '1') {
    instrument(fs, 'fsyncSync');
    instrument(knowledge.folderSync, 'prepareWrite');
    instrument(knowledge.folderSync, 'persistPrepared');
    instrument(knowledge, 'updateDocument');
    instrument(search, 'search');
  }
  const operation = async index => {
    const doc = knowledge.getDocument('note:2');
    return Promise.all([
      request('/api/knowledge/search?q=alpha&limit=20'),
      request(`/api/knowledge/documents/note:${index % count + 1}`),
      request('/api/knowledge/documents/note:2', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `alpha update ${index}`, baseVersion: doc.version }) }),
    ]);
  };
  const measurements = [];
  for (let i = 0; i < samples; i++) measurements.push(await operation(i));
  const summarize = values => Object.fromEntries(['search', 'switch', 'save'].map((name, i) => [name, { p50Ms: p50(values.map(row => row[i])), p95Ms: p95(values.map(row => row[i])) }]));
  const baseline = summarize(measurements);
  const scenarios = [];
  for (const mib of [8, 64, 250]) {
    traceScenario = `${mib}MiB`;
    const delay = monitorEventLoopDelay({ resolution: 2 }); delay.enable();
    const values = [], durations = [];
    for (let i = 0; i < samples; i++) {
      knowledge.folderSync.enqueuePath(`附件/${mib}MiB.png`);
      const start = performance.now();
      const background = knowledge.folderSync.syncNow({ reason: 'watch' });
      values.push(await operation(samples + i));
      const result = await background;
      if (result.report.errors.length) throw new Error(JSON.stringify(result.report.errors));
      durations.push(performance.now() - start);
    }
    delay.disable();
    const operations = summarize(values);
    scenarios.push({ attachmentMiB: mib, operations, firstVerificationMs: Number(durations[0].toFixed(2)), verificationP50Ms: p50(durations), verificationP95Ms: p95(durations),
      eventLoopP95Ms: Number((delay.percentile(95) / 1e6).toFixed(2)),
      additionalRequestP95Ms: Math.max(...Object.keys(operations).map(name => Number((operations[name].p95Ms - baseline[name].p95Ms).toFixed(2)))) });
  }
  const delay = monitorEventLoopDelay({ resolution: 2 }); delay.enable();
  traceScenario = 'full';
  const fullStarted = performance.now();
  const full = knowledge.folderSync.syncNow({ reason: 'manual' });
  const fullOperations = [];
  for (let i = 0; i < samples; i++) fullOperations.push(await operation(2 * samples + i));
  const result = await full;
  delay.disable();
  if (result.report.errors.length) throw new Error(JSON.stringify(result.report.errors));
  const report = { docs: count, samples, startupScanMs, validation, node: process.version, platform: process.platform, arch: process.arch,
    baseline, attachmentScenarios: scenarios, fullVerificationMs: Number((performance.now() - fullStarted).toFixed(2)),
    fullVerificationOperations: summarize(fullOperations), fullVerificationEventLoopP95Ms: Number((delay.percentile(95) / 1e6).toFixed(2)),
    rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)) };
  const passed = scenarios.every(row => row.eventLoopP95Ms < 20 && row.additionalRequestP95Ms <= 20)
    && report.fullVerificationEventLoopP95Ms < 20
    && Object.keys(baseline).every(name => report.fullVerificationOperations[name].p95Ms - baseline[name].p95Ms <= 20);
  report.meetsTargets = passed;
  if (process.env.PERF_TRACE === '1') {
    report.synchronousTrace = Object.fromEntries(Object.entries(trace).map(([scenario, timings]) => [scenario,
      Object.fromEntries(Object.entries(timings).map(([name, values]) => [name,
        { samples: values.length, p50Ms: p50(values), p95Ms: p95(values), maxMs: Number(Math.max(...values).toFixed(2)) }]))]));
  }
  for (const restore of originals) restore();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!passed && process.env.PERF_STRICT === '1') process.exitCode = 2;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await shutdownKnowledgeServices(); db.close();
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(directory, { recursive: true, force: true });
}
