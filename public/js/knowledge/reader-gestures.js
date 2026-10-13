export function readerGestureAllowed({ host, view, event, paginated, hasSelection = false }) {
  if (host.dataset.bookReady !== 'true' || view.hidden || !paginated || hasSelection) return false;
  const documents = new Set([host.ownerDocument, event.target.ownerDocument]);
  for (const doc of documents) {
    if (!doc) continue;
    if (doc.getSelection()?.toString()) return false;
    let focused = doc.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    if (focused?.isContentEditable || focused?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return false;
  }
  return true;
}

// One horizontal trackpad gesture turns one page, including its inertial tail.
export function createTrackpadPageTurn({ canTurn, turn, now = () => performance.now() }) {
  let last = -Infinity, distance = 0, consumed = false;
  return event => {
    if (event.ctrlKey || event.metaKey || event.altKey || !canTurn(event)) return;
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.5) return;
    const target = event.target;
    if (target?.closest?.('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"])')) return;
    for (let el = target; el?.nodeType === 1; el = el.parentElement) {
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const overflow = el.ownerDocument.defaultView.getComputedStyle(el).overflowX;
      if (/auto|scroll/.test(overflow) && (event.deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) return;
    }
    const time = now();
    if (time - last > 220) { distance = 0; consumed = false; }
    last = time;
    event.preventDefault();
    if (consumed) return;
    const delta = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1);
    if (distance && Math.sign(distance) !== Math.sign(delta)) distance = 0;
    distance += delta;
    if (Math.abs(distance) < 60) return;
    consumed = true;
    turn(distance > 0 ? 'right' : 'left');
  };
}
