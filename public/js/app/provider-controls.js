/** Shared provider toolbar menus and inline naming, without saving configuration. */
export function initProviderControls(root) {
  if (!root || root.dataset.providerControlsBound) return;
  root.dataset.providerControlsBound = 'true';
  root.addEventListener('input', event => {
    if (!event.target.matches('.provider-reference-name input')) return;
    const heading = event.target.closest('.custom-provider-detail')?.querySelector('[data-provider-heading]');
    if (heading) heading.textContent = event.target.value.trim() || '未命名供应商';
  });
  const close = () => root.querySelectorAll('.provider-more[open]').forEach(menu => { menu.open = false; });
  root.addEventListener('click', event => {
    const rename = event.target.closest('[data-provider-rename]');
    if (rename) {
      const card = rename.closest('.custom-provider-detail');
      const editor = card.querySelector('.provider-name-editor');
      close(); editor.hidden = false;
      const input = editor.querySelector('input'); input.focus(); input.select();
    } else if (event.target.closest('.provider-more button')) {
      const menu = event.target.closest('.provider-more');
      close(); menu.querySelector('summary').focus();
    }
  }, true);
  root.addEventListener('focusout', event => {
    const editor = event.target.closest('.provider-name-editor');
    if (!editor) return;
    const input = editor.querySelector('input');
    const select = editor.closest('.custom-provider-detail').querySelector('.provider-selector');
    if (select?.selectedOptions[0]) {
      select.selectedOptions[0].textContent = input.value.trim() || '未命名供应商';
      select.title = select.selectedOptions[0].textContent;
    }
    editor.hidden = true;
  });
  root.addEventListener('keydown', event => {
    const editor = event.target.closest('.provider-name-editor');
    if (editor && event.key === 'Enter') { event.preventDefault(); event.target.blur(); return; }
    const menu = event.target.closest('.provider-more');
    if (!menu) return;
    if (event.key === 'Escape' && menu.open) {
      event.preventDefault(); event.stopPropagation(); close(); menu.querySelector('summary').focus();
    }
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); menu.open = true;
      const items = [...menu.querySelectorAll('button')];
      const index = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
    }
  });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.provider-more')) close(); });
  document.addEventListener('click', event => { if (event.target.closest('[data-settings-nav],[data-settings-group-select]')) close(); });
  root.addEventListener('change', event => { if (event.target.matches('.provider-selector')) close(); });
}
