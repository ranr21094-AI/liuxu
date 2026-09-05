const { createAgentStore } = require('./store');
const { ensureAiChatsMigrated } = require('./migrate-ai-chats');
const { createMemoryService } = require('./memory');
const { resolveMemorySettings } = require('./memory-settings');
const { createRuntime } = require('./runtime');
const { definitions, computerToolAvailability } = require('./tools');
const { defaultModelClient } = require('./model');
const { serviceFor } = require('../knowledge/routes');
const { summarizeRun } = require('./trace');
const { inspectUploadedAttachment } = require('./attachments');

function normalizeAgentAttachments(raw, isSafeUploadFilename, { isPrivateUpload, allowPrivate } = {}) {
  if (!Array.isArray(raw)) return [];
  const items = [];
  for (const entry of raw.slice(0, 14)) {
    const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
    if (!url.startsWith('/uploads/')) continue;
    const filename = url.slice('/uploads/'.length);
    if (typeof isSafeUploadFilename === 'function' && !isSafeUploadFilename(filename)) continue;
    if (!allowPrivate && typeof isPrivateUpload === 'function' && isPrivateUpload(filename)) continue;
    const item = {
      url,
      // The URL's safe basename is canonical; client metadata cannot redirect
      // parsing to a different upload.
      filename,
    };
    if (typeof entry?.displayName === 'string' && entry.displayName.trim()) item.displayName = entry.displayName.trim().slice(0, 240);
    if (typeof entry?.kind === 'string') item.kind = entry.kind.slice(0, 16);
    if (typeof entry?.mimeType === 'string') item.mimeType = entry.mimeType.slice(0, 120);
    if (Number.isFinite(Number(entry?.size)) && Number(entry.size) >= 0) item.size = Number(entry.size);
    if (typeof entry?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(entry.sha256)) item.sha256 = entry.sha256.toLowerCase();
    if (typeof entry?.extractionStatus === 'string') item.extractionStatus = entry.extractionStatus.slice(0, 24);
    if (entry?.truncated === true) item.truncated = true;
    items.push(item);
  }
  return items;
}

function formatAgentUserMessage(content, attachments = []) {
  const text = String(content || '').trim();
  if (!attachments.length) return text;
  const refs = attachments.map(item => item.url).join(', ');
  return `${text}\n（附件：${refs}）`.trim();
}

function handleAgentUploadError(err, res) {
  if (err instanceof require('multer').MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '附件大小不能超过 30MB（文档和代码不能超过 20MB）' });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: '一次最多上传 14 个附件' });
    return res.status(400).json({ error: err.message });
  }
  return res.status(400).json({ error: err.message || 'Upload failed' });
}

const runtimes = new Map();

function runtimeFor(db, extras = {}) {
  const key = db.dataDir;
  let entry = runtimes.get(key);
  if (!entry) {
    ensureAiChatsMigrated(db);
    const store = createAgentStore(db);
    const memory = createMemoryService(store, {
      settingsFor: () => resolveMemorySettings(db.getAiSettings?.() || {}),
    });
    entry = { store, memory };
    runtimes.set(key, entry);
  }
  entry.hasDiaryAccessFlag = extras.hasDiaryAccessFlag;
  if (extras.modelClient) entry.modelClient = extras.modelClient;
  if (extras.webSearch) entry.webSearch = extras.webSearch;
  if (extras.webFetch) entry.webFetch = extras.webFetch;
  if (extras.westockRun) entry.westockRun = extras.westockRun;
  if (extras.imageGenerate) entry.imageGenerate = extras.imageGenerate;
  if (Object.prototype.hasOwnProperty.call(extras, 'computer')) entry.computer = extras.computer;
  if (extras.chrome) entry.chrome = extras.chrome;
  if (!entry.runtime) {
    entry.runtime = createRuntime({
      db,
      store: entry.store,
      memory: entry.memory,
      knowledgeSearch: serviceFor(db),
      modelClient: {
        complete(request) {
          if (!entry.modelClient?.complete) throw new Error('Agent model is unavailable');
          return entry.modelClient.complete(request);
        },
      },
      hasDiaryAccessFlag: () => entry.hasDiaryAccessFlag,
      webSearch: args => entry.webSearch
        ? entry.webSearch(args)
        : Promise.resolve({ ok: false, summary: 'Web search unavailable', errorCode: 'unavailable' }),
      webFetch: args => entry.webFetch
        ? entry.webFetch(args)
        : Promise.resolve({ ok: false, summary: 'Web fetch unavailable', errorCode: 'unavailable' }),
      westockRun: args => entry.westockRun
        ? entry.westockRun(args)
        : Promise.resolve({ ok: false, summary: 'WeStock unavailable', errorCode: 'unavailable' }),
      imageGenerate: args => entry.imageGenerate
        ? entry.imageGenerate(args)
        : Promise.resolve({ ok: false, summary: 'Image generation unavailable', errorCode: 'unavailable' }),
      computer: {
        available() {
          return Boolean(entry.computer);
        },
        execute(name, args) {
          return entry.computer
            ? entry.computer.execute(name, args)
            : Promise.resolve({ ok: false, summary: 'Computer tools disabled', errorCode: 'denied' });
        },
      },
      chrome: {
        request(name, args) {
          return entry.chrome
            ? entry.chrome.request(name, args)
            : { ok: false, summary: 'Chrome bridge unavailable', errorCode: 'denied' };
        },
      },
    });
  }
  return entry;
}

