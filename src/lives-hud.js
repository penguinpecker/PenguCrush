// ═══════════════════════════════════════════════════════════════
//  Lives HUD — shared renderer for map pre-level popup & end-game dialog
// ═══════════════════════════════════════════════════════════════

import * as Inventory from './inventory.js';

const LIFE_HEART_FULL = '/assets/ui/lives/heart-full.png';
const LIFE_HEART_ICE = '/assets/ui/lives/heart-ice.png';
const LIFE_HEART_EMPTY = '/assets/ui/lives/heart-empty.png';

export function formatNextLifeCountdown(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  return `${h}h ${m}m ${sec}s`;
}

/** True when the player can pay the 1-life cost for Replay / Next. */
export function canSpendLife() {
  const { lives, frozenLives } = Inventory.getLives();
  const hudSlots = Inventory.getLivesHudSlotCount();
  return Math.min(hudSlots, lives + frozenLives) > 0;
}

export function shakeLivesHud(rootId = 'livesHud') {
  const el = document.getElementById(rootId);
  if (!el) return;
  el.classList.remove('lives-hud--shake');
  void el.offsetWidth;
  el.classList.add('lives-hud--shake');
  el.addEventListener('animationend', () => el.classList.remove('lives-hud--shake'), { once: true });
}

export function shakeElement(el) {
  if (!el) return;
  el.classList.remove('level-popup-btn--shake');
  void el.offsetWidth;
  el.classList.add('level-popup-btn--shake');
  el.addEventListener('animationend', () => el.classList.remove('level-popup-btn--shake'), { once: true });
}

/**
 * @param {object} [opts]
 * @param {string} [opts.rootId]
 * @param {string} [opts.countId]
 * @param {string} [opts.heartsId]
 * @param {string} [opts.regenId]
 * @param {HTMLButtonElement|null} [opts.playBtn] map PLAY button — disabled at 0 lives
 */
export function renderLivesHud(opts = {}) {
  const rootId = opts.rootId ?? 'livesHud';
  const countId = opts.countId ?? 'livesCount';
  const heartsId = opts.heartsId ?? 'livesHearts';
  const regenId = opts.regenId ?? 'livesRegen';

  const { lives, frozenLives } = Inventory.getLives();
  const livesMax = Inventory.getMaxLives();
  const hudSlots = Inventory.getLivesHudSlotCount();
  const regularSlots = Inventory.getRegularLivesHudSlots();
  const regularEnd = Math.min(hudSlots, lives);
  const iceEnd = Math.min(hudSlots, lives + frozenLives);
  const visibleTotal = Math.min(hudSlots, lives + frozenLives);

  const rootEl = document.getElementById(rootId);
  const countEl = document.getElementById(countId);
  const rowEl = document.getElementById(heartsId);
  const regenEl = document.getElementById(regenId);

  if (rootEl) rootEl.classList.toggle('lives-hud--pass', Inventory.hasCrushPass());
  if (countEl) countEl.textContent = String(visibleTotal);

  if (rowEl) {
    rowEl.innerHTML = '';
    const hasPass = Inventory.hasCrushPass();
    for (let slot = 1; slot <= hudSlots; slot++) {
      const isPassSlot = slot > regularSlots;

      if (isPassSlot && !hasPass) {
        const wrap = document.createElement('div');
        wrap.className = 'lives-hud__heart lives-hud__heart--locked';
        wrap.title = 'Buy pass to unlock';
        wrap.setAttribute('data-tooltip', 'Buy pass to unlock');
        const heartImg = document.createElement('img');
        heartImg.className = 'lives-hud__heart--locked-img';
        heartImg.src = LIFE_HEART_EMPTY;
        heartImg.draggable = false;
        heartImg.alt = '';
        wrap.appendChild(heartImg);
        rowEl.appendChild(wrap);
        continue;
      }

      const isRegularFilled = slot <= regularEnd;
      const isIceFilled = !isRegularFilled && slot <= iceEnd;
      const filled = isRegularFilled || isIceFilled;
      const isIceSlot = isIceFilled || (isPassSlot && !filled);

      const img = document.createElement('img');
      img.className = 'lives-hud__heart';
      img.draggable = false;
      img.alt = '';
      if (!filled) {
        img.src = LIFE_HEART_EMPTY;
      } else if (isIceSlot || slot > lives) {
        img.src = LIFE_HEART_ICE;
      } else {
        img.src = LIFE_HEART_FULL;
      }
      rowEl.appendChild(img);
    }
  }

  if (regenEl) {
    if (visibleTotal <= 0) {
      regenEl.textContent = 'No lives!';
    } else if (lives >= livesMax) {
      regenEl.textContent = 'Full!';
    } else {
      const ms = Inventory.nextLifeRegenIn();
      regenEl.textContent =
        ms <= 0
          ? 'Next life soon…'
          : `Next life in: ${formatNextLifeCountdown(ms)}`;
    }
  }

  if (opts.playBtn) {
    const inactive = visibleTotal <= 0;
    opts.playBtn.disabled = inactive;
    opts.playBtn.classList.toggle('pop-play--disabled', inactive);
  }
}
