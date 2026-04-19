import './style.css';
import './map.css';
import { getAGWAddress, isSignedIn, connectAGW, signInWithAGW } from './agw.js';
import * as Inventory from './inventory.js';
import { isLevelUnlocked } from './progress.js';

// ── Current level routing (internal, not in the URL bar) ───────
// The URL never carries ?level=N anymore — the level is stored in
// sessionStorage and the URL only shows ?page=play. A stale ?level=N
// (e.g. from an old bookmark or manual URL edit) gets migrated once
// then stripped.
const LEVEL_KEY = 'pengu_current_level';

function getCurrentLevel() {
  const s = sessionStorage.getItem(LEVEL_KEY);
  if (s) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }
  return null;
}

function setCurrentLevel(n) {
  sessionStorage.setItem(LEVEL_KEY, String(n));
}

function clearCurrentLevel() {
  sessionStorage.removeItem(LEVEL_KEY);
}

/** One-time migration: if the URL still carries ?level=N, stash it
 *  into sessionStorage and rewrite the URL to ?page=play. */
function migrateLegacyLevelParam() {
  const url = new URLSearchParams(location.search);
  const legacy = url.get('level');
  if (legacy) {
    const n = parseInt(legacy, 10);
    if (Number.isFinite(n) && n >= 1) setCurrentLevel(n);
    history.replaceState(null, '', '/?page=play');
  }
}
migrateLegacyLevelParam();

function hasSession() {
  return !!getAGWAddress() && isSignedIn();
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.toggle('screen--hidden', s.id !== id);
    s.classList.toggle('screen--active', s.id === id);
  });
  document.body.dataset.screen = id.replace('Screen', '');
}

function showHomeGateHint() {
  const hint = document.getElementById('homeGateHint');
  if (!hint) return;
  hint.hidden = false;
  clearTimeout(showHomeGateHint._t);
  showHomeGateHint._t = setTimeout(() => { hint.hidden = true; }, 4000);
}

window.__pengu = {
  goToMap() {
    clearCurrentLevel();
    window.location.href = '/?page=map';
  },
  goToLevel(lvl) {
    setCurrentLevel(lvl);
    window.location.href = '/?page=play';
  },
};

let mapInited = false;
let gameLoaded = false;

function getPage() {
  return new URLSearchParams(window.location.search).get('page') || 'home';
}

async function boot() {
  const page = getPage();
  const isPlay = page === 'play';
  const level = isPlay ? getCurrentLevel() : null;

  // Gate non-home routes on active session (wallet + signature)
  if ((isPlay || page === 'map') && !hasSession()) {
    clearCurrentLevel();
    showScreen('homeScreen');
    showHomeGateHint();
    history.replaceState(null, '', '/');
    return;
  }

  if (isPlay) {
    // No level queued → send to map (no way to guess what to play)
    const allowed = level != null && await isLevelUnlocked(level);
    if (!allowed) {
      console.warn(`Level ${level ?? '(none)'} is locked — redirecting to map`);
      clearCurrentLevel();
      history.replaceState(null, '', '/?page=map');
      showScreen('mapScreen');
      if (!mapInited) {
        mapInited = true;
        const { initMap } = await import('./map.js');
        initMap();
      }
      return;
    }
    showScreen('gameScreen');
    if (!gameLoaded) {
      gameLoaded = true;
      await import('./game.js');
    }
  } else if (page === 'map') {
    showScreen('mapScreen');
    if (!mapInited) {
      mapInited = true;
      const { initMap } = await import('./map.js');
      initMap();
    }
  } else {
    showScreen('homeScreen');
  }
}

window.addEventListener('popstate', () => boot());

// ═══════════════════════════════════════════════════
// BOTTOM NAV BAR
// ═══════════════════════════════════════════════════
function updateNav() {
  const p = getPage();
  const page = p === 'play' ? 'game' : p;
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    // Gate everything except home behind an active session
    if (page !== 'home' && !hasSession()) {
      showScreen('homeScreen');
      showHomeGateHint();
      history.replaceState(null, '', '/');
      updateNav();
      return;
    }
    if (page === 'shop') {
      document.getElementById('shopOverlay')?.classList.add('active');
      initShopBombPreview();
      return;
    }
    if (page === 'leaderboard') {
      document.getElementById('lbOverlay')?.classList.add('active');
      loadLeaderboard();
      return;
    }
    if (page === 'home') {
      window.location.href = '/';
    } else {
      window.location.href = '/?page=' + page;
    }
  });
});

