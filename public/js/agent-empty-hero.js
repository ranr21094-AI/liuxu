const PATTERN_WORD = 'LIUXU';
const TITLE_ZH = '你好，我是留序';
const TITLE_EN = "HELLO, I'm LiuXu";
const PATTERN_CELL_COUNT = 100;
const POINTER_QUERY = '(any-hover: hover) and (any-pointer: fine)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const FOLLOW_TIME_CONSTANT_MS = 90;
const MAX_FRAME_DELTA_MS = 32;
const POSITION_EPSILON_PX = 0.25;

const cleanups = new WeakMap();

function buildPatternGrid() {
  return Array.from({ length: PATTERN_CELL_COUNT }, () => `<span>${PATTERN_WORD}</span>`).join('');
}

const patternGrid = buildPatternGrid();

export function renderAgentEmptyHero() {
  return `
    <div class="agent-empty-state agent-empty-hero" data-agent-hero>
      <div class="agent-empty-hero__frame">
        <div class="agent-empty-hero__pattern" aria-hidden="true">${patternGrid}</div>
        <div class="agent-empty-hero__layer agent-empty-hero__layer--base">
          <h1 lang="zh-CN">${TITLE_ZH}</h1>
        </div>
        <div class="agent-empty-hero__layer agent-empty-hero__layer--spotlight" aria-hidden="true">
          <div class="agent-empty-hero__pattern agent-empty-hero__pattern--spotlight">${patternGrid}</div>
          <h1 lang="en">${TITLE_EN}</h1>
        </div>
      </div>
    </div>`;
}

function resolveHero(root) {
  if (!root) return null;
  if (root.matches?.('[data-agent-hero]')) return root;
  return root.querySelector?.('[data-agent-hero]') || null;
}

export function mountAgentEmptyHero(root) {
  const hero = resolveHero(root);
  if (!hero) return;
  unmountAgentEmptyHero(hero);

  const frame = hero.querySelector('.agent-empty-hero__frame');
  if (!frame) return;

  const mediaMatches = query => window.matchMedia?.(query)?.matches ?? false;
  const supportsFinePointer = mediaMatches(POINTER_QUERY);
  const reducedMotion = mediaMatches(REDUCED_MOTION_QUERY);
  let raf = 0;
  let lastFrameTime = 0;
  let active = false;
  let currentX = 0;
  let currentY = 0;
  let targetX = 0;
  let targetY = 0;

  const applySpot = () => {
    frame.style.setProperty('--spot-x', `${currentX.toFixed(2)}px`);
    frame.style.setProperty('--spot-y', `${currentY.toFixed(2)}px`);
  };

  const pointFromEvent = event => {
    const rect = frame.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - rect.left, 0), Math.max(rect.width, 0)),
      y: Math.min(Math.max(event.clientY - rect.top, 0), Math.max(rect.height, 0)),
    };
  };

  const animateSpot = timestamp => {
    raf = 0;
    if (!active) return;

    const delta = lastFrameTime
      ? Math.min(Math.max(timestamp - lastFrameTime, 0), MAX_FRAME_DELTA_MS)
      : 1000 / 60;
    lastFrameTime = timestamp;
    const progress = 1 - Math.exp(-delta / FOLLOW_TIME_CONSTANT_MS);
    currentX += (targetX - currentX) * progress;
    currentY += (targetY - currentY) * progress;

    const distance = Math.hypot(targetX - currentX, targetY - currentY);
    if (distance <= POSITION_EPSILON_PX) {
      currentX = targetX;
      currentY = targetY;
    }
    applySpot();

    if (distance > POSITION_EPSILON_PX) {
      raf = requestAnimationFrame(animateSpot);
    } else {
      lastFrameTime = 0;
    }
  };

  const isTouchPointer = event => event.pointerType === 'touch';

  const showSpot = event => {
    if (isTouchPointer(event)) return;
    const point = pointFromEvent(event);
    currentX = point.x;
    currentY = point.y;
    targetX = point.x;
    targetY = point.y;
    active = true;
    lastFrameTime = 0;
    applySpot();
    frame.classList.add('is-spotlight-active');
  };

  const moveSpot = event => {
    if (isTouchPointer(event)) return;
    if (!active) {
      showSpot(event);
      return;
    }

    const point = pointFromEvent(event);
    targetX = point.x;
    targetY = point.y;
    if (reducedMotion) {
      currentX = targetX;
      currentY = targetY;
      applySpot();
      return;
    }
    if (!raf) raf = requestAnimationFrame(animateSpot);
  };

  const hideSpot = () => {
    active = false;
    lastFrameTime = 0;
    frame.classList.remove('is-spotlight-active');
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  frame.classList.remove('is-spotlight-active');

  if (!supportsFinePointer) {
    cleanups.set(hero, () => {});
    return;
  }

  frame.addEventListener('pointerenter', showSpot);
  frame.addEventListener('pointermove', moveSpot);
  frame.addEventListener('pointerleave', hideSpot);
  frame.addEventListener('pointercancel', hideSpot);

  cleanups.set(hero, () => {
    hideSpot();
    frame.removeEventListener('pointerenter', showSpot);
    frame.removeEventListener('pointermove', moveSpot);
    frame.removeEventListener('pointerleave', hideSpot);
    frame.removeEventListener('pointercancel', hideSpot);
  });
}

export function unmountAgentEmptyHero(root) {
  const hero = resolveHero(root);
  if (!hero) return;
  cleanups.get(hero)?.();
  cleanups.delete(hero);
}
