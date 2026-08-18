const CJK = /[\u4e00-\u9fff]/;
const LATIN1_HIGH = /[\u00c0-\u00ff]/;

function decodeUploadedFilename(name) {
  const raw = name == null ? '' : String(name);
  if (!raw) return raw;
  if (CJK.test(raw)) return raw;
  if (!LATIN1_HIGH.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (!decoded || decoded.includes('\uFFFD')) return raw;
    return decoded;
  } catch {
    return raw;
  }
}

function contentDisposition(filename, fallback = 'file') {
  const decoded = decodeUploadedFilename(filename) || fallback;
  const asciiName = decoded.replace(/[^\x20-\x7E]+/g, '_').replace(/["\\]/g, '_') || fallback;
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(decoded)}`;
}

module.exports = { decodeUploadedFilename, contentDisposition };
