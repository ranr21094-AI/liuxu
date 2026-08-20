function documentDateValue(doc) {
  return (doc.documentDate || doc.logDate || doc.updatedAt || doc.createdAt || '').slice(0, 10);
}

function filterDocuments(documents, filters = {}) {
  let list = Array.isArray(documents) ? documents : [];
  const status = filters.status === 'archived' ? 'archived' : 'active';
  list = list.filter(doc => (doc.status || 'active') === status);
  if (!filters.includeAnnotations) {
    list = list.filter(doc => doc.documentRole !== 'annotation');
  }
  if (filters.type) list = list.filter(doc => doc.sourceType === filters.type);
  if (filters.knowledgeBase) list = list.filter(doc => doc.knowledgeBase === filters.knowledgeBase);
  if (filters.folderPath) {
    list = list.filter(doc => (
      doc.folderPath === filters.folderPath
      || String(doc.folderPath || '').startsWith(`${filters.folderPath}/`)
    ));
  }
  if (!filters.knowledgeBase && !filters.folderPath && filters.legacyCollectionPath) {
    list = list.filter(doc => (
      doc.collectionPath === filters.legacyCollectionPath
      || String(doc.collectionPath).startsWith(`${filters.legacyCollectionPath}/`)
    ));
  }
  if (filters.search) {
    const needle = String(filters.search).toLowerCase();
    list = list.filter(doc => `${doc.title}\n${doc.content}`.toLowerCase().includes(needle));
  }
  if (filters.tag) {
    const tag = String(filters.tag).toLowerCase();
    list = list.filter(doc => (doc.tags || []).some(item => String(item).toLowerCase() === tag));
  }
  if (filters.from) list = list.filter(doc => !doc.updatedAt || doc.updatedAt.slice(0, 10) >= filters.from);
  if (filters.to) list = list.filter(doc => !doc.updatedAt || doc.updatedAt.slice(0, 10) <= filters.to);
  if (filters.date) list = list.filter(doc => documentDateValue(doc) === filters.date);
  return list;
}

function filtersFromQuery(query = {}) {
  return {
    legacyCollectionPath: typeof (query.collectionPath || query.collection) === 'string'
      ? String(query.collectionPath || query.collection)
      : '',
    knowledgeBase: typeof query.knowledgeBase === 'string' ? String(query.knowledgeBase).trim() : '',
    folderPath: typeof query.folderPath === 'string' ? String(query.folderPath).trim() : '',
    search: typeof (query.search || query.q) === 'string' ? String(query.search || query.q).trim() : '',
    tag: typeof query.tag === 'string' ? query.tag.trim().toLowerCase() : '',
    from: typeof query.from === 'string' ? query.from : '',
    to: typeof query.to === 'string' ? query.to : '',
    date: typeof query.date === 'string' ? query.date : '',
    type: typeof query.type === 'string' ? query.type : '',
    status: query.status === 'archived' ? 'archived' : 'active',
    includeAnnotations: query.includeAnnotations === '1',
  };
}

module.exports = { filterDocuments, filtersFromQuery, documentDateValue };
