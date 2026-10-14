const START = '<!-- liuxu-reading:start -->', END = '<!-- liuxu-reading:end -->';
export function splitAnnotation(content = '') {
  const start = content.indexOf(START), end = content.indexOf(END);
  if (start < 0 && end < 0) return { personal: content, summary: '', valid: true };
  if (start < 0 || end < start || content.indexOf(START, start + START.length) >= 0 || content.indexOf(END, end + END.length) >= 0) return { personal: content, summary: '', valid: false };
  return { personal: content.slice(0, start) + content.slice(end + END.length), summary: content.slice(start + START.length, end), valid: true };
}
