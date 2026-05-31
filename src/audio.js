/**
 * Lightweight audio manager.
 *
 * SFX are pooled (up to POOL_SIZE clones per key) so rapid-fire events like
 * cascades don't cut themselves off.  BGM loops with a cross-fade.
 *
 * All audio is disabled while the tab is hidden (visibilitychange) and
 * respects a persistent user mute preference stored in localStorage.
 *
 * Attribution (required by CC-BY 3.0):
 *   Background music "Happy Arcade Tune" by rezoner — opengameart.org
 *   SFX from Kenney UI Audio & Impact Sounds packs — kenney.nl (CC0)
 */

const SFX_BASE = '/assets/audio/sfx/';
const MUS_BASE = '/assets/audio/music/';
const POOL_SIZE = 4;
const MUTE_KEY  = 'pengucrush_mute';
const VOL_KEY   = 'pengucrush_volume';

const SFX_FILES = {
  tileSelect:       'tile-select.ogg',
  tileSwap:         'tile-swap.ogg',
  match:            'match.ogg',
  matchCascade:     'match-cascade.ogg',
  noMatch:          'no-match.ogg',
  boosterHammer:    'booster-hammer.ogg',
  boosterRowCol:    'booster-row-col.ogg',
  boosterColorBomb: 'booster-color-bomb.ogg',
  boosterShuffle:   'booster-shuffle.ogg',
  blockerBreak:     'blocker-break.ogg',
  fallerPenalty:    'faller-penalty.ogg',
  levelWin:         'level-win.ogg',
  levelFail:        'level-fail.ogg',
  buttonTap:        'button-tap.ogg',
  wheelSpin:        'wheel-spin.ogg',
  wheelPrize:       'wheel-prize.ogg',
};

const MUSIC_MUTE_KEY = 'pengucrush_music_muted';
const SFX_MUTE_KEY   = 'pengucrush_sfx_muted';

// ── State ────────────────────────────────────────────────────────────────────
let _volume      = parseFloat(localStorage.getItem(VOL_KEY) || '1');
if (!Number.isFinite(_volume) || _volume < 0 || _volume > 1) _volume = 1;

let _musicMuted = localStorage.getItem(MUSIC_MUTE_KEY) === 'true';
let _sfxMuted   = localStorage.getItem(SFX_MUTE_KEY)   === 'true';

// One-time migration from the old global mute key.
// We read it ONCE, write it into the new split keys, then DELETE it
// so it never silently overrides individual settings on future reloads.
const _legacyMuted = localStorage.getItem(MUTE_KEY);
if (_legacyMuted !== null) {
  if (_legacyMuted === 'true') {
    _musicMuted = true;
    _sfxMuted   = true;
    localStorage.setItem(MUSIC_MUTE_KEY, 'true');
    localStorage.setItem(SFX_MUTE_KEY,   'true');
  }
  localStorage.removeItem(MUTE_KEY); // remove so it never runs again
}

/** @type {Map<string, HTMLAudioElement[]>} */
const _pools = new Map();
/** @type {HTMLAudioElement | null} */
let _bgm = null;
let _bgmFading = false;
/** Track name currently playing — used for dedup without URL matching. */
let _bgmKey = '';
/** Volume arg last passed to playBgm — kept so setVolume can restore it correctly. */
let _bgmVolume = 0.35;

// ── Helpers ──────────────────────────────────────────────────────────────────
function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function _getPool(key) {
  if (!_pools.has(key)) {
    const src = SFX_BASE + SFX_FILES[key];
    const pool = Array.from({ length: POOL_SIZE }, () => {
      const a = new Audio(src);
      a.preload = 'auto';
      return a;
    });
    _pools.set(key, pool);
  }
  return _pools.get(key);
}

