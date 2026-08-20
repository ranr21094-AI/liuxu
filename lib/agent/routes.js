const { createAgentStore } = require('./store');
const { createMemoryService } = require('./memory');
const { createRuntime } = require('./runtime');
const { definitions, computerToolAvailability } = require('./tools');
const { defaultModelClient } = require('./model');
const { serviceFor } = require('../knowledge/routes');
const { summarizeRun } = require('./trace');

const runtimes = new Map();

function runtimeFor(db, extras = {}) {
  const key = db.dataDir;
  let entry = runtimes.get(key);
  if (!entry) {
    const store = createAgentStore(db);
    const memory = createMemoryService(store);
    entry = { store, memory };
    runtimes.set(key, entry);
  }
  entry.hasDiaryAccessFlag = extras.hasDiaryAccessFlag;
  if (extras.modelClient) entry.modelClient = extras.modelClient;
  if (extras.webSearch) entry.webSearch = extras.webSearch;
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
      const runs = store.listRunsForSession(session.id).map(summarizeRun).filter(Boolean);
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

  app.post('/api/agent/sessions/:id/messages', async (req, res) => {
    try {
      const pack = runtimeFor(ctx.db, await extras(req));
      const session = pack.store.getSession(req.params.id);
      if (!session || session.status === 'archived') return res.status(404).json({ error: 'Session not found' });
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (!content.trim()) return res.status(400).json({ error: 'Message is required' });
      if (!(session.messages || []).length && ['新任务', '新会话'].includes(session.title)) {
        session.title = content.trim().replace(/\s+/g, ' ').slice(0, 30) || session.title;
      }
      const run = await pack.runtime.start({ session, goal: content, userMessage: content });
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
      const pack = runtimeFor(ctx.db, await extras(req));
      const result = await pack.runtime.resolveApproval(req.params.id, req.params.approvalId, {
        approved: req.body?.approved !== false,
      });
      if (result.error) return res.status(404).json(result);
      res.json({ status: result.run.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/runs/:id/client-tools/:requestId/result', (req, res) => {
    try {
      const pack = runtimeFor(ctx.db, { hasDiaryAccessFlag: ctx.hasDiaryAccess(req) });
      const pending = pack.store.getRun(req.params.id)?.pendingClientTool;
      if (pending?.request?.signature) {
        const bridge = ctx.chromeFor?.(req);
        if (!bridge?.verify(req.body || {})) return res.status(403).json({ error: 'Invalid browser tool signature' });
      }
      const clientResult = req.body?.result && typeof req.body.result === 'object' ? req.body.result : req.body || {};
      const result = pack.runtime.clientToolResult(req.params.id, req.params.requestId, clientResult);
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
