import { getLevel, getLevelCount } from './levels.js';
import { getWallet, fetchPlayerProgress, buildMapProgress, connectAGW, disconnectAGW, shortAddress, hasInjectedWallet, signInWithAGW, isSignedIn } from './supabase.js';
import * as Inventory from './inventory.js';
import { renderShardSlots, SHARDS } from './shards.js';
import { buyCrushPassETH, spinDailyWheel as chainSpinWheel } from './onchain.js';
import { Events, setAnalyticsUser } from './analytics.js';

/** Map inventory grid: 5 boosters + 3 shards = 4×2 */
const INVENTORY_MAP_SLOTS = [
  { kind: 'booster', id: 'row',       label: 'Row clear',    icon: '/assets/boosters-2d/row-clear.png' },
  { kind: 'booster', id: 'col',       label: 'Column clear', icon: '/assets/boosters-2d/col-clear.png' },
  { kind: 'booster', id: 'colorBomb', label: 'Color bomb',   icon: '/assets/boosters-2d/color-bomb.png' },
  { kind: 'booster', id: 'hammer',    label: 'Hammer',       icon: '/assets/boosters-2d/hammer.png' },
  { kind: 'booster', id: 'shuffle',   label: 'Shuffle',      icon: '/assets/boosters-2d/shuffle.png' },
  ...SHARDS.map(s => ({ kind: 'shard', id: s.id, label: s.name, icon: s.img })),
];

const IMG_W = 2748, IMG_H = 1536;
const IMG_RATIO = IMG_W / IMG_H;

// Node positions on the map artwork (x/y percentages)
const NODE_POSITIONS = [
  { id: 1,  x: 11.7, y: 88.3 },
  { id: 2,  x: 18.5, y: 84.6 },
  { id: 3,  x: 24.7, y: 77.5 },
  { id: 4,  x: 25.2, y: 67.0 },
  { id: 5,  x: 19.7, y: 56.1 },
  { id: 6,  x: 23.5, y: 46.2 },
  { id: 7,  x: 29.6, y: 39.5 },
  { id: 8,  x: 37.0, y: 36.2 },
  { id: 9,  x: 44.3, y: 36.1 },
  { id: 10, x: 51.3, y: 39.1 },
  { id: 11, x: 56.5, y: 45.2 },
  { id: 12, x: 65.0, y: 56.1 },
  { id: 13, x: 67.2, y: 66.6 },
  { id: 14, x: 73.1, y: 73.7 },
  { id: 15, x: 80.3, y: 75.0 },
  { id: 16, x: 87.2, y: 69.7 },
  { id: 17, x: 87.6, y: 59.4 },
  { id: 18, x: 82.7, y: 51.7 },
  { id: 19, x: 77.5, y: 45.2 },
  { id: 20, x: 81.2, y: 36.8 },
];

function loadProgress() {
  // Read from localStorage first (instant)
  const saved = JSON.parse(localStorage.getItem('pengucrush_progress') || '{}');
  return NODE_POSITIONS.map(pos => {
    const p = saved[pos.id];
    let status = 'locked';
    let stars = 0;
    let best = 0;
    if (pos.id === 1) status = 'current'; // Level 1 always unlocked
    if (p) {
      stars = p.stars || 0;
      best = p.best || 0;
      if (stars > 0) status = 'completed';
      else if (p.unlocked) status = 'current';
    }
    return { ...pos, stars, best, status };
  });
}

function findCurrentLevel(nodes) {
  // The "current" level is the first non-completed one that's unlocked
  let lastCompleted = 0;
  for (const n of nodes) {
    if (n.status === 'completed') lastCompleted = n.id;
  }
  for (const n of nodes) {
    if (n.id === lastCompleted + 1 && n.status !== 'completed') {
      n.status = 'current';
      return;
    }
  }
}