function registerAgentRoutes(app, ctx) {
  async function extras(req) {
    return {
      hasDiaryAccessFlag: ctx.hasDiaryAccess(req),
      modelClient: ctx.modelClientFor ? await ctx.modelClientFor(req) : (ctx.modelClient || await defaultModelClient()),
      webSearch: ctx.webSearchFor ? ctx.webSearchFor(req) : ctx.webSearch,
      webFetch: ctx.webFetchFor ? ctx.webFetchFor(req) : ctx.webFetch,
      westockRun: ctx.westockRunFor ? ctx.westockRunFor(req) : ctx.westockRun,
      imageGenerate: ctx.imageGenerateFor ? ctx.imageGenerateFor(req) : ctx.imageGenerate,
      computer: ctx.computerFor?.(req),
      chrome: ctx.chromeFor?.(req),
    };
  }

  app.get('/api/agent/status', async (req, res) => {
    try {
      const status = ctx.agentStatusFor
        ? await ctx.agentStatusFor(req)
        : { configured: false, provider: '', model: '' };
      res.json({
        configured: Boolean(status?.configured),
        provider: String(status?.provider || ''),
        model: String(status?.model || ''),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agent/sessions', (req, res) => {
    try {
      const { store } = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const archivedOnly = req.query.status === 'archived';
      let sessions = store.listSessionSummaries({
        includeArchived: archivedOnly || req.query.archived === '1',
      });
      if (archivedOnly) sessions = sessions.filter(item => item.status === 'archived');
      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/sessions', (req, res) => {
    try {
      const { store } = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const session = store.createSession(req.body?.title);
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agent/sessions/:id', (req, res) => {
    try {
      const { store } = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const session = store.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const runs = store.listRunsForSession(session.id)
        .map(run => summarizeRun(run, { listChildRuns: store.listChildRuns.bind(store) }))
        .filter(Boolean);
      const latestRun = runs.at(-1) || null;
      res.json({
        ...session,
        runs,
        latestRun: latestRun ? { id: latestRun.id, status: latestRun.status } : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/agent/sessions/:id', (req, res) => {
    try {
      const { store } = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const session = store.updateSession(req.params.id, req.body || {});
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/agent/sessions/:id', (req, res) => {
    try {
      const { store } = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const result = store.deleteSession(req.params.id);
      if (!result) return res.status(404).json({ error: 'Session not found' });
      if (result.error) return res.status(400).json({ error: result.error });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/uploads', (req, res) => {
    if (ctx.agentAttachmentUpload) {
      const middleware = ctx.agentAttachmentUpload.fields([
        { name: 'files', maxCount: ctx.agentAttachmentMaxFiles || 14 },
        { name: 'images', maxCount: ctx.agentAttachmentMaxFiles || 14 },
        { name: 'image', maxCount: 1 },
      ]);
      middleware(req, res, async (err) => {
        if (err) return handleAgentUploadError(err, res);
        const files = Object.values(req.files || {}).flat().filter(Boolean);
        if (!files.length) return res.status(400).json({ error: '请选择要上传的附件' });
        const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
        const removeFiles = () => files.forEach(file => {
          try { require('fs').unlinkSync(file.path); } catch { /* ignore */ }
        });
        if (totalBytes > (ctx.agentAttachmentMaxTotalBytes || 100 * 1024 * 1024)) {
          removeFiles();
          return res.status(413).json({ error: '单次上传附件总大小不能超过 100MB' });
        }
        const items = [];
        for (const file of files) {
          try {
            items.push(await (ctx.agentAttachmentInspect || inspectUploadedAttachment)(file));
          } catch (inspectError) {
            removeFiles();
            return res.status(400).json({ error: inspectError.message || '附件校验失败' });
          }
        }
        return res.json({ items });
      });
      return;
    }
    if (!ctx.agentImageUpload) return res.status(503).json({ error: 'Agent upload is unavailable' });
    const useMultiple = req.query.multiple === '1' || req.query.multiple === 'true';
    const middleware = useMultiple
      ? ctx.agentImageUpload.array('images', 14)
      : ctx.agentImageUpload.single('image');
    middleware(req, res, (err) => {
      if (err) return handleAgentUploadError(err, res);
      const files = useMultiple ? (req.files || []) : (req.file ? [req.file] : []);
      if (!files.length) return res.status(400).json({ error: '请选择要上传的图片' });
      const validate = ctx.agentImageUploadValidate || (() => true);
      const serialize = ctx.agentImageUploadSerialize || ((request, file) => ({
        url: `/uploads/${file.filename}`,
        filename: file.filename,
      }));
      const items = [];
      for (const file of files) {
        if (!validate(file)) {
          try { require('fs').unlinkSync(file.path); } catch { /* ignore */ }
          return res.status(400).json({ error: '文件内容与图片格式不匹配' });
        }
        items.push(serialize(req, file));
      }
      res.json({ items });
    });
  });

  app.post('/api/agent/sessions/:id/messages', async (req, res) => {
    try {
      const pack = runtimeFor(ctx.db, await extras(req));
      const session = pack.store.getSession(req.params.id);
      if (!session || session.status === 'archived') return res.status(404).json({ error: 'Session not found' });
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (!content.trim()) return res.status(400).json({ error: 'Message is required' });
      const attachments = normalizeAgentAttachments(req.body?.attachments, ctx.db.isSafeUploadFilename, {
        isPrivateUpload: ctx.db.isPrivateUpload,
        allowPrivate: ctx.hasDiaryAccess(req),
      });
      const userMessage = formatAgentUserMessage(content, attachments);
      const waitingRun = pack.store.listRunsForSession(session.id)
        .slice()
        .reverse()
        .find(item => item.status === 'waiting_user');
      if (waitingRun) {
        const result = await pack.runtime.resumeUserInput(waitingRun.id, userMessage, attachments);
        if (result.error) return res.status(409).json({ error: result.error });
        return res.status(202).json({ runId: waitingRun.id, status: result.run.status, resumed: true });
      }
      if (!(session.messages || []).length && ['新任务', '新会话'].includes(session.title)) {
        session.title = content.trim().replace(/\s+/g, ' ').slice(0, 30) || session.title;
      }
      const run = await pack.runtime.start({
        session,
        goal: content,
        userMessage,
        attachments,
      });
      if (run?.error) return res.status(run.status || 409).json({ error: run.error });
      res.status(202).json({ runId: run.id, status: run.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agent/runs/:id/events', (req, res) => {
    try {
      const pack = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const unsubscribe = pack.runtime.attach(req.params.id, (event) => {
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      req.on('close', unsubscribe);
      const current = pack.store.getRun(req.params.id);
      if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) {
        res.end();
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/runs/:id/approvals/:approvalId', async (req, res) => {
    try {
      const approved = req.body?.approved;
      if (typeof approved !== 'boolean') {
        return res.status(400).json({ error: 'approved must be a boolean' });
      }
      const pack = runtimeFor(ctx.db, await extras(req));
      const result = await pack.runtime.resolveApproval(req.params.id, req.params.approvalId, {
        approved,
      });
      if (result.error) return res.status(404).json(result);
      res.json({ status: result.run.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/runs/:id/client-tools/:requestId/result', async (req, res) => {
    try {
      const pack = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const pending = pack.store.getRun(req.params.id)?.pendingClientTool;
      if (pending?.request?.signature) {
        const bridge = ctx.chromeFor?.(req);
        if (!bridge?.verify(req.body || {})) return res.status(403).json({ error: 'Invalid browser tool signature' });
      }
      const clientResult = req.body?.result && typeof req.body.result === 'object' ? req.body.result : req.body || {};
      const result = await pack.runtime.clientToolResult(req.params.id, req.params.requestId, clientResult);
      if (result.error) return res.status(404).json(result);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/runs/:id/cancel', (req, res) => {
    try {
      const pack = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const result = pack.runtime.cancel(req.params.id);
      if (result.error) return res.status(404).json(result);
      res.json({ status: result.run.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agent/tools', (req, res) => {
    const computer = ctx.computerFor?.(req);
    res.json({ tools: definitions(computerToolAvailability(Boolean(computer))) });
  });

  app.get('/api/agent/memories', (req, res) => {
    try {
      const { memory } = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      res.json({
        items: memory.list({ layer: req.query.layer }),
        proposals: memory.listProposals(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/agent/memories/:id', (req, res) => {
    try {
      const { memory } = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const result = memory.archive(req.params.id);
      if (result.error) return res.status(404).json(result);
      res.json(result.memory);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/memory/refresh', async (req, res) => {
    try {
      const status = ctx.agentStatusFor
        ? await ctx.agentStatusFor(req)
        : { configured: false };
      if (!status?.configured) return res.status(400).json({ error: 'Agent model is not configured' });
      const pack = runtimeFor(ctx.db, await extras(req));
      const result = await pack.runtime.startMemoryRefresh();
      if (result.error) return res.status(result.status || 409).json({ error: result.error });
      res.status(202).json({ runId: result.run.id, status: result.run.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/memory-proposals/:id/approve', (req, res) => {
    try {
      const { memory } = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const result = memory.approve(req.params.id);
      if (result.error) return res.status(400).json(result);
      res.json(result.memory);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/memory-proposals/:id/dismiss', (req, res) => {
    try {
      const { memory } = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const result = memory.dismiss(req.params.id);
      if (result.error) return res.status(400).json(result);
      res.json(result.proposal);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerAgentRoutes, runtimeFor };
