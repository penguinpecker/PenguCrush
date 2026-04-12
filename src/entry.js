import './style.css';
import './map.css';

function getLevel() {
  return new URLSearchParams(window.location.search).get('level');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.toggle('screen--hidden', s.id !== id);
    s.classList.toggle('screen--active', s.id === id);
  });
  document.body.dataset.screen = id.replace('Screen', '');
}

window.__pengu = {
  goToMap() {
    window.location.href = '/?page=map';
  },
  goToLevel(lvl) {
    window.location.href = '/?level=' + lvl;
  },
};

let mapInited = false;
let gameLoaded = false;

function getPage() {
  return new URLSearchParams(window.location.search).get('page') || 'home';
}

async function boot() {
  const level = getLevel();
  const page = getPage();

  if (level) {
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
    // home, shop, leaderboard — show homeScreen for now
    showScreen('homeScreen');
  }
}

window.addEventListener('popstate', () => boot());

// ═══════════════════════════════════════════════════
// BOTTOM NAV BAR
// ═══════════════════════════════════════════════════
function updateNav() {
  const page = getLevel() ? 'game' : getPage();
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    if (page === 'home') {
      window.location.href = '/';
    } else {
      window.location.href = '/?page=' + page;
    }
  });
});

updateNav();

// ═══════════════════════════════════════════════════
// HOME PLAY BUTTON → AGW CONNECT
// ═══════════════════════════════════════════════════
document.getElementById('homePlayBtn')?.addEventListener('click', async () => {
  try {
    const { connectAGW, getAGWAddress } = await import('./agw.js');
    if (!getAGWAddress()) {
      await connectAGW();
    }
    window.location.href = '/?page=map';
  } catch (err) {
    console.error('AGW connect error:', err);
    // Still navigate to map even if wallet connect fails/cancelled
    window.location.href = '/?page=map';
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

    const level = getLevel();
    const page = getPage();
    if (level) {
      gameLoaded = true;
      await import('./game.js');
    } else if (page === 'map') {
      mapInited = true;
      const { initMap } = await import('./map.js');
      initMap();
    }
    // home screen needs no async loading
    updateLoadingUI(1);

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await holdMinLoadingVideoPlayback(loadingVideo);
    finishLoadingOutro();
    if (level) {
      showScreen('gameScreen');
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
