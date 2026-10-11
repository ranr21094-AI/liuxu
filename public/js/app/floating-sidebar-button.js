/** Move the sidebar opener without changing page layout or persisting preferences. */
export function initFloatingSidebarButton(button) {
  if (!button) return;
  let drag = null;
  let position = null;
  let suppressUntil = 0;
  const margin = 12;
  function place(x, y) {
    const size = button.getBoundingClientRect();
    position = {
      x: Math.max(margin, Math.min(x, window.innerWidth - size.width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - size.height - margin)),
    };
    button.style.left = `${position.x}px`;
    button.style.top = `${position.y}px`;
  }
  button.title = '展开侧栏 · 拖动调整位置 · Alt＋方向键移动';
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const rect = button.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    button.setPointerCapture?.(event.pointerId);
  });
  button.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    button.classList.add('is-dragging');
    place(drag.left + dx, drag.top + dy);
  });
  function finish(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved) suppressUntil = Date.now() + 500;
    drag = null;
    button.classList.remove('is-dragging');
    if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId);
  }
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', finish);
  button.addEventListener('lostpointercapture', finish);
  button.addEventListener('click', event => {
    if (event.detail && Date.now() < suppressUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  button.addEventListener('keydown', event => {
    if (!event.altKey || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const rect = button.getBoundingClientRect();
    place(rect.left + (event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0),
      rect.top + (event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0));
  });
  window.addEventListener('resize', () => { if (position) place(position.x, position.y); });
}
