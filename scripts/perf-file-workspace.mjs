import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'liuxu-file-perf-'));
const root = path.join(dir, 'files'); await fs.mkdir(root);
process.env.DATA_DIR = path.join(dir, 'data');
const { createDatabase } = require('../database');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { createSearchIndex } = require('../lib/knowledge/search');
const count = Math.max(1, Number(process.env.PERF_DOCS) || 1000);
const samples = Math.max(5, Number(process.env.PERF_SAMPLES) || 30);
const percentile = (array, fraction) => [...array].sort((a, b) => a - b)[Math.min(array.length - 1, Math.ceil(array.length * fraction) - 1)];
const memory = () => {
  const value = process.memoryUsage();
  return Object.fromEntries(['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'].map(key => [key, Math.round(value[key] / 1024 / 1024 * 10) / 10]));
};
let db, knowledge, search, http;
try {
  for (let offset = 0; offset < count; offset += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - offset) }, (_, index) => {
      const id = offset + index;
      return fs.writeFile(path.join(root, `Note-${id}.md`), `workspacebenchmark ${id}\n${'知识正文测试。'.repeat(150)}`);
    }));
  }
  db = createDatabase(process.env.DATA_DIR);
  const startup = performance.now();
  knowledge = createKnowledgeService(db, { fileWorkspaceRoot: root, startFolderSync: false });
  await knowledge.ready;
  const startupMs = performance.now() - startup;
  let listedDocuments = knowledge.nativeDocuments().length;
  if (!listedDocuments) {
    while (!knowledge.workspace.fileGeneration) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    listedDocuments = knowledge.nativeDocuments().length;
  }
  const firstListAvailableMs = performance.now() - startup;
  const memoryAfterReady = memory();
  await knowledge.backgroundReady;
  const initialIndexReadyMs = performance.now() - startup;
  const memoryAfterInitialIndex = memory();
  const initialMetrics = { ...knowledge.workspace.metrics };
  search = createSearchIndex(knowledge); search.searchDocuments('workspacebenchmark');
  const memoryAfterSearch = memory();
  const express = require('express'); const app = express(); app.use(express.json());
  const document = knowledge.nativeDocuments()[0];
  app.get('/read', async (_req, res) => { try { res.json(await knowledge.getDocument(document.id)); } catch (error) { res.status(500).json({ error: error.message }); } });
  app.get('/search', (_req, res) => res.json(search.searchDocuments('workspacebenchmark', {}, { limit: 20 })));
  app.patch('/save', async (req, res) => { const value = await knowledge.updateDocument(document.id, req.body); res.status(value.error ? value.status : 200).json(value); });
  http = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const url = `http://127.0.0.1:${http.address().port}`;
  const delays = monitorEventLoopDelay({ resolution: 2 }); delays.enable();
  const durations = { read: [], save: [], search: [] };
  const background = process.env.PERF_BACKGROUND === '1' ? knowledge.workspace.scan() : null;
  const measured = async (kind, operation) => { const begin = performance.now(); const response = await operation(); const data = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); durations[kind].push(performance.now() - begin); return data; };
  for (let index = 0; index < samples; index++) {
    const current = await measured('read', () => fetch(`${url}/read`));
    await Promise.all([
      measured('save', () => fetch(`${url}/save`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseVersion: current.version, baseFingerprint: current.baseFingerprint, content: current.content + '\nchange' }) })),
      measured('search', () => fetch(`${url}/search`)),
    ]);
  }
  await background; await knowledge.workspace.flushIndex();
  const beforeUnchangedScan = { ...knowledge.workspace.metrics };
  const scanBegin = performance.now(); await knowledge.workspace.scan(); await knowledge.workspace.flushIndex(); const scanMs = performance.now() - scanBegin;
  const unchangedScanMetrics = Object.fromEntries(Object.keys(beforeUnchangedScan).map(key => [key, knowledge.workspace.metrics[key] - beforeUnchangedScan[key]]));
  await knowledge.folderSync.shutdown(); search.dispose();
  const restartBegin = performance.now();
  knowledge = createKnowledgeService(db, { fileWorkspaceRoot: root, startFolderSync: false });
  await knowledge.ready;
  const restartReadyMs = performance.now() - restartBegin;
  const restartListedDocuments = knowledge.nativeDocuments().length;
  const restartListAvailableMs = performance.now() - restartBegin;
  await knowledge.backgroundReady;
  const restartIndexReadyMs = performance.now() - restartBegin;
  const memoryAfterRestart = memory();
  const restartMetrics = { ...knowledge.workspace.metrics };
  search = createSearchIndex(knowledge); search.searchDocuments('workspacebenchmark');
  delays.disable();
  const report = { date: new Date().toISOString(), documents: count, samples, platform: process.platform, arch: process.arch,
    node: process.version, backgroundScan: Boolean(background), startupMs, firstListAvailableMs, listedDocuments,
    initialIndexReadyMs, initialMetrics, fullScanMs: scanMs, unchangedScanMetrics,
    restartReadyMs, restartListAvailableMs, restartListedDocuments, restartIndexReadyMs, restartMetrics,
    eventLoopP95Ms: delays.percentile(95) / 1e6,
    memory: { afterReady: memoryAfterReady, afterInitialIndex: memoryAfterInitialIndex,
      afterSearch: memoryAfterSearch, afterRestart: memoryAfterRestart },
    requests: Object.fromEntries(Object.entries(durations).map(([key, values]) => [key, { p50Ms: percentile(values, .5), p95Ms: percentile(values, .95) }])),
    limitations: 'Temporary local files, warm search and disk cache; one edited file; no Electron GUI or Windows verification; set PERF_BACKGROUND=1 for a scan concurrent with HTTP samples; fullScanMs includes index draining.' };
  if (process.env.PERF_OUTPUT) await fs.writeFile(path.resolve(process.env.PERF_OUTPUT), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  if (http) await new Promise(resolve => http.close(resolve));
  search?.dispose(); await knowledge?.folderSync.shutdown(); db?.close();
  require('../lib/db/connection').closeAllDatabases();
  await fs.rm(dir, { recursive: true, force: true });
}