updateNav();

// ═══════════════════════════════════════════════════
// LEADERBOARD POPUP
// ═══════════════════════════════════════════════════
let lbDataLoaded = false;

function shortAddr(addr) {
  if (!addr) return '???';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function buildRow(rank, wallet, xp) {
  const cls = rank === 1 ? 'lb-row--gold' : rank === 2 ? 'lb-row--silver' : rank === 3 ? 'lb-row--bronze' : '';
  return `<div class="lb-row ${cls}">
    <div class="lb-rank">${rank}</div>
    <div class="lb-penguin">🐧</div>
    <div class="lb-addr">${shortAddr(wallet)}</div>
    <div class="lb-xp">${xp.toLocaleString()} XP</div>
  </div>`;
}

async function loadLeaderboard() {
  const leftCol = document.getElementById('lbColLeft');
  const rightCol = document.getElementById('lbColRight');
  const loading = document.getElementById('lbLoading');
  if (!leftCol || !rightCol) return;

  loading?.classList.add('active');
  leftCol.innerHTML = '';
  rightCol.innerHTML = '';

  try {
    const { fetchLeaderboard } = await import('./supabase.js');
    const data = await fetchLeaderboard(25);

    loading?.classList.remove('active');

    if (!data || data.length === 0) {
      leftCol.innerHTML = '<div class="lb-row"><div class="lb-addr" style="text-align:center;width:100%">No players yet!</div></div>';
      return;
    }

    // Split into 2 columns: 1-13 left, 14-25 right
    const mid = Math.min(13, data.length);
    for (let i = 0; i < data.length; i++) {
      const row = buildRow(i + 1, data[i].wallet_address, data[i].total_score || 0);
      if (i < mid) leftCol.innerHTML += row;
      else rightCol.innerHTML += row;
    }
    lbDataLoaded = true;
  } catch (err) {
    loading?.classList.remove('active');
    leftCol.innerHTML = '<div class="lb-row"><div class="lb-addr" style="text-align:center;width:100%">Failed to load</div></div>';
    console.error('Leaderboard error:', err);
  }
}

document.getElementById('lbClose')?.addEventListener('click', () => {
  document.getElementById('lbOverlay')?.classList.remove('active');
});
document.getElementById('lbOverlay')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('active');
  }
});

// Tab switching
document.querySelectorAll('.lb-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.lb-tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    // Both tabs show same data for now — weekly filtering can be added later
    loadLeaderboard();
  });
});

// ═══════════════════════════════════════════════════
// SHOP POPUP
// ═══════════════════════════════════════════════════
let shopBombInited = false;

async function initShopBombPreview() {
  if (shopBombInited) return;
  shopBombInited = true;

  const canvas = document.getElementById('shopBombCanvas');
  if (!canvas) return;

  const THREE = await import('three');
  const { createGLTFLoader } = await import('./gltf-loader.js');

  const size = Math.max(1, Math.round(canvas.clientWidth || 50));
  canvas.width = size * 2;
  canvas.height = size * 2;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(size, size);
  renderer.setPixelRatio(2);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 1.0, 3.45);
  camera.lookAt(0, 0.02, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(2, 3, 2);
  scene.add(dir);
  const rim = new THREE.DirectionalLight(0x88ccff, 0.5);
  rim.position.set(-2, 1, -1);
  scene.add(rim);

  const loader = createGLTFLoader();
  loader.load('/assets/boosters/color-bomb.glb', (gltf) => {
    const model = gltf.scene;
    // Center and scale
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const sz = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(sz.x, sz.y, sz.z);
    /* Larger scale + closer camera = less empty “padding” inside the canvas */
    const scale = 2.05 / maxDim;
    model.scale.setScalar(scale);
    model.position.sub(center.multiplyScalar(scale));
    model.position.y += 0.1;
    scene.add(model);

    function animate() {
      requestAnimationFrame(animate);
      model.rotation.y += 0.012;
      renderer.render(scene, camera);
    }
    animate();
  });
}

