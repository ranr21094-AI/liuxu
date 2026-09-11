const { CSRF_COOKIE, SESSION_COOKIE } = require('./access');
const { getRemoteAccessService, isRemoteRequest } = require('./context');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_REMOTE_API = [
  ['GET', '/api/remote/bootstrap'],
  ['POST', '/api/remote/pair/request'],
];

function expectedOrigin(req) {
  const host = String(req.get('host') || '');
  return host ? `${req.isRemoteClient ? 'https' : req.protocol}://${host}` : '';
}

function hasValidOrigin(req) {
  const origin = String(req.get('origin') || '');
  return Boolean(origin && origin === expectedOrigin(req));
}

function isPublicRemoteApi(req) {
  if (PUBLIC_REMOTE_API.some(([method, route]) => req.method === method && req.path === route)) return true;
  return req.method === 'GET' && /^\/api\/remote\/pair\/[^/]+\/status$/.test(req.path);
}

function remoteAccessMiddleware(req, res, next) {
  if (!isRemoteRequest(req)) return next();
  req.isRemoteClient = true;
  res.setHeader('Cache-Control', 'no-store');
  const service = getRemoteAccessService();
  if (!service?.snapshot().enabled) return res.status(503).json({ error: '远程访问未开启' });
  if (isPublicRemoteApi(req)) return next();
  const protectedPath = req.path.startsWith('/api/')
    || req.path.startsWith('/uploads/')
    || req.path.startsWith('/knowledge-files/')
    || req.path.startsWith('/agent-assets/');
  if (!protectedPath) return next();
  const auth = service.authenticate(req.headers.cookie);
  if (!auth) return res.status(401).json({ error: '请先在电脑端确认此设备' });
  req.remoteAuth = auth;
  if (!SAFE_METHODS.has(req.method)) {
    if (!hasValidOrigin(req)) return res.status(403).json({ error: '请求来源无效' });
    if (!service.verifyCsrf(auth, req.headers.cookie, req.get('x-liuxu-csrf'))) {
      return res.status(403).json({ error: '远程会话校验失败，请刷新页面' });
    }
  }
  next();
}

function cookieLine(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}${name === SESSION_COOKIE ? '; HttpOnly' : ''}`;
}

function registerRemoteAccessRoutes(app) {
  app.get('/api/remote/bootstrap', (req, res) => {
    if (!isRemoteRequest(req)) return res.json({ remote: false, authenticated: true, desktop: process.env.LIUXU_DESKTOP === '1' });
    const service = getRemoteAccessService();
    const auth = service?.authenticate(req.headers.cookie);
    if (!auth) return res.status(401).json({ remote: true, authenticated: false });
    res.json({ remote: true, authenticated: true, device: { id: auth.device.id, name: auth.device.name } });
  });

  app.post('/api/remote/pair/request', (req, res) => {
    if (!isRemoteRequest(req)) return res.status(404).json({ error: 'Not found' });
    if (!hasValidOrigin(req)) return res.status(403).json({ error: '请求来源无效' });
    const result = getRemoteAccessService()?.requestPair({
      token: req.body?.token,
      name: req.body?.name,
      userAgent: req.get('user-agent'),
    }) || { error: '远程服务不可用', status: 503 };
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.status(202).json(result);
  });

  app.get('/api/remote/pair/:id/status', (req, res) => {
    if (!isRemoteRequest(req)) return res.status(404).json({ error: 'Not found' });
    const result = getRemoteAccessService()?.pairingStatus(req.params.id, req.query.token)
      || { error: '远程服务不可用', status: 503 };
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    if (result.state === 'approved') {
      const maxAge = Math.max(0, result.expiresAt - Date.now());
      res.setHeader('Set-Cookie', [
        cookieLine(SESSION_COOKIE, result.sessionToken, maxAge),
        cookieLine(CSRF_COOKIE, result.csrfToken, maxAge),
      ]);
    }
    res.json({ state: result.state, expiresAt: result.expiresAt, device: result.device });
  });

  app.post('/api/remote/logout', (req, res) => {
    if (!isRemoteRequest(req)) return res.json({ ok: true });
    getRemoteAccessService()?.revokeSessionFromCookie(req.headers.cookie);
    res.setHeader('Set-Cookie', [cookieLine(SESSION_COOKIE, '', 0), cookieLine(CSRF_COOKIE, '', 0)]);
    res.json({ ok: true });
  });
}

module.exports = { remoteAccessMiddleware, registerRemoteAccessRoutes, expectedOrigin, hasValidOrigin };
