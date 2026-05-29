import * as THREE from 'three';
import { createGLTFLoader } from './gltf-loader.js';
import { getLevel, hasLevel, getObjectiveChip, computeStars, movesRemainingForStars } from './levels.js';
import { getWallet, ensureWallet, saveLevelResult } from './supabase.js';
import * as Inventory from './inventory.js';
import { startLevel as chainStartLevel, submitLevel as chainSubmitLevel, submitAndStartNext as chainSubmitAndStartNext, sku as nameToSku } from './onchain.js';
import { rollShardsForMatch, renderShardSlots, computeTraits } from './shards.js';
import { saveSnapshot as saveMidGameSnapshot, loadSnapshot as loadMidGameSnapshot, clearSnapshot as clearMidGameSnapshot } from './mid-game.js';
import { Events } from './analytics.js';
import { renderLivesHud, canSpendLife, shakeLivesHud, shakeElement } from './lives-hud.js';

// ─── Per-level journal accumulated during play, submitted on-chain at end ────
const journal = {
  boostersUsed: [],   // bytes32 SKUs, one per consumption
  shardsEarned: [],   // bytes32 SKUs, one per award
  bigCombos: 0,       // count of combos ≥ 5
};
const BOOSTER_NAME_TO_SKU = {
  row:       nameToSku('booster.row'),
  col:       nameToSku('booster.col'),
  colorBomb: nameToSku('booster.colorBomb'),
  hammer:    nameToSku('booster.hammer'),
  shuffle:   nameToSku('booster.shuffle'),
};
const SHARD_NAME_TO_SKU = {
  necklace: nameToSku('shard.necklace'),
  crown:    nameToSku('shard.crown'),
  plooshie: nameToSku('shard.plooshie'),
};

// ═══════════════════════════════════════════════════════════════
//  LEVEL CONFIG — driven by ?level=N URL param
// ═══════════════════════════════════════════════════════════════
// Level routing is internal (sessionStorage) so the URL bar never
// exposes which level the player is on. Fall back to the legacy
// ?level=N param only if sessionStorage hasn't been populated yet
// (e.g. opening an old bookmark before entry.js's migration runs).
const levelNum = (() => {
  const fromSession = parseInt(sessionStorage.getItem('pengu_current_level') || '', 10);
  if (Number.isFinite(fromSession) && fromSession >= 1) return fromSession;
  const fromUrl = parseInt(new URLSearchParams(window.location.search).get('level') || '', 10);
  return Number.isFinite(fromUrl) && fromUrl >= 1 ? fromUrl : 1;
})();
const CONFIG = getLevel(levelNum);

const GRID = CONFIG.grid;
const CELL = 1.2;
const TILE_TYPES = CONFIG.tiles;

// All known GLB paths — only the ones needed for this level get loaded
const ALL_GLB_PATHS = {
  ice:       '/assets/tiles/shells/ice-crystal.glb',
  frostice:  '/assets/tiles/shells/frosted-ice.glb',
  fish:      '/assets/tiles/inners/fish.glb',
  popsicle:  '/assets/tiles/inners/popsicle.glb',
  shrimp:    '/assets/tiles/inners/shrimp.glb',
  crab:      '/assets/tiles/inners/snow-crab.glb',
};

// Only load GLBs needed for this level's tile set + ice shell for inners
const GLB_PATHS = {};
for (const t of TILE_TYPES) {
  if (ALL_GLB_PATHS[t]) GLB_PATHS[t] = ALL_GLB_PATHS[t];
}
// Always load ice shell — needed for fish/popsicle/shrimp/crab composites
if (!GLB_PATHS['ice']) GLB_PATHS['ice'] = ALL_GLB_PATHS['ice'];

// Inner tile types that render inside an ice crystal shell
const INNER_TYPES = new Set(['fish', 'popsicle', 'shrimp', 'crab']);

// Blocker GLB paths — loaded if level has blockers
const BLOCKER_GLB_PATHS = {
  frozen:  '/assets/blockers/frozen-overlay.glb',
  wall:    '/assets/blockers/stone-wall.glb',
  faller:  '/assets/blockers/falling-icicle.glb',
};
const blockerGlbCache = {};

// Booster state — hydrated from the wallet-scoped inventory so purchases and
// unused charges carry over between sessions.
let activeBooster = null; // null or 'row' | 'col' | 'colorBomb' | 'hammer' | 'shuffle'
const boosterCharges = {}; // { row: N, col: N, ... } — reflects inventory
function rehydrateBoosterCharges() {
  const inv = Inventory.getAllBoosters();
  for (const b of CONFIG.boosters) boosterCharges[b] = inv[b] || 0;
}
rehydrateBoosterCharges();
// Attempt a cloud pull once on load; if it finds greater values, the inventory
// change event will re-hydrate and update the UI.
Inventory.hydrateFromCloud().then(() => {
  rehydrateBoosterCharges();
  updateBoosterUI();
}).catch(() => {});
Inventory.onInventoryChange(() => {
  rehydrateBoosterCharges();
  updateBoosterUI();
});

const TYPE_FIX = {
  ice:       { rx: 0, ry: 0, rz: 0, scale: 0.85 },
  popsicle:  { rx: Math.PI/2, ry: Math.PI*5/4, rz: 0, scale: 0.70 },
  fish:      { rx: 0, ry: Math.PI/2, rz: 0, scale: 0.55 },
  frostice:  { rx: 0, ry: 0, rz: 0, scale: 0.85 },
  shrimp:    { rx: 0, ry: Math.PI/2, rz: 0, scale: 0.60 },
  crab:      { rx: 0, ry: 0, rz: 0, scale: 0.60 },
};

// Shard-driven passive traits (read once at load; shards earned mid-run
// don't change the current level's buff — they kick in next level).
const TRAITS = computeTraits(Inventory.getShards());

let board = [], selected = null, animating = false, score = 0, moves = CONFIG.moves + TRAITS.bonusMoves, combo = 0;
let gameOver = false;
let lowMovesWarned = false;

// Objective tracking
const objective = { ...CONFIG.objective };
let tilesCleared = {};
let blockersDestroyed = {};
let totalTilesCleared = 0;
/** HUD display count — lags behind tilesCleared while collect FX fly in. */
let goalDisplayCount = 0;
const goalIconBakeCache = {};
const OBJECTIVE_TILE_COLORS = {
  fish: 0xff7043,
  popsicle: 0x7cb342,
  ice: 0x4fc3f7,
  frostice: 0xe0f0ff,
  shrimp: 0xff5544,
  crab: 0xff8844,
};

// Game timing
const gameStartTime = performance.now();

// Falling blocker tracking
let turnCount = 0;
const fallerConfig = CONFIG.blockers.find(b => b.type === 'faller');
let fallerDropsPenalized = 0;
let fallerDropCycles = 0;

// Set background based on era
if (CONFIG.bg) {
  document.body.style.background = `url('${CONFIG.bg}') center/cover no-repeat fixed`;
}


// ═══════════════════════════════════════════════════════════════
//  THREE.JS SETUP — transparent canvas so BG shows through
// ═══════════════════════════════════════════════════════════════
const canvas = document.getElementById('gameCanvas');

function computeCanvasSize() {
  const vw = window.innerWidth || 360;
  const vh = window.innerHeight || 640;
  const compact = vw <= 700 || vh <= 720;
  const landscapePhone = compact && vw > vh && vh <= 500;
  const reserved = landscapePhone ? 155 : compact ? 250 : 320;
  const edgePadding = landscapePhone ? 280 : compact ? 24 : 60;
  const available = Math.min(vw - edgePadding, vh - reserved, 580);
  return Math.max(220, Math.floor(available));
}

let W = computeCanvasSize();
canvas.width = W; canvas.height = W;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setSize(W, W);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.4;

const scene = new THREE.Scene();

// Camera — frustum sized to show frame border around tiles
const frustum = GRID * CELL + 4.0;
const camera = new THREE.OrthographicCamera(-frustum/2, frustum/2, frustum/2, -frustum/2, 0.1, 100);
camera.position.set(0, 0, 20);
camera.lookAt(0, 0, 0);

function resizeGameCanvas() {
  const next = computeCanvasSize();
  if (next === W) return;
  W = next;
  canvas.width = W;
  canvas.height = W;
  renderer.setSize(W, W);
}

window.addEventListener('resize', resizeGameCanvas);

