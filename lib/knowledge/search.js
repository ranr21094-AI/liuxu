const fs = require('fs');
const path = require('path');
const MiniSearch = require('minisearch');
const { chunkDocument } = require('./chunk');
const { atomicWriteJson, readJsonIfExists } = require('../util/json-file');

function tokenize(text) {
  const source = String(text || '').toLowerCase();
  const tokens = [];
  for (const match of source.matchAll(/[a-z0-9]+/g)) tokens.push(match[0]);
  const chars = [...source].filter(ch => /[\u3400-\u9fff]/.test(ch));
  for (const ch of chars) tokens.push(ch);
  for (let i = 0; i < chars.length - 1; i += 1) tokens.push(chars[i] + chars[i + 1]);
  return tokens;
}

function createIndex() {
  return new MiniSearch({
    fields: ['title', 'tags', 'knowledgeBase', 'folderPath', 'collection', 'heading', 'body'],
    storeFields: ['documentId', 'heading', 'body', 'offset', 'visibility', 'collectionPath', 'knowledgeBase', 'folderPath', 'title', 'kind'],
    tokenize,
    processTerm: term => term,
    searchOptions: {
      boost: { title: 3, tags: 2, knowledgeBase: 2, folderPath: 2, collection: 2, heading: 2, body: 1 },
      prefix: true,
      fuzzy: 0.2,
    },
  });
}

function documentsToRecords(documents) {
  const records = [];
  for (const doc of documents) {
    const chunks = chunkDocument(doc);
    for (const chunk of chunks) {
      records.push({
        id: chunk.id,
        documentId: doc.id,
        title: doc.title || '',
        tags: (doc.tags || []).join(' '),
        knowledgeBase: doc.knowledgeBase || '',
        folderPath: doc.folderPath || '',
        collection: doc.collectionPath || '',
        heading: chunk.heading || '',
        body: chunk.text || '',
        offset: chunk.offset,
        visibility: doc.visibility,
        collectionPath: doc.collectionPath,
        knowledgeBase: doc.knowledgeBase,
        folderPath: doc.folderPath,
        kind: chunk.kind,
      });
    }
  }
  return records;
}

function createSearchIndex(knowledge) {
  function indexFile() { return path.join(knowledge.dataDir, 'knowledge-index.json'); }
  let mini = createIndex();
  let loadedSignature = '';

  function persist(signature, records) {
    atomicWriteJson(indexFile(), { signature, records });
  }

  function rebuild(diaryUnlocked) {
    const documents = knowledge.allDocuments({ diaryUnlocked: true });
    const records = documentsToRecords(documents);
    mini = createIndex();
    if (records.length) mini.addAll(records);
    const signature = knowledge.sourceSignature(true);
    persist(signature, records);
    loadedSignature = signature;
    return { mini, records, signature };
  }

  function load(diaryUnlocked) {
    const signature = knowledge.sourceSignature(true);
    if (loadedSignature === signature && mini.documentCount) return mini;
    const saved = readJsonIfExists(indexFile(), null);
    if (saved?.signature === signature && Array.isArray(saved.records)) {
      mini = createIndex();
      if (saved.records.length) mini.addAll(saved.records);
      loadedSignature = signature;
      return mini;
    }
    return rebuild(diaryUnlocked).mini;
  }

  function search(query, { diaryUnlocked = false, collectionPath = '', knowledgeBase = '', folderPath = '', limit = 30 } = {}) {
    const engine = load(diaryUnlocked);
    const raw = engine.search(String(query || '').trim(), { prefix: true });
    const seen = [];
    for (const hit of raw) {
      if (hit.visibility === 'diary' && !diaryUnlocked) continue;
      if (collectionPath && hit.collectionPath !== collectionPath && !String(hit.collectionPath || '').startsWith(`${collectionPath}/`)) continue;
      if (knowledgeBase && hit.knowledgeBase !== knowledgeBase) continue;
      if (folderPath && hit.folderPath !== folderPath && !String(hit.folderPath || '').startsWith(`${folderPath}/`)) continue;
      seen.push({
        id: hit.id,
        documentId: hit.documentId,
        title: hit.title,
        heading: hit.heading,
        snippet: String(hit.body || '').slice(0, 280),
        offset: hit.offset,
        score: hit.score,
        collectionPath: hit.collectionPath,
        knowledgeBase: hit.knowledgeBase,
        folderPath: hit.folderPath,
      });
      if (seen.length >= limit) break;
    }
    return seen;
  }

  return { search, rebuild, load };
}

module.exports = { createSearchIndex, tokenize };
