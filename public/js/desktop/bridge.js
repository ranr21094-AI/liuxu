/**
 * Renderer-only access to the sandboxed Electron bridge.  Keeping this lookup
 * in one module makes browser mode and desktop mode share the same UI code.
 */
export function getDesktopUpdates() {
  return window.liuxuDesktop?.updates || null;
}

export function isDesktopRuntime() {
  return Boolean(getDesktopUpdates());
}