// Lighting
scene.add(new THREE.AmbientLight(0xd0ecff, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(4, 6, 12);
scene.add(keyLight);
scene.add(new THREE.DirectionalLight(0x80d0ff, 0.5).translateX(-4));
scene.add(new THREE.DirectionalLight(0xa0e0ff, 0.3).translateY(-6));

// ═══════════════════════════════════════════════════════════════
//  BOOSTER CURSOR & ROW/COL HOVER HIGHLIGHT
// ═══════════════════════════════════════════════════════════════
const rowHighlightMat = new THREE.MeshBasicMaterial({ color: 0x00dfff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
const rowHighlightMesh = new THREE.Mesh(new THREE.PlaneGeometry(GRID * CELL, CELL * 0.94), rowHighlightMat);
rowHighlightMesh.position.z = 0.55;
scene.add(rowHighlightMesh);

const colHighlightMat = new THREE.MeshBasicMaterial({ color: 0x00dfff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
const colHighlightMesh = new THREE.Mesh(new THREE.PlaneGeometry(CELL * 0.94, GRID * CELL), colHighlightMat);
colHighlightMesh.position.z = 0.55;
scene.add(colHighlightMesh);

let _highlightRowActive = false, _highlightColActive = false;

// Pre-cached cursor data-URL strings, populated by preCacheBoosterCursors().
// Browsers require cursor images to be ≤128×128; we normalise to 48×48.
const _boosterCursorUrls = {};

async function _buildCursorDataUrl(src, size = 48) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      c.getContext('2d').drawImage(img, 0, 0, size, size);
      resolve(c.toDataURL());
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function preCacheBoosterCursors() {
  const specs = {
    row:       { src: '/assets/boosters-2d/row-clear.png',  hot: '24 24', size: 48 },
    col:       { src: '/assets/boosters-2d/col-clear.png',  hot: '24 24', size: 48 },
    hammer:    { src: '/assets/boosters-2d/hammer.png',     hot: '14 14', size: 28 },
    colorBomb: { src: '/assets/boosters-2d/color-bomb.png', hot: '24 24', size: 48 },
  };
  await Promise.all(Object.entries(specs).map(async ([type, { src, hot, size }]) => {
    const dataUrl = await _buildCursorDataUrl(src, size ?? 48);
    _boosterCursorUrls[type] = dataUrl
      ? `url(${dataUrl}) ${hot}, crosshair`
      : 'crosshair';
  }));
}

function applyBoosterCursor(type) {
  canvas.style.cursor = type ? (_boosterCursorUrls[type] || 'crosshair') : '';
}

// ═══════════════════════════════════════════════════════════════
//  GRID
// ═══════════════════════════════════════════════════════════════
function gridToWorld(row, col) {
  return new THREE.Vector3(
    (col - (GRID - 1) / 2) * CELL,
    ((GRID - 1) / 2 - row) * CELL,
    0
  );
}

// ═══════════════════════════════════════════════════════════════
//  GLB LOADER
// ═══════════════════════════════════════════════════════════════
const loader = createGLTFLoader();
const glbCache = {};

async function loadGLB(url) {
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => {
      const m = gltf.scene;
      m.traverse(ch => {
        if (ch.isMesh) {
          if (ch.material) ch.material.side = THREE.DoubleSide;
        }
      });
      const box = new THREE.Box3().setFromObject(m);
      const sz = new THREE.Vector3(); box.getSize(sz);
      console.log(`GLB ${url} → ${sz.x.toFixed(2)} x ${sz.y.toFixed(2)} x ${sz.z.toFixed(2)}`);
      resolve(m);
    }, null, reject);
  });
}

async function preloadAssets(onEachDone) {
  for (const [type, path] of Object.entries(GLB_PATHS)) {
    try {
      glbCache[type] = await loadGLB(path);
      console.log(`✓ ${type} loaded`);
    } catch (e) { console.warn(`✗ ${type} failed`, e); }
    onEachDone?.();
  }
  // Load blocker GLBs needed for this level
  const blockerTypes = new Set(CONFIG.blockers.map(b => b.type));
  for (const [type, path] of Object.entries(BLOCKER_GLB_PATHS)) {
    if (blockerTypes.has(type)) {
      try {
        blockerGlbCache[type] = await loadGLB(path);
        console.log(`✓ blocker:${type} loaded`);
      } catch (e) { console.warn(`✗ blocker:${type} failed`, e); }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
async function loadGridFrame() {
  try {
    const frame = await loadGLB('/assets/board/grid-frame.glb');

    // Rotate to face camera straight on
    // The model might need rotation — try X = -PI/2 to face forward
    frame.rotation.set(-Math.PI / 2, 0, 0);

    // Measure after rotation
    const box = new THREE.Box3().setFromObject(frame);
    const sz = new THREE.Vector3(); box.getSize(sz);
    console.log(`Frame after rotation: ${sz.x.toFixed(2)} x ${sz.y.toFixed(2)} x ${sz.z.toFixed(2)}`);

    // Scale to fit board + extra margin for thick border
    const boardSize = GRID * CELL + 3.5;
    const maxXY = Math.max(sz.x, sz.y);
    const s = boardSize / maxXY;
    frame.scale.multiplyScalar(s);

    // Center
    const newBox = new THREE.Box3().setFromObject(frame);
    const center = new THREE.Vector3(); newBox.getCenter(center);
    frame.position.sub(center);
    frame.position.z = -1;

    scene.add(frame);
    console.log('✓ Grid frame loaded and positioned');
    return true;
  } catch(e) {
    console.warn('Grid frame failed:', e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  TILE CREATION
// ═══════════════════════════════════════════════════════════════

// Helper: wrap any tile inside a transparent ice shell
function createInsideIceTile(innerType) {
  const wrapper = new THREE.Group();

  // Ice shell
  const iceClone = glbCache['ice'].clone();
  iceClone.traverse(ch => {
    if (ch.isMesh && ch.material) {
      ch.material = ch.material.clone();
      ch.material.transparent = true;
      ch.material.opacity = 0.4;
      ch.material.depthWrite = false;
    }
  });
  const iceFix = TYPE_FIX['ice'];
  const icePivot = new THREE.Group();
  icePivot.add(iceClone);
  icePivot.rotation.set(iceFix.rx, iceFix.ry, iceFix.rz);
  const iceBox = new THREE.Box3().setFromObject(icePivot);
  const iceSize = new THREE.Vector3(); iceBox.getSize(iceSize);
  const iceMax = Math.max(iceSize.x, iceSize.y, iceSize.z);
  if (iceMax > 0) icePivot.scale.multiplyScalar((CELL * 0.85) / iceMax);
  const iceNewBox = new THREE.Box3().setFromObject(icePivot);
  const iceCenter = new THREE.Vector3(); iceNewBox.getCenter(iceCenter);
  icePivot.position.sub(iceCenter);

  // Inner object
  const innerClone = glbCache[innerType].clone();
  innerClone.traverse(ch => {
    if (ch.isMesh && ch.material) ch.material = ch.material.clone();
  });
  const innerFix = TYPE_FIX[innerType];
  const innerPivot = new THREE.Group();
  innerPivot.add(innerClone);
  innerPivot.rotation.set(innerFix.rx, innerFix.ry, innerFix.rz);
  const innerBox = new THREE.Box3().setFromObject(innerPivot);
  const innerSize = new THREE.Vector3(); innerBox.getSize(innerSize);
  const innerMax = Math.max(innerSize.x, innerSize.y, innerSize.z);
  if (innerMax > 0) innerPivot.scale.multiplyScalar((CELL * innerFix.scale) / innerMax);
  const innerNewBox = new THREE.Box3().setFromObject(innerPivot);
  const innerCenter = new THREE.Vector3(); innerNewBox.getCenter(innerCenter);
  innerPivot.position.sub(innerCenter);

  wrapper.add(innerPivot);
  wrapper.add(icePivot);
  return wrapper;
}

function createTileMesh(type) {
  // Inner types render inside a transparent ice shell
  if (INNER_TYPES.has(type) && glbCache[type] && glbCache['ice']) {
    return createInsideIceTile(type);
  }
  // Shell types — standalone
  if (glbCache[type]) {
    const clone = glbCache[type].clone();
    clone.traverse(ch => {
      if (ch.isMesh && ch.material) ch.material = ch.material.clone();
    });
    const fix = TYPE_FIX[type] || { rx: 0, ry: 0, rz: 0, scale: 0.8 };
    const pivot = new THREE.Group();
    pivot.add(clone);
    pivot.rotation.set(fix.rx, fix.ry, fix.rz);
    const box = new THREE.Box3().setFromObject(pivot);
    const size = new THREE.Vector3(); box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) pivot.scale.multiplyScalar((CELL * fix.scale) / maxDim);
    const newBox = new THREE.Box3().setFromObject(pivot);
    const center = new THREE.Vector3(); newBox.getCenter(center);
    const wrapper = new THREE.Group();
    pivot.position.sub(center);
    wrapper.add(pivot);
    return wrapper;
  }
  // Fallback
  return new THREE.Mesh(
    new THREE.DodecahedronGeometry(CELL * 0.35, 0),
    new THREE.MeshPhysicalMaterial({ color: 0x4fc3f7, roughness: 0.15, clearcoat: 0.8 })
  );
}

// ═══════════════════════════════════════════════════════════════
//  BOARD
// ═══════════════════════════════════════════════════════════════
function randomType() { return TILE_TYPES[Math.floor(Math.random() * TILE_TYPES.length)]; }

function addFrozenOverlay(tile) {
  if (!blockerGlbCache['frozen']) {
    // Fallback: semi-transparent blue box
    const geo = new THREE.BoxGeometry(CELL * 0.9, CELL * 0.9, CELL * 0.4);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x88ccff, transparent: true, opacity: 0.35,
      roughness: 0.05, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide,
    });
    const overlay = new THREE.Mesh(geo, mat);
    overlay.position.z = 0.3;
    tile.mesh.add(overlay);
    tile.frozenMesh = overlay;
    return;
  }
  const clone = blockerGlbCache['frozen'].clone();
  clone.traverse(ch => {
    if (ch.isMesh && ch.material) {
      ch.material = ch.material.clone();
      ch.material.transparent = true;
      ch.material.opacity = 0.5;
      ch.material.depthWrite = false;
    }
  });
  const box = new THREE.Box3().setFromObject(clone);
  const sz = new THREE.Vector3(); box.getSize(sz);
  const maxDim = Math.max(sz.x, sz.y, sz.z);
  if (maxDim > 0) clone.scale.multiplyScalar((CELL * 0.9) / maxDim);
  const nb = new THREE.Box3().setFromObject(clone);
  const ct = new THREE.Vector3(); nb.getCenter(ct);
  clone.position.sub(ct);
  clone.position.z = 0.3;
  tile.mesh.add(clone);
  tile.frozenMesh = clone;
}

function removeFrozenOverlay(tile) {
  if (tile.frozenMesh) {
    tile.mesh.remove(tile.frozenMesh);
    tile.frozenMesh = null;
  }
  tile.frozen = false;
}

/** One match-adjacent hit — peels a layer or fully breaks the blocker. */
function damageBlocker(tile) {
  if (!tile?.frozen) return false;
  if ((tile.iceLayer || 0) > 1) {
    tile.iceLayer--;
    return false;
  }
  removeFrozenOverlay(tile);
  tile.iceLayer = 0;
  blockersDestroyed.frozen = (blockersDestroyed.frozen || 0) + 1;
  blockersDestroyed.ice = (blockersDestroyed.ice || 0) + 1;
  return true;
}

/** Booster / hammer — strips all layers and counts one broken blocker. */
function fullyBreakBlocker(tile) {
  if (!tile?.frozen) return;
  removeFrozenOverlay(tile);
  tile.iceLayer = 0;
  blockersDestroyed.frozen = (blockersDestroyed.frozen || 0) + 1;
  blockersDestroyed.ice = (blockersDestroyed.ice || 0) + 1;
}

function createWall(row, col) {
  let mesh;
  if (blockerGlbCache['wall']) {
    const clone = blockerGlbCache['wall'].clone();
    clone.traverse(ch => {
      if (ch.isMesh && ch.material) ch.material = ch.material.clone();
    });
    const box = new THREE.Box3().setFromObject(clone);
    const sz = new THREE.Vector3(); box.getSize(sz);
    const maxDim = Math.max(sz.x, sz.y, sz.z);
    if (maxDim > 0) clone.scale.multiplyScalar((CELL * 0.85) / maxDim);
    const nb = new THREE.Box3().setFromObject(clone);
    const ct = new THREE.Vector3(); nb.getCenter(ct);
    const wrapper = new THREE.Group();
    clone.position.sub(ct);
    wrapper.add(clone);
    mesh = wrapper;
  } else {
    mesh = new THREE.Mesh(
      new THREE.BoxGeometry(CELL * 0.85, CELL * 0.85, CELL * 0.5),
      new THREE.MeshStandardMaterial({ color: 0x556677, roughness: 0.8 })
    );
  }
  mesh.position.copy(gridToWorld(row, col));
  scene.add(mesh);
  return { type: '__wall', mesh, row, col, isWall: true };
}

function createTile(type, row, col, opts = {}) {
  const mesh = createTileMesh(type);
  mesh.position.copy(gridToWorld(row, col));
  scene.add(mesh);
  const tile = { type, mesh, row, col, frozen: false, iceLayer: 0, isWall: false, frozenMesh: null };
  if (opts.frozen) {
    tile.frozen = true;
    addFrozenOverlay(tile);
  }
  if (opts.iceLayer) {
    tile.iceLayer = opts.iceLayer;
    tile.frozen = true;
    addFrozenOverlay(tile);
  }
  return tile;
}

function initBoard() {
  board = [];
  // Fill grid with random tiles avoiding initial matches
  for (let r = 0; r < GRID; r++) {
    board[r] = [];
    for (let c = 0; c < GRID; c++) {
      let type;
      do { type = randomType(); } while (
        (c >= 2 && board[r][c-1]?.type === type && board[r][c-2]?.type === type) ||
        (r >= 2 && board[r-1]?.[c]?.type === type && board[r-2]?.[c]?.type === type)
      );
      board[r][c] = createTile(type, r, c);
    }
  }

  // Place blockers from level config
  for (const blocker of CONFIG.blockers) {
    const positions = getRandomEmptyCells(blocker.count || 0);
    for (const [r, c] of positions) {
      if (blocker.type === 'wall') {
        // Remove existing tile and place wall
        if (board[r][c]?.mesh) scene.remove(board[r][c].mesh);
        board[r][c] = createWall(r, c);
      } else if (blocker.type === 'frozen') {
        // Freeze existing tile
        board[r][c].frozen = true;
        addFrozenOverlay(board[r][c]);
      } else if (blocker.type === 'ice') {
        // Layered ice — frozen with layers
        board[r][c].frozen = true;
        board[r][c].iceLayer = blocker.layers || 1;
        addFrozenOverlay(board[r][c]);
      }
    }
  }
}

function getRandomEmptyCells(count) {
  const available = [];
  // Avoid edges for blockers — keep them interior for better gameplay
  const margin = 1;
  for (let r = margin; r < GRID - margin; r++)
    for (let c = margin; c < GRID - margin; c++)
      if (board[r][c] && !board[r][c].isWall && !board[r][c].frozen)
        available.push([r, c]);
  // Shuffle and take count
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }
  return available.slice(0, Math.min(count, available.length));
}

// ═══════════════════════════════════════════════════════════════
//  MATCH DETECTION
// ═══════════════════════════════════════════════════════════════
/**
 * Returns true if at least one swap of adjacent non-blocker tiles would create
 * a 3+ match. Used by the shuffle booster to verify the post-shuffle board is
 * actually playable (audit H9) — otherwise the player would lose the booster
 * charge AND the level.
 */
function hasAnyValidSwap() {
  const canSwap = (r, c) => {
    const t = board[r]?.[c];
    return !!t && !t.isWall && !t.frozen && !t.isFaller;
  };
  const trySwap = (r1, c1, r2, c2) => {
    if (!canSwap(r1, c1) || !canSwap(r2, c2)) return false;
    const a = board[r1][c1], b = board[r2][c2];
    board[r1][c1] = b; board[r2][c2] = a;
    const has = findMatches().size > 0;
    board[r1][c1] = a; board[r2][c2] = b;
    return has;
  };
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (c + 1 < GRID && trySwap(r, c, r, c + 1)) return true;
      if (r + 1 < GRID && trySwap(r, c, r + 1, c)) return true;
    }
  }
  return false;
}

const MAX_SHUFFLE_ATTEMPTS = 6;

function getShuffleablePositions() {
  const positions = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const t = board[r]?.[c];
      if (t && !t.isWall && !t.frozen && !t.isFaller) positions.push([r, c]);
    }
  }
  return positions;
}

/** Re-roll tile types at given cells until a valid swap exists (or attempts exhausted). */
function rerollShuffleableTiles(positions) {
  const newTiles = [];
  if (positions.length === 0) return newTiles;

  let solvable = false;
  for (let attempt = 0; attempt < MAX_SHUFFLE_ATTEMPTS && !solvable; attempt++) {
    if (attempt > 0) {
      for (const tile of newTiles) {
        try { scene.remove(tile.mesh); } catch (_) {}
      }
    }
    for (const [r, c] of positions) board[r][c] = null;
    newTiles.length = 0;
    for (const [r, c] of positions) {
      let type;
      do { type = randomType(); } while (
        (c >= 2 && board[r][c - 1]?.type === type && board[r][c - 2]?.type === type) ||
        (r >= 2 && board[r - 1]?.[c]?.type === type && board[r - 2]?.[c]?.type === type)
      );
      const tile = createTile(type, r, c);
      board[r][c] = tile;
      newTiles.push(tile);
    }
    solvable = hasAnyValidSwap();
  }
  return newTiles;
}

/** Sync re-roll at level start / after blockers — no animation, no move cost. */
function ensureBoardPlayableSync() {
  if (hasAnyValidSwap()) return;
  const positions = getShuffleablePositions();
  if (positions.length === 0) return;
  for (const [r, c] of positions) {
    const t = board[r][c];
    if (t?.mesh) scene.remove(t.mesh);
    board[r][c] = null;
  }
  rerollShuffleableTiles(positions);
}

/** Free auto-shuffle when no valid swap remains — does not consume a booster or a move. */
async function autoShuffleIfDead() {
  if (gameOver || hasAnyValidSwap()) return false;

  const positions = getShuffleablePositions();
  if (positions.length === 0) return false;

  const wasAnimating = animating;
  animating = true;
  showMsg('No moves — shuffling!', 1400);

  const vanishPs = positions.map(([r, c]) => animShuffleTileVanish(board[r][c].mesh));
  await Promise.all(vanishPs);
  for (const [r, c] of positions) board[r][c] = null;

  const newTiles = rerollShuffleableTiles(positions);
  await Promise.all(
    newTiles.map(tile => animSpawn(tile.mesh, gridToWorld(tile.row, tile.col), 450))
  );
  await delay(80);
  animating = wasAnimating;
  return true;
}

function findMatches() {
  const matched = new Set();
  const runs = [];
  const canMatch = (r, c) => board[r]?.[c] && !board[r][c].isWall && !board[r][c].frozen && !board[r][c].isFaller;
  // Horizontal sweep — each contiguous same-type run of 3+ is one run
  for (let r = 0; r < GRID; r++) {
    let c = 0;
    while (c < GRID) {
      if (!canMatch(r, c)) { c++; continue; }
      const t = board[r][c].type;
      let e = c;
      while (e + 1 < GRID && canMatch(r, e+1) && board[r][e+1].type === t) e++;
      const len = e - c + 1;
      if (len >= 3) {
        for (let i = c; i <= e; i++) matched.add(`${r},${i}`);
        runs.push({ length: len, dir: 'h' });
      }
      c = e + 1;
    }
  }
  // Vertical sweep — same shape
  for (let c = 0; c < GRID; c++) {
    let r = 0;
    while (r < GRID) {
      if (!canMatch(r, c)) { r++; continue; }
      const t = board[r][c].type;
      let e = r;
      while (e + 1 < GRID && canMatch(e+1, c) && board[e+1][c].type === t) e++;
      const len = e - r + 1;
      if (len >= 3) {
        for (let i = r; i <= e; i++) matched.add(`${i},${c}`);
        runs.push({ length: len, dir: 'v' });
      }
      r = e + 1;
    }
  }
  matched.runs = runs;
  return matched;
}

// ═══════════════════════════════════════════════════════════════
//  ANIMATIONS
// ═══════════════════════════════════════════════════════════════
const ease = t => t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
const easeB = t => {
  const n = 7.5625;
  if (t < 1/2.75) return n*t*t;
  if (t < 2/2.75) return n*(t-=1.5/2.75)*t+0.75;
  if (t < 2.5/2.75) return n*(t-=2.25/2.75)*t+0.9375;
  return n*(t-=2.625/2.75)*t+0.984375;
};

function animMove(mesh, target, dur = 250) {
  return new Promise(res => {
    const s = mesh.position.clone(), t0 = performance.now();
    (function tick() {
      const p = Math.min((performance.now() - t0) / dur, 1);
      mesh.position.lerpVectors(s, target, ease(p));
      p < 1 ? requestAnimationFrame(tick) : res();
    })();
  });
}

function animDestroy(mesh, dur = 350) {
  return new Promise(res => {
    const t0 = performance.now(), os = mesh.scale.clone();
    (function tick() {
      const p = Math.min((performance.now() - t0) / dur, 1), s = 1 - p;
      mesh.scale.set(os.x*s, os.y*s, os.z*s);
      mesh.rotation.y += 0.12;
      mesh.traverse(ch => { if (ch.isMesh && ch.material) { ch.material.transparent = true; ch.material.opacity = Math.max(0, s); }});
      p < 1 ? requestAnimationFrame(tick) : (scene.remove(mesh), res());
    })();
  });
}

function animSpawn(mesh, fp, dur = 450) {
  return new Promise(res => {
    mesh.position.set(fp.x, fp.y + GRID * CELL, fp.z);
    mesh.scale.set(0.01, 0.01, 0.01);
    const sp = mesh.position.clone(), t0 = performance.now();
    (function tick() {
      const p = Math.min((performance.now() - t0) / dur, 1), e = easeB(p);
      mesh.position.lerpVectors(sp, fp, e);
      mesh.scale.setScalar(Math.max(0.01, e));
      p < 1 ? requestAnimationFrame(tick) : res();
    })();
  });
}

function animShake(mesh, dur = 300) {
  return new Promise(res => {
    const t0 = performance.now(), ox = mesh.position.x;
    (function tick() {
      const p = Math.min((performance.now() - t0) / dur, 1);
      mesh.position.x = ox + Math.sin(p * Math.PI * 6) * 0.1 * (1 - p);
      p < 1 ? requestAnimationFrame(tick) : (mesh.position.x = ox, res());
    })();
  });
}

// Particles
function particles(pos, color = 0x4fc3f7) {
  for (let i = 0; i < 10; i++) {
    const geo = new THREE.SphereGeometry(0.05, 4, 4);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
    const p = new THREE.Mesh(geo, mat);
    p.position.copy(pos); scene.add(p);
    const vel = new THREE.Vector3((Math.random()-.5)*4, (Math.random()-.5)*4, Math.random()*2+1);
    let life = 0;
    (function tick() {
      life += 0.025;
      if (life >= 1) { scene.remove(p); return; }
      p.position.add(vel.clone().multiplyScalar(0.012));
      vel.z -= 0.03; mat.opacity = 1 - life;
      requestAnimationFrame(tick);
    })();
  }
}

// ═══════════════════════════════════════════════════════════════
//  BOOSTER ANIMATIONS — each booster has its own visual style
// ═══════════════════════════════════════════════════════════════

// ─── Row Booster: splitting-arrow sweep ───────────────────────

/** Builds a right- or left-pointing arrow Shape for Three.js ShapeGeometry. */
function buildArrowShape(direction) {
  const shape = new THREE.Shape();
  const w = CELL * 0.44, h = CELL * 0.28, tip = CELL * 0.34;
  if (direction > 0) {         // right arrow
    shape.moveTo(-w,  h * 0.55); shape.lineTo(0,   h * 0.55);
    shape.lineTo(0,   h);        shape.lineTo(tip,  0);
    shape.lineTo(0,  -h);        shape.lineTo(0,   -h * 0.55);
    shape.lineTo(-w, -h * 0.55); shape.closePath();
  } else {                      // left arrow
    shape.moveTo(w,  h * 0.55);  shape.lineTo(0,   h * 0.55);
    shape.lineTo(0,  h);          shape.lineTo(-tip, 0);
    shape.lineTo(0, -h);          shape.lineTo(0,   -h * 0.55);
    shape.lineTo(w, -h * 0.55);   shape.closePath();
  }
  return shape;
}

/** Creates a glowing arrow group (fill + soft glow halo). */
function createSplitArrow(direction) {
  const fillGeo = new THREE.ShapeGeometry(buildArrowShape(direction));
  const glowGeo = new THREE.ShapeGeometry(buildArrowShape(direction));
  const matFill = new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
  const matGlow = new THREE.MeshBasicMaterial({ color: 0x80ffff, transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false });
  const fill = new THREE.Mesh(fillGeo, matFill);
  const glow = new THREE.Mesh(glowGeo, matGlow);
  glow.scale.setScalar(1.38);
  glow.position.z = -0.05;
  const group = new THREE.Group();
  group.add(glow);
  group.add(fill);
  group._matFill = matFill;
  group._matGlow = matGlow;
  return group;
}

function _disposeArrow(arrow) {
  arrow.children.forEach(ch => { if (ch.geometry) ch.geometry.dispose(); if (ch.material) ch.material.dispose(); });
}

/** Slides a tile mesh off-screen in dirX direction (+1 right, -1 left), then removes it. */
function animSweepOut(mesh, dirX, dur = 270) {
  return new Promise(res => {
    const t0 = performance.now();
    const startX = mesh.position.x;
    const travel = dirX * CELL * (GRID + 2);
    (function tick() {
      const p = Math.min((performance.now() - t0) / dur, 1);
      mesh.position.x = startX + travel * ease(p);
      const fade = 1 - Math.pow(p, 0.7);
      mesh.traverse(ch => { if (ch.isMesh && ch.material) { ch.material.transparent = true; ch.material.opacity = Math.max(0, fade); }});
      p < 1 ? requestAnimationFrame(tick) : (scene.remove(mesh), res());
    })();
  });
}

/**
 * Row booster visual: two arrow halves appear at row centre, split apart and
 * glide to opposite edges, fading as they exit. Tiles are swept outward in a
 * staggered wave that follows each arrow half.
 */
async function animRowBoosterFx(row) {
  const rowY       = gridToWorld(row, 0).y;
  const boardHalfW = ((GRID - 1) / 2) * CELL;
  const edgeX      = boardHalfW + CELL * 1.8;
  const sweepDur   = 420;
  const centerCol  = (GRID - 1) / 2;

  const leftArrow  = createSplitArrow(-1);
  const rightArrow = createSplitArrow(1);
  leftArrow.position.set(-CELL * 0.25,  rowY, 1.2);
  rightArrow.position.set(CELL * 0.25,  rowY, 1.2);
  scene.add(leftArrow);
  scene.add(rightArrow);

  const ps = [];

  // Arrow flight + edge fade-out
  ps.push(new Promise(res => {
    const t0 = performance.now();
    (function tick() {
      const p = Math.min((performance.now() - t0) / sweepDur, 1);
      leftArrow.position.x  = -CELL * 0.25 - p * edgeX;
      rightArrow.position.x =  CELL * 0.25 + p * edgeX;
      const fade = p > 0.62 ? 1 - (p - 0.62) / 0.38 : 1;
      leftArrow._matFill.opacity  = 0.95 * fade;
      leftArrow._matGlow.opacity  = 0.30 * fade;
      rightArrow._matFill.opacity = 0.95 * fade;
      rightArrow._matGlow.opacity = 0.30 * fade;
      if (p < 1) {
        requestAnimationFrame(tick);
      } else {
        scene.remove(leftArrow);  _disposeArrow(leftArrow);
        scene.remove(rightArrow); _disposeArrow(rightArrow);
        res();
      }
    })();
  }));

  // Staggered tile sweep — tiles closest to centre go first
  for (let c = 0; c < GRID; c++) {
    const tile = board[row][c];
    if (!tile || tile.isWall) continue;
    if (tile.frozen) { fullyBreakBlocker(tile); continue; }

    const dir = c <= centerCol ? -1 : 1;
    const distFromCenter = Math.abs(c - centerCol);
    const startDelay = (distFromCenter / Math.max(centerCol, 1)) * sweepDur * 0.48;

    board[row][c] = null;
    recordTileCleared(tile.type, tile.mesh.position.clone());
    particles(tile.mesh.position.clone(), 0x00bfff);

    const captured = tile;
    ps.push(new Promise(res => {
      setTimeout(() => animSweepOut(captured.mesh, dir, 270).then(res), startDelay);
    }));
  }

  await Promise.all(ps);
}

// ─── Col Booster: vertical splitting-arrow sweep ─────────────

/** Builds an up- or down-pointing arrow Shape. */
function buildVerticalArrowShape(direction) {
  const shape = new THREE.Shape();
  const h = CELL * 0.44, w = CELL * 0.28, tip = CELL * 0.34;
  if (direction > 0) {         // up arrow
    shape.moveTo(-w * 0.55, -h); shape.lineTo(-w * 0.55, 0);
    shape.lineTo(-w,  0);        shape.lineTo(0,  tip);
    shape.lineTo( w,  0);        shape.lineTo( w * 0.55, 0);
    shape.lineTo( w * 0.55, -h); shape.closePath();
  } else {                      // down arrow
    shape.moveTo(-w * 0.55,  h); shape.lineTo(-w * 0.55, 0);
    shape.lineTo(-w,  0);        shape.lineTo(0, -tip);
    shape.lineTo( w,  0);        shape.lineTo( w * 0.55, 0);
    shape.lineTo( w * 0.55,  h); shape.closePath();
  }
  return shape;
}

/** Creates a glowing vertical arrow group (fill + soft glow halo). */
function createVerticalSplitArrow(direction) {
  const fillGeo = new THREE.ShapeGeometry(buildVerticalArrowShape(direction));
  const glowGeo = new THREE.ShapeGeometry(buildVerticalArrowShape(direction));
  const matFill = new THREE.MeshBasicMaterial({ color: 0x00ced1, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
  const matGlow = new THREE.MeshBasicMaterial({ color: 0x80ffee, transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false });
  const fill = new THREE.Mesh(fillGeo, matFill);
  const glow = new THREE.Mesh(glowGeo, matGlow);
  glow.scale.setScalar(1.38);
  glow.position.z = -0.05;
  const group = new THREE.Group();
  group.add(glow);
  group.add(fill);
  group._matFill = matFill;
  group._matGlow = matGlow;
  return group;
}

/** Slides a tile mesh off-screen along the Y axis (dirY: +1 up, -1 down), then removes it. */
function animSweepOutY(mesh, dirY, dur = 270) {
  return new Promise(res => {
    const t0 = performance.now();
    const startY = mesh.position.y;
    const travel = dirY * CELL * (GRID + 2);
    (function tick() {
      const p = Math.min((performance.now() - t0) / dur, 1);
      mesh.position.y = startY + travel * ease(p);
      const fade = 1 - Math.pow(p, 0.7);
      mesh.traverse(ch => { if (ch.isMesh && ch.material) { ch.material.transparent = true; ch.material.opacity = Math.max(0, fade); }});
      p < 1 ? requestAnimationFrame(tick) : (scene.remove(mesh), res());
    })();
  });
}

/**
 * Col booster visual: two arrow halves appear at column centre, split apart
 * vertically and glide to opposite edges, fading as they exit. Tiles are
 * swept outward in a staggered wave that follows each arrow half.
 */
async function animColBoosterFx(col) {
  const colX       = gridToWorld(0, col).x;
  const boardHalfH = ((GRID - 1) / 2) * CELL;
  const edgeY      = boardHalfH + CELL * 1.8;
  const sweepDur   = 420;
  const centerRow  = (GRID - 1) / 2;

  const downArrow = createVerticalSplitArrow(-1);
  const upArrow   = createVerticalSplitArrow(1);
  downArrow.position.set(colX, -CELL * 0.25, 1.2);
  upArrow.position.set(  colX,  CELL * 0.25, 1.2);
  scene.add(downArrow);
  scene.add(upArrow);

  const ps = [];

  // Arrow flight + edge fade-out
  ps.push(new Promise(res => {
    const t0 = performance.now();
    (function tick() {
      const p = Math.min((performance.now() - t0) / sweepDur, 1);
      downArrow.position.y = -CELL * 0.25 - p * edgeY;
      upArrow.position.y   =  CELL * 0.25 + p * edgeY;
      const fade = p > 0.62 ? 1 - (p - 0.62) / 0.38 : 1;
      downArrow._matFill.opacity = 0.95 * fade;
      downArrow._matGlow.opacity = 0.30 * fade;
      upArrow._matFill.opacity   = 0.95 * fade;
      upArrow._matGlow.opacity   = 0.30 * fade;
      if (p < 1) {
        requestAnimationFrame(tick);
      } else {
        scene.remove(downArrow); _disposeArrow(downArrow);
        scene.remove(upArrow);   _disposeArrow(upArrow);
        res();
      }
    })();
  }));

  // Staggered tile sweep — tiles nearest centre row launch first
  // In Three.js: row 0 = top (+Y), row GRID-1 = bottom (-Y)
  for (let r = 0; r < GRID; r++) {
    const tile = board[r][col];
    if (!tile || tile.isWall) continue;
    if (tile.frozen) { fullyBreakBlocker(tile); continue; }

    const dir = r <= centerRow ? 1 : -1; // upper half → up (+Y), lower half → down (-Y)
    const distFromCenter = Math.abs(r - centerRow);
    const startDelay = (distFromCenter / Math.max(centerRow, 1)) * sweepDur * 0.48;

    board[r][col] = null;
    recordTileCleared(tile.type, tile.mesh.position.clone());
    particles(tile.mesh.position.clone(), 0x00ced1);

    const captured = tile;
    ps.push(new Promise(res => {
      setTimeout(() => animSweepOutY(captured.mesh, dir, 270).then(res), startDelay);
    }));
  }

  await Promise.all(ps);
}

// ─── Color Bomb: pre-shake candies → chained mini-explosions ───

/** Wobble X/Y + rotation (does not touch Z so the idle float in `animate` still works). */
function animShakeColorBombTile(mesh, dur = 400) {
  return new Promise(res => {
    const t0 = performance.now();
    const ox = mesh.position.x, oy = mesh.position.y;
    const orx = mesh.rotation.x, ory = mesh.rotation.y, orz = mesh.rotation.z;
    (function tick() {
      const p = Math.min((performance.now() - t0) / dur, 1);
      const damp = 1 - p;
      mesh.position.x = ox + Math.sin(p * Math.PI * 11) * 0.13 * damp;
      mesh.position.y = oy + Math.cos(p * Math.PI * 9) * 0.11 * damp;
      mesh.rotation.x = orx + Math.sin(p * Math.PI * 6) * 0.14 * damp;
      mesh.rotation.y = ory + Math.cos(p * Math.PI * 5) * 0.11 * damp;
      mesh.rotation.z = orz + Math.sin(p * Math.PI * 8) * 0.12 * damp;
      p < 1 ? requestAnimationFrame(tick) : (mesh.position.x = ox, mesh.position.y = oy, mesh.rotation.set(orx, ory, orz), res());
    })();
  });
}

/** Single puff: sphere flies outward, scales up, fades. */
function _spawnOneExplosionPuff(pos, colors, baseSpeed, duration) {
  const geo = new THREE.SphereGeometry(0.03 + Math.random() * 0.055, 5, 5);
  const col = colors[Math.floor(Math.random() * colors.length)];
  const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 1, depthWrite: false });
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(pos);
  m.position.z += 0.28 + Math.random() * 0.35;
  scene.add(m);
  const ang = Math.random() * Math.PI * 2;
  const speed = baseSpeed * (0.65 + Math.random() * 0.9);
  let vx = Math.cos(ang) * speed * 0.0175;
  let vy = Math.sin(ang) * speed * 0.0175;
  let vz = (Math.random() - 0.35) * speed * 0.010;
  const t0 = performance.now();
  const life = duration + Math.random() * 70;
  (function tick() {
    const pr = Math.min((performance.now() - t0) / life, 1);
    m.position.x += vx * (1 - pr * 0.55);
    m.position.y += vy * (1 - pr * 0.55);
    m.position.z += vz;
    vz *= 0.94;
    m.scale.setScalar(0.45 + ease(pr) * 2.4);
    mat.opacity = Math.max(0, 1 - Math.pow(pr, 0.62));
    pr < 1 ? requestAnimationFrame(tick) : (scene.remove(m), geo.dispose(), mat.dispose());
  })();
}

/**
 * A cluster of small “sub-explosions”: radial puffs + expanding ring,
 * with 2–3 timed micro-bursts for a candy-bomb feel.
 */
function spawnMiniExplosionCluster(pos, options = {}) {
  const count = options.count ?? 10;
  const colors = options.colors ?? [0xff66aa, 0xff4488, 0xffaa66, 0xffccff, 0xffffff];
  const baseSpeed = options.baseSpeed ?? CELL * 0.45;
  const duration = options.duration ?? 280;

  const burst = (n, speedMul, tOffset) => {
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        _spawnOneExplosionPuff(pos, colors, baseSpeed * speedMul, duration);
      }, tOffset + i * 6);
    }
  };

  burst(Math.max(4, Math.floor(count * 0.55)), 1.0, 0);
  burst(Math.max(3, Math.floor(count * 0.35)), 0.75, 32);
  burst(Math.max(2, Math.floor(count * 0.25)), 0.55, 68);

  const ringGeo = new THREE.RingGeometry(0.06, 0.14, 20);
  const ringColor = options.ringColor ?? 0xff99cc;
  const ringMat = new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(pos);
  ring.position.z = 0.85;
  scene.add(ring);
  const t0 = performance.now();
  (function tickRing() {
    const pr = Math.min((performance.now() - t0) / 220, 1);
    ring.scale.setScalar(1 + pr * 5.5);
    ringMat.opacity = 0.9 * (1 - pr);
    pr < 1 ? requestAnimationFrame(tickRing) : (scene.remove(ring), ringGeo.dispose(), ringMat.dispose());
  })();
}

