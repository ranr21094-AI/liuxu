const PATTERN_WORD = 'LIUXU';
const TITLE_ZH = '你好，我是留序';
const TITLE_EN = "HELLO, I'm LiuXu";
const PATTERN_CELL_COUNT = 100;

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

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0;
  let spotX = '50%';
  let spotY = '50%';

  const applySpot = () => {
    raf = 0;
    frame.style.setProperty('--spot-x', spotX);
    frame.style.setProperty('--spot-y', spotY);
  };

  const setSpotFromEvent = event => {
    const rect = frame.getBoundingClientRect();
    spotX = `${event.clientX - rect.left}px`;
    spotY = `${event.clientY - rect.top}px`;
    if (!raf) raf = requestAnimationFrame(applySpot);
  };

  if (reducedMotion) {
    frame.style.setProperty('--spot-x', '50%');
    frame.style.setProperty('--spot-y', '50%');
    cleanups.set(hero, () => {});
    return;
  }

  frame.addEventListener('pointermove', setSpotFromEvent);
  frame.addEventListener('pointerenter', setSpotFromEvent);

  cleanups.set(hero, () => {
    if (raf) cancelAnimationFrame(raf);
    frame.removeEventListener('pointermove', setSpotFromEvent);
    frame.removeEventListener('pointerenter', setSpotFromEvent);
  });
}

export function unmountAgentEmptyHero(root) {
  const hero = resolveHero(root);
  if (!hero) return;
  cleanups.get(hero)?.();
  cleanups.delete(hero);
}