// Shop BUY handlers — increment booster inventory, flash confirmation.
// Real payment rails are out of scope here; the purchase is granted client-
// side and persisted so the booster shows up in-game immediately.
document.querySelectorAll('.shop-item').forEach(itemEl => {
  const itemType = itemEl.dataset.item; // e.g. 'colorBomb'
  const buyBtn = itemEl.querySelector('.shop-item__buy');
  const labelEl = buyBtn?.querySelector('.shop-item__buy-label');
  if (!buyBtn || !itemType) return;
  buyBtn.addEventListener('click', () => {
    if (buyBtn.disabled) return;
    buyBtn.disabled = true;
    const origLabel = labelEl ? labelEl.textContent : null;
    const newCount = Inventory.addBooster(itemType, 1);
    if (labelEl) labelEl.textContent = `+1 (${newCount})`;
    setTimeout(() => {
      if (labelEl && origLabel) labelEl.textContent = origLabel;
      buyBtn.disabled = false;
    }, 1400);
  });
});

document.getElementById('shopClose')?.addEventListener('click', () => {
  document.getElementById('shopOverlay')?.classList.remove('active');
});
document.getElementById('shopOverlay')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('active');
  }
});

// ═══════════════════════════════════════════════════
// LEAVE-LEVEL BUTTON (game screen back to map)
// ═══════════════════════════════════════════════════
const leaveOverlay = document.getElementById('leaveConfirm');
const leaveCancelBtn = document.getElementById('leaveCancel');
const leaveOkBtn = document.getElementById('leaveOk');
const gameBackBtn = document.getElementById('gameBackBtn');

function openLeaveConfirm() {
  leaveOverlay?.classList.add('active');
  leaveOverlay?.setAttribute('aria-hidden', 'false');
}
function closeLeaveConfirm() {
  leaveOverlay?.classList.remove('active');
  leaveOverlay?.setAttribute('aria-hidden', 'true');
}

gameBackBtn?.addEventListener('click', openLeaveConfirm);
leaveCancelBtn?.addEventListener('click', closeLeaveConfirm);
leaveOverlay?.addEventListener('click', e => {
  if (e.target === leaveOverlay) closeLeaveConfirm();
});
leaveOkBtn?.addEventListener('click', () => {
  closeLeaveConfirm();
  window.__pengu.goToMap();
});
document.addEventListener('keydown', e => {
  if (document.body.dataset.screen !== 'game') return;
  if (e.key === 'Escape') {
    if (leaveOverlay?.classList.contains('active')) closeLeaveConfirm();
    else openLeaveConfirm();
  }
});

// ═══════════════════════════════════════════════════
// HOME PLAY BUTTON → AGW CONNECT
// ═══════════════════════════════════════════════════
const homePlayBtn = document.getElementById('homePlayBtn');

homePlayBtn?.addEventListener('click', async () => {
  if (homePlayBtn.disabled) return;
  homePlayBtn.disabled = true;
  try {
    if (hasSession()) {
      window.location.href = '/?page=map';
      return;
    }
    if (!getAGWAddress()) {
      await connectAGW();
    }
    if (!isSignedIn()) {
      await signInWithAGW();
    }
    window.location.href = '/?page=map';
  } catch (err) {
    console.error('AGW connect/sign-in error:', err);
    const msg = String(err?.message || err || '');
    if (/popup|blocked|window/i.test(msg)) {
      alert('The AGW login popup was blocked. Please allow popups for this site and try again.');
    } else if (/reject|denied|cancel/i.test(msg)) {
      // User cancelled — no alert needed
    } else {
      alert('Wallet connect failed: ' + msg);
    }
  } finally {
    homePlayBtn.disabled = false;
  }
});

// ═══════════════════════════════════════════════════
// LOADING SCREEN (runs once on first visit)
// ═══════════════════════════════════════════════════
let loadingVideoSeekRaf = null;

function syncLoadingVideoToProgress(p) {
  const video = document.getElementById('loadingVideo');
  if (!video || !video.duration || !Number.isFinite(video.duration)) return;
  const t = Math.min(1, Math.max(0, p)) * video.duration;
  const targetTime = Math.min(t, Math.max(0, video.duration - 0.04));
  if (loadingVideoSeekRaf != null) cancelAnimationFrame(loadingVideoSeekRaf);
  loadingVideoSeekRaf = requestAnimationFrame(() => {
    loadingVideoSeekRaf = null;
    try {
      video.pause();
      if (Math.abs(video.currentTime - targetTime) < 0.02) return;
      video.currentTime = targetTime;
    } catch (_) {}
  });
}

function updateLoadingUI(p) {
  const pct = Math.round(p * 100);
  const bar = document.getElementById('loadingBarFill');
  const host = document.getElementById('loadingProgress');
  if (bar) bar.style.transform = 'scaleX(' + p + ')';
  if (host) host.setAttribute('aria-valuenow', String(pct));
  syncLoadingVideoToProgress(p);
}

