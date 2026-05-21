import './style.css';
import './map.css';
import { getAGWAddress, isSignedIn, connectAGW, signInWithAGW, getAgwClient, getWalletClient } from './agw.js';
import * as Inventory from './inventory.js';
import { isLevelUnlocked } from './progress.js';
import { buyBoosterETH, buyLivesETH, claimStarterPack, ensureStarterPack, bootstrapBatch, readStarterPackClaimed } from './onchain.js';
import { hasActiveSession, grantSession } from './session-key.js';
import { setupStatus, hideSetupStatus } from './setup-status.js';
import { Events, setAnalyticsUser } from './analytics.js';
import './dev-stars.js'; // adds window.__pengu.starDev() — no UI unless enabled
import './dev-shop.js';  // adds window.__pengu.shopDev() — align booster grid
import './dev-booster-export.js'; // adds window.__pengu.exportBoosterPNGs()
if (import.meta.env.DEV) import('./dev-audit.js'); // adds window.__pengu_audit.run()

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
  if (id === 'homeScreen') syncHomeConnectUi();
}

function syncHomeConnectUi() {
  const arc = document.getElementById('homeConnectArc');
  const btn = document.getElementById('homePlayBtn');
  if (!arc) return;
  const walletConnected = !!getAGWAddress();
  const session = hasSession();
  if (walletConnected) {
    arc.hidden = true;
    arc.setAttribute('aria-hidden', 'true');
  } else {
    arc.hidden = false;
    arc.setAttribute('aria-hidden', 'false');
  }
  if (btn) {
    btn.setAttribute(
      'aria-label',
      session ? 'Continue to map' : walletConnected ? 'Sign in and play' : 'Connect wallet and play',
    );
  }
}

if (document.getElementById('homeConnectArc')) syncHomeConnectUi();

function showHomeGateHint() {
  const hint = document.getElementById('homeGateHint');
  if (!hint) return;
  hint.hidden = false;
  clearTimeout(showHomeGateHint._t);
  showHomeGateHint._t = setTimeout(() => { hint.hidden = true; }, 4000);
}

