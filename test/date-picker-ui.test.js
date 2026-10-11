const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const load = () => import('../public/js/app/date-picker.js');
async function setup() {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const d = dom.window.document;
  d.querySelectorAll('[hidden]').forEach(el => el.hidden = false);
  d.querySelectorAll('details').forEach(el => el.open = true);
  const picker = (await load()).initDatePickers(d);
  return { dom, d, picker, open(id, value = '2024-02-29') { d.getElementById(id).value = value; picker.sync(); d.querySelector(`[data-date-input="${id}"]`).click(); return d.getElementById('sharedDatePicker'); } };
}

test('calendar date math handles leap years, six Monday-first rows, year boundaries and month clamping', async () => {
  const { parseDate, formatDate, calendarDays, shiftMonth } = await load();
  assert.equal(parseDate('2023-02-29'), null);
  assert.equal(parseDate('2024-02-30'), null);
  assert.equal(formatDate(parseDate('0001-01-01')), '0001-01-01');
  assert.equal(formatDate(shiftMonth(parseDate('2024-01-31'), 1)), '2024-02-29');
  assert.equal(formatDate(shiftMonth(parseDate('2024-12-31'), 1)), '2025-01-31');
  const days = calendarDays(2024, 1);
  assert.equal(days.length, 42);
  assert.equal(days[0].getDay(), 1);
  assert.equal(formatDate(days[0]), '2024-01-29');
  assert.equal(formatDate(days.at(-1)), '2024-03-10');
});

test('all five fields retain native date values and dispatch input/change exactly once on selection', async () => {
  const { dom, d, open, picker } = await setup();
  for (const id of ['knowledgeDateFilter', 'documentDate', 'mentionDateInput', 'todoFullDueDate', 'countdownTargetDate']) {
    const input = d.getElementById(id);
    const events = [];
    input.addEventListener('input', () => events.push('input')); input.addEventListener('change', () => events.push('change'));
    const popup = open(id);
    assert.equal(input.type, 'date');
    assert.equal(popup.querySelectorAll('[role="gridcell"]').length, 42);
    popup.querySelector('[data-date-value="2024-03-01"]').click();
    assert.equal(input.value, '2024-03-01');
    assert.deepEqual(events, ['input', 'change']);
    assert.equal(popup.hidden, true);
    assert.equal(d.activeElement.dataset.dateInput, id);
    assert.equal(d.querySelector(`[data-date-input="${id}"] .date-picker-value`).textContent, '2024-03-01');
    input.value = '2025-01-02'; picker.sync();
    assert.equal(d.querySelector(`[data-date-input="${id}"] .date-picker-value`).textContent, '2025-01-02');
  }
  dom.window.close();
});

test('optional dates clear; required dates retain native validity and have no clear action', async () => {
  const { dom, d, open } = await setup();
  let popup = open('todoFullDueDate'); popup.querySelector('[data-date-command="clear"]').click();
  assert.equal(d.getElementById('todoFullDueDate').value, '');
  popup = open('countdownTargetDate', '');
  assert.equal(popup.querySelector('[data-date-command="clear"]'), null);
  assert.equal(d.getElementById('countdownTargetDate').validity.valueMissing, true);
  popup.querySelector('[data-date-value]:not(:disabled)').click();
  assert.equal(d.getElementById('countdownTargetDate').validity.valueMissing, false);
  dom.window.close();
});

test('read-only/disabled dates cannot open and close an existing calendar when changed', async () => {
  const { dom, d, open, picker } = await setup();
  const input = d.getElementById('documentDate');
  const popup = open('documentDate');
  input.readOnly = true;
  await Promise.resolve();
  assert.equal(popup.hidden, true);
  assert.equal(d.querySelector('[data-date-input="documentDate"]').disabled, true);
  input.readOnly = false; input.disabled = true; picker.sync();
  d.querySelector('[data-date-input="documentDate"]').click();
  assert.equal(popup.hidden, true);
  input.disabled = false; picker.sync(); input.focus();
  assert.equal(d.activeElement.dataset.dateInput, 'documentDate');
  dom.window.close();
});

