const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('image provider settings, model test, catalog, and explicit test generation share one adapter flow', async t => {
  const seenAuth = [];
  const upstream = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || '');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'custom-image-v1' }] }));
    if (req.url === '/v1/images/generations') {
      return res.end(JSON.stringify({ data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-provider-routes-'));
  process.env.DATA_DIR = dataDir;
  process.env.AI_SECRETS_KEY_FILE = path.join(dataDir, 'ai-secrets.key');
  for (const file of ['../server', '../database', '../secret-store']) delete require.cache[require.resolve(file)];
  const database = require('../database');
  const { app } = require('../server');
  const server = http.createServer(app);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => {
    database.close();
    delete process.env.DATA_DIR;
    delete process.env.AI_SECRETS_KEY_FILE;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const provider = {
    id: 'ip_custom', name: 'Custom Images', adapter: 'openai-images',
    baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'provider-secret', enabled: true,
    models: [{
      id: 'im_custom', upstreamId: 'custom-image-v1', name: 'Custom Image', enabled: true,
      capabilities: { textToImage: true, imageEdit: false, maxOutputs: 1, maxReferences: 0 },
      defaults: { count: 1 },
    }],
  };
  const savedResponse = await fetch(`${base}/api/ai/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageProviders: [provider], defaultImageModelRef: 'image/ip_custom/im_custom' }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.imageProviders[0].apiKeyConfigured, true);
  assert.equal(saved.imageProviders[0].apiKey, undefined);

  const publicProvider = saved.imageProviders[0];
  const modelsResponse = await fetch(`${base}/api/ai/image-providers/models`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: publicProvider }),
  });
  assert.equal(modelsResponse.status, 200);
  assert.deepEqual((await modelsResponse.json()).models, ['custom-image-v1']);

  const connection = await fetch(`${base}/api/ai/image-providers/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: publicProvider, modelId: 'im_custom' }),
  });
  assert.equal(connection.status, 200);
  assert.equal((await connection.json()).level, 'full');

  const unconfirmed = await fetch(`${base}/api/ai/image-providers/test-generation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: publicProvider, modelId: 'im_custom', prompt: 'blue dot' }),
  });
  assert.equal(unconfirmed.status, 400);
  const generated = await fetch(`${base}/api/ai/image-providers/test-generation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: publicProvider, modelId: 'im_custom', prompt: 'blue dot', confirmed: true }),
  });
  assert.equal(generated.status, 200);
  const result = await generated.json();
  assert.equal(result.modelRef, 'image/ip_custom/im_custom');
  assert.match(result.url, /^\/uploads\//);
  assert.equal(seenAuth.every(value => value === 'Bearer provider-secret'), true);
});
