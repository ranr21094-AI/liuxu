const crypto = require('crypto');
const { toolResult } = require('../agent/tools');
const { loadPolicy, savePolicy } = require('./policy');

const nonceCache = new Map();

function noncesFor(dataDir) {
  if (!nonceCache.has(dataDir)) nonceCache.set(dataDir, new Set());
  return nonceCache.get(dataDir);
}

function sign(key, nonce, payload) {
  return crypto.createHmac('sha256', key).update(`${nonce}.${JSON.stringify(payload)}`).digest('hex');
}

function createChromeBridge(dataDir) {
  const usedNonces = noncesFor(dataDir);
  return {
    startPairing() {
      const pairingCode = crypto.randomBytes(3).toString('hex');
      const key = crypto.randomBytes(32).toString('hex');
      const policy = loadPolicy(dataDir);
      policy.pendingPairing = { pairingCode, key, expiresAt: Date.now() + 10 * 60 * 1000 };
      savePolicy(dataDir, policy);
      return { pairingCode };
    },
    confirmPairing(pairingCode) {
      const policy = loadPolicy(dataDir);
      if (!policy.pendingPairing || policy.pendingPairing.pairingCode !== pairingCode || Date.now() > policy.pendingPairing.expiresAt) {
        return { error: 'Invalid or expired pairing code' };
      }
      policy.chromePaired = true;
      policy.chromeKey = policy.pendingPairing.key;
      const key = policy.pendingPairing.key;
      delete policy.pendingPairing;
      savePolicy(dataDir, policy);
      // The shared secret is shown once to the owner, who pastes it into the
      // extension popup; the extension uses it to verify signed commands.
      return { ok: true, key };
    },
    command(name, args) {
      const policy = loadPolicy(dataDir);
      if (!policy.chromePaired || !policy.chromeKey) {
        return toolResult({ ok: false, summary: 'Chrome extension is not paired', errorCode: 'not_paired' });
      }
      const nonce = crypto.randomBytes(16).toString('hex');
      if (usedNonces.has(nonce)) return toolResult({ ok: false, summary: 'Replay detected', errorCode: 'replay' });
      usedNonces.add(nonce);
      if (usedNonces.size > 2048) {
        const first = usedNonces.values().next().value;
        usedNonces.delete(first);
      }
      const payload = { name, args, nonce };
      payload.signature = sign(policy.chromeKey, nonce, { name, args });
      return {
        clientTool: true,
        request: payload,
        result: toolResult({
          ok: true,
          summary: `Requested ${name}`,
          data: payload,
          evidence: [{ type: 'browser', action: name }],
        }),
      };
    },
    request(name, args) {
      return this.command(name, args);
    },
    verify(body) {
      const policy = loadPolicy(dataDir);
      const nonce = body?.nonce;
      const signature = typeof body?.signature === 'string' ? body.signature : '';
      if (!nonce || !signature || usedNonces.has(`used:${nonce}`)) return false;
      let expected;
      try {
        expected = sign(policy.chromeKey, nonce, { name: body.name, args: body.args });
      } catch {
        return false;
      }
      const expectedBytes = Buffer.from(expected, 'hex');
      const providedBytes = Buffer.from(signature, 'hex');
      const signatureValid = expectedBytes.length === providedBytes.length
        && crypto.timingSafeEqual(expectedBytes, providedBytes);
      // Burn the nonce for malformed attempts too, so failures cannot be used
      // as a timing or replay oracle.
      usedNonces.add(`used:${nonce}`);
      if (usedNonces.size > 2048) {
        const first = usedNonces.values().next().value;
        usedNonces.delete(first);
      }
      return signatureValid;
    },
  };
}

module.exports = { createChromeBridge, sign };
