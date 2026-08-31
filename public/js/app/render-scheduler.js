const pending = new Map();
const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame.bind(globalThis)
  : callback => setTimeout(callback, 0);
const cancelRaf = typeof cancelAnimationFrame === 'function'
  ? cancelAnimationFrame.bind(globalThis)
  : clearTimeout;

export function scheduleRender(key, callback) {
  const token = String(key || 'default');
  const previous = pending.get(token);
  if (previous) cancelRaf(previous);
  const frame = raf(() => {
    pending.delete(token);
    callback();
  });
  pending.set(token, frame);
  return () => {
    const current = pending.get(token);
    if (current === frame) {
      cancelRaf(frame);
      pending.delete(token);
    }
  };
}

export function cancelScheduledRender(key) {
  const token = String(key || 'default');
  const frame = pending.get(token);
  if (!frame) return;
  cancelRaf(frame);
  pending.delete(token);
}

export function cancelAllScheduledRenders() {
  for (const frame of pending.values()) cancelRaf(frame);
  pending.clear();
}
