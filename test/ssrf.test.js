const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGeneratedImageUrl, hostnameIsBlockedLiteral } = require('../lib/net/ssrf');

test('generated image URL validation blocks local and unresolved hosts', async () => {
  await assert.rejects(() => validateGeneratedImageUrl('http://example.com/a.png'), /HTTPS/);
  await assert.rejects(() => validateGeneratedImageUrl('https://localhost/a.png'), /not allowed/);
  await assert.rejects(() => validateGeneratedImageUrl('https://127.0.0.1/a.png'), /not allowed/);
  await assert.rejects(() => validateGeneratedImageUrl('https://intranet.local/a.png'), /not allowed/);
  assert.equal(hostnameIsBlockedLiteral('169.254.1.1'), true);
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(() => validateGeneratedImageUrl('https://evil.example/a.png', lookup), /not allowed/);
  const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];
  assert.equal(await validateGeneratedImageUrl('https://cdn.example/a.png', publicLookup), 'https://cdn.example/a.png');

  const proxyLookup = async () => [
    { address: '198.18.0.58', family: 4 },
    { address: 'fdfe:dcba:9876::3a', family: 6 },
  ];
  assert.equal(await validateGeneratedImageUrl('https://cdn.example/a.png', proxyLookup), 'https://cdn.example/a.png');

  const mixedLookup = async () => [
    { address: '198.18.0.58', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ];
  await assert.rejects(() => validateGeneratedImageUrl('https://cdn.example/a.png', mixedLookup), /not allowed/);
});

test('web.fetch validator allows literal localhost but blocks public-to-private hops', async () => {
  const { createAgentWebFetchValidator, fetchFollowingRedirects } = require('../lib/net/ssrf');
  const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];
  const local = createAgentWebFetchValidator('http://127.0.0.1:3001/page');
  assert.equal(await local('http://127.0.0.1:3001/next'), 'http://127.0.0.1:3001/next');
  await assert.rejects(() => local('http://169.254.169.254/latest'), /same host/);

  const publicOrigin = createAgentWebFetchValidator('https://cdn.example/doc');
  assert.equal(await publicOrigin('https://cdn.example/doc', publicLookup), 'https://cdn.example/doc');
  await assert.rejects(() => publicOrigin('http://127.0.0.1/secret', publicLookup), /not allowed/);
  const proxyLookup = async () => [{ address: '198.18.0.58', family: 4 }];
  await assert.rejects(() => publicOrigin('https://cdn.example/doc', proxyLookup), /private or local/);

  const hops = [];
  const fetchFn = async (url) => {
    hops.push(url);
    if (url === 'https://cdn.example/start') {
      return { status: 302, headers: { get: key => key === 'location' ? 'https://cdn.example/end' : null }, body: { cancel: async () => {} } };
    }
    return { status: 200, headers: { get: () => '' }, body: null };
  };
  const response = await fetchFollowingRedirects('https://cdn.example/start', {
    validate: publicOrigin,
    lookupFn: publicLookup,
    fetchFn,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(hops, ['https://cdn.example/start', 'https://cdn.example/end']);
});
