// Shortcut registry with localStorage persistence
const STORAGE_KEY = 'customShortcuts';

export const defaults = {
  save:         { keys: 'Ctrl+S',        description: '保存日志',              scope: 'editor' },
  preview:      { keys: 'Ctrl+P',        description: '切换编辑/预览',         scope: 'editor' },
  bold:         { keys: 'Ctrl+B',        description: '加粗',                  scope: 'editor' },
  italic:       { keys: 'Ctrl+I',        description: '斜体',                  scope: 'editor' },
  newLog:       { keys: 'Ctrl+N',        description: '新建日志',              scope: 'global' },
  search:       { keys: 'Ctrl+F',        description: '聚焦搜索框',            scope: 'global' },
  clearFilter:  { keys: 'Ctrl+Shift+F',  description: '清除所有筛选',          scope: 'global' },
  help:         { keys: '?',             description: '快捷键帮助',            scope: 'global' },
  escape:       { keys: 'Escape',        description: '关闭弹窗/退出编辑器',    scope: 'global' },
};

function loadCustom() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}

function saveCustom(custom) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
}

// Get all active shortcuts (defaults merged with custom overrides)
export function getAllShortcuts() {
  const custom = loadCustom();
  const all = {};
  for (const [action, def] of Object.entries(defaults)) {
    const override = custom[action];
    if (override) {
      all[action] = { ...def, ...override, custom: true };
    } else {
      all[action] = { ...def, custom: false };
    }
  }
  return all;
}

// Parse "Ctrl+Shift+K" → { ctrl:true, shift:true, alt:false, key:'k' }
export function parseKeys(combo) {
  const parts = combo.split('+').map(s => s.trim());
  const result = { ctrl: false, shift: false, alt: false, key: '' };
  for (const p of parts) {
    if (p === 'Ctrl') result.ctrl = true;
    else if (p === 'Shift') result.shift = true;
    else if (p === 'Alt') result.alt = true;
    else result.key = p;
  }
  return result;
}

// Format parsed keys back to string
export function formatKeys(parsed) {
  const parts = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.shift) parts.push('Shift');
  if (parsed.alt) parts.push('Alt');
  if (parsed.key) parts.push(parsed.key);
  return parts.join('+');
}

// Normalize a combo string for comparison
export function normalizeKeys(combo) {
  return formatKeys(parseKeys(combo));
}

// Check if a keyboard event matches a combo string
export function eventMatches(e, combo) {
  const parsed = parseKeys(combo);
  const ctrlOk = parsed.ctrl === (e.ctrlKey || e.metaKey);
  const altOk = parsed.alt === e.altKey;
  const keyOk = parsed.key.toLowerCase() === e.key.toLowerCase();
  // Shift: enforce only if shortcut explicitly requires it.
  // If not specified but key is non-alphanumeric (e.g. '?'), be lenient
  // since the user needs Shift to produce that character on most keyboards.
  const shiftOk = parsed.shift
    ? e.shiftKey
    : (/^[a-zA-Z0-9]$/.test(parsed.key) ? !e.shiftKey : true);
  return ctrlOk && shiftOk && altOk && keyOk;
}

// Find which action a key event triggers (returns action id or null)
export function findAction(e) {
  const shortcuts = getAllShortcuts();
  for (const [action, def] of Object.entries(shortcuts)) {
    if (!def.enabled && def.enabled !== undefined) continue;
    if (eventMatches(e, def.keys)) return action;
  }
  return null;
}

// Update a built-in shortcut
export function setShortcut(action, config) {
  if (!defaults[action]) return;
  const custom = loadCustom();
  if (!config || !config.keys) {
    delete custom[action];
  } else {
    custom[action] = { keys: normalizeKeys(config.keys) };
  }
  saveCustom(custom);
}

// Reset to defaults
export function resetAllShortcuts() {
  localStorage.removeItem(STORAGE_KEY);
}

// Check if a combo is already used by another action
export function isComboUsed(combo, exceptAction) {
  const shortcuts = getAllShortcuts();
  const norm = normalizeKeys(combo);
  for (const [action, def] of Object.entries(shortcuts)) {
    if (action === exceptAction) continue;
    if (normalizeKeys(def.keys) === norm) return action;
  }
  return null;
}