Object.assign(window.__pengu ||= {}, {
  goToMap() {
    clearCurrentLevel();
    window.location.href = '/?page=map';
  },
  goToLevel(lvl) {
    setCurrentLevel(lvl);
    window.location.href = '/?page=play';
  },
  /// Manual starter-pack claim — useful from the browser console if the
  /// auto-claim hasn't fired (e.g. you're inspecting state and want to
  /// trigger the chain tx right now). Returns { claimed, reason, tx? }.
  async claimStarterPack() {
    const r = await ensureStarterPack();
    if (r.claimed) await Inventory.hydrateFromChain().catch(() => {});
    return r;
  },
  /// Wipes all PenguCrush localStorage + sessionStorage and reloads. Useful
  /// when the local cache diverges from chain truth (e.g. stale "1 star" on
  /// level 1 while the on-chain submitLevel never landed). Run from the
  /// browser console: __pengu.resetLocalData()
  resetLocalData() {
    const PREFIXES = [
      'pengucrush_', 'pengu_', // app-scoped keys
    ];
    const remove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && PREFIXES.some(p => k.startsWith(p))) remove.push(k);
    }
    for (const k of remove) localStorage.removeItem(k);
    sessionStorage.clear();
    console.log(`🗑 wiped ${remove.length} localStorage keys + all sessionStorage`);
    setTimeout(() => location.reload(), 100);
  },
});

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

  // Silent AGW reconnect on reload. The SIWE signature is cached in
  // localStorage (so `hasSession()` is true) but the viem walletClient
  // lives in module memory and resets to null on every page load. Without
  // this, the next chain tx throws "wallet client missing — reconnect AGW"
  // even though the user looks signed in. Privy's stored cross-app
  // connection lets us silently re-request eth_accounts (no popup).
  if (hasSession() && !getWalletClient()) {
    try {
      await connectAGW();
    } catch (err) {
      console.warn('AGW silent reconnect failed:', err?.shortMessage || err?.message || err);
    }
  }

  // V2.3 — starter-pack auto-claim runs on EVERY app load with an active
  // session, regardless of which page (home/map/play) the user landed on.
  // Idempotent on chain. Fires in the background so it doesn't block
  // rendering, but hydrate runs on success so the next inventory read is
  // accurate. Falls back silently on RPC errors.
  if (hasSession() && getWalletClient()) {
    ensureStarterPack().then(r => {
      if (r?.claimed && r.reason === 'newly_claimed') {
        Inventory.hydrateFromChain().catch(() => {});
      }
    }).catch(() => {});
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
      Events.shopOpen();
      document.getElementById('shopOverlay')?.classList.add('active');
      return;
    }
    if (page === 'leaderboard') {
      Events.leaderboardOpen();
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
  // Only accept canonical 0x + 40 hex; anything else gets normalized so it
  // cannot smuggle HTML into the leaderboard render (defense-in-depth even
  // though buildRow now uses textContent, not innerHTML).
  if (typeof addr !== 'string') return '???';
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return '???';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function buildRow(rank, wallet, xp) {
  const cls = rank === 1 ? 'lb-row--gold' : rank === 2 ? 'lb-row--silver' : rank === 3 ? 'lb-row--bronze' : '';
  // Build via createElement + textContent so wallet text can never be parsed
  // as HTML, even if Supabase rows are later modified by a malicious party.
  const row = document.createElement('div');
  row.className = 'lb-row' + (cls ? ' ' + cls : '');
  const rankEl = document.createElement('div'); rankEl.className = 'lb-rank';    rankEl.textContent = String(rank);
  const peng   = document.createElement('div'); peng.className   = 'lb-penguin'; peng.textContent   = '🐧';
  const addrEl = document.createElement('div'); addrEl.className = 'lb-addr';    addrEl.textContent = shortAddr(wallet);
  const xpEl   = document.createElement('div'); xpEl.className   = 'lb-xp';      xpEl.textContent   = `${Number(xp || 0).toLocaleString()} XP`;
  row.append(rankEl, peng, addrEl, xpEl);
  return row;
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

    const placeholder = (text) => {
      const r = document.createElement('div'); r.className = 'lb-row';
      const a = document.createElement('div'); a.className = 'lb-addr';
      a.style.cssText = 'text-align:center;width:100%';
      a.textContent = text;
      r.appendChild(a);
      return r;
    };
    if (!data || data.length === 0) {
      leftCol.appendChild(placeholder('No players yet!'));
      Events.leaderboardLoadSuccess(0);
      return;
    }

    // Split into 2 columns: 1-13 left, 14-25 right. Append DOM nodes so wallet
    // text can never be re-parsed as HTML.
    const mid = Math.min(13, data.length);
    for (let i = 0; i < data.length; i++) {
      const row = buildRow(i + 1, data[i].wallet_address, data[i].total_score || 0);
      if (i < mid) leftCol.appendChild(row);
      else rightCol.appendChild(row);
    }
    lbDataLoaded = true;
    Events.leaderboardLoadSuccess(data.length);
  } catch (err) {
    loading?.classList.remove('active');
    const r = document.createElement('div'); r.className = 'lb-row';
    const a = document.createElement('div'); a.className = 'lb-addr';
    a.style.cssText = 'text-align:center;width:100%';
    a.textContent = 'Failed to load';
    r.appendChild(a);
    leftCol.appendChild(r);
    console.error('Leaderboard error:', err);
    Events.leaderboardLoadFail(String(err?.message || err).slice(0, 100));
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
// Shop BUY handlers — fetch signed quote from backend, send ETH payment via
// AGW (always prompts — value-bearing tx). On success the chain credits the
// inventory and the next chain-sync refreshes the localStorage cache.
document.querySelectorAll('.shop-tag[data-item]').forEach(tagEl => {
  const itemType = tagEl.dataset.item;
  const slotEl = document.querySelector(`.shop-slot[data-item="${itemType}"]`);
  const qty = parseInt(slotEl?.dataset.qty || '1', 10);
  const labelEl = tagEl.querySelector('.shop-tag__label');
  if (!itemType) return;
  tagEl.addEventListener('click', async () => {
    if (tagEl.disabled) return;
    if (!hasSession()) {
      showHomeGateHint();
      return;
    }
    tagEl.disabled = true;
    const origLabel = labelEl ? labelEl.textContent : null;
    if (labelEl) labelEl.textContent = 'Sign tx…';
    Events.shopBuyStart(itemType, qty, 'ETH');
    try {
      let r;
      if (itemType === 'lives') {
        r = await buyLivesETH(qty);
      } else {
        r = await buyBoosterETH(`booster.${itemType}`, qty);
      }
      if (!r?.hash) throw new Error('no tx hash returned');
      // Chain credited the booster/lives in the same tx. Pull fresh on-chain
      // balances so the HUD reflects truth. NO optimistic increment.
      await Inventory.hydrateFromChain().catch(() => {});
      Events.shopBuySuccess(itemType, qty, 'ETH', r.hash);
      if (labelEl) labelEl.textContent = '✓ Confirmed';
    } catch (err) {
      const msg = String(err?.shortMessage || err?.message || err).slice(0, 200);
      Events.shopBuyFail(itemType, qty, 'ETH', msg);
      console.warn('Shop purchase failed:', msg);
      if (labelEl) labelEl.textContent = 'Failed';
      const lowBalance = /insufficient balance|insufficient funds|out of gas/i.test(msg);
      if (!/reject|denied|cancel/i.test(msg)) {
        alert(lowBalance
          ? 'Your AGW wallet is out of ETH for gas on Abstract.\n\nFund your AGW address with a small amount of ETH on Abstract mainnet, then retry.'
          : `Shop purchase failed:\n\n${msg}`);
      }
    } finally {
      setTimeout(() => {
        if (labelEl && origLabel) labelEl.textContent = origLabel;
        tagEl.disabled = false;
      }, 1400);
    }
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
  // Best-effort level abandonment ping (we don't know movesUsed here cleanly)
  try {
    const lvl = parseInt(sessionStorage.getItem('pengu_current_level') || '0', 10);
    if (lvl) Events.levelLeave(lvl, 0);
  } catch (_) {}
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
  Events.playClicked();
  try {
    if (hasSession()) {
      // Already signed in — refresh chain state in background, then navigate.
      setAnalyticsUser(getAGWAddress());
      Inventory.hydrateFromChain().catch(() => {});
      window.location.href = '/?page=map';
      return;
    }
    if (!getAGWAddress()) {
      Events.agwConnectStart();
      setupStatus('Connecting Abstract Global Wallet…', { step: 'Step 1 of 3' });
      try {
        await connectAGW();
        syncHomeConnectUi();
        Events.agwConnectSuccess(getAGWAddress());
      } catch (e) {
        const msg = String(e?.shortMessage || e?.message || e).slice(0, 200);
        Events.agwConnectFail(msg.slice(0, 100));
        setupStatus('Wallet connect failed', { detail: msg, tone: 'error' });
        hideSetupStatus(6000);
        throw e;
      }
    }
    if (!isSignedIn()) {
      setupStatus('Sign the SIWE message in your wallet…', { step: 'Step 2 of 3' });
      try {
        await signInWithAGW();
        syncHomeConnectUi();
        Events.siweSignSuccess(getAGWAddress());
      } catch (e) {
        const msg = String(e?.shortMessage || e?.message || e).slice(0, 200);
        Events.siweSignFail(msg.slice(0, 100));
        setupStatus('Sign-in failed', { detail: msg, tone: 'error' });
        hideSetupStatus(6000);
        throw e;
      }
    }
    setAnalyticsUser(getAGWAddress());
    // Pull chain state right after sign-in so the map HUD shows the truth.
    Inventory.hydrateFromChain().catch(() => {});

    // Decide which on-chain setup the player still needs. We were previously
    // gating bootstrap on "starter pack unclaimed" only — that's wrong, because
    // a returning user with an expired session locally also benefits from
    // batching (one createSession + startLevel tx instead of two separate
    // prompts). So: run bootstrap whenever the local session is gone OR the
    // starter pack hasn't been claimed yet OR both.
    const player = getAGWAddress();
    let alreadyClaimed = false;
    try {
      alreadyClaimed = !!(await readStarterPackClaimed(player));
    } catch (e) {
      console.warn('[entry] readStarterPackClaimed failed, assuming not claimed:', e?.shortMessage || e?.message || e);
    }
    const sessionLive = hasActiveSession();
    const agwClient = getAgwClient();
    const needsBootstrap = !sessionLive || !alreadyClaimed;
    console.info('[entry] post-SIWE state: sessionLive=', sessionLive, 'starterClaimed=', alreadyClaimed, 'agwClient?', !!agwClient, 'needsBootstrap=', needsBootstrap);

    if (needsBootstrap && agwClient) {
      setupStatus('Setting up gameplay — one transaction…', {
        step: 'Step 3 of 3',
        detail: 'Bundling session key + starter pack + level 1 start into a single tx',
      });
      try {
        const r = await bootstrapBatch(1);
        Events.sessionKeyGranted?.(r?.sessionAddress);
        setupStatus('Ready! Loading level 1…', { tone: 'ok' });
        await Inventory.hydrateFromChain().catch(() => {});
        setCurrentLevel(1);
        hideSetupStatus(1500);
        window.location.href = '/?page=play';
        return;
      } catch (err) {
        const msg = String(err?.shortMessage || err?.message || err).slice(0, 240);
        console.warn('[entry] bootstrapBatch failed, falling back to sequential prompts:', msg);
        Events.sessionKeyFailed?.(msg);
        if (/reject|denied|cancel/i.test(msg)) {
          setupStatus('Cancelled', { detail: 'You cancelled the wallet prompt. Tap Play to try again.', tone: 'error' });
          hideSetupStatus(4000);
          return;
        }
        setupStatus('One-tx setup failed — falling back to per-tx prompts', { detail: msg, tone: 'error' });
        // Fall through to the legacy sequential path so the player can still
        // proceed even if the batch path errored out for some reason.
      }
    } else if (needsBootstrap && !agwClient) {
      console.warn('[entry] needsBootstrap but no agwClient — falling through to legacy prompts');
      setupStatus('Session manager unavailable — using per-tx prompts', { tone: 'error' });
    }

    // Legacy / fallback path — runs only if bootstrap was unavailable or
    // threw above. Failures here used to be silently swallowed; now they're
    // surfaced so a degraded session-key state is detectable.
    if (!hasActiveSession()) {
      const client = getAgwClient();
      if (client) {
        setupStatus('Granting session key…', { step: 'Fallback', detail: 'Confirm in the Privy popup' });
        try {
          const r = await grantSession(client);
          Events.sessionKeyGranted(r?.sessionAddress);
        } catch (err) {
          const msg = String(err?.shortMessage || err?.message || err).slice(0, 200);
          console.warn('[entry] session-key grant failed — gameplay will require per-tx prompts:', msg);
          Events.sessionKeyFailed(msg);
          setupStatus('Session-key grant failed', { detail: msg, tone: 'error' });
        }
      } else {
        console.warn('[entry] AGW high-level client not available — session keys disabled');
        Events.sessionKeyFailed?.('agw_client_missing');
      }
    }
    // V2.3 — claim the one-time starter pack (1 of each booster on chain).
    setupStatus('Claiming starter pack…', { step: 'Fallback' });
    const r = await ensureStarterPack();
    if (r.claimed) await Inventory.hydrateFromChain().catch(() => {});
    setupStatus('Ready! Loading map…', { tone: 'ok' });
    hideSetupStatus(1500);
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
function updateLoadingUI(p) {
  const pct = Math.round(p * 100);
  const bar = document.getElementById('loadingBarFill');
  const host = document.getElementById('loadingProgress');
  if (bar) bar.style.transform = 'scaleX(' + p + ')';
  if (host) host.setAttribute('aria-valuenow', String(pct));
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
  try {
    video.currentTime = 0;
  } catch (_) {}
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
    video.loop = true;
    if (video.currentTime >= video.duration - 0.12) video.currentTime = 0;
    await video.play();
  } catch (_) {}
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    video.pause();
    video.loop = false;
  } catch (_) {}
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
