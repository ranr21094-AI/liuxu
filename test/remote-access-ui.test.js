const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('workbench exposes pairing, desktop device management, and explicit quit controls', () => {
  const html = read('public/index.html');
  for (const id of ['remotePairingGate', 'remotePairButton', 'remoteAccessToggle', 'remoteAccessPort', 'remoteCreatePairing', 'remotePendingDevices', 'remoteAuthorizedDevices', 'remoteQuitApp']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-settings-nav="remote"/);
  assert.match(html, /不会开启公网 Funnel/);
});

test('remote browser client adds CSRF automatically and supports one-time pairing polling', () => {
  const auth = read('public/js/auth.js');
  const remote = read('public/js/remote-access.js');
  assert.match(auth, /X-LiuXu-CSRF/);
  assert.match(auth, /credentials: 'same-origin'/);
  assert.match(remote, /\/api\/remote\/pair\/request/);
  assert.match(remote, /state === 'approved'/);
  assert.match(remote, /history\.replaceState/);
});

test('phone layout reserves touch targets, safe area, and scrollable approval content', () => {
  const css = read('public/css/workbench.css');
  assert.match(css, /body\.remote-client \.settings-card \{[^}]*100dvh/);
  assert.match(css, /body\.remote-client \.settings-nav \{[^}]*overflow-x: auto/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /body\.remote-client \.agent-approval-dock \.card-actions \{[^}]*position: sticky/);
});
