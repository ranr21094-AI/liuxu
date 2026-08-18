const TARGET_CHARS = 1200;
const OVERLAP_CHARS = 150;

function splitParagraphs(text) {
  return String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
}

function windowChunks(text, heading, startOffset) {
  const chunks = [];
  const source = String(text || '');
  if (!source) return chunks;
  let index = 0;
  while (index < source.length) {
    const end = Math.min(source.length, index + TARGET_CHARS);
    const slice = source.slice(index, end);
    chunks.push({
      heading,
      text: slice,
      offset: startOffset + index,
    });
    if (end >= source.length) break;
    index = Math.max(index + TARGET_CHARS - OVERLAP_CHARS, index + 1);
  }
  return chunks;
}

function chunkDocument(doc) {
  const content = String(doc.content || '');
  const sections = [];
  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  let lastIndex = 0;
  let lastHeading = doc.title || '';
  let match = headingPattern.exec(content);
  if (!match) {
    sections.push({ heading: lastHeading, text: content, offset: 0 });
  } else {
    while (match) {
      if (match.index > lastIndex) {
        sections.push({ heading: lastHeading, text: content.slice(lastIndex, match.index), offset: lastIndex });
      }
      lastHeading = match[2].trim();
      lastIndex = match.index + match[0].length;
      match = headingPattern.exec(content);
    }
    if (lastIndex < content.length) {
      sections.push({ heading: lastHeading, text: content.slice(lastIndex), offset: lastIndex });
    }
  }

  const chunks = [];
  chunks.push({
    id: `${doc.id}#title`,
    documentId: doc.id,
    heading: doc.title || '',
    text: doc.title || '',
    offset: 0,
    kind: 'title',
  });
  let serial = 0;
  for (const section of sections) {
    const paragraphs = splitParagraphs(section.text);
    const body = paragraphs.join('\n\n') || section.text;
    for (const piece of windowChunks(body, section.heading, section.offset)) {
      serial += 1;
      chunks.push({
        id: `${doc.id}#${serial}`,
        documentId: doc.id,
        heading: piece.heading,
        text: piece.text,
        offset: piece.offset,
        kind: 'body',
      });
    }
  }
  return chunks;
}

module.exports = { chunkDocument, TARGET_CHARS, OVERLAP_CHARS };
