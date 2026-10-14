import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const docsCount = Math.min(10000, Math.max(100, Number.parseInt(process.env.PERF_DOCS || '1000', 10) || 1000));
const startedAt = new Date().toISOString();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-perf-'));
const syncRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-perf-knowledge-'));
process.env.DATA_DIR = tempDir;
process.env.AI_SECRETS_KEY_FILE = path.join(tempDir, 'ai-secrets.key');

const { createDatabase } = require('../database.js');
const { closeAllDatabases } = require('../lib/db/connection');
const { createKnowledgeService } = require('../lib/knowledge/documents');
const { createSearchIndex } = require('../lib/knowledge/search');
const { createAgentStore } = require('../lib/agent/store');
const { exportWorkspace } = require('../lib/workspace/zip');
const { treeForDocuments } = require('../lib/knowledge/routes');

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(2));
}

function elapsed(fn) {
  const before = performance.now();
  const value = fn();
  return { value, ms: performance.now() - before };
}

function seedKnowledge(sqlite) {
  const insert = sqlite.prepare('INSERT INTO knowledge_documents (id, body) VALUES (?, ?)');
  const seed = sqlite.transaction(() => {
    for (let index = 1; index <= docsCount; index += 1) {
      const collection = index % 5 === 0 ? '研究/归档' : '研究';
      const doc = {
        id: `note:${index}`,
        sourceType: 'note',
        sourceRef: `note:${index}`,
        title: `性能基线文档 ${index}`,
        content: (`这是第 ${index} 篇用于搜索性能基线的中文内容，包含可检索关键词 alpha-${index % 17} 和知识库，` + '用于模拟真实较长正文与多段内容。'.repeat(25)).slice(0, 1032),
        collectionPath: collection,
        knowledgeBase: '研究',
        folderPath: index % 5 === 0 ? '归档' : '',
        tags: ['性能', index % 2 ? '中文' : '测试'],
        visibility: 'standard',
        status: 'active',
        fileMeta: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        documentDate: '2026-01-01',
        documentRole: 'normal',
      };
      insert.run(doc.id, JSON.stringify(doc));
    }
    sqlite.prepare("UPDATE meta SET value = ? WHERE key = 'next_note_id'").run(String(docsCount + 1));
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('next_note_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(docsCount + 1));
    sqlite.prepare('UPDATE knowledge_index_state SET version = version + 1, updated_at = ? WHERE id = 1').run(Date.now());
  });
  seed();
}

const db = createDatabase(tempDir);
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();
try {
  seedKnowledge(db.sqlite);
  const knowledge = createKnowledgeService(db);
  const search = createSearchIndex(knowledge);
  const coldSearch = elapsed(() => search.search('知识库', { limit: 20 }));
  const searchSamples = [];
  for (let index = 0; index < 40; index += 1) {
    searchSamples.push(elapsed(() => search.search(`alpha-${index % 17}`, { limit: 20 })).ms);
  }

  const first = knowledge.getDocument('note:1');
  const documentSamples = [];
  const saveThenSearchSamples = [];
  let current = first;
  for (let index = 0; index < 30; index += 1) {
    const combined = elapsed(() => {
      const result = knowledge.updateDocument('note:1', {
        content: `${first.content} update-${index}`,
        baseVersion: current.version,
      });
      if (result.error) throw new Error(result.error);
      current = result.document;
      search.search(`update-${index}`, { limit: 20 });
    });
    saveThenSearchSamples.push(combined.ms);
    documentSamples.push(elapsed(() => knowledge.updateDocument('note:1', {
      content: `${first.content} update-${index} measured`,
      baseVersion: current.version,
    })).ms);
    current = knowledge.getDocument('note:1');
  }

  const listPageSamples = [];
  const quickOpenSamples = [];
  const treeSamples = [];
  for (let index = 0; index < 12; index += 1) {
    listPageSamples.push(elapsed(() => knowledge.listDocumentPage({ status: 'active' }, { limit: 60, offset: 0 })).ms);
    quickOpenSamples.push(elapsed(() => knowledge.quickOpen({ query: '性能基线', limit: 20 })).ms);
    treeSamples.push(elapsed(() => treeForDocuments(
      db.getAllCategories(),
      knowledge.listDocumentTreeLocations({ hideAppBundles: false }),
      db,
    )).ms);
  }

  knowledge.folderSync.configure({ enabled: true, rootPath: syncRoot });
  await knowledge.folderSync.syncNow({ reason: 'manual' });
  const syncSamples = [];
  eventLoopDelay.reset();
  for (let index = 0; index < 4; index += 1) {
    const before = performance.now();
    await knowledge.folderSync.syncNow({ reason: 'interval' });
    syncSamples.push(performance.now() - before);
  }
  await new Promise(resolve => setTimeout(resolve, 25));
  const unchangedSyncEventLoopDelayP95Ms = Number((eventLoopDelay.percentile(95) / 1e6).toFixed(2));
  eventLoopDelay.reset();

  const todo = db.createTodo({ title: '性能基线待办' });
  const todoSamples = [];
  for (let index = 0; index < 30; index += 1) {
    todoSamples.push(elapsed(() => db.updateTodo(todo.id, { title: `性能基线待办 ${index}` })).ms);
  }

  const agent = createAgentStore(db);
  const session = agent.createSession('性能基线会话');
  agent.saveSession({ ...session, messages: Array.from({ length: 300 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `message-${index}` })) });
  const sessionRead = elapsed(() => agent.getSession(session.id, { messageLimit: 200 }));
  const backupStarted = performance.now();
  const archive = await exportWorkspace(db, { fileResult: true });
  const backupMs = performance.now() - backupStarted;
  fs.rmSync(archive.cleanupPath, { recursive: true, force: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  const workspaceExportEventLoopDelayP95Ms = Number((eventLoopDelay.percentile(95) / 1e6).toFixed(2));
  eventLoopDelay.disable();
  const report = {
    generatedAt: startedAt,
    docs: docsCount,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    metrics: {
      coldSearchMs: Number(coldSearch.ms.toFixed(2)),
      searchP50Ms: percentile(searchSamples, 0.5),
      searchP95Ms: percentile(searchSamples, 0.95),
      saveThenSearchP50Ms: percentile(saveThenSearchSamples, 0.5),
      saveThenSearchP95Ms: percentile(saveThenSearchSamples, 0.95),
      listPageP95Ms: percentile(listPageSamples, 0.95),
      quickOpenP95Ms: percentile(quickOpenSamples, 0.95),
      treeP95Ms: percentile(treeSamples, 0.95),
      unchangedSyncP50Ms: percentile(syncSamples, 0.5),
      unchangedSyncP95Ms: percentile(syncSamples, 0.95),
      pagedSession200MessagesMs: Number(sessionRead.ms.toFixed(2)),
      pagedSessionResponseBytes: Buffer.byteLength(JSON.stringify(sessionRead.value)),
      documentUpdateP95Ms: percentile(documentSamples, 0.95),
      todoUpdateP95Ms: percentile(todoSamples, 0.95),
      workspaceZipExportMs: Number(backupMs.toFixed(2)),
      workspaceZipBytes: archive.size,
      unchangedSyncEventLoopDelayP95Ms,
      workspaceExportEventLoopDelayP95Ms,
      rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
    },
  };
  const outputDir = path.join(process.cwd(), 'perf-results');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `perf-baseline-${Date.now()}.json`);
  fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...report, reportFile: path.basename(outputFile) }, null, 2)}\n`);
} finally {
  eventLoopDelay.disable();
  try { db.close(); } catch {}
  closeAllDatabases();
  fs.rmSync(syncRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