/** Final shatter: quick pop + spin + fade, then remove mesh. */
function animColorBombShatter(mesh, dur = 270) {
  return new Promise(res => {
    const t0 = performance.now(), os = mesh.scale.clone();
    (function tick() {
      const p = Math.min((performance.now() - t0) / dur, 1);
      const pulse = p < 0.22 ? 1 + Math.sin((p / 0.22) * Math.PI) * 0.42 : 1;
      const shrink = p < 0.22 ? pulse : pulse * (1 - (p - 0.22) / 0.78);
      mesh.scale.set(os.x * shrink, os.y * shrink, os.z * shrink);
      mesh.rotation.z += 0.16;
      mesh.rotation.x += 0.05;
      const fade = 1 - Math.pow(p, 0.48);
      mesh.traverse(ch => { if (ch.isMesh && ch.material) { ch.material.transparent = true; ch.material.opacity = Math.max(0, fade); }});
      p < 1 ? requestAnimationFrame(tick) : (scene.remove(mesh), res());
    })();
  });
}

// ─── Hammer: swing → impact → same mini-explosion + shatter ───

const HAMMER_EXPLOSION_COLORS = [0xffb800, 0xff8800, 0xffdd44, 0xffffff, 0xffaa66];
const HAMMER_ICE_EXPLOSION_COLORS = [0x88ccff, 0xaaeeff, 0xffffff, 0x66b8ff];

const HAMMER_SWING_GLB = '/assets/boosters/hammer.glb';
/**
 * Lay the hammer in the board plane (horizontal strike): pitch about X, not yaw about Y.
 * Model is usually upright in GLB; ±π/2 drops it flat on XY. Flip sign if head points wrong.
 */
const HAMMER_SWING_PITCH_X = Math.PI / 2;
/** In-plane heading (right→left) — added to swing Z; keeps arc in horizontal plane. */
const HAMMER_SWING_Z_BASE = Math.PI / 2;
/** Show hammer in GLB default orientation first (no pitch / horizontal offset). */
const HAMMER_SWING_INITIAL_FRAC = 0.11;
/** Smoothly rotate into horizontal strike pose (pitch + in-plane base) before the swing arc. */
const HAMMER_SWING_HORIZONTAL_BLEND_FRAC = 0.08;
/**
 * Pivot-local positions (strike is origin). Small |x|, large +y = above candy, slam is mostly −y (overhead).
 */
const HAMMER_SWING_POS_PRE = { x: 0.06, y: 0.92, z: 0.18 };
const HAMMER_SWING_POS_WIND = { x: 0.04, y: 1.05, z: 0.18 };
const HAMMER_SWING_POS_IMPACT = { x: 0, y: -0.06, z: 0.14 };

/** Single reused mesh for every hammer swing (no new geometry per hit). */
let _hammerSwingModel = null;
let _hammerSwingFadeMats = [];
let _hammerSwingLoadPromise = null;

/** World point on the top-front of the cell — hammer head targets this (not cell centre). */
function hammerStrikePoint(cellCenterWorld) {
  return new THREE.Vector3(
    cellCenterWorld.x,
    cellCenterWorld.y + CELL * 0.46,
    Math.max(cellCenterWorld.z, 0) + 0.88
  );
}

