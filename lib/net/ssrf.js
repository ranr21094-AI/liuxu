const dns = require('dns');
const net = require('net');

function ipv4IsPrivateOrLocal(parts) {
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function numericIpv4IsPrivateOrLocal(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 0xffffffff) return true;
  return ipv4IsPrivateOrLocal([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function isPrivateIpLiteral(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);

  if (net.isIP(h) === 4) {
    return ipv4IsPrivateOrLocal(h.split('.').map(Number));
  }

  const v4Tail = h.match(/^:(?::ffff)?:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4Tail) return ipv4IsPrivateOrLocal(v4Tail[1].split('.').map(Number));

  if (net.isIP(h) === 6) {
    if (h === '::1' || h === '::') return true;
    return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb');
  }

  if (/^\d{1,10}$/.test(h)) return numericIpv4IsPrivateOrLocal(h);
  if (/^0x[0-9a-f]{1,8}$/i.test(h)) return numericIpv4IsPrivateOrLocal(h);
  if (/^0[0-7]{1,11}$/.test(h)) return numericIpv4IsPrivateOrLocal(Number('0o' + h.slice(1)));
  return false;
}

function hostnameIsBlockedLiteral(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  return isPrivateIpLiteral(h);
}

async function hostnameResolvesToPrivateOrLocal(hostname, lookupFn) {
  if (hostnameIsBlockedLiteral(hostname)) return true;
  const lookup = lookupFn || dns.promises.lookup.bind(dns.promises);
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Generated image URL is not allowed');
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    throw new Error('Generated image URL is not allowed');
  }
  return addresses.some(entry => isPrivateIpLiteral(entry.address));
}

async function validateGeneratedImageUrl(value, lookupFn) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Generated image URL is not allowed');
  }
  if (url.protocol !== 'https:') throw new Error('Generated image URL must use HTTPS');
  if (url.username || url.password) throw new Error('Generated image URL is not allowed');
  if (await hostnameResolvesToPrivateOrLocal(url.hostname, lookupFn)) {
    throw new Error('Generated image URL is not allowed');
  }
  return url.toString();
}

module.exports = {
  isPrivateIpLiteral,
  hostnameIsBlockedLiteral,
  hostnameResolvesToPrivateOrLocal,
  validateGeneratedImageUrl,
};