function _getReady(key) {
  const pool = _getPool(key);
  // Prefer an element that has finished or not yet started
  return pool.find(a => a.paused || a.ended) || pool[0];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Play a short SFX repeatedly for the duration of an animation (e.g. wheel spin ratchet).
 * Returns a cancel function — call it to stop early if the animation is cut short.
 *
 * @param {string} key        SFX key from SFX_FILES
 * @param {number} intervalMs How often to fire the sound (ms). Default 180ms.
 * @param {number} durationMs Total duration to loop for (ms). Default 4200ms.
 * @param {number} volume     Per-play volume multiplier (0–1). Default 0.55.
 * @returns {() => void}      Cancel function.
 */
export function playSfxLoop(key, { intervalMs = 180, durationMs = 4200, volume = 0.55 } = {}) {
  if (_sfxMuted || !SFX_FILES[key]) return () => {};
  playSfx(key, { volume }); // fire immediately on first call
  let elapsed = 0;
  const t = setInterval(() => {
    elapsed += intervalMs;
    if (elapsed >= durationMs) { clearInterval(t); return; }
    playSfx(key, { volume });
  }, intervalMs);
  return () => clearInterval(t); // caller can cancel early
}

/** Play a one-shot SFX (fire-and-forget). */
export function playSfx(key, { volume = 1 } = {}) {
  if (_sfxMuted || document.hidden) return;
  if (!SFX_FILES[key]) { console.warn('[audio] unknown SFX key:', key); return; }
  try {
    const el = _getReady(key);
    el.currentTime = 0;
    el.volume = _clamp(_volume * volume, 0, 1);
    el.play().catch(() => {});
  } catch (_) {}
}

/** Start looping BGM with optional fade-in. */
export function playBgm(src = 'game-bgm.mp3', { volume = 0.35, fadeMs = 1200 } = {}) {
  // Use key-based dedup so tab-hidden (paused) BGM is resumed rather than replaced.
  if (_bgmKey === src) {
    if (_bgm && _bgm.paused && !_musicMuted) _bgm.play().catch(() => {});
    return;
  }
  _bgmKey    = src;
  _bgmVolume = volume;
  stopBgm(300);
  const a = new Audio(MUS_BASE + src);
  a.loop    = true;
  a.preload = 'auto';
  a.volume  = 0; // always start silent; fade-in or direct-set below corrects it
  _bgm = a;
  if (!_musicMuted) a.play().catch(() => {});
  if (!_musicMuted && fadeMs > 0) {
    const target = _clamp(_volume * volume, 0, 1);
    const steps  = 30;
    const dt     = fadeMs / steps;
    let   i      = 0;
    const t = setInterval(() => {
      if (a !== _bgm) { clearInterval(t); return; }
      i++;
      a.volume = _clamp((i / steps) * target, 0, 1);
      if (i >= steps) clearInterval(t);
    }, dt);
  } else if (!_musicMuted) {
    a.volume = _clamp(_volume * volume, 0, 1);
  }
}

/** Fade out and stop BGM. */
export function stopBgm(fadeMs = 600) {
  _bgmKey = ''; // clear key so playBgm can start a new track
  const a = _bgm;
  if (!a || a.paused) { _bgm = null; return; }
  _bgm = null;
  if (fadeMs <= 0 || _bgmFading) { _bgmFading = false; a.pause(); return; }
  _bgmFading = true;
  const startVol = a.volume;
  const steps = 20;
  const dt = fadeMs / steps;
  let i = 0;
  const t = setInterval(() => {
    i++;
    a.volume = _clamp(startVol * (1 - i / steps), 0, 1);
    if (i >= steps) { clearInterval(t); a.pause(); _bgmFading = false; }
  }, dt);
}

export function getMusicMuted() { return _musicMuted; }
export function getSfxMuted()   { return _sfxMuted; }
export function getVolume()     { return _volume; }

export function setMusicMuted(v) {
  _musicMuted = !!v;
  localStorage.setItem(MUSIC_MUTE_KEY, String(_musicMuted));
  if (_bgm) {
    if (_musicMuted) { _bgm.pause(); }
    else { _bgm.volume = _clamp(_volume * _bgmVolume, 0, 1); _bgm.play().catch(() => {}); }
  }
}

export function setSfxMuted(v) {
  _sfxMuted = !!v;
  localStorage.setItem(SFX_MUTE_KEY, String(_sfxMuted));
}

export function setVolume(v) {
  _volume = _clamp(Number(v), 0, 1);
  localStorage.setItem(VOL_KEY, String(_volume));
  if (_bgm && !_musicMuted) _bgm.volume = _clamp(_volume * _bgmVolume, 0, 1);
}

/** Legacy helper — toggles both channels at once. */
export function toggleMute() {
  const both = !(_musicMuted && _sfxMuted);
  setMusicMuted(both);
  setSfxMuted(both);
}

// Pause BGM when tab is hidden; resume when visible again (unless music is muted).
document.addEventListener('visibilitychange', () => {
  if (!_bgm) return;
  if (document.hidden) {
    _bgm.pause();
  } else if (!_musicMuted) {
    _bgm.play().catch(() => {});
  }
});
