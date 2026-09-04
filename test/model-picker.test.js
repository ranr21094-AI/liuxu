const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

test('model picker hides internal provider ids and filters stale entries', async () => {
  const url = pathToFileURL(path.join(__dirname, '../public/js/settings/model.js'));
  url.search = `test=${Date.now()}`;
  const { buildModelPickerGroups } = await import(url.href);
  const groups = buildModelPickerGroups([
    {
      id: 'p_abcd1234',
      name: 'p_abcd1234',
      baseUrl: 'https://api.example.com/v1',
      models: [
        { id: 'gpt-4o', name: '' },
        { id: 'gpt-4o', name: 'duplicate' },
        { id: 'bad model', name: 'ignored' },
      ],
    },
    {
      id: 'p_abcd1234',
      name: 'Duplicate provider',
      baseUrl: 'https://duplicate.example.com',
      models: [{ id: 'other', name: 'ignored duplicate provider' }],
    },
    {
      id: 'p_named001',
      name: 'Readable provider',
      models: [{ id: 'model-a', name: 'Model A' }],
    },
    {
      id: 'p_empty001',
      name: 'Empty provider',
      models: [{ id: '', name: '' }],
    },
  ]);

  assert.deepEqual(groups, [
    {
      label: 'api.example.com',
      items: [{ id: 'custom/p_abcd1234/gpt-4o', name: 'gpt-4o' }],
    },
    {
      label: 'Readable provider',
      items: [{ id: 'custom/p_named001/model-a', name: 'Model A' }],
    },
  ]);
});

