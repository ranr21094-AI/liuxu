const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const {
  createRemoteAccessService,
  PAIRING_TTL_MS,
  SESSION_COOKIE,
  CSRF_COOKIE,
} = require('../lib/remote/access');
const { setRemoteAccessService, registerRemoteServer } = require('../lib/remote/context');
const { remoteAccessMiddleware, registerRemoteAccessRoutes } = require('../lib/remote/routes');
const { serveStatusHasConfiguration, tailscaleServeCommand } = require('../electron/remote-access');

function tempService(t, clock = { now: Date.now() }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-remote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, service: createRemoteAccessService({ statePath: path.join(dir, 'remote.json'), now: () => clock.now }) };
}

function cookieValues(lines) {
  const result = {};
  for (const line of lines) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    result[pair.slice(0, index)] = decodeURIComponent(pair.slice(index + 1));
  }
  return result;
}

test('pairing token is single-use, expires, and persisted sessions can be revoked', (t) => {
  const clock = { now: 1_800_000_000_000 };
  const { dir, service } = tempService(t, clock);
  service.configure({ enabled: true, port: 43140, publicUrl: 'https://phone.example.ts.net' });
  const pairing = service.createPairing();
  const request = service.requestPair({ token: pairing.token, name: 'iPhone' });
  assert.ok(request.requestId);
  assert.equal(service.requestPair({ token: pairing.token }).status, 410, 'pairing token cannot be replayed');
  service.approvePairing(request.requestId);
  const approved = service.pairingStatus(request.requestId, request.pollToken);
  const cookie = `${SESSION_COOKIE}=${approved.sessionToken}; ${CSRF_COOKIE}=${approved.csrfToken}`;
  const auth = service.authenticate(cookie);
  assert.equal(auth.device.name, 'iPhone');
  assert.equal(service.verifyCsrf(auth, cookie, approved.csrfToken), true);
  const persisted = fs.readFileSync(path.join(dir, 'remote.json'), 'utf8');
  assert.equal(persisted.includes(approved.sessionToken), false, 'raw session secret is never persisted');
  const reloaded = createRemoteAccessService({ statePath: path.join(dir, 'remote.json'), now: () => clock.now });
  assert.ok(reloaded.authenticate(cookie));
  reloaded.revokeDevice(auth.device.id);
  assert.equal(reloaded.authenticate(cookie), null);

  const expired = service.createPairing();
  clock.now += PAIRING_TTL_MS + 1;
  assert.equal(service.requestPair({ token: expired.token }).status, 410);
});

test('remote listener protects APIs and files with session, origin, and CSRF checks', async (t) => {
  const { service } = tempService(t);
  service.configure({ enabled: true, port: 43140, publicUrl: 'https://device.example.ts.net' });
  setRemoteAccessService(service);
  const pairing = service.createPairing();
  const request = service.requestPair({ token: pairing.token, name: 'Android' });
  service.approvePairing(request.requestId);
  const approved = service.pairingStatus(request.requestId, request.pollToken);

  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(remoteAccessMiddleware);
  registerRemoteAccessRoutes(app);
  app.get('/api/private', (_req, res) => res.json({ ok: true }));
  app.post('/api/private', (_req, res) => res.json({ changed: true }));
  app.get('/uploads/private.png', (_req, res) => res.send('secret'));
  app.get('/', (_req, res) => res.send('shell'));
  const server = http.createServer(app);
  registerRemoteServer(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const remoteOrigin = `https://127.0.0.1:${server.address().port}`;
  const forwarded = { 'X-Forwarded-Proto': 'https' };

  assert.equal((await fetch(`${base}/`)).status, 200, 'application shell remains available for pairing');
  assert.equal((await fetch(`${base}/api/private`)).status, 401);
  assert.equal((await fetch(`${base}/uploads/private.png`)).status, 401);
  const cookie = `${SESSION_COOKIE}=${approved.sessionToken}; ${CSRF_COOKIE}=${approved.csrfToken}`;
  assert.equal((await fetch(`${base}/api/private`, { headers: { ...forwarded, Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/private`, { method: 'POST', headers: { ...forwarded, Cookie: cookie } })).status, 403);
  assert.equal((await fetch(`${base}/api/private`, { method: 'POST', headers: { ...forwarded, Cookie: cookie, Origin: 'https://evil.example', 'X-LiuXu-CSRF': approved.csrfToken } })).status, 403);
  assert.equal((await fetch(`${base}/api/private`, { method: 'POST', headers: { ...forwarded, Cookie: cookie, Origin: remoteOrigin, 'X-LiuXu-CSRF': approved.csrfToken } })).status, 200);
});

test('Tailscale Serve helper detects existing config and targets only loopback', () => {
  assert.equal(serveStatusHasConfiguration('{}'), false);
  assert.equal(serveStatusHasConfiguration('{"TCP":{"443":{}}}'), true);
  assert.equal(tailscaleServeCommand(43140), 'tailscale serve --bg --yes http://127.0.0.1:43140');
});

test('pairing response cookies are secure and strict', async (t) => {
  const { service } = tempService(t);
  service.configure({ enabled: true, port: 43140, publicUrl: 'https://device.example.ts.net' });
  setRemoteAccessService(service);
  const pairing = service.createPairing();

  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(remoteAccessMiddleware);
  registerRemoteAccessRoutes(app);
  const server = http.createServer(app);
  registerRemoteServer(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'X-Forwarded-Proto': 'https', Origin: `https://127.0.0.1:${server.address().port}`, 'Content-Type': 'application/json' };
  const requested = await (await fetch(`${base}/api/remote/pair/request`, { method: 'POST', headers, body: JSON.stringify({ token: pairing.token, name: 'Phone' }) })).json();
  service.approvePairing(requested.requestId);
  const response = await fetch(`${base}/api/remote/pair/${requested.requestId}/status?token=${encodeURIComponent(requested.pollToken)}`, { headers });
  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.length, 2);
  assert.ok(setCookies.every(line => line.includes('Secure') && line.includes('SameSite=Strict')));
  assert.ok(setCookies.some(line => line.startsWith(`${SESSION_COOKIE}=`) && line.includes('HttpOnly')));
  assert.ok(cookieValues(setCookies)[CSRF_COOKIE]);
});
