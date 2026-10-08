const test = require('node:test');
const assert = require('node:assert/strict');

test('recent items validate, deduplicate, cap and discard corrupt data', async () => {
  const storage = { value: JSON.stringify([{ type: 'document', id: 'note:bad', title: 'bad' }, { nope: true }]), getItem() { return this.value; }, setItem(_key, value) { this.value = value; }, removeItem() { this.value = null; } };
  const { getRecentItems, rememberRecentItem, MAX_ITEMS } = await import('../public/js/knowledge/recent-items.js');
  assert.deepEqual(getRecentItems(storage), []);
  for (let i = 0; i < MAX_ITEMS + 4; i += 1) rememberRecentItem({ type: 'document', id: `note:${i}`, title: `Note ${i}` }, storage);
  assert.equal(getRecentItems(storage).length, MAX_ITEMS);
  rememberRecentItem({ type: 'document', id: 'note:3', title: 'Updated' }, storage);
  const items = getRecentItems(storage);
  assert.equal(items.length, MAX_ITEMS);
  assert.equal(items.filter(item => item.id === 'note:3').length, 1);
  assert.equal(items[0].title, 'Updated');
});
