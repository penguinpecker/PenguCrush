// ═══════════════════════════════════════════════════════════════
//  DEV-STARS — stars-only alignment tool (minimal version)
//
//  Enable:  __pengu.starDev()  or  ?dev=stars (persists via localStorage)
//
//  With a popup visible that has stars (map-popup or end-of-level):
//    • SHIFT + drag a star          → move the whole group
//    • SHIFT + scroll wheel on star → resize (up = bigger, down = smaller)
//    • SHIFT + ArrowLeft / Right    → shrink / widen the gap
//    • SHIFT + ArrowUp / Down       → nudge the group vertically
//    • Press P                      → print CSS
//
//  No other UI is touched. Clicks on the empty background pass through
//  normally. Disable: __pengu.starDev('off').
// ═══════════════════════════════════════════════════════════════

const TARGETS = [
  { name: 'map-popup',   container: '.pop-stars',          star: '.pop-star',             frameSel: '.popup-frame' },
  { name: 'level-popup', container: '.level-popup-stars',  star: '.level-popup-stars img', frameSel: '.level-popup' },
];

let active = false;
let dragging = null;

function findActiveTarget() {
  for (const t of TARGETS) {
    const c = document.querySelector(t.container);
    if (c && c.offsetParent) return t;
  }
  return null;
}

function px(el, prop) { return parseFloat(getComputedStyle(el)[prop]); }

function printState() {
  const t = findActiveTarget();
  if (!t) { console.warn('[star-dev] no popup is visible'); return; }
  const container = document.querySelector(t.container);
  const frame = document.querySelector(t.frameSel);
  const stars = [...container.querySelectorAll(t.star)];
  const cRect = container.getBoundingClientRect();
  const fRect = frame.getBoundingClientRect();
  const top  = ((cRect.top  + cRect.height / 2 - fRect.top)  / fRect.height) * 100;
  const left = ((cRect.left + cRect.width  / 2 - fRect.left) / fRect.width)  * 100;
  const gap  = px(container, 'gap');
  const starW = stars.length ? stars[0].offsetWidth : 0;
  const starPctFrame = (starW / fRect.width) * 100;
  const gapPctFrame  = (gap   / fRect.width) * 100;
  console.group(`[star-dev] ${t.name}`);
  console.log(`frame: ${Math.round(fRect.width)}×${Math.round(fRect.height)}px`);
  console.log(`container center (% of frame):  top ${top.toFixed(2)}%, left ${left.toFixed(2)}%`);
  console.log(`star width: ${starW.toFixed(1)}px = ${starPctFrame.toFixed(2)}% of frame`);
  console.log(`gap:        ${gap.toFixed(1)}px = ${gapPctFrame.toFixed(2)}% of frame`);
  console.log('--- paste-ready (cqw units, works on every viewport) ---');
  if (t.name === 'map-popup') {
    console.log(`.pop-stars   { top: ${top.toFixed(1)}%; left: ${left.toFixed(1)}%; gap: ${gapPctFrame.toFixed(2)}cqw; }`);
    console.log(`.pop-star    { width: ${starPctFrame.toFixed(2)}cqw; }`);
  } else {
    console.log(`.level-popup-stars      { top: ${top.toFixed(1)}%; left: ${left.toFixed(1)}%; gap: ${gapPctFrame.toFixed(2)}cqw; }`);
    console.log(`.level-popup-stars img  { width: ${starPctFrame.toFixed(2)}cqw; }`);
  }
  console.groupEnd();
}

function applyOffsets(t, { dtop, dleft, dGap, dWidth }) {
  const container = document.querySelector(t.container);
  if (!container) return;
  const frame = document.querySelector(t.frameSel);
  const fRect = frame.getBoundingClientRect();
  const cRect = container.getBoundingClientRect();

  let newTop, newLeft, newGap, newStarW;

  if (dtop !== undefined || dleft !== undefined) {
    const curTop  = ((cRect.top  + cRect.height / 2 - fRect.top)  / fRect.height) * 100;
    const curLeft = ((cRect.left + cRect.width  / 2 - fRect.left) / fRect.width)  * 100;
    newTop  = curTop  + (dtop  || 0);
    newLeft = curLeft + (dleft || 0);
    container.style.position = 'absolute';
    container.style.top  = newTop + '%';
    container.style.left = newLeft + '%';
    container.style.transform = 'translate(-50%, -50%)';
  }
  if (dGap !== undefined) {
    const cur = px(container, 'gap');
    newGap = Math.max(0, cur + dGap);
    container.style.gap = newGap + 'px';
  }
  if (dWidth !== undefined) {
    const stars = container.querySelectorAll(t.star);
    stars.forEach(s => {
      // Use offsetWidth (layout width) not getBoundingClientRect().width
      // (which includes CSS transforms like the ±10° rotation on the
      // end-of-level stars and would feed its rotated bbox back in,
      // causing both scroll directions to grow).
      const cur = s.offsetWidth;
      newStarW = Math.max(4, cur + dWidth);
      s.style.setProperty('min-width', '0', 'important');
      s.style.width = newStarW + 'px';
    });
  }

  return { newTop, newLeft, newGap, newStarW };
}

