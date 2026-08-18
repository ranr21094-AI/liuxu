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
});
