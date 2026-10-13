// textarea normalizes CRLF/CR to LF. Keep raw text separately and apply only
// the changed input region, retaining untouched original line endings.
export function createRawTextState(content, bom, baseFingerprint) {
  let raw = String(content), fingerprint = baseFingerprint;
  let display = raw.replace(/\r\n|\r/g, '\n');
  const endings = raw.match(/\r\n|\r|\n/g) || [];
  const counts = new Map();
  endings.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  const newline = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '\n';
  function edit(nextDisplay) {
    const next = String(nextDisplay).replace(/\r\n|\r/g, '\n');
    if (next === display) return raw;
    let prefix = 0, suffix = 0;
    while (prefix < display.length && prefix < next.length && display[prefix] === next[prefix]) prefix++;
    while (suffix < display.length - prefix && suffix < next.length - prefix
      && display[display.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
    const offsets = [0];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '\r' && raw[i + 1] === '\n') i++;
      offsets.push(i + 1);
    }
    const start = offsets[prefix], end = offsets[display.length - suffix];
    const oldEndings = raw.slice(start, end).match(/\r\n|\r|\n/g) || [];
    let index = 0;
    const insertion = next.slice(prefix, next.length - suffix).replace(/\n/g, () => oldEndings[index++] || newline);
    raw = raw.slice(0, start) + insertion + raw.slice(end);
    display = next;
    return raw;
  }
  return { get content() { return raw; }, get display() { return display; }, bom: Boolean(bom),
    get baseFingerprint() { return fingerprint; }, edit,
    acknowledge(value) { fingerprint = value; } };
}
