import { getLevel, getLevelCount } from './levels.js';
import { getWallet, fetchPlayerProgress, buildMapProgress, connectAGW, disconnectAGW, shortAddress, hasInjectedWallet, signInWithAGW, isSignedIn } from './supabase.js';
import * as Inventory from './inventory.js';

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

  function openPopup(lv) {
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
    overlay.classList.add('active');
  }

  function closePopup() { overlay.classList.remove('active'); currentPopupLevel = null; }

  document.getElementById('popupClose').addEventListener('click', closePopup);
  document.getElementById('popupBack').addEventListener('click', closePopup);
  overlay.addEventListener('click', e => { if (e.target === overlay) closePopup(); });
  document.getElementById('popupPlay').addEventListener('click', () => {
    if (currentPopupLevel) window.__pengu.goToLevel(currentPopupLevel.id);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopup(); });

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
      const effect = Inventory.applyDailyReward(rewardText);
      if (dailyResult) {
        let suffix = '';
        if (effect.type === 'booster') suffix = ` (+1 ${effect.booster})`;
        dailyResult.textContent = `You won: ${rewardText}${suffix}`;
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
    openDailyWheel();
    refreshSpinButtonState();
  });
  dailyClose?.addEventListener('click', () => closeDailyWheel());
  dailyOverlay?.querySelector('.daily-wheel-overlay__backdrop')?.addEventListener('click', () => closeDailyWheel());
  dailySpinBtn?.addEventListener('click', () => spinDailyWheel());

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && dailyOverlay?.classList.contains('active')) {
      closeDailyWheel();
    }
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