function waitForLoadingPoster() {
  const img = document.getElementById('loadingPoster');
  if (!img?.src) return Promise.resolve();
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', () => {
      img.classList.add('loading-screen__poster--hidden');
      done();
    }, { once: true });
  });
}

function waitForLoadingVideo(video) {
  return new Promise((resolve) => {
    if (!video) { resolve(); return; }
    const finish = () => resolve();
    if (video.error) { finish(); return; }
    if (video.readyState >= 2) { finish(); return; }
    video.addEventListener('loadeddata', finish, { once: true });
    video.addEventListener('canplay', finish, { once: true });
    video.addEventListener('error', finish, { once: true });
    try { video.load(); } catch (_) { finish(); }
  });
}

function revealLoadingVideoLayer() {
  const video = document.getElementById('loadingVideo');
  const content = document.getElementById('loadingScreenContent');
  if (!video || video.error || video.readyState < 2) return;
  video.classList.add('loading-screen__video--ready');
  content?.classList.add('loading-screen__content--video-ready');
}

const MIN_LOADING_PLAY_MS = 2500;

async function holdMinLoadingVideoPlayback(video) {
  if (!video || video.error || !Number.isFinite(video.duration)) {
    await new Promise((r) => setTimeout(r, MIN_LOADING_PLAY_MS));
    return;
  }
  const deadline = performance.now() + MIN_LOADING_PLAY_MS;
  try {
    if (video.currentTime >= video.duration - 0.12) video.currentTime = 0;
    await video.play();
  } catch (_) {}
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (video.ended) {
      video.currentTime = 0;
      try { await video.play(); } catch (_) {}
    }
  }
  try { video.pause(); } catch (_) {}
}

function finishLoadingOutro() {
  const screen = document.getElementById('loadingScreen');
  const video = document.getElementById('loadingVideo');
  updateLoadingUI(1);
  if (video?.duration && Number.isFinite(video.duration)) {
    try { video.currentTime = Math.max(0, video.duration - 0.03); } catch (_) {}
  }
  try { video?.pause(); } catch (_) {}

  if (!screen) return;
  screen.setAttribute('aria-busy', 'false');
  screen.classList.add('loading-screen--exit');

  let outroDone = false;
  const cleanup = () => {
    if (outroDone) return;
    outroDone = true;
    screen.remove();
  };
  screen.addEventListener('animationend', (e) => {
    if (e.animationName === 'loading-screen-outro' || e.animationName === 'loading-screen-outro-reduced') cleanup();
  }, { once: true });
  setTimeout(cleanup, 1000);
}

// ═══════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════
void (async () => {
  try {
    updateLoadingUI(0);
    const loadingVideo = document.getElementById('loadingVideo');
    try { loadingVideo?.pause(); } catch (_) {}

    await waitForLoadingPoster();
    updateLoadingUI(0.33);

    await waitForLoadingVideo(loadingVideo);
    revealLoadingVideoLayer();
    updateLoadingUI(0.66);

    const page = getPage();
    const isPlay = page === 'play';
    const level = isPlay ? getCurrentLevel() : null;

    const sessionOk = hasSession();
    // Level gate — chain-verified unlock for level > 1
    let levelAllowed = false;
    if (isPlay) {
      levelAllowed = sessionOk && level != null && await isLevelUnlocked(level);
      if (!levelAllowed) {
        console.warn(`Level ${level ?? '(none)'} is locked — redirecting`);
        clearCurrentLevel();
      }
    }

    if (levelAllowed) {
      gameLoaded = true;
      await import('./game.js');
    } else if ((page === 'map' || (isPlay && !levelAllowed)) && sessionOk) {
      mapInited = true;
      const { initMap } = await import('./map.js');
      initMap();
    }
    updateLoadingUI(1);

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await holdMinLoadingVideoPlayback(loadingVideo);
    finishLoadingOutro();

    if (!sessionOk && (isPlay || page === 'map')) {
      history.replaceState(null, '', '/');
      showScreen('homeScreen');
      showHomeGateHint();
    } else if (levelAllowed) {
      showScreen('gameScreen');
    } else if (isPlay && !levelAllowed) {
      history.replaceState(null, '', '/?page=map');
      showScreen('mapScreen');
    } else if (page === 'map') {
      showScreen('mapScreen');
    } else {
      showScreen('homeScreen');
    }
  } catch (err) {
    console.error(err);
    document.getElementById('loadingScreen')?.remove();
    boot();
  }
})();
