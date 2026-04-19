import { getLevel, getLevelCount } from './levels.js';
import { getWallet, fetchPlayerProgress, buildMapProgress, connectAGW, disconnectAGW, shortAddress, hasInjectedWallet } from './supabase.js';

const IMG_W = 2000, IMG_H = 1116;
const IMG_RATIO = IMG_W / IMG_H;

// Node positions on the map artwork (x/y percentages)
const NODE_POSITIONS = [
  { id: 1,  x: 11.8, y: 87.9 },
  { id: 2,  x: 21.3, y: 84.9 },
  { id: 3,  x: 29.7, y: 81.7 },
  { id: 4,  x: 34.9, y: 73.3 },
  { id: 5,  x: 21.8, y: 61.0 },
  { id: 6,  x: 16.0, y: 52.1 },
  { id: 7,  x: 21.1, y: 42.7 },
  { id: 8,  x: 29.2, y: 39.9 },
  { id: 9,  x: 38.4, y: 41.8 },
  { id: 10, x: 46.0, y: 47.8 },
  { id: 11, x: 52.5, y: 55.9 },
  { id: 12, x: 63.5, y: 73.9 },
  { id: 13, x: 71.5, y: 79.9 },
  { id: 14, x: 79.8, y: 81.0 },
  { id: 15, x: 87.8, y: 76.7 },
  { id: 16, x: 90.8, y: 64.0 },
  { id: 17, x: 84.8, y: 54.5 },
  { id: 18, x: 76.8, y: 49.4 },
  { id: 19, x: 71.3, y: 42.4 },
  { id: 20, x: 75.4, y: 34.4 },
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

    if (lv.status === 'locked') {
      const lock = document.createElement('span');
      lock.className = 'lock-icon';
      lock.textContent = '\u{1F512}';
      node.appendChild(lock);
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

  function resizeStage() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.max(vw, vh * IMG_RATIO);
    const h = Math.max(vh, vw / IMG_RATIO);
    stage.style.setProperty('--scene-w', w + 'px');
    stage.style.setProperty('--scene-h', h + 'px');
  }
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
  agwBtn.addEventListener('click', async () => {
    if (getWallet()) {
      disconnectAGW();
      updateAgwBtn();
      return;
    }
    agwBtn.textContent = 'Connecting…';
    agwBtn.disabled = true;
    try {
      await connectAGW();
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
    document.querySelectorAll('.pop-star').forEach((img, i) => {
      img.src = i < lv.stars ? '/assets/ui/star-gold.png' : '/assets/ui/star-empty.png';
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

  function spinDailyWheel() {
    if (!dailySpinEl || dailySpinning) return;
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
      dailySpinBtn.disabled = false;
      if (dailyResult) {
        const won = sliceIndexUnderPointer(dailyWheelRotation);
        dailyResult.textContent = `You won: ${DAILY_REWARDS[won]}`;
        dailyResult.hidden = false;
      }
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