/**
 * Load & normalize the shop / booster-tray hammer GLB once; clone materials so fade-out is safe.
 */
async function ensureHammerSwingModel() {
  if (_hammerSwingModel) return;
  if (!_hammerSwingLoadPromise) {
    _hammerSwingLoadPromise = (async () => {
      try {
        const loaded = await loadGLB(HAMMER_SWING_GLB);
        const root = loaded.clone(true);
        root.traverse(ch => {
          if (ch.isMesh && ch.material) {
            if (Array.isArray(ch.material)) {
              ch.material = ch.material.map(m => {
                const c = m.clone();
                c.transparent = true;
                c.depthWrite = false;
                return c;
              });
            } else {
              const c = ch.material.clone();
              c.transparent = true;
              c.depthWrite = false;
              ch.material = c;
            }
          }
        });
        const box = new THREE.Box3().setFromObject(root);
        const sz = new THREE.Vector3();
        box.getSize(sz);
        const maxD = Math.max(sz.x, sz.y, sz.z, 1e-6);
        root.scale.multiplyScalar((CELL * 0.52) / maxD);
        const nb = new THREE.Box3().setFromObject(root);
        const c = new THREE.Vector3();
        nb.getCenter(c);
        root.position.sub(c);
        _hammerSwingFadeMats = [];
        root.traverse(ch => {
          if (ch.isMesh && ch.material) {
            const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
            for (const m of mats) _hammerSwingFadeMats.push(m);
          }
        });
        _hammerSwingModel = root;
        _hammerSwingModel.visible = false;
      } catch (e) {
        console.warn('hammer.glb swing reuse failed, procedural fallback:', e);
        _hammerSwingModel = createHammerProceduralFallback();
        _hammerSwingFadeMats = [];
        _hammerSwingModel.traverse(ch => {
          if (ch.isMesh && ch.material) _hammerSwingFadeMats.push(ch.material);
        });
        _hammerSwingModel.visible = false;
      }
    })();
  }
  await _hammerSwingLoadPromise;
}

function _resetHammerSwingOpacity() {
  for (const m of _hammerSwingFadeMats) {
    if (m) m.opacity = 1;
  }
}

/** Detach reusable hammer from pivot; dispose only the empty pivot. */
function _finishHammerSwing(pivot) {
  const h = _hammerSwingModel;
  if (h && h.parent === pivot) pivot.remove(h);
  scene.remove(pivot);
  if (h) h.visible = false;
  _resetHammerSwingOpacity();
}

/**
 * Fallback ~½-tile primitive hammer if GLB fails (matches swing rig orientation).
 */
function createHammerProceduralFallback() {
  const g = new THREE.Group();
  const handleMat = new THREE.MeshBasicMaterial({
    color: 0x5a3928, transparent: true, opacity: 1, depthTest: true, depthWrite: false,
  });
  const headMat = new THREE.MeshBasicMaterial({
    color: 0xd8e0ea, transparent: true, opacity: 1, depthTest: true, depthWrite: false,
  });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.042, 0.62, 8), handleMat);
  handle.position.y = -0.31;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.085, 0.09), headMat);
  head.position.set(0.04, 0.065, 0);
  g.add(handle);
  g.add(head);
  g.scale.setScalar(0.98);
  return g;
}

/**
 * Pivot sits on strike point (top of candy). Hammer swings down from above so the head
 * meets the tile top, not the cell below (centre Y would read as a “lower” hit in screen space).
 */
async function animHammerSwing(strikePoint, onImpact) {
  await ensureHammerSwingModel();
  const hammer = _hammerSwingModel;
  const fadeMats = _hammerSwingFadeMats;

  return new Promise(res => {
    const pivot = new THREE.Group();
    pivot.position.copy(strikePoint);
    scene.add(pivot);

    hammer.visible = true;
    _resetHammerSwingOpacity();
    hammer.rotation.order = 'YXZ';
    pivot.add(hammer);

    const totalMs = 520;
    const t0 = performance.now();
    let impacted = false;

    const T_INIT = HAMMER_SWING_INITIAL_FRAC;
    const T_BLEND_END = T_INIT + HAMMER_SWING_HORIZONTAL_BLEND_FRAC;

    (function tick() {
      const p = Math.min((performance.now() - t0) / totalMs, 1);

      if (p < T_INIT) {
        hammer.position.set(HAMMER_SWING_POS_PRE.x, HAMMER_SWING_POS_PRE.y, HAMMER_SWING_POS_PRE.z);
        hammer.rotation.set(0, 0, -1.78);
      } else if (p < T_BLEND_END) {
        const b = ease((p - T_INIT) / (T_BLEND_END - T_INIT));
        hammer.position.set(HAMMER_SWING_POS_PRE.x, HAMMER_SWING_POS_PRE.y, HAMMER_SWING_POS_PRE.z);
        hammer.rotation.set(
          b * HAMMER_SWING_PITCH_X,
          0,
          -1.78 + b * HAMMER_SWING_Z_BASE
        );
      } else {
        const pRem = (p - T_BLEND_END) / (1 - T_BLEND_END);

        if (pRem < 0.32) {
          const q = pRem / 0.32;
          const e = ease(q);
          hammer.position.set(
            HAMMER_SWING_POS_PRE.x + e * (HAMMER_SWING_POS_WIND.x - HAMMER_SWING_POS_PRE.x),
            HAMMER_SWING_POS_PRE.y + e * (HAMMER_SWING_POS_WIND.y - HAMMER_SWING_POS_PRE.y),
            HAMMER_SWING_POS_PRE.z + e * (HAMMER_SWING_POS_WIND.z - HAMMER_SWING_POS_PRE.z)
          );
          hammer.rotation.set(HAMMER_SWING_PITCH_X, 0, HAMMER_SWING_Z_BASE + (-1.78 - e * 0.16));
        } else if (pRem < 0.50) {
          const q = (pRem - 0.32) / 0.18;
          const slam = q * q * q;
          hammer.position.set(
            HAMMER_SWING_POS_WIND.x + (HAMMER_SWING_POS_IMPACT.x - HAMMER_SWING_POS_WIND.x) * slam,
            HAMMER_SWING_POS_WIND.y + (HAMMER_SWING_POS_IMPACT.y - HAMMER_SWING_POS_WIND.y) * slam,
            HAMMER_SWING_POS_WIND.z + (HAMMER_SWING_POS_IMPACT.z - HAMMER_SWING_POS_WIND.z) * slam
          );
          hammer.rotation.set(HAMMER_SWING_PITCH_X, 0, HAMMER_SWING_Z_BASE + (-1.94 + slam * 0.95));
          if (!impacted && q >= 0.75) {
            impacted = true;
            onImpact?.();
          }
        } else {
          if (!impacted) {
            impacted = true;
            onImpact?.();
          }
          const q = (pRem - 0.50) / 0.50;
          hammer.position.set(
            HAMMER_SWING_POS_IMPACT.x,
            HAMMER_SWING_POS_IMPACT.y + 0.02 * q,
            HAMMER_SWING_POS_IMPACT.z
          );
          for (const m of fadeMats) m.opacity = Math.max(0, 1 - q * 1.18);
        }
      }

      p < 1 ? requestAnimationFrame(tick) : (_finishHammerSwing(pivot), res());
    })();
  });
}

async function animHammerHitCandy(candyMesh, cellCenterWorld) {
  const strike = hammerStrikePoint(cellCenterWorld);
  let shatterP = null;
  await animHammerSwing(strike, () => {
    const os = candyMesh.scale.clone();
    candyMesh.scale.set(os.x * 1.08, os.y * 0.32, os.z * 1.06);
    const burstPos = cellCenterWorld.clone();
    burstPos.z += 0.35;
    spawnMiniExplosionCluster(burstPos, {
      count: 15,
      baseSpeed: CELL * 0.52,
      colors: HAMMER_EXPLOSION_COLORS,
      ringColor: 0xffaa55,
    });
    spawnMiniExplosionCluster(burstPos, {
      count: 8,
      baseSpeed: CELL * 0.34,
      duration: 230,
      colors: [0xffee88, 0xff6600, 0xffffff],
      ringColor: 0xffcc77,
    });
    particles(burstPos.clone(), 0xffb800);
    shatterP = animColorBombShatter(candyMesh, 275);
  });
  if (shatterP) await shatterP;
}

async function animHammerBreakIce(tile, cellCenterWorld) {
  await animHammerSwing(hammerStrikePoint(cellCenterWorld), () => {
    const burstPos = cellCenterWorld.clone();
    burstPos.z += 0.35;
    spawnMiniExplosionCluster(burstPos, {
      count: 12,
      baseSpeed: CELL * 0.4,
      colors: HAMMER_ICE_EXPLOSION_COLORS,
      ringColor: 0x99ddff,
    });
    particles(burstPos.clone(), 0xaaeeff);
    fullyBreakBlocker(tile);
  });
  await animShake(tile.mesh, 220);
}

async function animColorBombBoosterFx(originRow, originCol, targets) {
  await Promise.all(targets.map(({ mesh }) => animShakeColorBombTile(mesh, 400)));
  await delay(90);

  const originWp = gridToWorld(originRow, originCol);
  spawnMiniExplosionCluster(originWp, { count: 18, baseSpeed: CELL * 0.55, colors: [0xff66ee, 0xff8844, 0xffccff, 0xffffff] });
  await delay(50);

  const sorted = [...targets].sort((a, b) =>
    (Math.abs(a.r - originRow) + Math.abs(a.c - originCol)) -
    (Math.abs(b.r - originRow) + Math.abs(b.c - originCol))
  );
  const maxMan = Math.max(...sorted.map(t => Math.abs(t.r - originRow) + Math.abs(t.c - originCol)), 1);

  const ps = sorted.map((t, idx) => {
    const man = Math.abs(t.r - originRow) + Math.abs(t.c - originCol);
    const wave = (man / maxMan) * 160 + idx * 14;
    const wp = gridToWorld(t.r, t.c);
    return delay(wave).then(() => {
      spawnMiniExplosionCluster(wp, { count: 11, baseSpeed: CELL * 0.42 });
      spawnMiniExplosionCluster(wp, { count: 7, baseSpeed: CELL * 0.3, duration: 220, colors: [0xffaa88, 0xff4488, 0xffffee] });
      particles(wp.clone(), 0xff66aa);
      return animColorBombShatter(t.mesh, 265);
    });
  });
  await Promise.all(ps);
}

// ═══════════════════════════════════════════════════════════════
//  GAME FLOW
// ═══════════════════════════════════════════════════════════════
async function swapTiles(r1, c1, r2, c2) {
  const a = board[r1][c1], b = board[r2][c2];
  await Promise.all([animMove(a.mesh, gridToWorld(r2, c2)), animMove(b.mesh, gridToWorld(r1, c1))]);
  board[r1][c1] = b; board[r2][c2] = a;
  a.row = r2; a.col = c2; b.row = r1; b.col = c1;
}

async function removeMatches(matched) {
  const cols = { ice: 0x4fc3f7, popsicle: 0x7cb342, fish: 0xff7043, frostice: 0xe0f0ff, shrimp: 0xff5544, crab: 0xff8844 };
  const ps = [];
  const unfrozen = new Set();

  for (const k of matched) {
    const [r, c] = k.split(',').map(Number);
    if (board[r][c]) {
      const tileType = board[r][c].type;
      const wp = board[r][c].mesh.position.clone();
      particles(wp, cols[tileType] || 0xfff);
      ps.push(animDestroy(board[r][c].mesh));

      recordTileCleared(tileType, wp);

      // Check adjacent cells for frozen tiles to unfreeze
      for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nr = r + dr, nc = c + dc;
        const adj = board[nr]?.[nc];
        if (adj && adj.frozen && !unfrozen.has(`${nr},${nc}`)) {
          unfrozen.add(`${nr},${nc}`);
          const broken = damageBlocker(adj);
          if (broken) {
            particles(adj.mesh.position.clone(), 0xaaeeff);
          } else {
            ps.push(animShake(adj.mesh, 200));
            particles(adj.mesh.position.clone(), 0x88ccff);
          }
        }
      }

      board[r][c] = null;
    }
  }
  await Promise.all(ps);
}

async function dropTiles() {
  const ps = [];
  for (let c = 0; c < GRID; c++) {
    let wr = GRID - 1;
    for (let r = GRID - 1; r >= 0; r--) {
      const tile = board[r][c];
      if (!tile) continue;
      if (tile.isWall) { wr = r - 1; continue; } // Walls stay put, skip over
      if (tile.isFaller) { wr = r - 1; continue; } // Fallers stay put during match cascades
      if (r !== wr) {
        board[wr][c] = tile; board[r][c] = null;
        tile.row = wr;
        ps.push(animMove(tile.mesh, gridToWorld(wr, c), 300));
      }
      wr--;
    }
    // Fill empty cells above (skip wall rows)
    for (let r = wr; r >= 0; r--) {
      if (board[r][c]?.isWall || board[r][c]?.isFaller) continue;
      const t = randomType(), tile = createTile(t, r, c);
      board[r][c] = tile;
      ps.push(animSpawn(tile.mesh, gridToWorld(r, c), 450));
    }
  }
  await Promise.all(ps);
}

async function processMatches() {
  combo = 0;
  let m = findMatches();
  while (m.size > 0) {
    combo++; score += Math.round(m.size * 10 * combo * TRAITS.scoreMultiplier * Inventory.getScoreMultiplier());
    if (combo === 5) { journal.bigCombos++; Events.bigCombo(combo, levelNum); }
    else if (combo > 5) { journal.bigCombos++; /* extension of an already-tracked combo */ }
    // Mid-level shard drops: any 4+ run rolls each shard independently
    // (necklace 20% · crown 10% · plooshie 5%). A match can award 0..3.
    for (const run of (m.runs || [])) {
      if (run.length >= 4) {
        for (const id of rollShardsForMatch()) awardShard(id);
      }
    }
    updateHUD();
    await removeMatches(m);
    await delay(100);
    await dropTiles();
    await delay(150);
    m = findMatches();
  }
  combo = 0; updateHUD();
}

// ═══════════════════════════════════════════════════════════════
//  FALLING BLOCKERS
// ═══════════════════════════════════════════════════════════════
function createFallerMesh() {
  if (blockerGlbCache['faller']) {
    const clone = blockerGlbCache['faller'].clone();
    clone.traverse(ch => {
      if (ch.isMesh && ch.material) ch.material = ch.material.clone();
    });
    const box = new THREE.Box3().setFromObject(clone);
    const sz = new THREE.Vector3(); box.getSize(sz);
    const maxDim = Math.max(sz.x, sz.y, sz.z);
    if (maxDim > 0) clone.scale.multiplyScalar((CELL * 0.75) / maxDim);
    const nb = new THREE.Box3().setFromObject(clone);
    const ct = new THREE.Vector3(); nb.getCenter(ct);
    const wrapper = new THREE.Group();
    clone.position.sub(ct);
    wrapper.add(clone);
    return wrapper;
  }
  // Fallback: cyan icicle shape
  const geo = new THREE.ConeGeometry(CELL * 0.25, CELL * 0.7, 6);
  const mat = new THREE.MeshStandardMaterial({ color: 0x88ccff, roughness: 0.15, metalness: 0.1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI; // point down
  return mesh;
}

function spawnFaller() {
  // Pick a random column that has an empty or swappable tile in row 0
  const candidates = [];
  for (let c = 0; c < GRID; c++) {
    if (!board[0][c] || (!board[0][c].isWall && !board[0][c].isFaller)) candidates.push(c);
  }
  if (candidates.length === 0) return;
  const col = candidates[Math.floor(Math.random() * candidates.length)];

  // Remove existing tile at row 0 if present
  if (board[0][col] && !board[0][col].isWall) {
    scene.remove(board[0][col].mesh);
    board[0][col] = null;
  }

  const mesh = createFallerMesh();
  mesh.position.copy(gridToWorld(0, col));
  scene.add(mesh);
  board[0][col] = { type: '__faller', mesh, row: 0, col, isWall: false, isFaller: true, frozen: false };
}

async function dropFallers() {
  const ps = [];
  // Process from bottom to top so fallers don't collide
  for (let c = 0; c < GRID; c++) {
    for (let r = GRID - 1; r >= 0; r--) {
      const tile = board[r][c];
      if (!tile || !tile.isFaller) continue;

      if (r === GRID - 1) {
        // Hit bottom — penalty!
        particles(tile.mesh.position.clone(), 0xff4444);
        await animDestroy(tile.mesh);
        board[r][c] = null;
        const prevMoves = moves;
        moves = Math.max(0, moves - 1);
        maybeWarnLowMoves(prevMoves);
        fallerDropsPenalized++;
        updateHUD();
        showMsg('-1 Move!', 600);
        Events.fallerPenalty(levelNum);

        // Refill with a normal tile
        const t = randomType();
        const newTile = createTile(t, r, c);
        board[r][c] = newTile;
        continue;
      }

      // Check cell below
      const below = board[r + 1]?.[c];
      if (below && (below.isWall || below.isFaller)) continue; // blocked

      // Move faller down one row
      if (below && !below.isWall) {
        // Swap with the tile below
        board[r + 1][c] = tile;
        board[r][c] = below;
        tile.row = r + 1;
        below.row = r;
        ps.push(animMove(tile.mesh, gridToWorld(r + 1, c), 200));
        ps.push(animMove(below.mesh, gridToWorld(r, c), 200));
      } else if (!below) {
        board[r + 1][c] = tile;
        board[r][c] = null;
        tile.row = r + 1;
        ps.push(animMove(tile.mesh, gridToWorld(r + 1, c), 200));
      }
    }
  }
  if (ps.length) await Promise.all(ps);
}

async function processFallers() {
  if (!fallerConfig) return;
  turnCount++;
  if (turnCount % fallerConfig.interval !== 0) return;
  fallerDropCycles++;
  spawnFaller();
  await delay(200);
  await dropFallers();
}

/** After cascades settle: faller step, auto-shuffle if dead, then win / out-of-moves popup. */
async function resolveLevelStateAfterBoardSettled() {
  await processFallers();
  if (gameOver) return;
  if (await autoShuffleIfDead()) return;
  syncGoalDisplayToActual();
  if (isLevelWin()) {
    await delay(400);
    showLevelPopup(true);
  } else if (moves <= 0) {
    await delay(400);
    showLevelPopup(false);
  }
}

function meetsScoreTarget() {
  return score >= CONFIG.targetScore;
}

function countRemainingBreakableBlockers() {
  let n = 0;
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const t = board[r]?.[c];
      if (!t || t.isWall || t.isFaller) continue;
      if (t.frozen || (t.iceLayer || 0) > 0) n++;
    }
  }
  return n;
}