test('keyboard movement handles week boundaries and month/year changes with one focusable date', async () => {
  const { dom, d, open } = await setup();
  const popup = open('knowledgeDateFilter');
  const key = key => d.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  key('ArrowRight'); assert.equal(d.activeElement.dataset.dateValue, '2024-03-01');
  key('Home'); assert.equal(d.activeElement.dataset.dateValue, '2024-02-26');
  key('End'); assert.equal(d.activeElement.dataset.dateValue, '2024-03-03');
  key('PageUp'); assert.equal(d.activeElement.dataset.dateValue, '2024-02-03');
  assert.equal(popup.querySelectorAll('.date-picker-day[tabindex="0"]').length, 1);
  const year = popup.querySelector('[data-date-year]'); year.value = '2025'; year.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.match(popup.querySelector('[role="grid"]').getAttribute('aria-label'), /2025年2月/);
  d.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(popup.hidden, true);
  assert.equal(d.activeElement.dataset.dateInput, 'knowledgeDateFilter');
  dom.window.close();
});

test('one calendar at a time, min/max/step respected, and positioning stays inside viewport', async () => {
  const { dom, d, open } = await setup();
  Object.defineProperty(dom.window, 'innerWidth', { value: 390 }); Object.defineProperty(dom.window, 'innerHeight', { value: 360 });
  const input = d.getElementById('knowledgeDateFilter'); input.min = '2024-02-28'; input.max = '2024-03-02'; input.step = '2';
  const trigger = d.querySelector('[data-date-input="knowledgeDateFilter"]');
  trigger.getBoundingClientRect = () => ({ left: 320, top: 290, bottom: 326 });
  d.getElementById('sharedDatePicker').getBoundingClientRect = () => ({ width: 288, height: 320 });
  const popup = open('knowledgeDateFilter', '2024-02-28');
  assert.equal(popup.querySelector('[data-date-value="2024-02-29"]').disabled, true);
  assert.equal(popup.querySelector('[data-date-value="2024-03-01"]').disabled, false);
  assert.ok(Number.parseInt(popup.style.top) >= 12);
  assert.ok(Number.parseInt(popup.style.left) + 288 <= 390 - 12);
  open('todoFullDueDate');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(popup.dataset.datePickerOwner, 'todoFullDueDate');
  assert.equal(d.querySelectorAll('#sharedDatePicker').length, 1);
  dom.window.close();
});

test('calendar interactions preserve the knowledge filter panel and Escape closes nested surfaces in order', async () => {
  const { dom, d, picker } = await setup();
  const { initSidebarSearch } = await import('../public/js/app/sidebar-search.js');
  const panel = d.getElementById('knowledgeFilterPanel'); panel.hidden = true;
  let changes = 0;
  const controls = initSidebarSearch({ document: d, onKnowledgeChange: () => changes++, onMemoryChange() {}, onSessionChange() {} });
  panel.hidden = false; d.getElementById('knowledgeFilterDetails').open = true;
  d.getElementById('knowledgeDateFilter').value = '2024-02-29'; picker.sync();
  const trigger = d.querySelector('[data-date-input="knowledgeDateFilter"]'); trigger.click();
  const popup = d.getElementById('sharedDatePicker');
  popup.querySelector('[data-date-command="next"]').click();
  assert.equal(panel.hidden, false);
  d.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(popup.hidden, true); assert.equal(panel.hidden, false); assert.equal(d.activeElement, trigger);
  d.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.hidden, true);
  panel.hidden = false; d.getElementById('knowledgeFilterDetails').open = true; trigger.click();
  popup.querySelector('[data-date-value="2024-03-01"]').click();
  assert.equal(panel.hidden, false);
  assert.equal(changes, 1);
  assert.match(d.getElementById('knowledgeActiveFilters').textContent, /2024-03-01/);
  trigger.click(); controls.resetKnowledge();
  assert.equal(popup.hidden, true);
  assert.equal(d.querySelector('[data-date-input="knowledgeDateFilter"] .date-picker-value').textContent, '选择日期');
  dom.window.close();
});

test('programmatic record changes refresh the trigger and close the previous record calendar', async () => {
  const { dom, d, open, picker } = await setup();
  const popup = open('documentDate');
  d.getElementById('documentDate').value = '2025-01-01'; picker.sync();
  assert.equal(popup.hidden, true);
  assert.equal(d.querySelector('[data-date-input="documentDate"] .date-picker-value').textContent, '2025-01-01');
  dom.window.close();
});
