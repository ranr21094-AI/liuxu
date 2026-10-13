const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('floating opener distinguishes click from drag, clamps position and supports keyboard movement', async () => {
  const dom = new JSDOM('<button id="open">Open</button>');
  const previous = global.window;
  global.window = dom.window;
  try {
    const { initFloatingSidebarButton } = await import('../public/js/app/floating-sidebar-button.js');
    const button = dom.window.document.querySelector('button');
    button.getBoundingClientRect = () => ({ left: parseFloat(button.style.left) || 12, top: parseFloat(button.style.top) || 12, width: 40, height: 40 });
    initFloatingSidebarButton(button);
    let opens = 0;
    button.addEventListener('click', () => opens++);
    const pointer = (type, x, y) => {
      const event = new dom.window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      button.dispatchEvent(event);
    };
    pointer('pointerdown', 20, 20); pointer('pointerup', 20, 20);
    button.dispatchEvent(new dom.window.MouseEvent('click', { detail: 1 }));
    assert.equal(opens, 1);
    pointer('pointerdown', 20, 20); pointer('pointermove', 300, 200); pointer('pointerup', 300, 200);
    button.dispatchEvent(new dom.window.MouseEvent('click', { detail: 1 }));
    assert.equal(opens, 1);
    assert.equal(button.style.left, '292px');
    button.click(); // Keyboard activation remains available after dragging.
    assert.equal(opens, 2);
    button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true }));
    assert.equal(button.style.left, '276px');
    dom.window.innerWidth = 200; dom.window.innerHeight = 150;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    assert.equal(button.style.left, '148px'); assert.equal(button.style.top, '98px');
    pointer('pointerdown', 150, 100); pointer('pointermove', -500, -500); pointer('pointercancel', -500, -500);
    assert.equal(button.style.left, '12px'); assert.equal(button.classList.contains('is-dragging'), false);
  } finally { global.window = previous; dom.window.close(); }
});