function meetsPrimaryObjective() {
  const obj = CONFIG.objective;
  switch (obj.type) {
    case 'score':
      return score >= obj.target;
    case 'clearTile':
      if (obj.tileType === 'any') return totalTilesCleared >= obj.count;
      return (tilesCleared[obj.tileType] || 0) >= obj.count;
    case 'breakBlocker':
      return (blockersDestroyed[obj.blockerType] || 0) >= obj.count;
    case 'breakAll':
      return countRemainingBreakableBlockers() === 0;
    case 'clearPercent': {
      const total = GRID * GRID;
      return totalTilesCleared >= Math.ceil(total * obj.percent / 100);
    }
    case 'combo': {
      if (obj.blockerType != null && obj.blockerCount != null) {
        if ((blockersDestroyed[obj.blockerType] || 0) < obj.blockerCount) return false;
      }
      if (obj.surviveDrops != null && fallerDropCycles < obj.surviveDrops) return false;
      return true;
    }
    default:
      return true;
  }
}

function isLevelWin() {
  return meetsPrimaryObjective() && meetsScoreTarget();
}

function getFailPopupMessage() {
  const primaryDone = meetsPrimaryObjective();
  const scoreDone = meetsScoreTarget();
  const chip = getObjectiveChip(CONFIG);
  let msg = 'Try again!';
  if (!primaryDone && !scoreDone) {
    msg = chip
      ? 'Reach the score target and complete the objective'
      : 'Reach the score target';
  } else if (!scoreDone) {
    msg = `Need ${CONFIG.targetScore.toLocaleString()} points`;
  } else if (!primaryDone) {
    msg = chip ? 'Objective not complete' : 'Try again!';
  }
  if (!canSpendLife()) msg += ' · No lives left';
  return msg;
}

function countsForObjectiveTile(tileType) {
  const obj = CONFIG.objective;
  if (obj?.type !== 'clearTile') return false;
  return obj.tileType === 'any' || obj.tileType === tileType;
}

function shouldAnimateObjectiveCollect(tileType) {
  return countsForObjectiveTile(tileType) && !!getObjectiveChip(CONFIG);
}

function recordTileCleared(tileType, worldPos = null) {
  tilesCleared[tileType] = (tilesCleared[tileType] || 0) + 1;
  totalTilesCleared++;
  if (shouldAnimateObjectiveCollect(tileType)) {
    spawnObjectiveCollectFx(worldPos, tileType);
  } else if (countsForObjectiveTile(tileType)) {
    goalDisplayCount = getActualObjectiveTileCount();
    syncGoalHud();
    const gc = document.getElementById('goalCanvas');
    if (gc) drawHUDPanel(gc);
  }
}

function getActualObjectiveTileCount() {
  const obj = CONFIG.objective;
  if (obj?.type !== 'clearTile') return goalDisplayCount;
  return obj.tileType === 'any'
    ? totalTilesCleared
    : (tilesCleared[obj.tileType] || 0);
}

function syncGoalDisplayToActual() {
  goalDisplayCount = getActualObjectiveTileCount();
}

function worldToScreen(worldPos) {
  const v = worldPos.clone().project(camera);
  const rect = canvas.getBoundingClientRect();
  return {
    x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
    y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
  };
}

function getGoalHudTargetScreenPoint() {
  const gc = document.getElementById('goalCanvas');
  if (!gc) return { x: window.innerWidth * 0.5, y: 48 };
  const rect = gc.getBoundingClientRect();
  const box = getGoalPanelImageRect(gc);
  const sx = rect.width / gc.width;
  const sy = rect.height / gc.height;
  return {
    x: rect.left + (box.x + box.w * 0.68) * sx,
    y: rect.top + goalPanelValueY(box) * sy,
  };
}

let goalFlyStaggerMs = 0;

function spawnObjectiveCollectFx(worldPos, tileType) {
  const layer = document.getElementById('goalFlyLayer');
  const color = OBJECTIVE_TILE_COLORS[tileType] || 0xff9040;
  const hex = `#${color.toString(16).padStart(6, '0')}`;

  const finish = () => {
    goalDisplayCount = Math.min(getActualObjectiveTileCount(), goalDisplayCount + 1);
    const gc = document.getElementById('goalCanvas');
    if (gc) {
      gc._goalCountPulseUntil = performance.now() + 320;
      syncGoalHud();
      drawHUDPanel(gc);
    }
  };

  if (!layer || !worldPos) {
    finish();
    return;
  }

  const delay = goalFlyStaggerMs;
  goalFlyStaggerMs += 70;
  setTimeout(() => {
    goalFlyStaggerMs = Math.max(0, goalFlyStaggerMs - 70);

    const from = worldToScreen(worldPos);
    const to = getGoalHudTargetScreenPoint();
    const spark = document.createElement('div');
    spark.className = 'goal-fly-spark';
    spark.style.boxShadow = `0 0 10px ${hex}, 0 0 22px ${hex}88`;
    spark.style.background = `radial-gradient(circle, #fff 0%, ${hex} 42%, rgba(255,112,67,0) 72%)`;
    layer.appendChild(spark);

    const dur = 520;
    const t0 = performance.now();
    (function tick(now) {
      const p = Math.min((now - t0) / dur, 1);
      const e = 1 - Math.pow(1 - p, 2.4);
      const x = from.x + (to.x - from.x) * e;
      const y = from.y + (to.y - from.y) * e - Math.sin(p * Math.PI) * 36;
      spark.style.left = `${x}px`;
      spark.style.top = `${y}px`;
      spark.style.opacity = p < 0.08 ? p / 0.08 : p > 0.88 ? (1 - p) / 0.12 : 1;
      spark.style.transform = `translate(-50%, -50%) scale(${0.55 + p * 0.65})`;

      if (p > 0.12 && p < 0.88 && Math.random() < 0.45) {
        const trail = document.createElement('div');
        trail.className = 'goal-fly-spark--trail';
        trail.style.left = `${x}px`;
        trail.style.top = `${y}px`;
        trail.style.opacity = '0.7';
        layer.appendChild(trail);
        setTimeout(() => trail.remove(), 180);
      }

      if (p < 1) requestAnimationFrame(tick);
      else {
        spark.remove();
        finish();
      }
    })(t0);
  }, delay);
}

async function bakeObjectiveTileIcon(tileType) {
  if (goalIconBakeCache[tileType]) return goalIconBakeCache[tileType];
  if (!glbCache[tileType]) return null;

  const offCanvas = document.createElement('canvas');
  offCanvas.width = 128;
  offCanvas.height = 128;

  const pr = new THREE.WebGLRenderer({ canvas: offCanvas, antialias: true, alpha: true });
  pr.setSize(128, 128);
  pr.setClearColor(0x000000, 0);
  pr.toneMapping = THREE.ACESFilmicToneMapping;
  pr.toneMappingExposure = 1.4;

  const ps = new THREE.Scene();
  ps.add(new THREE.AmbientLight(0xd0ecff, 1.2));
  const kl = new THREE.DirectionalLight(0xffffff, 1.4);
  kl.position.set(4, 6, 12);
  ps.add(kl);
  ps.add(new THREE.DirectionalLight(0x80d0ff, 0.45).translateX(-4));

  const tileMesh = INNER_TYPES.has(tileType)
    ? createInsideIceTile(tileType)
    : (() => {
        const g = new THREE.Group();
        const clone = glbCache[tileType].clone();
        clone.traverse(ch => { if (ch.isMesh && ch.material) ch.material = ch.material.clone(); });
        const fix = TYPE_FIX[tileType] || { rx: 0, ry: 0, rz: 0, scale: 0.85 };
        const pivot = new THREE.Group();
        pivot.add(clone);
        pivot.rotation.set(fix.rx, fix.ry, fix.rz);
        const box = new THREE.Box3().setFromObject(pivot);
        const sz = new THREE.Vector3(); box.getSize(sz);
        const max = Math.max(sz.x, sz.y, sz.z);
        if (max > 0) pivot.scale.multiplyScalar((CELL * fix.scale) / max);
        const nb = new THREE.Box3().setFromObject(pivot);
        const ct = new THREE.Vector3(); nb.getCenter(ct);
        pivot.position.sub(ct);
        g.add(pivot);
        return g;
      })();

  ps.add(tileMesh);
  const box = new THREE.Box3().setFromObject(tileMesh);
  const sz = new THREE.Vector3(); box.getSize(sz);
  const maxDim = Math.max(sz.x, sz.y, sz.z);
  tileMesh.scale.multiplyScalar(1.65 / maxDim);
  const nb = new THREE.Box3().setFromObject(tileMesh);
  const ct = new THREE.Vector3(); nb.getCenter(ct);
  tileMesh.position.sub(ct);

  const finalBox = new THREE.Box3().setFromObject(tileMesh);
  const finalSz = new THREE.Vector3(); finalBox.getSize(finalSz);
  const pad = 1.15;
  const half = Math.max(finalSz.x, finalSz.y, finalSz.z) * pad / 2;
  const pc = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 100);
  pc.position.set(0, 0, 20);
  pc.lookAt(0, 0, 0);
  pr.render(ps, pc);
  pr.dispose();

  const img = new Image();
  img.src = offCanvas.toDataURL();
  await img.decode();
  goalIconBakeCache[tileType] = img;
  return img;
}

async function ensureGoalTileIcon(goalCanvas, tileType) {
  if (!goalCanvas || !tileType) return;
  if (goalCanvas._goalIconKey === tileType && goalCanvas._goalIcon?.complete) return;
  const img = await bakeObjectiveTileIcon(tileType);
  if (!img) return;
  goalCanvas._goalIconKey = tileType;
  goalCanvas._goalIcon = img;
  drawHUDPanel(goalCanvas);
}

function getGoalHudDisplayCurrent(data) {
  const obj = CONFIG.objective;
  if (obj?.type === 'clearTile') return goalDisplayCount;
  return data.current;
}

function getObjectiveProgressValues() {
  const obj = CONFIG.objective;
  const chip = getObjectiveChip(CONFIG);
  if (!chip) return null;

  let current = 0;
  switch (obj.type) {
    case 'clearTile':
      current = obj.tileType === 'any'
        ? totalTilesCleared
        : (tilesCleared[obj.tileType] || 0);
      break;
    case 'breakBlocker':
      current = blockersDestroyed[obj.blockerType] || 0;
      break;
    case 'breakAll':
      current = countRemainingBreakableBlockers();
      return { chip, current, target: null, invert: true };
    case 'clearPercent': {
      const need = Math.ceil(GRID * GRID * obj.percent / 100);
      current = totalTilesCleared;
      return { chip, current, target: need, invert: false };
    }
    case 'combo':
      if (obj.blockerType != null && obj.blockerCount != null) {
        current = blockersDestroyed[obj.blockerType] || 0;
      } else if (obj.surviveDrops != null) {
        current = fallerDropCycles;
      }
      break;
    default:
      return null;
  }
  return { chip, current, target: chip.target, invert: false };
}

function syncGoalHud() {
  const panel = document.getElementById('goalHudPanel');
  const labelEl = document.getElementById('goalHudLabel');
  const goalValEl = document.getElementById('goalVal');
  const goalCanvas = document.getElementById('goalCanvas');
  const data = getObjectiveProgressValues();
  if (!panel || !data) {
    if (panel) panel.hidden = true;
    return;
  }
  panel.hidden = false;
  if (labelEl) labelEl.textContent = data.chip.label;
  if (goalValEl) {
    if (data.invert) {
      goalValEl.textContent = data.current === 0 ? '✓' : `${data.current} left`;
    } else {
      const cur = Math.min(getGoalHudDisplayCurrent(data), data.target ?? data.current);
      goalValEl.textContent = `${cur}/${data.target ?? cur}`;
    }
  }
  const obj = CONFIG.objective;
  if (goalCanvas && obj?.type === 'clearTile' && ALL_GLB_PATHS[obj.tileType]) {
    ensureGoalTileIcon(goalCanvas, obj.tileType);
  } else if (goalCanvas && data.chip.icon) {
    if (goalCanvas._goalIconSrc !== data.chip.icon) {
      goalCanvas._goalIconSrc = data.chip.icon;
      const img = new Image();
      img.onload = () => {
        goalCanvas._goalIcon = img;
        drawHUDPanel(goalCanvas);
      };
      img.src = data.chip.icon;
    }
  }
}

function updateHUD() {
  document.getElementById('scoreVal').textContent = score.toLocaleString();
  const targetEl = document.getElementById('targetScoreVal');
  if (targetEl) targetEl.textContent = CONFIG.targetScore.toLocaleString();
  document.getElementById('movesVal').textContent = moves;
  syncGoalHud();
  const sc = document.getElementById('scoreCanvas');
  const mc = document.getElementById('movesCanvas');
  const gc = document.getElementById('goalCanvas');
  if (sc) drawHUDPanel(sc);
  if (gc && !document.getElementById('goalHudPanel')?.hidden) drawHUDPanel(gc);
  if (mc) drawHUDPanel(mc);
}

function maybeWarnLowMoves(prevMoves) {
  if (gameOver || lowMovesWarned || moves !== 3 || prevMoves <= 3) return;
  lowMovesWarned = true;
  showMsg('Only 3 moves left!', 2200);
}

function getTotalMoveBudget() {
  return CONFIG.moves + TRAITS.bonusMoves;
}

function getMovesUsed() {
  return getTotalMoveBudget() - moves;
}

function getStars() {
  if (!isLevelWin()) return 0;
  return computeStars(score, getMovesUsed(), CONFIG);
}

// ═══════════════════════════════════════════════════════════════
//  LEVEL COMPLETE / FAIL POPUP
// ═══════════════════════════════════════════════════════════════
/// Journal cached at level-end and consumed by whichever popup button the
/// user clicks. V2.6: chain calls are deferred to the button click and fired
/// as ONE atomic tx (submit + next-startLevel together) — no more racing
/// auto-submit on popup open and a fresh wallet prompt on Next.
let pendingJournal = null;
let _endPopupWon = false;
let _popupLivesInterval = null;

const END_POPUP_LIVES = {
  rootId: 'levelPopupLivesHud',
  countId: 'levelPopupLivesCount',
  heartsId: 'levelPopupLivesHearts',
  regenId: 'levelPopupLivesRegen',
};

function refreshEndPopupLives() {
  renderLivesHud(END_POPUP_LIVES);
}

function clearEndPopupLivesInterval() {
  if (_popupLivesInterval) {
    clearInterval(_popupLivesInterval);
    _popupLivesInterval = null;
  }
}

