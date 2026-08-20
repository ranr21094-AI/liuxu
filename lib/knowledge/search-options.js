const ALL_UI_FIELDS = ['title', 'heading', 'body', 'tags', 'path'];
const PATH_INDEX_FIELDS = ['knowledgeBase', 'folderPath', 'collection'];

const PRESET_OPTIONS = {
  smart: {
    prefix: true,
    fuzzy: 0.2,
    strict: false,
    fields: [...ALL_UI_FIELDS],
  },
  exact: {
    prefix: false,
    fuzzy: 0,
    strict: true,
    fields: ['title', 'heading', 'body'],
  },
};

const DEFAULT_SEARCH_OPTIONS = {
  preset: 'smart',
  ...PRESET_OPTIONS.smart,
};

function resolveIndexFields(uiFields) {
  const fields = [];
  for (const name of uiFields) {
    if (name === 'path') fields.push(...PATH_INDEX_FIELDS);
    else fields.push(name);
  }
  return [...new Set(fields.filter(Boolean))];
}

function normalizeFields(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const parsed = value.filter(field => ALL_UI_FIELDS.includes(field));
  return parsed.length ? parsed : [...fallback];
}

function presetOptions(preset) {
  if (preset === 'exact') return { ...PRESET_OPTIONS.exact, fields: [...PRESET_OPTIONS.exact.fields] };
  return { ...PRESET_OPTIONS.smart, fields: [...PRESET_OPTIONS.smart.fields] };
}

function parseSearchOptions(query = {}) {
  const presetRaw = String(query.preset || '').trim();
  const preset = ['smart', 'exact', 'custom'].includes(presetRaw) ? presetRaw : null;
  const options = preset && preset !== 'custom' ? presetOptions(preset) : presetOptions('smart');

  if (query.prefix !== undefined && query.prefix !== '') {
    options.prefix = query.prefix === '1' || query.prefix === 'true';
  }
  if (query.fuzzy !== undefined && query.fuzzy !== '') {
    const fuzzy = Number(query.fuzzy);
    options.fuzzy = Number.isFinite(fuzzy) ? Math.min(0.5, Math.max(0, fuzzy)) : 0;
  }
  if (query.strict !== undefined && query.strict !== '') {
    options.strict = query.strict === '1' || query.strict === 'true';
  }
  if (typeof query.fields === 'string' && query.fields.trim()) {
    options.fields = normalizeFields(
      query.fields.split(',').map(item => item.trim()),
      options.fields,
    );
  }

  const hasExplicitOverride = ['prefix', 'fuzzy', 'strict', 'fields'].some(
    key => query[key] !== undefined && String(query[key]).trim() !== '',
  );
  const resolvedPreset = preset || (hasExplicitOverride ? 'custom' : 'smart');

  return {
    preset: resolvedPreset,
    prefix: Boolean(options.prefix),
    fuzzy: options.fuzzy,
    strict: Boolean(options.strict),
    fields: normalizeFields(options.fields, PRESET_OPTIONS.smart.fields),
    indexFields: resolveIndexFields(normalizeFields(options.fields, PRESET_OPTIONS.smart.fields)),
  };
}

module.exports = {
  ALL_UI_FIELDS,
  DEFAULT_SEARCH_OPTIONS,
  PRESET_OPTIONS,
  parseSearchOptions,
  resolveIndexFields,
};
