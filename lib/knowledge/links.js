const WIKI_LINK_RE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;
const DOCUMENT_ID_RE = /^(?:note|file):[1-9]\d*$/;

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('zh-CN');
}

function isDocumentId(value) {
  return DOCUMENT_ID_RE.test(String(value || '').trim());
}

function safeLabel(value) {
  return String(value || '')
    .replace(/\|/g, '｜')
    .replace(/\]\]/g, '］］')
    .replace(/\r?\n/g, ' ')
    .trim()
    .slice(0, 200);
}

function canonicalLink(label, documentId) {
  const target = String(documentId || '').trim();
  if (!isDocumentId(target)) return '';
  return `[[${safeLabel(label) || target}|${target}]]`;
}

function parseWikiLinks(content) {
  const source = String(content || '');
  const links = [];
  for (const match of source.matchAll(WIKI_LINK_RE)) {
    const left = String(match[1] || '').trim();
    const right = String(match[2] || '').trim();
    const targetId = right && isDocumentId(right) ? right : '';
    links.push({
      raw: match[0],
      label: left,
      targetId,
      rawTarget: right || left,
      canonical: Boolean(targetId),
      start: match.index || 0,
      end: (match.index || 0) + match[0].length,
    });
  }
  return links;
}

function canonicalizeContent(content, resolveTitle) {
  const source = String(content || '');
  const resolver = typeof resolveTitle === 'function' ? resolveTitle : () => null;
  const issues = [];
  let changed = false;
  const next = source.replace(WIKI_LINK_RE, (raw, rawLeft, rawRight) => {
    const left = String(rawLeft || '').trim();
    const right = String(rawRight || '').trim();
    if (right && isDocumentId(right)) return canonicalLink(left, right) || raw;
    const resolution = resolver(normalizeTitle(left));
    if (resolution?.status === 'resolved' && isDocumentId(resolution.documentId)) {
      changed = true;
      return canonicalLink(left, resolution.documentId) || raw;
    }
    issues.push({
      raw,
      title: left,
      status: resolution?.status === 'ambiguous' ? 'ambiguous' : 'unresolved',
      candidates: Array.isArray(resolution?.candidates) ? resolution.candidates : [],
    });
    return raw;
  });
  return { content: next, changed, issues, links: parseWikiLinks(next) };
}

function resolvedLinks(content, resolveTitle) {
  const result = canonicalizeContent(content, resolveTitle);
  return result.links.map(link => ({
    ...link,
    resolved: Boolean(link.targetId),
  }));
}

module.exports = {
  WIKI_LINK_RE,
  DOCUMENT_ID_RE,
  normalizeTitle,
  isDocumentId,
  safeLabel,
  canonicalLink,
  parseWikiLinks,
  canonicalizeContent,
  resolvedLinks,
};
