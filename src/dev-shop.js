// ═══════════════════════════════════════════════════════════════
//  DEV-SHOP — align each booster and each price tag INDIVIDUALLY.
//
//  Enable:   __pengu.shopDev()       or   ?dev=shop
//  Disable:  __pengu.shopDev('off')
//  Print:    P   — logs every item's top/left/width/height in %
//
//  Every booster icon (.shop-slot) and every price tag (.shop-tag) is a
//  separate, free-floating element. Click one to select it (orange dashed
//  outline shows which). Then:
//
//    SHIFT + drag                 → move the selected item
//    SHIFT + ← / →                → shrink / widen  width
//    SHIFT + ↑ / ↓                → shrink / grow   height
//    SHIFT + 1 / 2                → nudge left / right  (small step)
//    SHIFT + 3 / 4                → nudge up   / down   (small step)
//    SHIFT + 7 / 8                → icon / label size (inside the item)
//    P                            → print paste-ready inline styles for all
//
//  All values are %/cqw relative to .shop-popup so the layout stays locked
//  across every viewport.
// ═══════════════════════════════════════════════════════════════

const FRAME_SEL = '.shop-popup';
const ITEMS_SEL = '.shop-slot, .shop-tag';

let active = false;
let selected = null;
let dragging = null;

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }
function pxNum(el, prop) { return parseFloat(getComputedStyle(el)[prop]) || 0; }
function frameRect() { const f = $(FRAME_SEL); return f ? f.getBoundingClientRect() : null; }
function pctX(px) { const r = frameRect(); return r ? (px / r.width)  * 100 : 0; }
function pctY(px) { const r = frameRect(); return r ? (px / r.height) * 100 : 0; }

function select(el) {
  if (selected === el) return;
  if (selected) { selected.style.outline = ''; selected.style.outlineOffset = ''; }
  selected = el;
  if (selected) {
    selected.style.outline = '2px dashed #ff6a1f';
    selected.style.outlineOffset = '2px';
    const kind = selected.classList.contains('shop-slot') ? 'slot' : 'tag';
    const item = selected.dataset.item || '?';
    console.log(`[shop-dev] selected → ${kind}:${item}`);
  }
}

function rectAsPct(el) {
  const fR = frameRect(); if (!fR) return null;
  const r = el.getBoundingClientRect();
  return {
    top:    ((r.top  - fR.top)  / fR.height) * 100,
    left:   ((r.left - fR.left) / fR.width)  * 100,
    width:  (r.width  / fR.width)  * 100,
    height: (r.height / fR.height) * 100,
  };
}

function printState() {
  const items = $$(ITEMS_SEL);
  if (!items.length) { console.warn('[shop-dev] no items found — open the shop popup first'); return; }
  console.group('[shop-dev] paste-ready inline styles');
  const lines = [];
  items.forEach(el => {
    const p = rectAsPct(el);
    if (!p) return;
    const kind = el.classList.contains('shop-slot') ? 'slot' : 'tag';
    const item = el.dataset.item || '?';
    const styleStr = `top:${p.top.toFixed(2)}%;left:${p.left.toFixed(2)}%;width:${p.width.toFixed(2)}%;height:${p.height.toFixed(2)}%`;
    lines.push(`${kind} ${item.padEnd(10)} style="${styleStr}"`);
  });
  lines.forEach(l => console.log(l));
  console.groupEnd();
}

function adjustSelected(delta) {
  if (!selected) { console.warn('[shop-dev] nothing selected — click an item first'); return; }
  const fR = frameRect(); if (!fR) return;
  const r = selected.getBoundingClientRect();
  const curTop    = ((r.top  - fR.top)  / fR.height) * 100;
  const curLeft   = ((r.left - fR.left) / fR.width)  * 100;
  const curWidth  = (r.width  / fR.width)  * 100;
  const curHeight = (r.height / fR.height) * 100;
  if (delta.dtop    !== undefined) selected.style.top    = (curTop    + delta.dtop)    + '%';
  if (delta.dleft   !== undefined) selected.style.left   = (curLeft   + delta.dleft)   + '%';
  if (delta.dwidth  !== undefined) selected.style.width  = Math.max(1, curWidth  + delta.dwidth)  + '%';
  if (delta.dheight !== undefined) selected.style.height = Math.max(1, curHeight + delta.dheight) + '%';
}