function updateEndPopupActionStates(won) {
  const replayBtn = document.getElementById('levelPopupReplay');
  const nextBtn = document.getElementById('levelPopupNext');
  const hasLife = canSpendLife();
  const canNextLevel = won && hasLevel(levelNum + 1);
  const blockedNoLives = !hasLife;
  const blockedNoLevel = won && !hasLevel(levelNum + 1);

  if (replayBtn) {
    replayBtn.classList.toggle('disabled', blockedNoLives);
    replayBtn.classList.toggle('level-popup-btn--no-lives', blockedNoLives);
    replayBtn.title = blockedNoLives ? 'No lives left — wait or get more' : '';
  }

  if (nextBtn) {
    if (!won) {
      nextBtn.classList.add('hidden');
      nextBtn.disabled = true;
      nextBtn.classList.remove('disabled', 'level-popup-btn--no-lives');
      nextBtn.title = '';
    } else {
      nextBtn.classList.remove('hidden');
      nextBtn.disabled = blockedNoLevel;
      nextBtn.classList.toggle('disabled', blockedNoLevel || blockedNoLives);
      nextBtn.classList.toggle('level-popup-btn--no-lives', blockedNoLives && canNextLevel);
      if (blockedNoLevel) nextBtn.title = 'No more levels';
      else if (blockedNoLives) nextBtn.title = 'No lives left — wait or get more';
      else nextBtn.title = '';
    }
  }

  return { hasLife, canNextLevel, blockedNoLives };
}

function flashNoLivesFeedback(...btns) {
  shakeLivesHud(END_POPUP_LIVES.rootId);
  btns.forEach(shakeElement);
}

let _confettiRaf = null;
let _confettiResize = null;

function stopWinConfetti() {
  if (_confettiRaf) {
    cancelAnimationFrame(_confettiRaf);
    _confettiRaf = null;
  }
  if (_confettiResize) {
    window.removeEventListener('resize', _confettiResize);
    _confettiResize = null;
  }
  const canvas = document.getElementById('levelConfetti');
  if (!canvas) return;
  canvas.classList.remove('active');
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function spawnWinConfetti() {
  const canvas = document.getElementById('levelConfetti');
  if (!canvas) return;
  stopWinConfetti();
  canvas.classList.add('active');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resize();
  _confettiResize = resize;
  window.addEventListener('resize', resize);

  const colors = ['#FFD700', '#FF6B6B', '#4FC3F7', '#7CB342', '#FF7043', '#AB47BC', '#FFFFFF', '#FFEB3B'];
  const particles = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: -30 - Math.random() * canvas.height * 0.4,
    w: 5 + Math.random() * 7,
    h: 3 + Math.random() * 5,
    color: colors[Math.floor(Math.random() * colors.length)],
    vx: (Math.random() - 0.5) * 5,
    vy: 2.5 + Math.random() * 5,
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.25,
  }));

  const start = performance.now();
  const duration = 4000;

  const frame = now => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.06;
      p.vx *= 0.998;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (now - start < duration) {
      _confettiRaf = requestAnimationFrame(frame);
    } else {
      stopWinConfetti();
    }
  };
  _confettiRaf = requestAnimationFrame(frame);
}

function setLevelResultBanner(won) {
  const banner = document.getElementById('levelResultBanner');
  const textEl = document.getElementById('levelResultBannerText');
  if (!banner || !textEl) return;
  banner.hidden = false;
  banner.classList.toggle('level-result-banner--win', won);
  banner.classList.toggle('level-result-banner--lose', !won);
  textEl.textContent = won ? 'You Won!' : 'You Lost!';
}

function showLevelPopup(wonHint) {
  gameOver = true;
  syncGoalDisplayToActual();
  // Re-check at popup time — never award stars/unlock unless both gates are met.
  const won = isLevelWin();
  if (wonHint && !won) {
    console.warn('[level-end] Win blocked: score or primary objective incomplete');
  }

  const popup = document.getElementById('levelPopup');
  popup?.classList.toggle('fail', !won);

  // Fire analytics first so we have a clean snapshot before any UI mutation
  const movesUsedNow = getMovesUsed();
  const durationMsNow = Math.round(performance.now() - gameStartTime);
  const starsNow = won ? getStars() : 0;
  if (won) Events.levelWin(levelNum, score, starsNow, movesUsedNow, durationMsNow);
  else     Events.levelFail(levelNum, score, movesUsedNow, durationMsNow);
  const title = document.getElementById('levelPopupTitle');
  const starsEl = document.getElementById('levelPopupStars');
  const scoreEl = document.getElementById('levelPopupScore');
  const objEl = document.getElementById('levelPopupObjective');
  const nextBtn = document.getElementById('levelPopupNext');

  const stars = won ? getStars() : 0;
  const durationMs = Math.round(performance.now() - gameStartTime);

  setLevelResultBanner(won);
  if (won) spawnWinConfetti();
  else stopWinConfetti();

  const levelTitleHtml = `<span class="level-popup-title-label">LEVEL</span><span class="level-popup-title-num">${levelNum}</span>`;

  if (won) {
    title.classList.remove('fail');
    title.innerHTML = levelTitleHtml;

    // level-popup-frame.png has three empty stars baked into the art,
    // so only render a gold overlay for each EARNED star. Empty slots
    // show the baked-in star cleanly — no doubled outlines.
    starsEl.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const img = document.createElement('img');
      if (i < stars) {
        img.src = '/assets/ui/star-gold.png';
        img.classList.add('earned');
        img.style.animationDelay = `${i * 0.15}s`;
      } else {
        img.style.visibility = 'hidden';
      }
      starsEl.appendChild(img);
    }

    scoreEl.textContent = score.toLocaleString();
    const savedMoves = movesRemainingForStars(movesUsedNow, CONFIG.moves);
    objEl.textContent = savedMoves > 0
      ? `${stars} star${stars !== 1 ? 's' : ''} · ${savedMoves} move${savedMoves !== 1 ? 's' : ''} saved`
      : `${stars} star${stars !== 1 ? 's' : ''} earned`;
    nextBtn.classList.remove('hidden');
    updateEndPopupActionStates(true);
  } else {
    title.classList.remove('fail');
    title.innerHTML = levelTitleHtml;

    // Failure: overlay empty stars so baked-in frame art doesn't look like a reward.
    starsEl.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const img = document.createElement('img');
      img.src = '/assets/ui/star-empty.png';
      img.alt = '';
      starsEl.appendChild(img);
    }

    scoreEl.textContent = score.toLocaleString();
    objEl.textContent = getFailPopupMessage();
    updateEndPopupActionStates(false);
  }

  _endPopupWon = won;
  clearEndPopupLivesInterval();
  refreshEndPopupLives();
  updateEndPopupActionStates(won);

  Inventory.hydrateFromChain()
    .catch(() => {})
    .finally(() => {
      refreshEndPopupLives();
      const state = updateEndPopupActionStates(won);
      _popupLivesInterval = setInterval(refreshEndPopupLives, 1000);
      if (state.blockedNoLives && (won ? state.canNextLevel : true)) {
        setTimeout(() => shakeLivesHud(END_POPUP_LIVES.rootId), 450);
      }
    });

  // Save to localStorage (immediate fallback)
  const progress = JSON.parse(localStorage.getItem('pengucrush_progress') || '{}');
  const prev = progress[levelNum] || { stars: 0, best: 0 };
  progress[levelNum] = { stars: Math.max(prev.stars, stars), best: Math.max(prev.best, score) };
  if (won && stars > 0 && !progress[levelNum + 1] && hasLevel(levelNum + 1)) {
    progress[levelNum + 1] = { stars: 0, best: 0, unlocked: true };
  }
  localStorage.setItem('pengucrush_progress', JSON.stringify(progress));

  // Save to Supabase (async, non-blocking)
  const wallet = getWallet();
  const movesUsed = getMovesUsed();
  if (wallet) {
    saveLevelResult({
      wallet,
      level: levelNum,
      score,
      stars,
      movesUsed,
      boostersUsed: {},
      completed: won,
      durationMs,
    }).catch(() => {});

    // V2.6 — DON'T auto-fire submit on popup open. Each button handler
    // below makes its own one-shot chain call: Map → submitLevel,
    // Next/Replay → submitAndStartNext (1 atomic tx). Caching the journal
    // for the button click; popup state is the source of truth until the
    // user picks where to go.
    pendingJournal = {
      level: levelNum,
      score,
      stars,
      movesUsed,
      completed: won,
      durationMs,
      boostersUsed: journal.boostersUsed,
      shardsEarned: journal.shardsEarned,
      bigCombos: journal.bigCombos,
      fallerPenalties: fallerDropsPenalized,
    };
    // Accumulate this run's shards into the per-level lifetime tally so
    // the pre-game popup for this level shows "from this level" totals.
    Inventory.recordLevelShards(levelNum, levelShards);

    // Clear any mid-game snapshot now that the level is over
    clearMidGameSnapshot(levelNum).catch(() => {});
  }

  popup.classList.add('active');
}

function setupLevelPopupButtons() {
  /// Single-shot mutex across all three popup buttons. Once any button
  /// kicks off its work (chain tx or navigation), every other click is a
  /// no-op until the page navigates away. Prevents:
  ///   • Double-fire of submitAndStartNext from rapid Next clicks.
  ///   • Clicking Map mid-tx and navigating optimistically while the
  ///     chain call is still pending.
  let _levelEndBusy = false;

  const mapBtn = document.getElementById('levelPopupMap');
  const replayBtn = document.getElementById('levelPopupReplay');
  const nextBtn = document.getElementById('levelPopupNext');

  /// Toggle all popup buttons in lockstep so visual state matches the
  /// busy flag — the user never sees a button that looks clickable while
  /// another is mid-tx.
  function setBusy(busy) {
    _levelEndBusy = busy;
    if (busy) {
      [mapBtn, replayBtn, nextBtn].forEach(b => { if (b) b.disabled = true; });
      return;
    }
    updateEndPopupActionStates(_endPopupWon);
  }

  /// Common error path shared by all three popup buttons.
  /// Routes through the central src/errors.js mapper so the player gets a
  /// consistent friendly message regardless of which surface threw the err.
  async function explainAndAlert(err, defaultMsg) {
    const { alertFriendly } = await import('./errors.js');
    alertFriendly(err, defaultMsg);
  }

  /// Confirms the chainWrite return value actually represents a confirmed
  /// tx (must have a hex tx hash). Defense in depth: chainWrite already
  /// throws on revert, but if any future code path returns early without
  /// awaiting the receipt this guard catches it before we navigate.
  function assertConfirmed(result, label) {
    if (!result || typeof result.hash !== 'string' || !/^0x[0-9a-fA-F]{1,}$/.test(result.hash)) {
      throw new Error(`${label}: chain call returned no tx hash (received ${JSON.stringify(result)})`);
    }
  }

  /// Map button — zero chain calls, just navigate. The user is leaving;
  /// score is discarded. If they want to record the run, they click
  /// Next or Replay instead (both single-tx fused submits).
  mapBtn.addEventListener('click', () => {
    if (_levelEndBusy) return;
    pendingJournal = null;
    window.__pengu.goToMap();
  });

  /// Replay button — fused submit + start same level (1 atomic tx).
  replayBtn.addEventListener('click', async (e) => {
    if (_levelEndBusy) return;
    if (!canSpendLife()) {
      flashNoLivesFeedback(replayBtn);
      return;
    }
    const btn = e.currentTarget;
    const orig = btn.textContent;
    setBusy(true);
    btn.textContent = 'Confirming…';
    try {
      let result;
      if (pendingJournal) {
        result = await chainSubmitAndStartNext(pendingJournal, levelNum);
        pendingJournal = null;
      } else {
        // No journal (failed run, started without a submit). Plain startLevel.
        result = await chainStartLevel(levelNum);
      }
      assertConfirmed(result, 'Replay');
      console.info('[level-end] Replay confirmed', result.hash, 'via', result.used);
      await Inventory.hydrateFromChain().catch(() => {});
      window.__pengu.goToLevel(levelNum);
    } catch (err) {
      console.warn('submitAndStartNext (Replay) failed:', err);
      explainAndAlert(err, 'Could not restart this level on chain.');
      setBusy(false);
      if (orig) btn.textContent = orig;
    }
  });

  /// Next button — fused submit + start NEXT level (1 atomic tx).
  nextBtn.addEventListener('click', async (e) => {
    if (_levelEndBusy) return;
    if (!hasLevel(levelNum + 1)) return;
    if (!canSpendLife()) {
      flashNoLivesFeedback(nextBtn);
      return;
    }
    const btn = e.currentTarget;
    const orig = btn.textContent;
    setBusy(true);
    btn.textContent = 'Confirming…';
    try {
      let result;
      if (pendingJournal) {
        result = await chainSubmitAndStartNext(pendingJournal, levelNum + 1);
        pendingJournal = null;
      } else {
        result = await chainStartLevel(levelNum + 1);
      }
      assertConfirmed(result, 'Next');
      console.info('[level-end] Next confirmed', result.hash, 'via', result.used);
      await Inventory.hydrateFromChain().catch(() => {});
      window.__pengu.goToLevel(levelNum + 1);
    } catch (err) {
      console.warn('submitAndStartNext (Next) failed:', err);
      explainAndAlert(err, 'Could not advance to the next level on chain.');
      setBusy(false);
      if (orig) btn.textContent = orig;
    }
  });
}

document.getElementById('levelPopupLivesBuyBtn')?.addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('shopOverlay')?.classList.add('active');
});

window.addEventListener('pengu:inventory', () => {
  if (!document.getElementById('levelPopup')?.classList.contains('active')) return;
  refreshEndPopupLives();
  updateEndPopupActionStates(_endPopupWon);
});

async function handleSwap(r1, c1, r2, c2) {
  if (animating || gameOver) return; animating = true;
  await swapTiles(r1, c1, r2, c2);
  if (findMatches().size === 0) {
    await swapTiles(r2, c2, r1, c1);
    await Promise.all([animShake(board[r1][c1].mesh), animShake(board[r2][c2].mesh)]);
    showMsg('No match!', 500);
  } else {
    const prevMoves = moves;
    moves--;
    maybeWarnLowMoves(prevMoves);
    updateHUD();
    await processMatches();
    // Mid-game snapshot every 5 moves — saves to localStorage + Supabase for
    // cross-device resume. On-chain checkpoint removed: rejecting it didn't
    // block gameplay anyway, so it was a meaningless prompt for non-session
    // wallets.
    const movesUsed = getMovesUsed();
    if (movesUsed > 0 && movesUsed % 5 === 0) {
      try {
        const snapshotObj = {
          level: levelNum, movesUsed, score,
          tilesCleared: { ...tilesCleared },
          blockersDestroyed: { ...blockersDestroyed },
          totalTilesCleared,
          turnCount,
          fallerDropsPenalized,
          journal: { ...journal, boostersUsed: [...journal.boostersUsed], shardsEarned: [...journal.shardsEarned] },
          board: board.map(row => row.map(t => t ? { type: t.type, frozen: t.frozen, iceLayer: t.iceLayer, isWall: t.isWall, isFaller: t.isFaller } : null)),
        };
        saveMidGameSnapshot(levelNum, snapshotObj).catch(() => {});
      } catch (_) { /* cosmetic */ }
    }
    await resolveLevelStateAfterBoardSettled();
  }
  animating = false;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════
//  BOOSTERS
// ═══════════════════════════════════════════════════════════════
async function useBoosterRow(row) {
  if (animating) return;
  animating = true;
  await animRowBoosterFx(row);
  await delay(100);
  await dropTiles();
  await processMatches();
  await resolveLevelStateAfterBoardSettled();
  animating = false;
}

async function useBoosterCol(col) {
  if (animating) return;
  animating = true;
  await animColBoosterFx(col);
  await delay(100);
  await dropTiles();
  await processMatches();
  await resolveLevelStateAfterBoardSettled();
  animating = false;
}

async function useBoosterHammer(row, col) {
  if (animating) return;
  const tile = board[row][col];
  if (!tile || tile.isWall) return;
  animating = true;
  const wp = gridToWorld(row, col);

  if (tile.frozen) {
    await animHammerBreakIce(tile, wp);
    updateHUD();
    await resolveLevelStateAfterBoardSettled();
  } else {
    const mesh = tile.mesh;
    const ttype = tile.type;
    const wp = mesh.position.clone();
    recordTileCleared(ttype, wp);
    board[row][col] = null;
    await animHammerHitCandy(mesh, wp);
    await delay(100);
    await dropTiles();
    await processMatches();
    await resolveLevelStateAfterBoardSettled();
  }
  animating = false;
}

async function useBoosterColorBomb(row, col) {
  if (animating) return;
  const tile = board[row][col];
  if (!tile || tile.isWall || tile.frozen) return;
  animating = true;
  const targetType = tile.type;

  const targets = [];
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const t = board[r][c];
    if (!t || t.isWall || t.frozen || t.type !== targetType) continue;
    targets.push({ r, c, mesh: t.mesh });
    recordTileCleared(t.type, t.mesh.position.clone());
    board[r][c] = null;
  }

  await animColorBombBoosterFx(row, col, targets);
  await delay(100);
  await dropTiles();
  await processMatches();
  await resolveLevelStateAfterBoardSettled();
  animating = false;
}

