const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(path.join(ROOT, 'public', 'js', 'agent-empty-hero.js')).href;

async function loadHeroModule() {
  return import(`${moduleUrl}?spotlight=${Date.now()}-${Math.random()}`);
}

function createBrowserEnvironment({ finePointer = true, reducedMotion = false } = {}) {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const dom = new JSDOM('<!doctype html><body></body>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const callbacks = new Map();
  let nextFrameId = 1;

  dom.window.matchMedia = query => ({
    matches: query.includes('prefers-reduced-motion') ? reducedMotion : finePointer,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });

  const requestAnimationFrame = callback => {
    const id = nextFrameId++;
    callbacks.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = id => callbacks.delete(id);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = requestAnimationFrame;
  globalThis.cancelAnimationFrame = cancelAnimationFrame;

  return {
    dom,
    pendingFrames: () => callbacks.size,
    step(timestamp) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach(callback => callback(timestamp));
    },
    restore() {
      callbacks.clear();
      dom.window.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

function dispatchPointer(dom, target, type, { clientX = 0, clientY = 0, pointerType = 'mouse' } = {}) {
  const event = new dom.window.MouseEvent(type, {
    bubbles: false,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
}

function mountFixture(document, html) {
  document.body.innerHTML = html;
  const frame = document.querySelector('.agent-empty-hero__frame');
  frame.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    right: 810,
    bottom: 520,
    width: 800,
    height: 500,
  });
  return frame;
}

test('empty Agent hero keeps one accessible Chinese title and a hidden English reveal', async () => {
  const { renderAgentEmptyHero } = await loadHeroModule();
  const dom = new JSDOM(`<!doctype html><body>${renderAgentEmptyHero()}</body>`);
  try {
    const titles = dom.window.document.querySelectorAll('.agent-empty-hero h1');
    assert.equal(titles.length, 2);
    assert.equal(titles[0].textContent, '你好，我是留序');
    assert.equal(titles[0].closest('[aria-hidden="true"]'), null);
    assert.equal(titles[1].textContent, "HELLO, I'm LiuXu");
    assert.equal(titles[1].closest('[aria-hidden="true"]')?.classList.contains('agent-empty-hero__layer--spotlight'), true);
  } finally {
    dom.window.close();
  }
});

test('spotlight starts hidden, follows smoothly, and disappears when the pointer leaves', async () => {
  const environment = createBrowserEnvironment();
  try {
    const heroModule = await loadHeroModule();
    const frame = mountFixture(document, heroModule.renderAgentEmptyHero());
    heroModule.mountAgentEmptyHero(document);

    assert.equal(frame.classList.contains('is-spotlight-active'), false);
    dispatchPointer(environment.dom, frame, 'pointerenter', { clientX: 110, clientY: 120 });
    assert.equal(frame.classList.contains('is-spotlight-active'), true);
    assert.equal(frame.style.getPropertyValue('--spot-x'), '100.00px');
    assert.equal(frame.style.getPropertyValue('--spot-y'), '100.00px');

    dispatchPointer(environment.dom, frame, 'pointermove', { clientX: 410, clientY: 270 });
    assert.equal(environment.pendingFrames(), 1);
    environment.step(16.67);
    const firstX = Number.parseFloat(frame.style.getPropertyValue('--spot-x'));
    assert.ok(firstX > 100 && firstX < 400);

    let timestamp = 16.67;
    for (let frameCount = 0; environment.pendingFrames() && frameCount < 120; frameCount += 1) {
      timestamp += 16.67;
      environment.step(timestamp);
    }
    assert.equal(frame.style.getPropertyValue('--spot-x'), '400.00px');
    assert.equal(frame.style.getPropertyValue('--spot-y'), '250.00px');
    assert.equal(environment.pendingFrames(), 0);

    dispatchPointer(environment.dom, frame, 'pointermove', { clientX: 700, clientY: 400 });
    assert.equal(environment.pendingFrames(), 1);
    dispatchPointer(environment.dom, frame, 'pointerleave');
    assert.equal(frame.classList.contains('is-spotlight-active'), false);
    assert.equal(environment.pendingFrames(), 0);

    heroModule.unmountAgentEmptyHero(document);
    dispatchPointer(environment.dom, frame, 'pointerenter', { clientX: 200, clientY: 200 });
    assert.equal(frame.classList.contains('is-spotlight-active'), false);
  } finally {
    environment.restore();
  }
});

test('reduced motion updates the spotlight immediately without scheduling animation', async () => {
  const environment = createBrowserEnvironment({ reducedMotion: true });
  try {
    const heroModule = await loadHeroModule();
    const frame = mountFixture(document, heroModule.renderAgentEmptyHero());
    heroModule.mountAgentEmptyHero(document);

    dispatchPointer(environment.dom, frame, 'pointerenter', { clientX: 110, clientY: 120 });
    dispatchPointer(environment.dom, frame, 'pointermove', { clientX: 410, clientY: 270 });
    assert.equal(frame.style.getPropertyValue('--spot-x'), '400.00px');
    assert.equal(frame.style.getPropertyValue('--spot-y'), '250.00px');
    assert.equal(environment.pendingFrames(), 0);

    dispatchPointer(environment.dom, frame, 'pointerleave');
    assert.equal(frame.classList.contains('is-spotlight-active'), false);
  } finally {
    environment.restore();
  }
});

test('coarse and touch pointers cannot activate the spotlight', async () => {
  const coarseEnvironment = createBrowserEnvironment({ finePointer: false });
  try {
    const heroModule = await loadHeroModule();
    const frame = mountFixture(document, heroModule.renderAgentEmptyHero());
    heroModule.mountAgentEmptyHero(document);
    dispatchPointer(coarseEnvironment.dom, frame, 'pointerenter', { clientX: 200, clientY: 200 });
    assert.equal(frame.classList.contains('is-spotlight-active'), false);
  } finally {
    coarseEnvironment.restore();
  }

  const touchEnvironment = createBrowserEnvironment();
  try {
    const heroModule = await loadHeroModule();
    const frame = mountFixture(document, heroModule.renderAgentEmptyHero());
    heroModule.mountAgentEmptyHero(document);
    dispatchPointer(touchEnvironment.dom, frame, 'pointerenter', {
      clientX: 200,
      clientY: 200,
      pointerType: 'touch',
    });
    assert.equal(frame.classList.contains('is-spotlight-active'), false);
  } finally {
    touchEnvironment.restore();
  }
});

test('spotlight styles default to hidden and preserve touch and reduced-motion accessibility', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'public', 'css', 'workbench.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  assert.match(styles, /--spot-r:\s*clamp\(118px, 12vw, 150px\)/);
  assert.match(styles, /touch-action:\s*auto/);
  assert.match(styles, /\.agent-empty-hero__layer--spotlight\s*\{[\s\S]*?visibility:\s*hidden;[\s\S]*?opacity:\s*0;/);
  assert.match(styles, /\.agent-empty-hero__frame\.is-spotlight-active \.agent-empty-hero__layer--spotlight\s*\{[\s\S]*?opacity:\s*1;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none;/);
  assert.doesNotMatch(html, /agent-empty-hero__frame is-spotlight-active/);
});