function adjustIcon(dPct) {
  if (!selected) return;
  // Inner icon/label — resize proportionally inside the item
  const innerImg = selected.querySelector('.shop-slot__icon');
  if (innerImg) {
    const curW = (innerImg.offsetWidth  / selected.offsetWidth)  * 100;
    const curH = (innerImg.offsetHeight / selected.offsetHeight) * 100;
    innerImg.style.width  = Math.max(5, Math.min(100, curW + dPct)) + '%';
    innerImg.style.height = Math.max(5, Math.min(100, curH + dPct)) + '%';
    return;
  }
  // Tag: bump font-size instead
  const label = selected.querySelector('.shop-tag__label');
  if (label) {
    const cur = parseFloat(getComputedStyle(selected).fontSize) || 16;
    selected.style.fontSize = Math.max(6, cur + dPct * 0.5) + 'px';
  }
}

// ── Events ────────────────────────────────────────────────────
function onPointerDown(e) {
  if (!active) return;
  const item = e.target.closest(ITEMS_SEL);
  if (!item) return;
  if (!e.shiftKey) {
    // Plain click just selects the item (does not start a drag)
    e.preventDefault(); e.stopPropagation();
    select(item);
    return;
  }
  e.preventDefault(); e.stopPropagation();
  select(item);
  dragging = { x: e.clientX, y: e.clientY };
}
function onPointerMove(e) {
  if (!dragging) return;
  const dx = e.clientX - dragging.x;
  const dy = e.clientY - dragging.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  dragging.x = e.clientX; dragging.y = e.clientY;
  adjustSelected({ dleft: pctX(dx), dtop: pctY(dy) });
}
function onPointerUp() { dragging = null; }

function onKey(e) {
  if (!active) return;
  if (e.key === 'p' || e.key === 'P') { printState(); return; }
  if (!e.shiftKey || !selected) return;
  let handled = true;
  switch (e.key) {
    case 'ArrowLeft':  adjustSelected({ dwidth:  -0.5 }); break;
    case 'ArrowRight': adjustSelected({ dwidth:  +0.5 }); break;
    case 'ArrowUp':    adjustSelected({ dheight: -0.5 }); break;
    case 'ArrowDown':  adjustSelected({ dheight: +0.5 }); break;
    case '1': adjustSelected({ dleft: -0.25 }); break;
    case '2': adjustSelected({ dleft: +0.25 }); break;
    case '3': adjustSelected({ dtop:  -0.25 }); break;
    case '4': adjustSelected({ dtop:  +0.25 }); break;
    case '7': adjustIcon(-1); break;
    case '8': adjustIcon(+1); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
}

function enable() {
  if (active) return;
  active = true;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup',   onPointerUp,   true);
  document.addEventListener('keydown',     onKey);
  console.log('%c[shop-dev] on', 'color:#2e8;font-weight:bold');
  console.log('  Open the shop first (nav → shop), then:');
  console.log('  Click any booster OR price tag → select it');
  console.log('  SHIFT+drag                    → move the selected item');
  console.log('  SHIFT+←/→                     → width');
  console.log('  SHIFT+↑/↓                     → height');
  console.log('  SHIFT+1/2                     → nudge left/right');
  console.log('  SHIFT+3/4                     → nudge up/down');
  console.log('  SHIFT+7/8                     → inner icon/label size');
  console.log('  P                             → print all inline styles');
}
function disable() {
  if (!active) return;
  active = false;
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup',   onPointerUp,   true);
  document.removeEventListener('keydown',     onKey);
  if (selected) { selected.style.outline = ''; selected.style.outlineOffset = ''; }
  selected = null;
  try { localStorage.removeItem('pengu_shop_dev'); } catch (_) {}
  console.log('[shop-dev] off');
}

function api(cmd) {
  if (cmd === 'off')   return disable();
  if (cmd === 'print') return printState();
  enable();
}

window.__pengu = window.__pengu || {};
window.__pengu.shopDev   = api;
window.__pengu.printShop = printState;

try {
  const url = new URLSearchParams(location.search);
  if (url.get('dev') === 'shop') {
    localStorage.setItem('pengu_shop_dev', '1');
    enable();
  } else if (localStorage.getItem('pengu_shop_dev') === '1') {
    enable();
  }
} catch (_) {}
