const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { sign } = require('../lib/computer/chrome');

test('the real extension verifier requires pairing and rejects tampering or replay', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../chrome-extension/background.js'), 'utf8');
  let pairingKey = '';
  const context = vm.createContext({
    crypto: crypto.webcrypto,
    TextEncoder,
    Uint8Array,
    chrome: { storage: { local: { get: async () => ({ liuxuPairingKey: pairingKey }) } } },
  });
  vm.runInContext(source.slice(source.indexOf('const PAIRING_KEY_STORAGE'), source.indexOf('async function detachTab')), context);
  const verify = command => {
    context.command = command;
    return vm.runInContext('verifyAgentCommand(command)', context);
  };
  const key = 'ab'.repeat(32);
  const command = (nonce, args = {}) => ({
    name: 'browser.click',
    args,
    nonce,
    signature: sign(key, nonce, { name: 'browser.click', args }),
  });

  assert.equal(await verify(command('unpaired')), false);
  pairingKey = key;
  const allowed = command('allowed');
  assert.equal(await verify(allowed), true);
  assert.equal(await verify(allowed), false);

  const changedArguments = command('changed-arguments');
  changedArguments.args = { x: 10, y: 20 };
  assert.equal(await verify(changedArguments), false);
  const changedSignature = command('changed-signature');
  changedSignature.signature = '00'.repeat(32);
  assert.equal(await verify(changedSignature), false);
});