function animShuffleTileVanish(mesh, dur = 260) {
  return new Promise(res => {
    const t0 = performance.now();
    const os = mesh.scale.clone();
    const oz = mesh.position.z;
    (function tick() {
      const p = Math.min((performance.now() - t0) / dur, 1);
      const e = ease(p);
      const s = 1 - e;
      mesh.scale.set(os.x * Math.max(0.02, s), os.y * Math.max(0.02, s), os.z * Math.max(0.02, s));
      mesh.rotation.z += 0.1;
      mesh.position.z = oz + e * 0.4;
      mesh.traverse(ch => {
        if (ch.isMesh && ch.material) {
          ch.material.transparent = true;
          ch.material.opacity = Math.max(0, s);
        }
      });
      p < 1 ? requestAnimationFrame(tick) : (scene.remove(mesh), res());
    })();
  });
}

let _shuffleBoosterGltfRoot = null;

/** Cached root cloned per overlay so the shuffle animation uses vectors, not the raster HUD icon. */
async function cloneShuffleBoosterForOverlay() {
  if (!_shuffleBoosterGltfRoot) {
    _shuffleBoosterGltfRoot = await loadGLB('/assets/boosters/shuffle.glb');
  }
  return _shuffleBoosterGltfRoot.clone(true);
}

/** PNG fallback if GLB fails (same motion as pre-3D overlay). */
async function playShuffleBoosterOverlayWithPng(btn, dx, dy, w0, h0, endScale) {
  const imgEl = btn.querySelector('.booster-slot-icon img');
  const wrap = document.createElement('div');
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:1600;display:flex;align-items:center;justify-content:center;pointer-events:none;';

  const backdrop = document.createElement('div');
  backdrop.style.cssText = 'position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(20,60,90,.45) 0%,rgba(6,16,24,.78) 100%);opacity:0;transition:opacity .3s ease';
  wrap.appendChild(backdrop);

  const ghost = document.createElement('img');
  ghost.src = imgEl?.src || '/assets/boosters-2d/shuffle.png';
  ghost.alt = '';
  ghost.draggable = false;
  ghost.style.cssText = `width:${w0}px;height:${h0}px;object-fit:contain;filter:drop-shadow(0 14px 36px rgba(0,0,0,.55));transition:transform .58s cubic-bezier(.34,1.1,.42,1);will-change:transform;transform-origin:center center;`;
  ghost.style.transform = `translate(${dx}px,${dy}px) scale(1) rotate(0deg)`;
  wrap.appendChild(ghost);
  document.body.appendChild(wrap);

  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.style.opacity = '1';
    ghost.style.transform = `translate(0,0) scale(${endScale}) rotate(360deg)`;
    r();
  })));

  await delay(320);

  const close = async () => {
    ghost.style.transition = 'transform .52s cubic-bezier(.45,0,.55,1), opacity .42s ease';
    backdrop.style.transition = 'opacity .4s ease';
    ghost.style.transform = `translate(0,0) scale(0) rotate(720deg)`;
    ghost.style.opacity = '0';
    backdrop.style.opacity = '0';
    await delay(480);
    wrap.remove();
  };

  return { close };
}

/**
 * Shuffle booster flies from the slot to center, scales up, spins. Uses live GLB render (sharp at any scale); PNG if load fails.
 */
async function playShuffleBoosterOverlay() {
  const btn = document.querySelector('.booster-slot[data-booster="shuffle"]:not(.booster-slot--locked)');
  if (!btn) {
    await delay(400);
    return { close: async () => {} };
  }

  const br = btn.getBoundingClientRect();
  const dx = br.left + br.width / 2 - window.innerWidth / 2;
  const dy = br.top + br.height / 2 - window.innerHeight / 2;
  const w0 = Math.max(br.width, 56);
  const h0 = Math.max(br.height, 56);
  const side = Math.max(w0, h0);
  const vpMin = Math.min(window.innerWidth, window.innerHeight);
  const targetPx = vpMin * 0.3;
  const endScale = Math.max(0.35, targetPx / side);

  try {
    const model = await cloneShuffleBoosterForOverlay();
    const pr = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    pr.setClearColor(0x000000, 0);
    pr.toneMapping = THREE.ACESFilmicToneMapping;
    pr.toneMappingExposure = 1.6;

    const pixelRatio = Math.min(2.5, window.devicePixelRatio || 1);
    const bufSize = Math.max(320, Math.ceil(side * endScale * pixelRatio * 1.35));
    const canvasEl = pr.domElement;
    canvasEl.width = bufSize;
    canvasEl.height = bufSize;
    pr.setSize(bufSize, bufSize, false);

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.8));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4);
    dl.position.set(2, 3, 8);
    scene.add(dl);

    const rots = [[0, 0, 0], [-Math.PI / 2, 0, 0], [0, -Math.PI / 2, 0]];
    let best = rots[0], bestArea = 0;
    for (const r of rots) {
      model.rotation.set(r[0], r[1], r[2]);
      const b = new THREE.Box3().setFromObject(model);
      const s = new THREE.Vector3(); b.getSize(s);
      if (s.x * s.y > bestArea) { bestArea = s.x * s.y; best = r; }
    }
    model.rotation.set(best[0], best[1], best[2]);

    const box = new THREE.Box3().setFromObject(model);
    const sz = new THREE.Vector3(); box.getSize(sz);
    model.scale.multiplyScalar(3.5 / Math.max(sz.x, sz.y, sz.z));
    const nb = new THREE.Box3().setFromObject(model);
    const ct = new THREE.Vector3(); nb.getCenter(ct);
    model.position.sub(ct);
    scene.add(model);

    const finalBox = new THREE.Box3().setFromObject(model);
    const finalSz = new THREE.Vector3(); finalBox.getSize(finalSz);
    const pad = 1.15;
    const halfW = finalSz.x * pad / 2;
    const halfH = finalSz.y * pad / 2;
    const camH = Math.max(halfH, halfW);
    const cam = new THREE.OrthographicCamera(-camH, camH, camH, -camH, 0.1, 100);
    cam.position.set(0, 0, 15);
    cam.lookAt(0, 0, 0);

    const wrap = document.createElement('div');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:1600;display:flex;align-items:center;justify-content:center;pointer-events:none;';

    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(20,60,90,.45) 0%,rgba(6,16,24,.78) 100%);opacity:0;transition:opacity .3s ease';
    wrap.appendChild(backdrop);

    const host = document.createElement('div');
    host.style.cssText = `width:${side}px;height:${side}px;flex-shrink:0;filter:drop-shadow(0 14px 36px rgba(0,0,0,.55));transition:transform .58s cubic-bezier(.34,1.1,.42,1);will-change:transform;transform-origin:center center;`;
    host.style.transform = `translate(${dx}px,${dy}px) scale(1) rotate(0deg)`;
    canvasEl.style.cssText = 'width:100%;height:100%;display:block';
    host.appendChild(canvasEl);
    wrap.appendChild(host);
    document.body.appendChild(wrap);

    let disposed = false;
    let rafId = 0;
    let prevT = performance.now();
    function tick(now) {
      if (disposed) return;
      const dt = (now - prevT) / 1000;
      prevT = now;
      /* Screen-plane roll (not yaw): camera looks down −Z, so Z is the view axis. */
      model.rotateZ(-dt * 3.8);
      pr.render(scene, cam);
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {
      backdrop.style.opacity = '1';
      host.style.transform = `translate(0,0) scale(${endScale}) rotate(360deg)`;
      r();
    })));

    await delay(320);

    const close = async () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      host.style.transition = 'transform .52s cubic-bezier(.45,0,.55,1), opacity .42s ease';
      backdrop.style.transition = 'opacity .4s ease';
      host.style.transform = `translate(0,0) scale(0) rotate(720deg)`;
      host.style.opacity = '0';
      backdrop.style.opacity = '0';
      await delay(480);
      pr.dispose();
      wrap.remove();
    };

    return { close };
  } catch (e) {
    console.warn('Shuffle 3D overlay failed, using PNG:', e);
    return playShuffleBoosterOverlayWithPng(btn, dx, dy, w0, h0, endScale);
  }
}

async function useBoosterShuffle() {
  if (animating) return;
  animating = true;

  const positions = getShuffleablePositions();
  if (positions.length === 0) {
    animating = false;
    return;
  }

  const { close } = await playShuffleBoosterOverlay();

  const vanishPs = positions.map(([r, c]) => animShuffleTileVanish(board[r][c].mesh));
  await Promise.all(vanishPs);
  for (const [r, c] of positions) board[r][c] = null;

  const newTiles = rerollShuffleableTiles(positions);
  await Promise.all(
    newTiles.map(tile => animSpawn(tile.mesh, gridToWorld(tile.row, tile.col), 450))
  );

  await close();
  await delay(80);
  await resolveLevelStateAfterBoardSettled();
  animating = false;
}

function consumeBooster(type) {
  const remaining = Inventory.consumeBooster(type);
  boosterCharges[type] = remaining;
  updateBoosterUI();
  if (remaining <= 0) activeBooster = null;
  const skuHash = BOOSTER_NAME_TO_SKU[type];
  if (skuHash) journal.boostersUsed.push(skuHash);
  Events.boosterUsed(type, levelNum);
}

function updateBoosterUI() {
  document.querySelectorAll('.booster-slot').forEach(btn => {
    const type = btn.dataset.booster;
    if (!CONFIG.boosters.includes(type)) return;
    const charges = boosterCharges[type] || 0;
    btn.classList.toggle('booster-slot--empty', charges <= 0);
    btn.classList.toggle('booster-slot--active', type === activeBooster);
    const badge = btn.querySelector('.booster-slot-count');
    if (badge) badge.textContent = charges;
  });
  applyBoosterCursor(activeBooster);
  // Clear highlights when no directional booster is active
  if (!activeBooster || (activeBooster !== 'row' && activeBooster !== 'col')) {
    _highlightRowActive = false; _highlightColActive = false;
    rowHighlightMat.opacity = 0;  colHighlightMat.opacity = 0;
  }
}

async function renderGLBIcon(glbPath, size = 128) {
  try {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = size;
    offCanvas.height = size;
    const pr = new THREE.WebGLRenderer({ canvas: offCanvas, antialias: true, alpha: true });
    pr.setSize(size, size);
    pr.setClearColor(0x000000, 0);
    pr.toneMapping = THREE.ACESFilmicToneMapping;
    pr.toneMappingExposure = 1.6;

    const ps = new THREE.Scene();
    ps.add(new THREE.AmbientLight(0xffffff, 1.8));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4);
    dl.position.set(2, 3, 8);
    ps.add(dl);

    const model = await loadGLB(glbPath);

    // Auto-rotate to best facing
    const rots = [[0,0,0], [-Math.PI/2,0,0], [0,-Math.PI/2,0]];
    let best = rots[0], bestArea = 0;
    for (const r of rots) {
      model.rotation.set(r[0], r[1], r[2]);
      const b = new THREE.Box3().setFromObject(model);
      const s = new THREE.Vector3(); b.getSize(s);
      if (s.x * s.y > bestArea) { bestArea = s.x * s.y; best = r; }
    }
    model.rotation.set(best[0], best[1], best[2]);

    const box = new THREE.Box3().setFromObject(model);
    const sz = new THREE.Vector3(); box.getSize(sz);
    model.scale.multiplyScalar(3.5 / Math.max(sz.x, sz.y, sz.z));
    const nb = new THREE.Box3().setFromObject(model);
    const ct = new THREE.Vector3(); nb.getCenter(ct);
    model.position.sub(ct);
    ps.add(model);

    const finalBox = new THREE.Box3().setFromObject(model);
    const finalSz = new THREE.Vector3(); finalBox.getSize(finalSz);
    const pad = 1.15;
    const halfW = finalSz.x * pad / 2;
    const halfH = finalSz.y * pad / 2;
    const camH = Math.max(halfH, halfW);
    const pc = new THREE.OrthographicCamera(-camH, camH, camH, -camH, 0.1, 100);
    pc.position.set(0, 0, 15);
    pc.lookAt(0, 0, 0);
    pr.render(ps, pc);

    const dataUrl = offCanvas.toDataURL();
    pr.dispose();
    return dataUrl;
  } catch (e) {
    console.warn('Booster icon render failed:', glbPath, e);
    return null;
  }
}

const BOOSTER_GLB = {
  row:       '/assets/boosters/row-clear.glb',
  col:       '/assets/boosters/col-clear.glb',
  colorBomb: '/assets/boosters/color-bomb.glb',
  hammer:    '/assets/boosters/hammer.glb',
  shuffle:   '/assets/boosters/shuffle.glb',
};

const ALL_BOOSTERS = ['row', 'col', 'colorBomb', 'hammer', 'shuffle'];

function setupBoosterUI() {
  const bar = document.getElementById('boosterBar');
  if (!bar) return;

  const tray = document.createElement('img');
  tray.className = 'booster-tray-bg';
  tray.src = '/assets/ui/booster-tray.png';
  tray.draggable = false;
  bar.appendChild(tray);

  const slotsEl = document.createElement('div');
  slotsEl.className = 'booster-slots';
  bar.appendChild(slotsEl);

  for (const type of ALL_BOOSTERS) {
    const isAvailable = CONFIG.boosters.includes(type);
    const btn = document.createElement('button');
    btn.className = 'booster-slot';
    btn.dataset.booster = type;

    if (!isAvailable) {
      btn.classList.add('booster-slot--locked');
      btn.innerHTML = '<div class="booster-slot-icon"></div>';
      slotsEl.appendChild(btn);
      continue;
    }

    btn.innerHTML = `<div class="booster-slot-icon"><div class="booster-slot-spinner"></div></div><span class="booster-slot-count">${boosterCharges[type] || 0}</span>`;

    const iconWrap = btn.querySelector('.booster-slot-icon');
    renderGLBIcon(BOOSTER_GLB[type], 128).then(dataUrl => {
      if (dataUrl) iconWrap.innerHTML = `<img src="${dataUrl}" alt="${type}" />`;
    });

    btn.addEventListener('click', () => {
      if ((boosterCharges[type] || 0) <= 0) return;
      if (activeBooster === type) {
        activeBooster = null;
      } else {
        activeBooster = type;
      }
      if (type === 'shuffle' && activeBooster === 'shuffle') {
        activeBooster = null;
        consumeBooster('shuffle');
        useBoosterShuffle();
        return;
      }
      updateBoosterUI();
    });
    slotsEl.appendChild(btn);
  }

  const shopBtn = document.createElement('button');
  shopBtn.type = 'button';
  shopBtn.className = 'lives-hud__plus booster-bar__shop-plus';
  shopBtn.id = 'gameBoosterShopBtn';
  shopBtn.setAttribute('aria-label', 'Buy boosters');
  shopBtn.innerHTML = '<img src="/assets/ui/lives/plus-button.png" draggable="false" alt="" />';
  shopBtn.addEventListener('click', e => {
    e.stopPropagation();
    Events.shopOpen();
    document.getElementById('shopOverlay')?.classList.add('active');
  });
  slotsEl.appendChild(shopBtn);

  updateBoosterUI();
}

// ═══════════════════════════════════════════════════════════════
//  INPUT
// ═══════════════════════════════════════════════════════════════
const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
const selGeo = new THREE.RingGeometry(CELL * 0.43, CELL * 0.49, 32);
const selMat = new THREE.MeshBasicMaterial({ color: 0xffeb3b, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
const selRing = new THREE.Mesh(selGeo, selMat);
selRing.visible = false; selRing.position.z = 0.6; scene.add(selRing);

function getClicked(event) {
  const rect = canvas.getBoundingClientRect();
  mouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const meshes = [];
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++)
      if (board[r]?.[c]) board[r][c].mesh.traverse(ch => { if (ch.isMesh) meshes.push(ch); });
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const hitObj = hits[0].object;
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++) {
      if (!board[r][c]) continue;
      let found = false;
      board[r][c].mesh.traverse(ch => { if (ch === hitObj) found = true; });
      if (found) return { row: r, col: c };
    }
  return null;
}