// ── Events ────────────────────────────────────────────────────

function onPointerDown(e) {
  if (!active || !e.shiftKey) return;
  const t = findActiveTarget();
  if (!t) return;
  const star = e.target.closest(t.star);
  if (!star) return;
  e.preventDefault();
  e.stopPropagation();
  dragging = { t, startX: e.clientX, startY: e.clientY };
}

function onPointerMove(e) {
  if (!dragging) return;
  const dx = e.clientX - dragging.startX;
  const dy = e.clientY - dragging.startY;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  dragging.startX = e.clientX;
  dragging.startY = e.clientY;
  const frame = document.querySelector(dragging.t.frameSel);
  const fRect = frame.getBoundingClientRect();
  const r = applyOffsets(dragging.t, {
    dleft: (dx / fRect.width)  * 100,
    dtop:  (dy / fRect.height) * 100,
  });
  if (r) console.log(`[star-dev] drag → top ${r.newTop.toFixed(2)}%  left ${r.newLeft.toFixed(2)}%`);
}

function onPointerUp() { dragging = null; }

function onWheel(e) {
  if (!active || !e.shiftKey) return;
  const t = findActiveTarget();
  if (!t) return;
  if (!e.target.closest(t.container)) return;
  e.preventDefault();
  e.stopPropagation();
  // Sign-based: positive deltaY = finger/wheel scrolling down = shrink.
  // Some trackpads fire very small values; use Math.sign so the direction
  // is taken from the sign alone, not the magnitude.
  const sign = Math.sign(e.deltaY);
  if (sign === 0) return;
  const dir = -sign;               // scroll up → +1 (grow), down → -1 (shrink)
  const before = document.querySelector(t.star).offsetWidth;
  applyOffsets(t, { dWidth: dir * 2 });
  const after = document.querySelector(t.star).offsetWidth;
  console.log(`[star-dev] wheel deltaY=${e.deltaY.toFixed(2)} dir=${dir}  star width ${before} → ${after}px`);
}

function onKey(e) {
  if (!active) return;
  if (e.key === 'p' || e.key === 'P') { printState(); return; }
  if (!e.shiftKey) return;
  const t = findActiveTarget();
  if (!t) return;
  let r = null;
  switch (e.key) {
    case 'ArrowLeft':  r = applyOffsets(t, { dGap: -1 }); e.preventDefault(); break;
    case 'ArrowRight': r = applyOffsets(t, { dGap: +1 }); e.preventDefault(); break;
    case 'ArrowUp':    r = applyOffsets(t, { dtop: -0.2 }); e.preventDefault(); break;
    case 'ArrowDown':  r = applyOffsets(t, { dtop: +0.2 }); e.preventDefault(); break;
    // Reliable keyboard alternatives to scroll-wheel resize:
    case '[': case '-': case '_':
      r = applyOffsets(t, { dWidth: -2 }); e.preventDefault(); break;
    case ']': case '=': case '+':
      r = applyOffsets(t, { dWidth: +2 }); e.preventDefault(); break;
  }
  if (r) {
    const parts = [];
    if (r.newTop !== undefined)  parts.push(`top ${r.newTop.toFixed(2)}%`);
    if (r.newLeft !== undefined) parts.push(`left ${r.newLeft.toFixed(2)}%`);
    if (r.newGap !== undefined)  parts.push(`gap ${r.newGap.toFixed(1)}px`);
    if (r.newStarW !== undefined) parts.push(`star ${r.newStarW}px`);
    if (parts.length) console.log('[star-dev] ' + parts.join('  '));
  }
}

function enable() {
  if (active) return;
  active = true;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup',   onPointerUp, true);
  document.addEventListener('wheel',       onWheel, { capture: true, passive: false });
  document.addEventListener('keydown',     onKey);
  console.log('%c[star-dev] on', 'color:#2e8;font-weight:bold');
  console.log('  SHIFT+drag a star  → move');
  console.log('  SHIFT+scroll       → resize (up=bigger, down=smaller)');
  console.log('  SHIFT+[  /  ]      → resize (shrink / grow, same as scroll)');
  console.log('  SHIFT+←/→          → gap');
  console.log('  SHIFT+↑/↓          → vertical nudge');
  console.log('  P                  → print CSS');
}

function disable() {
  if (!active) return;
  active = false;
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup',   onPointerUp, true);
  document.removeEventListener('wheel',       onWheel, { capture: true });
  document.removeEventListener('keydown',     onKey);
  try { localStorage.removeItem('pengu_star_dev'); } catch (_) {}
  console.log('[star-dev] off');
}

function api(cmd) {
  if (cmd === 'off') return disable();
  if (cmd === 'print') return printState();
  enable();
}

window.__pengu = window.__pengu || {};
window.__pengu.starDev   = api;
window.__pengu.printStars = printState;

try {
  const url = new URLSearchParams(location.search);
  if (url.get('dev') === 'stars') {
    localStorage.setItem('pengu_star_dev', '1');
    enable();
  } else if (localStorage.getItem('pengu_star_dev') === '1') {
    enable();
  }
} catch (_) {}
