/** Reveal native validation errors without changing existing settings validation. */
export function initSettingsPresentation(form, selectPanel) {
  if (!form) return;
  form.addEventListener('invalid', event => {
    const field = event.target;
    const panel = field.closest('[data-settings-panel]');
    if (panel?.hidden) selectPanel(panel.dataset.settingsPanel);
    let parent = field.parentElement;
    while (parent && parent !== form) {
      if (parent.tagName === 'DETAILS') parent.open = true;
      parent = parent.parentElement;
    }
    requestAnimationFrame(() => {
      field.scrollIntoView?.({ block: 'nearest' });
      field.focus();
    });
  }, true);
}