canvas.addEventListener('click', async e => {
  if (animating || gameOver || moves <= 0) return;
  const cl = getClicked(e);
  if (!cl) return;

  // Booster mode — click applies the booster
  if (activeBooster) {
    const bType = activeBooster;
    // Validate the click target BEFORE consuming the charge so a misclick on
    // a wall / frozen tile doesn't silently burn the booster (audit H8).
    const target = board[cl.row]?.[cl.col];
    let validTarget = true;
    if (bType === 'hammer') {
      validTarget = !!target && !target.isWall;
    } else if (bType === 'colorBomb') {
      validTarget = !!target && !target.isWall && !target.frozen;
    }
    if (!validTarget) {
      // Keep the booster armed; player can pick a different tile.
      return;
    }
    activeBooster = null;
    updateBoosterUI();
    consumeBooster(bType);
    if (bType === 'row') await useBoosterRow(cl.row);
    else if (bType === 'col') await useBoosterCol(cl.col);
    else if (bType === 'hammer') await useBoosterHammer(cl.row, cl.col);
    else if (bType === 'colorBomb') await useBoosterColorBomb(cl.row, cl.col);
    selRing.visible = false;
    selected = null;
    return;
  }

  // Normal match-3 mode
  const tileAt = (r, c) => board[r]?.[c];
  const blocked = (r, c) => { const t = tileAt(r, c); return !t || t.isWall || t.frozen || t.isFaller; };

  if (!selected) {
    if (blocked(cl.row, cl.col)) return;
    selected = cl;
    const p = gridToWorld(cl.row, cl.col);
    selRing.position.set(p.x, p.y, 0.6); selRing.visible = true;
  } else if (selected.row === cl.row && selected.col === cl.col) {
    selected = null; selRing.visible = false;
  } else if (Math.abs(selected.row - cl.row) + Math.abs(selected.col - cl.col) === 1) {
    if (blocked(cl.row, cl.col) || blocked(selected.row, selected.col)) {
      const reason = tileAt(cl.row, cl.col)?.isWall || tileAt(selected.row, selected.col)?.isWall ? 'Can\'t move walls!' : 'Tile is frozen!';
      showMsg(reason, 500);
      selected = null; selRing.visible = false;
      return;
    }
    selRing.visible = false;
    handleSwap(selected.row, selected.col, cl.row, cl.col);
    selected = null;
  } else {
    if (blocked(cl.row, cl.col)) return;
    selected = cl;
    const p = gridToWorld(cl.row, cl.col);
    selRing.position.set(p.x, p.y, 0.6);
  }
});

// Booster row/col hover highlight tracking
canvas.addEventListener('mousemove', e => {
  if (!activeBooster || (activeBooster !== 'row' && activeBooster !== 'col')) {
    _highlightRowActive = false; _highlightColActive = false;
    rowHighlightMat.opacity = 0;  colHighlightMat.opacity = 0;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const mx = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  const my = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  const worldX =  mx * (frustum / 2);
  const worldY =  my * (frustum / 2);
  const hovRow = Math.round((GRID - 1) / 2 - worldY / CELL);
  const hovCol = Math.round(worldX / CELL + (GRID - 1) / 2);

  if (activeBooster === 'row') {
    _highlightColActive = false; colHighlightMat.opacity = 0;
    if (hovRow >= 0 && hovRow < GRID) {
      _highlightRowActive = true;
      rowHighlightMesh.position.y = gridToWorld(hovRow, 0).y;
    } else { _highlightRowActive = false; rowHighlightMat.opacity = 0; }
  } else {
    _highlightRowActive = false; rowHighlightMat.opacity = 0;
    if (hovCol >= 0 && hovCol < GRID) {
      _highlightColActive = true;
      colHighlightMesh.position.x = gridToWorld(0, hovCol).x;
    } else { _highlightColActive = false; colHighlightMat.opacity = 0; }
  }
});

canvas.addEventListener('mouseleave', () => {
  _highlightRowActive = false; _highlightColActive = false;
  rowHighlightMat.opacity = 0;  colHighlightMat.opacity = 0;
});

// Right-click cancels active booster
canvas.addEventListener('contextmenu', e => {
  if (activeBooster) { e.preventDefault(); activeBooster = null; updateBoosterUI(); }
});

// ═══════════════════════════════════════════════════════════════
//  HUD — updateHUD defined above with syncGoalHud
// ═══════════════════════════════════════════════════════════════

function showMsg(html, dur = 1500) {
  const el = document.getElementById('msg');
  el.innerHTML = html; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}

// ═══════════════════════════════════════════════════════════════
//  RENDER LOOP
// ═══════════════════════════════════════════════════════════════
let clk = 0;
function animate() {
  requestAnimationFrame(animate);
  clk += 0.01;
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++) {
      const tile = board[r]?.[c];
      if (!tile?.mesh) continue;
      tile.mesh.position.z = Math.sin(clk + r * 0.5 + c * 0.7) * 0.02;
    }
  if (selRing.visible) {
    selRing.scale.setScalar(1 + Math.sin(clk * 4) * 0.05);
    selRing.rotation.z = clk * 0.5;
  }
  if (_highlightRowActive) rowHighlightMat.opacity = 0.16 + Math.sin(clk * 5) * 0.09;
  if (_highlightColActive) colHighlightMat.opacity = 0.16 + Math.sin(clk * 5) * 0.09;
  const gc = document.getElementById('goalCanvas');
  if (gc?._ready && performance.now() < (gc._goalCountPulseUntil || 0)) drawHUDPanel(gc);
  renderer.render(scene, camera);
}

// ═══════════════════════════════════════════════════════════════
//  DEBUG — Popsicle: 2=X 3=Y 4=Z | Fish: 7=X 8=Y 9=Z
// ═══════════════════════════════════════════════════════════════
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeBooster) {
    activeBooster = null;
    updateBoosterUI();
    return;
  }
  const keyMap = {
    '2': { type: 'popsicle', axis: 'rx' },
    '3': { type: 'popsicle', axis: 'ry' },
    '4': { type: 'popsicle', axis: 'rz' },
    '7': { type: 'fish', axis: 'rx' },
    '8': { type: 'fish', axis: 'ry' },
    '9': { type: 'fish', axis: 'rz' },
    '5': { type: 'frostice', axis: 'rx' },
    '6': { type: 'frostice', axis: 'ry' },
  };
  const action = keyMap[e.key];
  if (!action) return;
  const fix = TYPE_FIX[action.type];
  fix[action.axis] += Math.PI / 4;
  console.log(`${action.type} rotation → rx:${(fix.rx*180/Math.PI).toFixed(0)}° ry:${(fix.ry*180/Math.PI).toFixed(0)}° rz:${(fix.rz*180/Math.PI).toFixed(0)}°`);
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++) {
      if (board[r][c]?.type === action.type) {
        scene.remove(board[r][c].mesh);
        board[r][c] = createTile(action.type, r, c);
      }
    }
});

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  3D HUD PANELS — score/moves GLB; goal uses PNG + CSS label
// ═══════════════════════════════════════════════════════════════
const GOAL_PANEL_PNG = '/assets/hud/objective-panel.png';

async function bakeHudPanelGlb(glbPath) {
  const offCanvas = document.createElement('canvas');
  offCanvas.width = 640;
  offCanvas.height = 350;

  const pr = new THREE.WebGLRenderer({ canvas: offCanvas, antialias: true, alpha: true });
  pr.setSize(640, 350);
  pr.setClearColor(0x000000, 0);
  pr.toneMapping = THREE.ACESFilmicToneMapping;
  pr.toneMappingExposure = 1.5;

  const ps = new THREE.Scene();
  ps.add(new THREE.AmbientLight(0xffffff, 1.5));
  const pl = new THREE.DirectionalLight(0xffffff, 1.2);
  pl.position.set(0, 2, 10); ps.add(pl);

  const model = await loadGLB(glbPath);
  const rots = [
    [0, 0, 0],
    [-Math.PI / 2, 0, 0],
    [0, -Math.PI / 2, 0],
  ];
  let best = rots[0], bestArea = 0;
  for (const r of rots) {
    model.rotation.set(r[0], r[1], r[2]);
    const b = new THREE.Box3().setFromObject(model);
    const s = new THREE.Vector3(); b.getSize(s);
    if (s.x * s.y > bestArea) { bestArea = s.x * s.y; best = r; }
  }
  model.rotation.set(best[0], best[1], best[2]);

  const box = new THREE.Box3().setFromObject(model);
  const sz = new THREE.Vector3(); box.getSize(sz);
  model.scale.multiplyScalar(5 / Math.max(sz.x, sz.y));
  const nb = new THREE.Box3().setFromObject(model);
  const ct = new THREE.Vector3(); nb.getCenter(ct);
  model.position.sub(ct);
  ps.add(model);

  const finalBox = new THREE.Box3().setFromObject(model);
  const finalSz = new THREE.Vector3(); finalBox.getSize(finalSz);
  const pad = 1.1;
  const halfW = finalSz.x * pad / 2;
  const halfH = finalSz.y * pad / 2;
  const aspect = 640 / 350;
  const camH = Math.max(halfH, halfW / aspect);
  const pc = new THREE.OrthographicCamera(-camH * aspect, camH * aspect, camH, -camH, 0.1, 100);
  pc.position.set(0, 0, 20); pc.lookAt(0, 0, 0);
  pr.render(ps, pc);
  pr.dispose();
  return offCanvas;
}

async function loadHUDPanel(canvasId, glbPath) {
  try {
    const offCanvas = await bakeHudPanelGlb(glbPath);
    const panelImg = new Image();
    panelImg.src = offCanvas.toDataURL();

    const cvs = document.getElementById(canvasId);
    if (!cvs) return;
    cvs.width = 640;
    cvs.height = 280;
    cvs._panelImg = panelImg;
    cvs._ready = false;

    panelImg.onload = () => {
      cvs._ready = true;
      drawHUDPanel(cvs);
    };

    console.log(`✓ HUD ${canvasId} rendered as 2D`);
  } catch (e) { console.warn(`HUD ${canvasId} failed:`, e); }
}

async function loadGoalHUDPanel() {
  try {
    const panelImg = new Image();
    panelImg.src = GOAL_PANEL_PNG;
    await panelImg.decode();

    const cvs = document.getElementById('goalCanvas');
    if (!cvs) return;
    cvs.width = 640;
    cvs.height = 280;
    cvs._panelImg = panelImg;
    cvs._ready = true;
    drawHUDPanel(cvs);
    console.log('✓ HUD goalCanvas loaded from PNG');
  } catch (e) { console.warn('HUD goalCanvas failed:', e); }
}

function glbPanelValueY(cvs) {
  return cvs.height * 0.54;
}

function goalPanelValueY(box) {
  return box.y + box.h * 0.54;
}

function getGoalPanelImageRect(cvs) {
  const rect = cvs.getBoundingClientRect();
  const scale = rect.width > 0 ? cvs.width / rect.width : 1;
  const topMargin = 20 * scale;
  const w = cvs.width * 0.8;
  const h = cvs.height * 0.8;
  const x = (cvs.width - w) / 2;
  const y = topMargin;
  return { x, y, w, h };
}

function goalIconDrawSize(cvs, iconSize) {
  const rect = cvs.getBoundingClientRect();
  if (!rect.width || !rect.height) return { w: iconSize, h: iconSize };
  const sx = rect.width / cvs.width;
  const sy = rect.height / cvs.height;
  // Compensate for non-uniform canvas CSS scaling so the icon appears square on screen.
  return { w: iconSize * (sy / sx), h: iconSize };
}

function drawHUDPanel(cvs) {
  if (!cvs._ready) return;
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, cvs.width, cvs.height);

  const isScore = cvs.id === 'scoreCanvas';
  const isGoal = cvs.id === 'goalCanvas';
  const goalImg = isGoal ? getGoalPanelImageRect(cvs) : null;

  if (goalImg) {
    ctx.drawImage(cvs._panelImg, goalImg.x, goalImg.y, goalImg.w, goalImg.h);
  } else {
    ctx.drawImage(cvs._panelImg, 0, 0, cvs.width, cvs.height);
  }
  const valueEl = isScore
    ? document.getElementById('scoreVal')
    : isGoal
    ? document.getElementById('goalVal')
    : document.getElementById('movesVal');
  const targetEl = isScore ? document.getElementById('targetScoreVal') : null;
  const current = valueEl?.textContent || '0';
  const target = targetEl?.textContent || '';

  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,30,60,0.6)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.textBaseline = 'middle';

  if (isScore && target) {
    const line = `${current} / ${target}`;
    const digits = line.replace(/[^0-9]/g, '').length;
    const fontSize = digits > 9 ? 42 : digits > 7 ? 48 : 54;
    ctx.font = `bold ${fontSize}px Fredoka, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(line, cvs.width / 2, glbPanelValueY(cvs));
  } else if (isGoal) {
    const text = current;
    const icon = cvs._goalIcon;
    const box = goalImg;
    const cy = goalPanelValueY(box);
    const iconSize = Math.round(box.h * 0.30);
    const iconDraw = icon?.complete ? goalIconDrawSize(cvs, iconSize) : { w: iconSize, h: iconSize };
    const pulsing = performance.now() < (cvs._goalCountPulseUntil || 0);
    let fontSize = pulsing ? 52 : 48;
    ctx.font = `bold ${fontSize}px Fredoka, sans-serif`;
    let textW = ctx.measureText(text).width;
    const gap = 10;
    let totalW = textW + (icon?.complete ? iconDraw.w + gap : 0);
    while (totalW > box.w * 0.82 && fontSize > 30) {
      fontSize -= 2;
      ctx.font = `bold ${fontSize}px Fredoka, sans-serif`;
      textW = ctx.measureText(text).width;
      totalW = textW + (icon?.complete ? iconDraw.w + gap : 0);
    }
    const cx = box.x + box.w / 2;
    if (pulsing) {
      ctx.shadowBlur = 14;
      ctx.shadowColor = 'rgba(255, 160, 80, 0.85)';
    }
    if (icon?.complete) {
      const startX = cx - totalW / 2;
      ctx.drawImage(icon, startX, cy - iconDraw.h / 2, iconDraw.w, iconDraw.h);
      ctx.textAlign = 'left';
      ctx.fillText(text, startX + iconDraw.w + gap, cy);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(text, cx, cy);
    }
  } else {
    ctx.font = 'bold 62px Fredoka, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(current, cvs.width / 2, glbPanelValueY(cvs));
  }
  ctx.shadowBlur = 0;
}

async function init() {
  // chainStartLevel was MOVED to the map's Play button (src/map.js) so the
  // chain prompt happens BEFORE the user is teleported into the play page.
  // By the time we get here the chain has already accepted startLevel and
  // the life is debited, so this init() trusts the gate and just renders.
  Events.levelStart(levelNum);

  await preloadAssets(() => {});
  await ensureHammerSwingModel();
  await loadGridFrame();
  await loadHUDPanel('scoreCanvas', '/assets/hud/score-panel.glb');
  if (getObjectiveChip(CONFIG)) await loadGoalHUDPanel();
  await loadHUDPanel('movesCanvas', '/assets/hud/moves-panel.glb');
  await preCacheBoosterCursors();

  const targetEl = document.getElementById('targetScoreVal');
  if (targetEl) targetEl.textContent = CONFIG.targetScore.toLocaleString();

  updateHUD();
  setupBoosterUI();
  setupLevelPopupButtons();
  setupShardHud();
  initBoard();
  ensureBoardPlayableSync();
  animate();

}

let shardPulseId = null;
let shardPulseUntil = 0;
let shardPulseTimer = null;

/// Per-level shard count for the in-game HUD. Resets at every level start
/// (this module is re-imported on each /?page=play navigation, so module
/// init = level start). The Inventory popup still shows the LIFETIME total
/// via Inventory.getShards().
const levelShards = { necklace: 0, crown: 0, plooshie: 0 };

function setupShardHud() {
  const el = document.getElementById('shardHud');
  if (!el) return;
  const refresh = () => {
    const hl = performance.now() < shardPulseUntil ? shardPulseId : null;
    renderShardSlots(el, { counts: levelShards, variant: 'hud', highlight: hl });
  };
  refresh();
  // No Inventory.onInventoryChange — the HUD is per-level, not lifetime.
}

function awardShard(id) {
  if (!id) return;
  shardPulseId = id;
  shardPulseUntil = performance.now() + 1200;
  levelShards[id] = (levelShards[id] || 0) + 1;
  Inventory.addShard(id, 1); // lifetime total; chain settles at submitLevel
  const skuHash = SHARD_NAME_TO_SKU[id];
  if (skuHash) journal.shardsEarned.push(skuHash);
  Events.shardEarned(id, levelNum);
  // Refresh HUD immediately to show the +1
  const el = document.getElementById('shardHud');
  if (el) renderShardSlots(el, { counts: levelShards, variant: 'hud', highlight: id });
  clearTimeout(shardPulseTimer);
  shardPulseTimer = setTimeout(() => {
    if (el) renderShardSlots(el, { counts: levelShards, variant: 'hud' });
  }, 1250);
}

init().catch((err) => {
  console.error(err);
});