async function syncFromSupabase(nodes, nodesContainer, openPopup) {
  const wallet = getWallet();
  if (!wallet) return;
  try {
    const data = await fetchPlayerProgress(wallet);
    if (!data?.progress?.length) return;
    const cloudProgress = buildMapProgress(data.progress);

    // Merge — take the better of local vs cloud
    const local = JSON.parse(localStorage.getItem('pengucrush_progress') || '{}');
    let changed = false;
    for (const [lvl, cloud] of Object.entries(cloudProgress)) {
      const loc = local[lvl] || { stars: 0, best: 0 };
      if (cloud.stars > loc.stars || cloud.best > loc.best) {
        local[lvl] = { stars: Math.max(loc.stars, cloud.stars), best: Math.max(loc.best, cloud.best) };
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem('pengucrush_progress', JSON.stringify(local));
      // Rebuild nodes (simple: reload map)
      nodesContainer.innerHTML = '';
      const fresh = loadProgress();
      findCurrentLevel(fresh);
      renderNodes(fresh, nodesContainer, openPopup);
    }
  } catch (e) {
    console.warn('Supabase sync failed:', e);
  }
}

function renderNodes(nodes, nodesContainer, openPopup) {
  nodes.forEach(lv => {
    const node = document.createElement('button');
    node.className = 'level-node ' + lv.status;
    node.style.left = lv.x + '%';
    node.style.top = lv.y + '%';
    node.dataset.level = lv.id;

    const inner = document.createElement('div');
    inner.className = 'node-inner';
    inner.textContent = lv.id;
    node.appendChild(inner);

    if (lv.status === 'completed' && lv.stars > 0) {
      const starsEl = document.createElement('div');
      starsEl.className = 'node-stars';
      for (let s = 0; s < 3; s++) {
        const star = document.createElement('img');
        star.src = s < lv.stars ? '/assets/ui/star-gold.png' : '/assets/ui/star-empty.png';
        star.className = 'node-star-img';
        star.draggable = false;
        starsEl.appendChild(star);
      }
      node.appendChild(starsEl);
    }

    node.addEventListener('click', () => {
      if (lv.status === 'locked') {
        node.style.animation = 'none';
        node.offsetHeight;
        node.style.animation = 'shake 0.4s ease';
        setTimeout(() => node.style.animation = '', 400);
        return;
      }
      openPopup(lv);
    });

    nodesContainer.appendChild(node);
  });
}

export function initMap() {
  Events.mapView();
  setAnalyticsUser(getWallet());
  const stage = document.getElementById('mapStage');
  const nodesContainer = document.getElementById('mapNodes');

  let sceneW = window.innerWidth, sceneH = window.innerHeight;
  function resizeStage() {
    const vw = window.innerWidth, vh = window.innerHeight;
    sceneW = Math.max(vw, vh * IMG_RATIO);
    sceneH = Math.max(vh, vw / IMG_RATIO);
    stage.style.setProperty('--scene-w', sceneW + 'px');
    stage.style.setProperty('--scene-h', sceneH + 'px');
    clampPan();
  }

  // ── Drag-to-pan the map scene ──────────────────────
  let panX = 0, panY = 0;
  let isPanning = false, hasDragged = false;
  let pointerStartX = 0, pointerStartY = 0;
  let panStartX = 0, panStartY = 0;
  const DRAG_THRESHOLD = 6;

  function clampPan() {
    const maxX = Math.max(0, (sceneW - window.innerWidth) / 2);
    const maxY = Math.max(0, (sceneH - window.innerHeight) / 2);
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
    stage.style.setProperty('--pan-x', panX + 'px');
    stage.style.setProperty('--pan-y', panY + 'px');
  }

  stage.addEventListener('pointerdown', e => {
    if (e.shiftKey) return; // reserved for dev node-drag
    if (e.button !== undefined && e.button !== 0) return;
    isPanning = true;
    hasDragged = false;
    pointerStartX = e.clientX;
    pointerStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    // Defer setPointerCapture until we actually start panning — otherwise
    // clicks on inner buttons (level nodes, daily wheel) get swallowed.
  });

  stage.addEventListener('pointermove', e => {
    if (!isPanning) return;
    const dx = e.clientX - pointerStartX;
    const dy = e.clientY - pointerStartY;
    if (!hasDragged && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      hasDragged = true;
      stage.classList.add('panning');
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (hasDragged) {
      panX = panStartX + dx;
      panY = panStartY + dy;
      clampPan();
    }
  });

  function endPan(e) {
    if (!isPanning) return;
    isPanning = false;
    if (hasDragged) {
      try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
      stage.classList.remove('panning');
      const suppress = ev => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      stage.addEventListener('click', suppress, { capture: true, once: true });
      setTimeout(() => stage.removeEventListener('click', suppress, true), 0);
    }
  }
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  resizeStage();
  window.addEventListener('resize', resizeStage);

  const s = document.createElement('style');
  s.textContent = '@keyframes shake { 0%, 100% { transform: translate(-50%,-50%) translateX(0); } 20% { transform: translate(-50%,-50%) translateX(-6px); } 40% { transform: translate(-50%,-50%) translateX(6px); } 60% { transform: translate(-50%,-50%) translateX(-4px); } 80% { transform: translate(-50%,-50%) translateX(4px); } }';
  document.head.appendChild(s);

  // ── AGW wallet button ──────────────────────────────
  const agwBtn = document.getElementById('agwBtn');
  function updateAgwBtn() {
    const addr = getWallet();
    if (addr) {
      agwBtn.textContent = shortAddress(addr);
      agwBtn.classList.add('connected');
    } else {
      agwBtn.textContent = 'Connect Wallet';
      agwBtn.classList.remove('connected');
    }
  }
  updateAgwBtn();

  // ── Disconnect confirm dialog ────────────────────────
  const disconnectOverlay = document.getElementById('disconnectConfirm');
  const disconnectCancelBtn = document.getElementById('disconnectCancel');
  const disconnectOkBtn = document.getElementById('disconnectOk');

  function openDisconnectConfirm() {
    disconnectOverlay?.classList.add('active');
    disconnectOverlay?.setAttribute('aria-hidden', 'false');
  }
  function closeDisconnectConfirm() {
    disconnectOverlay?.classList.remove('active');
    disconnectOverlay?.setAttribute('aria-hidden', 'true');
  }

  disconnectCancelBtn?.addEventListener('click', closeDisconnectConfirm);
  disconnectOverlay?.addEventListener('click', e => {
    if (e.target === disconnectOverlay) closeDisconnectConfirm();
  });
  disconnectOkBtn?.addEventListener('click', () => {
    Events.walletDisconnected();
    disconnectAGW();
    closeDisconnectConfirm();
    window.location.href = '/';
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && disconnectOverlay?.classList.contains('active')) {
      closeDisconnectConfirm();
    }
  });

  agwBtn.addEventListener('click', async () => {
    if (getWallet()) {
      openDisconnectConfirm();
      return;
    }
    agwBtn.textContent = 'Connecting…';
    agwBtn.disabled = true;
    try {
      await connectAGW();
      agwBtn.textContent = 'Sign in…';
      try {
        await signInWithAGW();
      } catch (sigErr) {
        console.warn('AGW sign-in rejected:', sigErr);
        disconnectAGW();
        updateAgwBtn();
        alert('Signature required to sign in. Please try again.');
        return;
      }
      updateAgwBtn();
      loadProgress(); // refresh map with wallet data
    } catch (err) {
      console.error('AGW connect error:', err);
      agwBtn.textContent = 'Connect Wallet';
      if (!hasInjectedWallet()) {
        alert('No wallet detected. Please install MetaMask or another browser wallet.');
      }
    } finally {
      agwBtn.disabled = false;
    }
  });

  const overlay = document.getElementById('popupOverlay');
  let currentPopupLevel = null;
  const popupPlayBtn = document.getElementById('popupPlay');

  const LIFE_HEART_FULL = '/assets/ui/lives/heart-full.png';
  const LIFE_HEART_ICE = '/assets/ui/lives/heart-ice.png';
  const LIFE_HEART_EMPTY = '/assets/ui/lives/heart-empty.png';

  function formatNextLifeCountdown(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    return `${h}h ${m}m ${sec}s`;
  }

  function renderLivesHud() {
    const { lives, frozenLives, total } = Inventory.getLives();
    const livesMax = Inventory.getMaxLives();
    const hudSlots = Inventory.getLivesHudSlotCount();

    const countEl = document.getElementById('livesCount');
    const rowEl = document.getElementById('livesHearts');
    const regenEl = document.getElementById('livesRegen');

    if (countEl) countEl.textContent = String(total);

    if (rowEl) {
      rowEl.innerHTML = '';
      const hasPass = Inventory.hasCrushPass();
      for (let slot = 1; slot <= hudSlots; slot++) {
        const filled = slot <= lives + frozenLives;
        const isIceSlot = slot > livesMax; // slots 4 & 5 are the frozen-heart zone
        const isLocked = !filled && isIceSlot && !hasPass;

        if (isLocked) {
          // Show a greyed-out heart with a lock badge; tooltip on hover
          const wrap = document.createElement('div');
          wrap.className = 'lives-hud__heart lives-hud__heart--locked';
          wrap.title = 'Unlock with Weekly Pass';
          wrap.setAttribute('data-tooltip', 'Unlock with Weekly Pass');
          const heartImg = document.createElement('img');
          heartImg.className = 'lives-hud__heart--locked-img';
          heartImg.src = LIFE_HEART_EMPTY;
          heartImg.draggable = false;
          heartImg.alt = '';
          wrap.appendChild(heartImg);
          rowEl.appendChild(wrap);
        } else {
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
    }

    if (regenEl) {
      if (lives >= livesMax) regenEl.textContent = 'Full!';
      else {
        const ms = Inventory.nextLifeRegenIn();
        regenEl.textContent =
          ms <= 0
            ? 'Next life soon…'
            : `Next life in: ${formatNextLifeCountdown(ms)}`;
      }
    }

    if (popupPlayBtn) {
      const inactive = total <= 0;
      popupPlayBtn.disabled = inactive;
      popupPlayBtn.classList.toggle('pop-play--disabled', inactive);
    }

    refreshCrushPassChrome();
  }

  function refreshCrushPassChrome() {
    const on = Inventory.hasCrushPass();
    document.getElementById('crushPassBtn')?.classList.toggle('crush-pass--active', on);
    document.getElementById('livesHud')?.classList.toggle('lives-hud--pass', on);
  }

  window.addEventListener('pengu:inventory', renderLivesHud);

  const livesBuyBtn = document.getElementById('livesBuyBtn');
  livesBuyBtn?.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('shopOverlay')?.classList.add('active');
  });

  setInterval(renderLivesHud, 1000);
  renderLivesHud();

  function openPopup(lv) {
    Events.levelPopupOpen(lv.id);
    currentPopupLevel = lv;
    const cfg = getLevel(lv.id);
    document.getElementById('popupLevelNum').textContent = lv.id;
    // The popup-frame art already has three empty stars baked in.
    // Only show a gold star on top for each EARNED star — leave the
    // slots without an earned star empty so the baked-in star shows
    // through cleanly.
    document.querySelectorAll('.pop-star').forEach((img, i) => {
      if (i < lv.stars) {
        img.src = '/assets/ui/star-gold.png';
        img.style.visibility = 'visible';
      } else {
        img.style.visibility = 'hidden';
      }
    });
    document.getElementById('popupTarget').textContent = cfg.targetScore.toLocaleString();
    document.getElementById('popupMoves').textContent = cfg.moves;
    document.getElementById('popupBest').textContent = lv.best > 0 ? lv.best.toLocaleString() : '\u2014';
    renderShardSlots(document.getElementById('popupShards'), { counts: Inventory.getShards(), variant: 'card' });
    overlay.classList.add('active');
    renderLivesHud();
  }

  function closePopup() { overlay.classList.remove('active'); currentPopupLevel = null; }

  document.getElementById('popupClose').addEventListener('click', closePopup);
  document.getElementById('popupBack').addEventListener('click', closePopup);
  overlay.addEventListener('click', e => { if (e.target === overlay) closePopup(); });
  popupPlayBtn?.addEventListener('click', () => {
    if (!currentPopupLevel) return;
    const { total } = Inventory.getLives();
    if (total <= 0) {
      alert('No lives left! Wait for the next free life or get more from the shop.');
      return;
    }
    if (!Inventory.consumeLife()) {
      alert('No lives left!');
      return;
    }
    window.__pengu.goToLevel(currentPopupLevel.id);
  });

  // Daily wheel (map screen)
  const dailyOverlay = document.getElementById('dailyWheelOverlay');
  const dailyOpen = document.getElementById('dailyWheelOpen');
  const dailyClose = document.getElementById('dailyWheelClose');
  const dailySpinEl = document.getElementById('dailyWheelSpin');
  const dailySpinBtn = document.getElementById('dailyWheelSpinBtn');
  const dailyResult = document.getElementById('dailyWheelResult');

  const DAILY_SEGMENTS = 6;
  const DAILY_SEGMENT_DEG = 360 / DAILY_SEGMENTS;
  /** Art has spokes at 12 o’clock; segment centers on bitmap are at 30° + i×60°. Base spin aligns slice 0 under pointer. */
  const DAILY_BASE_ROTATION_DEG = -30;
  /**
   * Index i = slice i (same as --i / data-slice). Clockwise from top, first slice center is ~30° on bitmap →
   * matches art order: 5 Gems, Try Again, 100 XP, 50 Coins, Ice Boost, 250 XP.
   */
  const DAILY_REWARDS = ['5 Gems', 'Try Again', '100 XP', '50 Coins', 'Ice Boost', '250 XP'];

  function formatDailyWheelResult(rewardText, effect) {
    const mult = effect.wheelMultiplier || 1;
    const passTag = mult > 1 ? ' (2× Crush Pass)' : '';
    if (effect.type === 'gems') return `You won: ${effect.amount} Gems${passTag}`;
    if (effect.type === 'coins') return `You won: ${effect.amount} Coins${passTag}`;
    if (effect.type === 'xp') return `You won: ${effect.amount} XP${passTag}`;
    if (effect.type === 'booster' && effect.boosterGrants?.length) {
      const tally = {};
      for (const id of effect.boosterGrants) tally[id] = (tally[id] || 0) + 1;
      const parts = Object.entries(tally).map(([id, n]) => `${n}× ${id}`);
      return `You won: Ice Boost → ${parts.join(', ')}${passTag}`;
    }
    return `You won: ${rewardText}${passTag}`;
  }

  function normDeg360(d) {
    return ((d % 360) + 360) % 360;
  }

  /** Segment center k on bitmap (degrees CW from top) before wheel rotation */
  function segmentCenterDeg(k) {
    return 30 + k * DAILY_SEGMENT_DEG;
  }

  /** Which slice index has its center nearest the pointer (top); must match spin math */
  function sliceIndexUnderPointer(rotationDeg) {
    const R = normDeg360(rotationDeg);
    let bestK = 0;
    let bestDist = 400;
    for (let k = 0; k < DAILY_SEGMENTS; k++) {
      const a = normDeg360(segmentCenterDeg(k) + R);
      const dist = Math.min(a, 360 - a);
      if (dist < bestDist) {
        bestDist = dist;
        bestK = k;
      }
    }
    return bestK;
  }

  document.querySelectorAll('.daily-wheel-slice[data-slice]').forEach(el => {
    const i = Number(el.dataset.slice);
    const label = el.querySelector('.daily-wheel-slice__label');
    if (label && Number.isInteger(i) && DAILY_REWARDS[i]) label.textContent = DAILY_REWARDS[i];
  });

  let dailyWheelRotation = DAILY_BASE_ROTATION_DEG;
  let dailySpinning = false;

  if (dailySpinEl) {
    dailySpinEl.style.transform = `rotate(${dailyWheelRotation}deg)`;
  }

  function openDailyWheel() {
    dailyOverlay?.classList.add('active');
    dailyOverlay?.setAttribute('aria-hidden', 'false');
  }

  function closeDailyWheel() {
    dailyOverlay?.classList.remove('active');
    dailyOverlay?.setAttribute('aria-hidden', 'true');
  }

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function formatSpinCooldown(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function refreshSpinButtonState() {
    if (!dailySpinBtn) return;
    const can = Inventory.canSpinDaily();
    dailySpinBtn.disabled = !can || dailySpinning;
    dailySpinBtn.textContent = can ? 'SPIN' : 'COME BACK TOMORROW';
    if (!can && dailyResult && !dailySpinning) {
      const wait = Inventory.nextSpinAvailableIn();
      const last = Inventory.getInventory().dailySpinHistory.slice(-1)[0];
      dailyResult.textContent = last
        ? `Already spun today — you won: ${last.reward}. Next spin in ${formatSpinCooldown(wait)}.`
        : `You can spin again in ${formatSpinCooldown(wait)}.`;
      dailyResult.hidden = false;
    }
  }

  function spinDailyWheel() {
    if (!dailySpinEl || dailySpinning) return;
    if (!Inventory.canSpinDaily()) {
      refreshSpinButtonState();
      return;
    }
    Events.wheelSpinStart();
    const targetIndex = Math.floor(Math.random() * DAILY_SEGMENTS);
    const spins = prefersReducedMotion() ? 1 : 5;
    const current = normDeg360(dailyWheelRotation);
    /** Final rotation (mod 360) so segment k center lines up with pointer: γ_k + R ≡ 0 ⇒ R ≡ −γ_k */
    const desiredRest = normDeg360(-segmentCenterDeg(targetIndex));
    let delta = spins * 360 + desiredRest - current;
    if (delta < DAILY_SEGMENT_DEG * 2) delta += 360;
    dailyWheelRotation += delta;

    dailySpinning = true;
    dailySpinBtn.disabled = true;
    if (dailyResult) {
      dailyResult.hidden = true;
      dailyResult.textContent = '';
    }

    const duration = prefersReducedMotion() ? 0.01 : 4;
    dailySpinEl.style.transition = `transform ${duration}s cubic-bezier(0.17, 0.67, 0.12, 0.99)`;
    dailySpinEl.style.transform = `rotate(${dailyWheelRotation}deg)`;

    const done = () => {
      dailySpinning = false;
      const won = sliceIndexUnderPointer(dailyWheelRotation);
      const rewardText = DAILY_REWARDS[won];
      // Fire chain spin in background — server-signed roll, no client tampering.
      // Local Inventory.applyDailyReward mirrors the effect for instant UI.
      chainSpinWheel().then(r => {
        if (r?.hash) console.log('🐧 daily wheel mined:', r.hash);
        Inventory.hydrateFromChain().catch(() => {});
      }).catch(err => {
        console.warn('🐧 daily wheel failed (non-fatal):', err?.message || err);
        Events.wheelSpinFail(String(err?.message || err).slice(0, 100));
      });
      const effect = Inventory.applyDailyReward(rewardText);
      Events.wheelSpinComplete(rewardText);
      if (dailyResult) {
        dailyResult.textContent = formatDailyWheelResult(rewardText, effect);
        dailyResult.hidden = false;
      }
      refreshSpinButtonState();
    };

    if (duration < 0.1) {
      done();
    } else {
      const onEnd = e => {
        if (e.propertyName && e.propertyName !== 'transform') return;
        clearTimeout(fallback);
        dailySpinEl.removeEventListener('transitionend', onEnd);
        done();
      };
      const fallback = setTimeout(() => {
        dailySpinEl.removeEventListener('transitionend', onEnd);
        done();
      }, duration * 1000 + 400);
      dailySpinEl.addEventListener('transitionend', onEnd);
    }
  }

  dailyOpen?.addEventListener('click', e => {
    e.stopPropagation();
    Events.wheelOpen();
    openDailyWheel();
    refreshSpinButtonState();
  });
  dailyClose?.addEventListener('click', () => closeDailyWheel());
  dailyOverlay?.querySelector('.daily-wheel-overlay__backdrop')?.addEventListener('click', () => closeDailyWheel());
  dailySpinBtn?.addEventListener('click', () => spinDailyWheel());

  // Weekly Crush Pass (map screen)
  const crushPassBtn = document.getElementById('crushPassBtn');
  const crushPassOverlay = document.getElementById('crushPassOverlay');
  const crushPassTicket = document.getElementById('crushPassTicket');
  const crushPassTimer = document.getElementById('crushPassTimer');
  const crushPassBurst = document.getElementById('crushPassBurst');
  const crushPassFlyTarget = document.getElementById('crushPassFlyTarget');
  const crushPassBoostersRow = document.getElementById('crushPassBoostersRow');
  const crushPassRewardLabel = document.getElementById('crushPassRewardLabel');
  const crushPassHint = document.getElementById('crushPassHint');
  const crushPassManageRow = document.getElementById('crushPassManageRow');
  const crushPassRenewBtn = document.getElementById('crushPassRenewBtn');
  const crushPassCancelSubscriptionBtn = document.getElementById('crushPassCancelSubscriptionBtn');
  const crushPassPurchaseOverlay = document.getElementById('crushPassPurchaseOverlay');
  const crushPassBuyBtn = document.getElementById('crushPassBuyBtn');
  const crushPassCancelPurchaseBtn = document.getElementById('crushPassCancelPurchaseBtn');
  const crushPassPurchaseCard = document.getElementById('crushPassPurchaseCard');

  let crushPassAnimating = false;
  /** Reward payload waiting for user to "crack open" the ticket after purchase. */
  let crushPassPendingReward = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let crushPassTimerInterval = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let crushPassSplitT = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let crushPassBurstT = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let crushPassFlyT = null;
  /** @type {((e: TransitionEvent) => void) | null} */
  let crushPassFlyTransitionEnd = null;

  function clearCrushPassTimeouts() {
    if (crushPassSplitT) clearTimeout(crushPassSplitT);
    if (crushPassBurstT) clearTimeout(crushPassBurstT);
    if (crushPassFlyT) clearTimeout(crushPassFlyT);
    crushPassSplitT = crushPassBurstT = crushPassFlyT = null;
    if (crushPassFlyTransitionEnd && crushPassFlyTarget) {
      crushPassFlyTarget.removeEventListener('transitionend', crushPassFlyTransitionEnd);
      crushPassFlyTransitionEnd = null;
    }
  }

  function formatCrushPassActiveCountdown(ms) {
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${Math.max(1, m)}m`;
  }

  function openCrushPassPurchaseOverlay() {
    crushPassPurchaseOverlay?.classList.add('active');
    crushPassPurchaseOverlay?.setAttribute('aria-hidden', 'false');
  }

  function closeCrushPassPurchaseOverlay() {
    crushPassPurchaseOverlay?.classList.remove('active');
    crushPassPurchaseOverlay?.setAttribute('aria-hidden', 'true');
  }

  function renderCrushPassTimer() {
    if (!crushPassTimer) return;
    if (Inventory.hasCrushPass()) {
      const ms = Inventory.crushPassExpiresIn();
      crushPassTimer.textContent = `Pass active — expires in ${formatCrushPassActiveCountdown(ms)}`;
    } else {
      crushPassTimer.textContent = 'Tap to get this week\'s pass!';
    }
    updateCrushPassHint();
  }

  function updateCrushPassHint() {
    if (!crushPassHint) return;
    const show = !!crushPassPendingReward && !crushPassAnimating;
    crushPassHint.classList.toggle('crush-pass-hint--active', show);
    crushPassHint.setAttribute('aria-hidden', show ? 'false' : 'true');
    const priceEl = crushPassHint.querySelector('.crush-pass-hint__price');
    if (priceEl) priceEl.textContent = show ? 'Tap!' : '$4.99';
  }

  function resetCrushPassUI() {
    crushPassAnimating = false;
    // NOTE: crushPassPendingReward is intentionally NOT cleared here so that
    // openCrushPassOverlay can inspect it after calling resetCrushPassUI.
    crushPassOverlay?.classList.remove('crush-pass-overlay--burst');
    crushPassTicket?.classList.remove('crush-pass-ticket--shake', 'crush-pass-ticket--split');
    crushPassBurst?.classList.remove('crush-pass-burst--active');
    crushPassBurst?.setAttribute('aria-hidden', 'true');
    crushPassFlyTarget?.classList.remove('crush-pass-burst__pile--fly');
    crushPassFlyTarget?.style.removeProperty('--crush-fly-x');
    crushPassFlyTarget?.style.removeProperty('--crush-fly-y');
    crushPassFlyTarget?.style.removeProperty('opacity');
    if (crushPassBoostersRow) crushPassBoostersRow.innerHTML = '';
    if (crushPassRewardLabel) crushPassRewardLabel.textContent = '';
    updateCrushPassHint();
  }

  function openCrushPassOverlay() {
    if (!crushPassOverlay) return;
    clearCrushPassTimeouts();
    resetCrushPassUI();
    const hasPending = !!crushPassPendingReward;
    const active = Inventory.hasCrushPass();
    // Manage-row visible only when pass is active and no unclaimed reward is waiting
    if (crushPassManageRow) crushPassManageRow.hidden = !active || hasPending;
    // Hide the $4.99 hint banner only when active and nothing to claim
    crushPassHint?.classList.toggle('crush-pass-hint--hidden', active && !hasPending);
    crushPassOverlay.classList.add('active');
    crushPassOverlay.setAttribute('aria-hidden', 'false');
    renderCrushPassTimer();
    if (crushPassTimerInterval) clearInterval(crushPassTimerInterval);
    crushPassTimerInterval = setInterval(() => {
      if (crushPassOverlay?.classList.contains('active')) renderCrushPassTimer();
    }, 60000);
  }

  function closeCrushPassOverlay() {
    clearCrushPassTimeouts();
    crushPassPendingReward = null; // discard unclaimed reward if user dismisses
    if (crushPassTimerInterval) {
      clearInterval(crushPassTimerInterval);
      crushPassTimerInterval = null;
    }
    crushPassOverlay?.classList.remove('active');
    crushPassOverlay?.setAttribute('aria-hidden', 'true');
    crushPassHint?.classList.remove('crush-pass-hint--hidden');
    if (crushPassManageRow) crushPassManageRow.hidden = true;
    resetCrushPassUI();
  }

  function scheduleCrushPassRewardFly() {
    const invBtn = document.getElementById('inventoryMapOpen');
    const flyEl = crushPassFlyTarget;
    if (!flyEl || !invBtn) {
      closeCrushPassOverlay();
      return;
    }
    const runFly = () => {
      const ir = flyEl.getBoundingClientRect();
      const tr = invBtn.getBoundingClientRect();
      const dx = tr.left + tr.width / 2 - (ir.left + ir.width / 2);
      const dy = tr.top + tr.height / 2 - (ir.top + ir.height / 2);
      flyEl.style.setProperty('--crush-fly-x', `${dx}px`);
      flyEl.style.setProperty('--crush-fly-y', `${dy}px`);
      void flyEl.offsetWidth;
      let flyFinished = false;
      const finishFly = () => {
        if (flyFinished) return;
        flyFinished = true;
        if (crushPassFlyT) {
          clearTimeout(crushPassFlyT);
          crushPassFlyT = null;
        }
        if (crushPassFlyTransitionEnd) {
          flyEl.removeEventListener('transitionend', crushPassFlyTransitionEnd);
          crushPassFlyTransitionEnd = null;
        }
        closeCrushPassOverlay();
      };
      crushPassFlyTransitionEnd = e => {
        if (e.target !== flyEl || e.propertyName !== 'transform') return;
        finishFly();
      };
      flyEl.addEventListener('transitionend', crushPassFlyTransitionEnd);
      /** Fallback if transitionend does not fire (tab hidden, reduced motion quirks). */
      crushPassFlyT = setTimeout(finishFly, 900);
      flyEl.classList.add('crush-pass-burst__pile--fly');
    };
    requestAnimationFrame(() => requestAnimationFrame(runFly));
  }

  /**
   * @param {{ boosters: Array<{ icon: string, label: string, count: number }>, shardBonus?: { icon: string, label: string } | null, label: string }} reward
   */
  function renderCrushPassBurstReward(reward) {
    if (!crushPassBoostersRow || !reward.boosters) return;
    crushPassBoostersRow.innerHTML = '';
    for (const b of reward.boosters) {
      const pill = document.createElement('div');
      pill.className = 'crush-pass-booster-pill';
      pill.title = b.label;
      const img = document.createElement('img');
      img.className = 'crush-pass-booster-pill__icon';
      img.src = b.icon;
      img.alt = b.label;
      img.draggable = false;
      const qty = document.createElement('span');
      qty.className = 'crush-pass-booster-pill__qty';
      qty.textContent = `×${b.count}`;
      pill.appendChild(img);
      pill.appendChild(qty);
      crushPassBoostersRow.appendChild(pill);
    }
    if (reward.shardBonus) {
      const sb = reward.shardBonus;
      const pill = document.createElement('div');
      pill.className = 'crush-pass-booster-pill crush-pass-booster-pill--shard';
      pill.title = sb.label;
      const img = document.createElement('img');
      img.className = 'crush-pass-booster-pill__icon';
      img.src = sb.icon;
      img.alt = sb.label;
      img.draggable = false;
      const qty = document.createElement('span');
      qty.className = 'crush-pass-booster-pill__qty';
      qty.textContent = '×1';
      pill.appendChild(img);
      pill.appendChild(qty);
      crushPassBoostersRow.appendChild(pill);
    }
  }

  function startCrushPassRewardCelebration(reward) {
    if (!reward) return;
    crushPassAnimating = true;
    if (crushPassManageRow) crushPassManageRow.hidden = true;
    updateCrushPassHint();
    renderCrushPassBurstReward(reward);
    if (crushPassRewardLabel) crushPassRewardLabel.textContent = reward.label;
    crushPassBurst?.classList.add('crush-pass-burst--active');
    crushPassBurst?.setAttribute('aria-hidden', 'false');
    crushPassOverlay?.classList.add('crush-pass-overlay--burst');
    renderCrushPassTimer();

    const CRUSH_PASS_HOLD_BEFORE_FLY_MS = 2200;
    crushPassBurstT = setTimeout(() => {
      crushPassBurstT = null;
      scheduleCrushPassRewardFly();
    }, CRUSH_PASS_HOLD_BEFORE_FLY_MS);
  }

  function shakeTicket() {
    if (!crushPassTicket) return;
    crushPassTicket.classList.remove('crush-pass-ticket--shake');
    crushPassTicket.offsetHeight; // reflow to restart animation
    crushPassTicket.classList.add('crush-pass-ticket--shake');
    setTimeout(() => crushPassTicket?.classList.remove('crush-pass-ticket--shake'), 620);
  }

  function handleCrushPassTicketActivate() {
    if (!crushPassTicket || crushPassAnimating) return;

    if (crushPassPendingReward) {
      // Tear the ticket open and celebrate!
      const reward = crushPassPendingReward;
      crushPassPendingReward = null;
      crushPassAnimating = true;
      updateCrushPassHint(); // hides the "Tap!" arrow now
      crushPassTicket.classList.add('crush-pass-ticket--split');
      crushPassSplitT = setTimeout(() => {
        crushPassSplitT = null;
        startCrushPassRewardCelebration(reward);
      }, 550);
      return;
    }

    // No pending reward — just a friendly shake to show "nothing to do right now"
    shakeTicket();
  }

  crushPassBtn?.addEventListener('click', e => {
    e.stopPropagation();
    Events.passOpen();
    if (Inventory.hasCrushPass()) openCrushPassOverlay();
    else openCrushPassPurchaseOverlay();
  });
  crushPassOverlay?.querySelector('.crush-pass-overlay__backdrop')?.addEventListener('click', () => {
    closeCrushPassOverlay();
  });
  crushPassPurchaseOverlay?.querySelector('.crush-pass-purchase-overlay__backdrop')?.addEventListener('click', () => {
    closeCrushPassPurchaseOverlay();
  });
  crushPassBuyBtn?.addEventListener('click', async e => {
    e.stopPropagation();
    if (crushPassBuyBtn.disabled) return;
    crushPassBuyBtn.disabled = true;
    const origText = crushPassBuyBtn.textContent;
    crushPassBuyBtn.textContent = 'Confirm payment…';
    Events.passBuyStart();
    try {
      const r = await buyCrushPassETH();
      await Inventory.hydrateFromChain().catch(() => {});
      const reward = Inventory.purchaseCrushPass();
      if (!reward) return;
      Events.passBuySuccess(r?.hash);
      if (reward.shardBonus?.id) Events.passShardBonus(reward.shardBonus.id);
      closeCrushPassPurchaseOverlay();
      refreshCrushPassChrome();
      crushPassPendingReward = reward;
      openCrushPassOverlay();
      requestAnimationFrame(() => {
        shakeTicket();
        setTimeout(shakeTicket, 900);
      });
    } catch (err) {
      const msg = String(err?.shortMessage || err?.message || err).slice(0, 100);
      console.warn('Crush Pass purchase failed:', msg);
      Events.passBuyFail(msg);
      alert('Pass purchase failed — see console.');
    } finally {
      crushPassBuyBtn.textContent = origText;
      crushPassBuyBtn.disabled = false;
    }
  });
  crushPassCancelPurchaseBtn?.addEventListener('click', e => {
    e.stopPropagation();
    closeCrushPassPurchaseOverlay();
  });
  crushPassPurchaseCard?.addEventListener('click', () => {
    crushPassPurchaseCard.classList.remove('crush-pass-purchase-card--shake');
    void crushPassPurchaseCard.offsetWidth; // reflow to restart animation
    crushPassPurchaseCard.classList.add('crush-pass-purchase-card--shake');
    setTimeout(() => crushPassPurchaseCard?.classList.remove('crush-pass-purchase-card--shake'), 620);
  });
  crushPassRenewBtn?.addEventListener('click', e => {
    e.stopPropagation();
    closeCrushPassOverlay();
    openCrushPassPurchaseOverlay();
  });
  crushPassCancelSubscriptionBtn?.addEventListener('click', e => {
    e.stopPropagation();
    Inventory.cancelCrushPass();
    Events.passCancelled();
    refreshCrushPassChrome();
    closeCrushPassOverlay();
  });
  crushPassTicket?.addEventListener('click', e => {
    e.stopPropagation();
    handleCrushPassTicketActivate();
  });
  crushPassTicket?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleCrushPassTicketActivate();
    }
  });

  // Inventory popup (map screen)
  const inventoryOverlay = document.getElementById('inventoryOverlay');
  const inventoryOpen = document.getElementById('inventoryMapOpen');
  const inventoryClose = document.getElementById('inventoryClose');
  const inventoryGrid = document.getElementById('inventoryGrid');

  function renderInventoryGrid() {
    if (!inventoryGrid) return;
    const boosters = Inventory.getAllBoosters();
    const shards = Inventory.getShards();
    inventoryGrid.innerHTML = '';
    for (const def of INVENTORY_MAP_SLOTS) {
      const cell = document.createElement('div');
      cell.className = 'inventory-slot';
      cell.title = def.label;
      const icon = document.createElement('img');
      icon.className = 'inventory-slot__icon';
      icon.src = def.icon;
      icon.alt = def.label;
      icon.draggable = false;
      const qty = document.createElement('span');
      qty.className = 'inventory-slot__qty';
      const n = def.kind === 'booster' ? (boosters[def.id] ?? 0) : (shards[def.id] ?? 0);
      qty.textContent = `×${n}`;
      cell.appendChild(icon);
      cell.appendChild(qty);
      inventoryGrid.appendChild(cell);
    }
  }

  function openInventory() {
    renderInventoryGrid();
    inventoryOverlay?.classList.add('active');
    inventoryOverlay?.setAttribute('aria-hidden', 'false');
  }

  function closeInventory() {
    inventoryOverlay?.classList.remove('active');
    inventoryOverlay?.setAttribute('aria-hidden', 'true');
  }

  inventoryOpen?.addEventListener('click', e => {
    e.stopPropagation();
    Events.inventoryOpen();
    openInventory();
  });
  inventoryClose?.addEventListener('click', () => closeInventory());
  inventoryOverlay?.querySelector('.inventory-overlay__backdrop')?.addEventListener('click', () => closeInventory());
  Inventory.onInventoryChange(() => {
    if (inventoryOverlay?.classList.contains('active')) renderInventoryGrid();
    if (crushPassOverlay?.classList.contains('active')) renderCrushPassTimer();
    refreshCrushPassChrome();
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (inventoryOverlay?.classList.contains('active')) {
      closeInventory();
      return;
    }
    if (crushPassPurchaseOverlay?.classList.contains('active')) {
      closeCrushPassPurchaseOverlay();
      return;
    }
    if (crushPassOverlay?.classList.contains('active')) {
      closeCrushPassOverlay();
      return;
    }
    if (dailyOverlay?.classList.contains('active')) {
      closeDailyWheel();
      return;
    }
    if (overlay.classList.contains('active')) closePopup();
  });

  // Load progress and render
  const nodes = loadProgress();
  findCurrentLevel(nodes);
  renderNodes(nodes, nodesContainer, openPopup);

  // Async sync from Supabase (merges cloud data if better)
  syncFromSupabase(nodes, nodesContainer, openPopup);

  // DEV TOOLS
  let dragging = null;
  document.addEventListener('mousedown', e => {
    if (!e.shiftKey) return;
    const node = e.target.closest('.level-node');
    if (!node) return;
    e.preventDefault(); dragging = node; node.style.zIndex = '999';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = nodesContainer.getBoundingClientRect();
    dragging.style.left = ((e.clientX - rect.left) / rect.width * 100).toFixed(1) + '%';
    dragging.style.top = ((e.clientY - rect.top) / rect.height * 100).toFixed(1) + '%';
  });
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging.style.zIndex = '';
      console.log('Level ' + dragging.dataset.level + ' -> x: ' + parseFloat(dragging.style.left).toFixed(1) + ', y: ' + parseFloat(dragging.style.top).toFixed(1));
      dragging = null;
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'd' || e.key === 'D') {
      console.log('-- Positions --');
      nodesContainer.querySelectorAll('.level-node').forEach(n =>
        console.log('  { id: ' + n.dataset.level + ', x: ' + parseFloat(n.style.left).toFixed(1) + ', y: ' + parseFloat(n.style.top).toFixed(1) + ' },')
      );
    }
  });
}
