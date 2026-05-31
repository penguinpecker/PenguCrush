import { getLevel, getLevelCount, getObjectiveChip, formatLevelObjective } from './levels.js';
import { getWallet, fetchPlayerProgress, buildMapProgress, connectAGW, disconnectAGW, shortAddress, hasInjectedWallet, signInWithAGW, isSignedIn } from './supabase.js';
import * as Inventory from './inventory.js';
import { renderShardSlots, SHARDS } from './shards.js';
import { buyCrushPassETH, spinDailyWheel as chainSpinWheel, claimStarterPack, readStarterPackClaimed, PENGUCRUSH_ADDRESS } from './onchain.js';
import {
  getDailyWheelSliceLabels,
  decodeDailySpinFromReceipt,
} from './wheel.js';
import { getPublicClient } from './agw.js';
import { formatEther } from 'viem';
import penguCrushAbiJson from '../contracts/PenguCrushABI.json';
import { Events, setAnalyticsUser } from './analytics.js';
import { renderLivesHud } from './lives-hud.js';
import { playSfx, playSfxLoop } from './audio.js';

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
      else if (p.unlocked && pos.id > 1 && (saved[pos.id - 1]?.stars || 0) > 0) status = 'current';
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

/// Pull per-level best results straight from chain (PenguCrushV2.bestResults)
/// and merge into the localStorage progress cache, then re-render the map.
/// This is the authoritative path — runs on every map load alongside the
/// Supabase mirror sync so a fresh device / cleared cache / new session
/// still shows the player's actual progress.
async function hydrateProgressFromChain(nodes, nodesContainer, openPopup) {
  const wallet = getWallet();
  if (!wallet) return;
  const abi = Array.isArray(penguCrushAbiJson) ? penguCrushAbiJson : (penguCrushAbiJson.abi || []);
  try {
    const client = getPublicClient();
    const results = await Promise.all(NODE_POSITIONS.map(pos =>
      client.readContract({
        address: PENGUCRUSH_ADDRESS,
        abi,
        functionName: 'getBestResult',
        args: [wallet, pos.id],
      }).catch(() => null)
    ));
    const local = JSON.parse(localStorage.getItem('pengucrush_progress') || '{}');
    let changed = false;
    for (let i = 0; i < NODE_POSITIONS.length; i++) {
      const r = results[i];
      if (!r) continue;
      // Treat any non-zero level field as "this row has been written".
      const lvl = Number(r.level ?? r[0] ?? 0);
      if (lvl === 0) continue;
      const stars = Number(r.stars ?? r[2] ?? 0);
      const best = Number(r.score ?? r[1] ?? 0);
      const cur = local[lvl] || { stars: 0, best: 0 };
      if (stars > cur.stars || best > cur.best) {
        local[lvl] = { stars: Math.max(cur.stars, stars), best: Math.max(cur.best, best) };
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem('pengucrush_progress', JSON.stringify(local));
      nodesContainer.innerHTML = '';
      const fresh = loadProgress();
      findCurrentLevel(fresh);
      renderNodes(fresh, nodesContainer, openPopup);
    }
  } catch (err) {
    console.warn('Chain progress hydrate failed:', err?.shortMessage || err?.message || err);
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

  // Starter pack claim is now handled lazily inside startLevelWithSetup
  // (batched with the first startLevel call into one popup). Previously
  // this block fired claimStarterPack() from a non-gesture async chain
  // on EVERY map mount — which was both a ghost popup attempt (no user
  // gesture, so Privy throws "Failed to initialize request") AND
  // redundant with the batched flow. Removed entirely.

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

  // ── Wallet dialog (balance, copy address, disconnect) ──
  const disconnectOverlay = document.getElementById('disconnectConfirm');
  const disconnectCancelBtn = document.getElementById('disconnectCancel');
  const disconnectOkBtn = document.getElementById('disconnectOk');
  const walletDialogAddress = document.getElementById('walletDialogAddress');
  const walletDialogBalance = document.getElementById('walletDialogBalance');
  const walletDialogCopy = document.getElementById('walletDialogCopy');

  function formatEthBalance(wei) {
    const eth = formatEther(wei);
    const n = Number(eth);
    if (!Number.isFinite(n)) return `${eth} ETH`;
    if (n === 0) return '0 ETH';
    if (n < 0.0001) return '<0.0001 ETH';
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH`;
  }

  async function copyWalletAddress(addr) {
    if (!addr) return false;
    try {
      await navigator.clipboard.writeText(addr);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = addr;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  function openWalletDialog() {
    disconnectOverlay?.classList.add('active');
    disconnectOverlay?.setAttribute('aria-hidden', 'false');
  }
  function closeWalletDialog() {
    disconnectOverlay?.classList.remove('active');
    disconnectOverlay?.setAttribute('aria-hidden', 'true');
    if (walletDialogCopy) walletDialogCopy.textContent = 'Copy';
  }

  async function refreshWalletDialog() {
    const addr = getWallet();
    if (!addr) return;
    if (walletDialogAddress) walletDialogAddress.textContent = addr;
    if (walletDialogBalance) walletDialogBalance.textContent = 'Loading…';
    openWalletDialog();
    try {
      const bal = await getPublicClient().getBalance({ address: addr });
      if (walletDialogBalance) walletDialogBalance.textContent = formatEthBalance(bal);
    } catch (err) {
      console.warn('[wallet] balance fetch failed:', err?.message || err);
      if (walletDialogBalance) walletDialogBalance.textContent = 'Unavailable';
    }
  }

  disconnectCancelBtn?.addEventListener('click', closeWalletDialog);
  disconnectOverlay?.addEventListener('click', e => {
    if (e.target === disconnectOverlay) closeWalletDialog();
  });
  walletDialogCopy?.addEventListener('click', async () => {
    const addr = getWallet();
    const ok = await copyWalletAddress(addr);
    if (!walletDialogCopy) return;
    walletDialogCopy.textContent = ok ? 'Copied!' : 'Copy failed';
    if (ok) {
      window.setTimeout(() => {
        if (walletDialogCopy.textContent === 'Copied!') walletDialogCopy.textContent = 'Copy';
      }, 1600);
    }
  });
  disconnectOkBtn?.addEventListener('click', () => {
    Events.walletDisconnected();
    disconnectAGW();
    closeWalletDialog();
    window.location.href = '/';
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && disconnectOverlay?.classList.contains('active')) {
      closeWalletDialog();
    }
  });

  agwBtn.addEventListener('click', async () => {
    if (getWallet()) {
      refreshWalletDialog();
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
  const popupPlayBtn = document.getElementById('popupPlay');

  function renderMapLivesHud() {
    renderLivesHud({ playBtn: popupPlayBtn });
    refreshCrushPassChrome();
  }

  function refreshCrushPassChrome() {
    const on = Inventory.hasCrushPass();
    document.getElementById('crushPassBtn')?.classList.toggle('crush-pass--active', on);
    document.getElementById('livesHud')?.classList.toggle('lives-hud--pass', on);
  }

  window.addEventListener('pengu:inventory', renderMapLivesHud);

  const livesBuyBtn = document.getElementById('livesBuyBtn');
  livesBuyBtn?.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('shopOverlay')?.classList.add('active');
  });

  setInterval(renderMapLivesHud, 1000);
  renderMapLivesHud();

  function renderPopupObjective(cfg) {
    const row = document.getElementById('popupObjectiveRow');
    if (!row) return;
    const chip = getObjectiveChip(cfg);
    if (!chip) {
      row.hidden = true;
      row.innerHTML = '';
      return;
    }
    const text = formatLevelObjective(cfg)
      || (chip.target != null ? `${chip.label} · 0/${chip.target}` : chip.label);
    row.hidden = false;
    row.innerHTML = `
      <div class="pop-goal-chip">
        <img class="pop-goal-chip__icon" src="${chip.icon}" alt="" draggable="false" />
        <span class="pop-goal-chip__progress">${text}</span>
      </div>
    `;
  }

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
    renderPopupObjective(cfg);
    document.getElementById('popupBest').textContent = lv.best > 0 ? lv.best.toLocaleString() : '\u2014';
    // Show shards earned FROM THIS LEVEL specifically (cumulative across
    // past runs of this level). Lifetime totals across every level live in
    // the dedicated inventory popup.
    renderShardSlots(document.getElementById('popupShards'), {
      counts: Inventory.getLevelShards(lv.id),
      variant: 'card',
    });
    overlay.classList.add('active');
    renderMapLivesHud();
  }

  function closePopup() { overlay.classList.remove('active'); currentPopupLevel = null; }

  document.getElementById('popupClose').addEventListener('click', closePopup);
  document.getElementById('popupBack').addEventListener('click', closePopup);
  overlay.addEventListener('click', e => { if (e.target === overlay) closePopup(); });
  popupPlayBtn?.addEventListener('click', async () => {
    if (!currentPopupLevel) return;
    if (popupPlayBtn.disabled) return;
    const { total } = Inventory.getLives();
    if (total <= 0) {
      alert('No lives left! Wait for the next free life or get more from the shop.');
      return;
    }
    // Fire chainStartLevel BEFORE navigating. The chain consumes the life
    // + emits LevelStarted. Only after the receipt lands do we navigate to
    // the play page. If it reverts (no lives / no gas / cancelled) we
    // STAY on the map and surface the reason — no client-side state goes
    // out of sync because we never optimistically decremented.
    const origLabel = popupPlayBtn.textContent;
    popupPlayBtn.disabled = true;
    popupPlayBtn.classList.add('pop-play--disabled');
    if (origLabel) popupPlayBtn.textContent = 'Confirming…';
    try {
      // startLevelWithSetup: returning players get a plain startLevel tx;
      // brand-new players (starter pack not yet claimed) get a SINGLE
      // batched tx that fires claimStarterPack + startLevel atomically.
      // Either way the player only sees one popup at this step.
      const { startLevelWithSetup } = await import('./onchain.js');
      const result = await startLevelWithSetup(currentPopupLevel.id);
      // Defense in depth: throws on revert already, but guard against a
      // future code path that resolves without an actual receipt.
      if (!result?.hash || !/^0x[0-9a-fA-F]+$/.test(result.hash)) {
        throw new Error(`startLevel returned no tx hash (got ${JSON.stringify(result)})`);
      }
      console.info('[map-play] startLevel confirmed', result.hash, 'via', result.used);
      await Inventory.hydrateFromChain().catch(() => {});
      window.__pengu.goToLevel(currentPopupLevel.id);
    } catch (err) {
      console.warn('startLevel failed:', err?.shortMessage || err?.message || err);
      const { alertFriendly, friendlyError } = await import('./errors.js');
      const { cta } = friendlyError(err);
      alertFriendly(err, 'Could not start this level on chain.');
      if (cta === 'lives') {
        await Inventory.hydrateFromChain().catch(() => {});
        renderMapLivesHud();
      }
      popupPlayBtn.disabled = false;
      popupPlayBtn.classList.remove('pop-play--disabled');
      if (origLabel) popupPlayBtn.textContent = origLabel;
    }
  });

  // Daily wheel (map screen)
  const dailyOverlay = document.getElementById('dailyWheelOverlay');
  const dailyOpen = document.getElementById('dailyWheelOpen');
  const dailyClose = document.getElementById('dailyWheelClose');
  const dailySpinEl = document.getElementById('dailyWheelSpin');
  const dailySpinBtn = document.getElementById('dailyWheelSpinBtn');
  const dailyResult = document.getElementById('dailyWheelResult');
  const dailyAlertDot = document.getElementById('dailyWheelAlertDot');
  const wheelWinBurst = document.getElementById('wheelWinBurst');
  const wheelWinLabel = document.getElementById('wheelWinLabel');
  const wheelWinConfetti = document.getElementById('wheelWinConfetti');

  function refreshWheelAlertDot() {
    if (!dailyAlertDot) return;
    const canSpin = Inventory.canSpinDaily();
    dailyAlertDot.hidden = !canSpin;
  }

  const CONFETTI_COLORS = [
    '#ff3b30','#ff9500','#ffcc00','#34c759','#007aff','#af52de','#ff2d55','#5ac8fa','#fff'
  ];

  function spawnWheelConfetti() {
    if (!wheelWinConfetti) return;
    wheelWinConfetti.innerHTML = '';
    const count = 80;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'wheel-win-burst__confetti-piece';
      el.style.left = `${Math.random() * 100}%`;
      el.style.width = `${6 + Math.random() * 8}px`;
      el.style.height = `${6 + Math.random() * 8}px`;
      el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      el.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      el.style.setProperty('--fall-dur', `${1.4 + Math.random() * 1.4}s`);
      el.style.setProperty('--fall-delay', `${Math.random() * 0.8}s`);
      el.style.setProperty('--rot', `${(Math.random() > 0.5 ? 1 : -1) * (180 + Math.floor(Math.random() * 360))}deg`);
      wheelWinConfetti.appendChild(el);
    }
  }

  let _wheelWinTimer = null;

  function clearWheelWinCelebration() {
    if (_wheelWinTimer !== null) { clearTimeout(_wheelWinTimer); _wheelWinTimer = null; }
    if (wheelWinBurst) {
      wheelWinBurst.classList.remove('wheel-win-burst--active');
      wheelWinBurst.setAttribute('aria-hidden', 'true');
    }
  }

  function showWheelWinCelebration(prizeText) {
    if (!wheelWinBurst || !wheelWinLabel) return;
    clearWheelWinCelebration(); // cancel any stale timer from a previous win
    wheelWinLabel.textContent = `🎉 ${prizeText}!`;
    spawnWheelConfetti();
    wheelWinBurst.classList.add('wheel-win-burst--active');
    wheelWinBurst.setAttribute('aria-hidden', 'false');
    _wheelWinTimer = setTimeout(() => {
      _wheelWinTimer = null;
      wheelWinBurst.classList.remove('wheel-win-burst--active');
      wheelWinBurst.setAttribute('aria-hidden', 'true');
    }, 3000);
  }

  const DAILY_SEGMENTS = 6;
  const DAILY_SEGMENT_DEG = 360 / DAILY_SEGMENTS;
  /** Art spokes at 12 o’clock; segment centers at 30° + i×60°. Base spin aligns slice 0 under pointer. */
  const DAILY_BASE_ROTATION_DEG = -30;

  function refreshWheelSliceLabels() {
    const labels = getDailyWheelSliceLabels();
    document.querySelectorAll('.daily-wheel-slice[data-slice]').forEach((el) => {
      const i = Number(el.dataset.slice);
      const label = el.querySelector('.daily-wheel-slice__label');
      if (label && Number.isInteger(i) && labels[i]) label.textContent = labels[i];
    });
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

  refreshWheelSliceLabels();
  refreshWheelAlertDot();

  let dailyWheelRotation = DAILY_BASE_ROTATION_DEG;
  let dailySpinning = false;

  if (dailySpinEl) {
    dailySpinEl.style.transform = `rotate(${dailyWheelRotation}deg)`;
  }

  function openDailyWheel() {
    dailyOverlay?.classList.add('active');
    dailyOverlay?.setAttribute('aria-hidden', 'false');
    refreshWheelSliceLabels();
  }

  function closeDailyWheel() {
    dailyOverlay?.classList.remove('active');
    dailyOverlay?.setAttribute('aria-hidden', 'true');
    clearWheelWinCelebration(); // cancel stale dismiss timer and reset burst element
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
    dailyOpen?.classList.toggle('daily-wheel-btn--used', !can);
    if (can) {
      if (dailyResult && !dailySpinning) {
        dailyResult.textContent = '';
        dailyResult.hidden = true;
      }
    } else if (dailyResult && !dailySpinning) {
      const wait = Inventory.nextSpinAvailableIn();
      const last = Inventory.getInventory().dailySpinHistory.slice(-1)[0];
      dailyResult.textContent = last
        ? `Already spun today — you won: ${last.reward}. Next spin in ${formatSpinCooldown(wait)}.`
        : `You can spin again in ${formatSpinCooldown(wait)}.`;
      dailyResult.hidden = false;
    }
  }

  /// Rotate the wheel CSS so segment `slotIndex` lands under the top pointer.
  /// Returns a promise that resolves when the CSS transition (or its fallback
  /// timeout) ends. Spinning state is the caller's responsibility.
  function animateWheelToSlot(slotIndex) {
    return new Promise((resolve) => {
      if (!dailySpinEl) { resolve(); return; }
      const spins = prefersReducedMotion() ? 1 : 5;
      const current = normDeg360(dailyWheelRotation);
      const desiredRest = normDeg360(-segmentCenterDeg(slotIndex));
      let delta = spins * 360 + desiredRest - current;
      if (delta < DAILY_SEGMENT_DEG * 2) delta += 360;
      dailyWheelRotation += delta;
      const duration = prefersReducedMotion() ? 0.01 : 4;
      dailySpinEl.style.transition = `transform ${duration}s cubic-bezier(0.17, 0.67, 0.12, 0.99)`;
      dailySpinEl.style.transform = `rotate(${dailyWheelRotation}deg)`;
      if (duration < 0.1) { resolve(); return; }
      const onEnd = e => {
        if (e.propertyName && e.propertyName !== 'transform') return;
        cleanup();
        resolve();
      };
      const fallback = setTimeout(() => { cleanup(); resolve(); }, duration * 1000 + 400);
      function cleanup() {
        clearTimeout(fallback);
        dailySpinEl.removeEventListener('transitionend', onEnd);
      }
      dailySpinEl.addEventListener('transitionend', onEnd);
    });
  }

  /// Pull slotIndex from DailySpin event (falls back to legacy data parse).
  function readSlotIndexFromReceipt(receipt) {
    const spin = decodeDailySpinFromReceipt(receipt, PENGUCRUSH_ADDRESS);
    if (spin) return spin.slotIndex;
    const logs = receipt?.logs || [];
    try {
      for (const log of logs) {
        if (log.data && log.data.length >= 2 + 64 * 2) {
          const second = log.data.slice(2 + 64, 2 + 128);
          const v = parseInt(second.slice(-2), 16);
          if (!Number.isNaN(v) && v < 16) return v;
        }
      }
    } catch (_) {}
    return null;
  }

  function readPrizeFromReceipt(receipt) {
    const spin = decodeDailySpinFromReceipt(receipt, PENGUCRUSH_ADDRESS);
    if (spin?.prizeText) return spin.prizeText;
    const slot = readSlotIndexFromReceipt(receipt);
    if (slot == null) return null;
    const labels = getDailyWheelSliceLabels();
    return labels[slot] || null;
  }

  async function spinDailyWheel() {
    if (!dailySpinEl || dailySpinning) return;
    if (!Inventory.canSpinDaily()) {
      refreshSpinButtonState();
      return;
    }
    Events.wheelSpinStart();
    dailySpinning = true;
    if (dailySpinBtn) dailySpinBtn.disabled = true;
    if (dailyResult) {
      dailyResult.textContent = 'Confirming on chain…';
      dailyResult.hidden = false;
    }

    try {
      // ── 1) Chain first. No animation yet. ──
      const r = await chainSpinWheel();
      if (!r?.hash) throw new Error('no tx hash returned');

      // ── 2) Decode the actual landing slot from the on-chain event ──
      let slot = readSlotIndexFromReceipt(r.receipt);
      if (slot == null) slot = 0; // safe fallback; chain credited correctly regardless

      // ── 3) Now animate to the chain-determined slot ──
      // Start the ratchet tick loop exactly when the wheel begins spinning (4 s animation).
      if (dailyResult) dailyResult.textContent = 'Spinning…';
      const stopSpinSound = playSfxLoop('wheelSpin', { intervalMs: 160, durationMs: 4500, volume: 0.6 });
      await animateWheelToSlot(slot);
      stopSpinSound(); // cancel any remaining ticks the moment the wheel stops

      // ── 4) Pull fresh balances + show reward ──
      await Inventory.hydrateFromChain().catch(() => {});
      const rewardText = readPrizeFromReceipt(r.receipt) || getDailyWheelSliceLabels()[slot] || 'a reward';
      Inventory.markDailySpun(rewardText);
      Events.wheelSpinComplete(r.hash);
      refreshWheelAlertDot();
      const isTryAgain = rewardText === 'Try Again';
      if (dailyResult) {
        dailyResult.textContent = isTryAgain ? 'Try again tomorrow!' : `You won: ${rewardText}!`;
        dailyResult.hidden = false;
      }
      if (!isTryAgain) { playSfx('wheelPrize'); showWheelWinCelebration(rewardText); }
    } catch (err) {
      const msg = String(err?.shortMessage || err?.message || err).slice(0, 300);
      console.warn('Wheel spin failed:', msg);
      Events.wheelSpinFail(msg);
      const { friendlyError, alertFriendly } = await import('./errors.js');
      const { user: friendly } = friendlyError(err);
      if (/already spun|wheelalreadyspun|409/i.test(msg)) {
        Inventory.markDailySpun();
      }
      if (dailyResult) {
        dailyResult.textContent = friendly;
        dailyResult.hidden = false;
      }
      alertFriendly(err, 'Daily wheel spin failed.');
    } finally {
      dailySpinning = false;
      refreshSpinButtonState();
    }
  }

  dailyOpen?.addEventListener('click', e => {
    e.stopPropagation();
    playSfx('buttonTap');
    Events.wheelOpen();
    openDailyWheel();
    refreshSpinButtonState();
    refreshWheelAlertDot();
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
  const crushPassPurchaseOverlay = document.getElementById('crushPassPurchaseOverlay');
  const crushPassBuyBtn = document.getElementById('crushPassBuyBtn');
  const crushPassCancelPurchaseBtn = document.getElementById('crushPassCancelPurchaseBtn');
  const crushPassPurchaseCard = document.getElementById('crushPassPurchaseCard');
  const crushPassPurchaseNote = document.getElementById('crushPassPurchaseNote');

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

  /**
   * Sets the buy-modal copy based on the player's pass state:
   *  - active   → "Extend +1 week" + green note that time stacks
   *  - lapsed   → "Renew Pass" (had one before, it expired)
   *  - first    → "Buy Pass"
   */
  function applyCrushPassPurchaseCopy() {
    const active = Inventory.hasCrushPass();
    const returning = Inventory.hadCrushPassBefore();
    if (crushPassBuyBtn) {
      crushPassBuyBtn.textContent = active ? 'Extend +1 week' : returning ? 'Renew Pass' : 'Buy Pass';
    }
    if (crushPassPurchaseNote) {
      if (active) {
        const ms = Inventory.crushPassExpiresIn();
        crushPassPurchaseNote.textContent = `+7 days added on top of your current time (${formatCrushPassActiveCountdown(ms)} left)`;
        crushPassPurchaseNote.hidden = false;
      } else {
        crushPassPurchaseNote.hidden = true;
        crushPassPurchaseNote.textContent = '';
      }
    }
  }

  function openCrushPassPurchaseOverlay() {
    applyCrushPassPurchaseCopy();
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
    crushPassBuyBtn.textContent = 'Sign tx…';
    Events.passBuyStart();
    try {
      const r = await buyCrushPassETH();
      if (!r?.hash) throw new Error('no tx hash returned');
      // Chain already credited boosters + frozen lives + (possibly) the shard
      // bonus. Pull fresh on-chain state into the local cache so the
      // celebration screen reads truth instead of double-crediting via the
      // legacy `Inventory.purchaseCrushPass()` mock.
      await Inventory.hydrateFromChain().catch(() => {});
      Events.passBuySuccess(r.hash);
      // Build the celebration payload from current chain state. The 5 booster
      // SKUs are seeded; show "+3 of each" since that's the contract default
      // (passBoostersEach storage var). Shard bonus is read from chain.
      const reward = {
        kind: 'weekly_pass',
        label: '3 of each booster',
        boosters: ['row','col','colorBomb','hammer','shuffle'].map(id => ({
          id, count: 3,
          icon: `/assets/boosters-2d/${id === 'colorBomb' ? 'color-bomb' : id === 'row' ? 'row-clear' : id === 'col' ? 'col-clear' : id}.png`,
          label: id,
        })),
      };
      closeCrushPassPurchaseOverlay();
      refreshCrushPassChrome();
      crushPassPendingReward = reward;
      openCrushPassOverlay();
      requestAnimationFrame(() => {
        shakeTicket();
        setTimeout(shakeTicket, 900);
      });
    } catch (err) {
      const msg = String(err?.shortMessage || err?.message || err).slice(0, 200);
      Events.passBuyFail(msg);
      const { alertFriendly } = await import('./errors.js');
      alertFriendly(err, 'Pass purchase failed.');
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
  // The "Cancel renewal" action was removed: the pass is not an auto-renewing
  // subscription (no recurring charge), so there's nothing to cancel — it simply
  // expires on its own. The old cancel button also wiped remaining paid time and
  // bonus lives, which destroyed value the player had already paid for.
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
  const inventoryDots = document.getElementById('inventoryDots');
  const inventoryPrev = document.getElementById('inventoryPrev');
  const inventoryNext = document.getElementById('inventoryNext');

  const INVENTORY_ITEMS_PER_PAGE = 4;
  let inventoryPage = 0;

  function renderInventoryGrid() {
    if (!inventoryGrid) return;
    const boosters = Inventory.getAllBoosters();
    const shards = Inventory.getShards();

    // Collect non-zero items in display order
    const items = INVENTORY_MAP_SLOTS.filter(def =>
      (def.kind === 'booster' ? (boosters[def.id] ?? 0) : (shards[def.id] ?? 0)) > 0
    );

    const totalPages = Math.max(1, Math.ceil(items.length / INVENTORY_ITEMS_PER_PAGE));
    inventoryPage = Math.min(inventoryPage, totalPages - 1);
    const pageItems = items.slice(
      inventoryPage * INVENTORY_ITEMS_PER_PAGE,
      (inventoryPage + 1) * INVENTORY_ITEMS_PER_PAGE
    );

    // ── Grid ──
    inventoryGrid.innerHTML = '';
    if (pageItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'inventory-slot inventory-slot--empty';
      empty.textContent = 'No items yet';
      inventoryGrid.appendChild(empty);
    } else {
      for (const def of pageItems) {
        const n = def.kind === 'booster' ? (boosters[def.id] ?? 0) : (shards[def.id] ?? 0);
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
        qty.textContent = `×${n}`;
        cell.appendChild(icon);
        cell.appendChild(qty);
        inventoryGrid.appendChild(cell);
      }
    }

    // ── Navigation arrows ──
    const multiPage = totalPages > 1;
    if (inventoryPrev) {
      inventoryPrev.hidden = !multiPage;
      inventoryPrev.disabled = inventoryPage === 0;
    }
    if (inventoryNext) {
      inventoryNext.hidden = !multiPage;
      inventoryNext.disabled = inventoryPage === totalPages - 1;
    }

    // ── Dots ──
    if (inventoryDots) {
      inventoryDots.innerHTML = '';
      if (multiPage) {
        for (let i = 0; i < totalPages; i++) {
          const dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'inventory-popup__dot' + (i === inventoryPage ? ' inventory-popup__dot--active' : '');
          dot.setAttribute('aria-label', `Page ${i + 1}`);
          dot.setAttribute('aria-current', i === inventoryPage ? 'true' : 'false');
          const pg = i;
          dot.addEventListener('click', () => { inventoryPage = pg; renderInventoryGrid(); });
          inventoryDots.appendChild(dot);
        }
      }
    }
  }

  function openInventory() {
    inventoryPage = 0;
    renderInventoryGrid();
    inventoryOverlay?.classList.add('active');
    inventoryOverlay?.setAttribute('aria-hidden', 'false');
  }

  function closeInventory() {
    inventoryOverlay?.classList.remove('active');
    inventoryOverlay?.setAttribute('aria-hidden', 'true');
  }

  inventoryPrev?.addEventListener('click', () => {
    if (inventoryPage > 0) { inventoryPage--; renderInventoryGrid(); }
  });
  inventoryNext?.addEventListener('click', () => {
    inventoryPage++; renderInventoryGrid();
  });

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
    refreshSpinButtonState();
    renderMapLivesHud();
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

  // Load progress from localStorage and render immediately so the user
  // sees something. Chain is the authoritative source — hydrate from
  // bestResults right after so a fresh device / cleared cache / new
  // session still shows completed levels. Supabase mirror runs after
  // (best-effort, table is empty without a service-role writer).
  const nodes = loadProgress();
  findCurrentLevel(nodes);
  renderNodes(nodes, nodesContainer, openPopup);

  hydrateProgressFromChain(nodes, nodesContainer, openPopup);
  syncFromSupabase(nodes, nodesContainer, openPopup);

  void (async () => {
    await Inventory.hydrateFromChain().catch(() => {});
    renderMapLivesHud();
    refreshSpinButtonState();
  })();

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
