import * as THREE from 'three';
import { createGLTFLoader } from './gltf-loader.js';
import { getLevel, hasLevel } from './levels.js';
import { getWallet, ensureWallet, saveLevelResult } from './supabase.js';
import * as Inventory from './inventory.js';
import { logLevelOnchain } from './onchain.js';

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

let board = [], selected = null, animating = false, score = 0, moves = CONFIG.moves, combo = 0;
let gameOver = false;

// Objective tracking
const objective = { ...CONFIG.objective };
let tilesCleared = {};
let blockersDestroyed = {};
let totalTilesCleared = 0;

// Game timing
const gameStartTime = performance.now();

// Falling blocker tracking
let turnCount = 0;
const fallerConfig = CONFIG.blockers.find(b => b.type === 'faller');
let fallerDropsPenalized = 0;

// Set background based on era
if (CONFIG.bg) {
  document.body.style.background = `url('${CONFIG.bg}') center/cover no-repeat fixed`;
}

console.log(`🐧 Level ${levelNum} | Era ${CONFIG.era} | ${GRID}x${GRID} | ${CONFIG.moves} moves | Tiles: ${TILE_TYPES.join(', ')}`);

// ═══════════════════════════════════════════════════════════════
//  THREE.JS SETUP — transparent canvas so BG shows through
// ═══════════════════════════════════════════════════════════════
const canvas = document.getElementById('gameCanvas');
const W = Math.min(window.innerWidth - 60, window.innerHeight - 320, 580);
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

// Lighting
scene.add(new THREE.AmbientLight(0xd0ecff, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(4, 6, 12);
scene.add(keyLight);
scene.add(new THREE.DirectionalLight(0x80d0ff, 0.5).translateX(-4));
scene.add(new THREE.DirectionalLight(0xa0e0ff, 0.3).translateY(-6));

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
function findMatches() {
  const matched = new Set();
  const canMatch = (r, c) => board[r]?.[c] && !board[r][c].isWall && !board[r][c].frozen && !board[r][c].isFaller;
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID - 2; c++) {
    if (!canMatch(r, c)) continue;
    const t = board[r][c].type;
    if (canMatch(r, c+1) && board[r][c+1].type === t && canMatch(r, c+2) && board[r][c+2].type === t) {
      let e = c + 2;
      while (e + 1 < GRID && canMatch(r, e+1) && board[r][e+1].type === t) e++;
      for (let i = c; i <= e; i++) matched.add(`${r},${i}`);
    }
  }
  for (let c = 0; c < GRID; c++) for (let r = 0; r < GRID - 2; r++) {
    if (!canMatch(r, c)) continue;
    const t = board[r][c].type;
    if (canMatch(r+1, c) && board[r+1][c].type === t && canMatch(r+2, c) && board[r+2][c].type === t) {
      let e = r + 2;
      while (e + 1 < GRID && canMatch(e+1, c) && board[e+1][c].type === t) e++;
      for (let i = r; i <= e; i++) matched.add(`${i},${c}`);
    }
  }
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
      particles(board[r][c].mesh.position.clone(), cols[tileType] || 0xfff);
      ps.push(animDestroy(board[r][c].mesh));

      tilesCleared[tileType] = (tilesCleared[tileType] || 0) + 1;
      totalTilesCleared++;

      // Check adjacent cells for frozen tiles to unfreeze
      for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nr = r + dr, nc = c + dc;
        const adj = board[nr]?.[nc];
        if (adj && adj.frozen && !unfrozen.has(`${nr},${nc}`)) {
          unfrozen.add(`${nr},${nc}`);
          if (adj.iceLayer > 1) {
            adj.iceLayer--;
            // Visual feedback — shake the frozen tile
            ps.push(animShake(adj.mesh, 200));
            particles(adj.mesh.position.clone(), 0x88ccff);
          } else {
            removeFrozenOverlay(adj);
            adj.iceLayer = 0;
            particles(adj.mesh.position.clone(), 0xaaeeff);
            blockersDestroyed['frozen'] = (blockersDestroyed['frozen'] || 0) + 1;
            blockersDestroyed['ice'] = (blockersDestroyed['ice'] || 0) + 1;
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
    combo++; score += m.size * 10 * combo; updateHUD();
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
        moves = Math.max(0, moves - 1);
        fallerDropsPenalized++;
        updateHUD();
        showMsg('-1 Move!', 600);

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
  spawnFaller();
  await delay(200);
  await dropFallers();
}

/** After cascades settle: faller step, then win / out-of-moves popup (same as a normal swap). */
async function resolveLevelStateAfterBoardSettled() {
  await processFallers();
  if (gameOver) return;
  if (checkObjective()) {
    await delay(400);
    showLevelPopup(true);
  } else if (moves <= 0) {
    await delay(400);
    showLevelPopup(false);
  }
}

function checkObjective() {
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
      // Check no blockers remain on board (placeholder — blockers not placed yet)
      return score >= CONFIG.targetScore;
    case 'clearPercent': {
      const total = GRID * GRID;
      return totalTilesCleared >= Math.ceil(total * obj.percent / 100);
    }
    case 'combo':
      return score >= obj.scoreTarget;
    default:
      return score >= CONFIG.targetScore;
  }
}

function getStars() {
  const [s1, s2, s3] = CONFIG.stars;
  if (score >= s3) return 3;
  if (score >= s2) return 2;
  if (score >= s1) return 1;
  return 0;
}

// ═══════════════════════════════════════════════════════════════
//  LEVEL COMPLETE / FAIL POPUP
// ═══════════════════════════════════════════════════════════════
function showLevelPopup(won) {
  gameOver = true;
  const popup = document.getElementById('levelPopup');
  const title = document.getElementById('levelPopupTitle');
  const starsEl = document.getElementById('levelPopupStars');
  const scoreEl = document.getElementById('levelPopupScore');
  const objEl = document.getElementById('levelPopupObjective');
  const nextBtn = document.getElementById('levelPopupNext');

  const stars = won ? getStars() : 0;
  const durationMs = Math.round(performance.now() - gameStartTime);

  if (won) {
    title.classList.remove('fail');
    title.innerHTML = `<span class="level-popup-title-label">LEVEL</span><span class="level-popup-title-num">${levelNum}</span>`;

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
    objEl.textContent = `${stars} star${stars !== 1 ? 's' : ''} earned`;
    nextBtn.classList.remove('hidden');
    const canNext = hasLevel(levelNum + 1);
    nextBtn.disabled = !canNext;
    nextBtn.classList.toggle('disabled', !canNext);
  } else {
    title.innerHTML = 'Out of<br>Moves!';
    title.classList.add('fail');

    // Failure: all three slots empty → no overlays needed, baked-in
    // stars on the popup frame show through.
    starsEl.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const img = document.createElement('img');
      img.style.visibility = 'hidden';
      starsEl.appendChild(img);
    }

    scoreEl.textContent = score.toLocaleString();
    objEl.textContent = 'Try again!';
    nextBtn.classList.add('hidden');
    nextBtn.disabled = false;
    nextBtn.classList.remove('disabled');
  }

  // Save to localStorage (immediate fallback)
  const progress = JSON.parse(localStorage.getItem('pengucrush_progress') || '{}');
  const prev = progress[levelNum] || { stars: 0, best: 0 };
  progress[levelNum] = { stars: Math.max(prev.stars, stars), best: Math.max(prev.best, score) };
  if (won && !progress[levelNum + 1] && hasLevel(levelNum + 1)) {
    progress[levelNum + 1] = { stars: 0, best: 0, unlocked: true };
  }
  localStorage.setItem('pengucrush_progress', JSON.stringify(progress));

  // Save to Supabase (async, non-blocking)
  const wallet = getWallet();
  const movesUsed = CONFIG.moves - moves;
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
    }).then(res => {
      if (res?.success) console.log('🐧 Progress saved to Supabase:', res);
      else console.warn('🐧 Supabase save failed:', res);
    });

    // On-chain: submitScore to the PenguCrush proxy on Abstract (best-effort).
    // Only write for completed runs so failed attempts don't clutter history.
    if (won) {
      logLevelOnchain({ level: levelNum, score, stars, movesUsed });
    }
  }

  popup.classList.add('active');
}

function setupLevelPopupButtons() {
  document.getElementById('levelPopupMap').addEventListener('click', () => {
    window.__pengu.goToMap();
  });
  document.getElementById('levelPopupReplay').addEventListener('click', () => {
    window.location.href = `/?level=${levelNum}`;
  });
  document.getElementById('levelPopupNext').addEventListener('click', () => {
    if (hasLevel(levelNum + 1)) window.__pengu.goToLevel(levelNum + 1);
  });
}

async function handleSwap(r1, c1, r2, c2) {
  if (animating || gameOver) return; animating = true;
  await swapTiles(r1, c1, r2, c2);
  if (findMatches().size === 0) {
    await swapTiles(r2, c2, r1, c1);
    await Promise.all([animShake(board[r1][c1].mesh), animShake(board[r2][c2].mesh)]);
    showMsg('No match!', 500);
  } else {
    moves--; updateHUD(); await processMatches();
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
  const ps = [];
  for (let c = 0; c < GRID; c++) {
    const tile = board[row][c];
    if (!tile || tile.isWall) continue;
    if (tile.frozen) { removeFrozenOverlay(tile); tile.iceLayer = 0; continue; }
    particles(tile.mesh.position.clone(), 0x00bfff);
    ps.push(animDestroy(tile.mesh));
    tilesCleared[tile.type] = (tilesCleared[tile.type] || 0) + 1;
    totalTilesCleared++;
    board[row][c] = null;
  }
  await Promise.all(ps);
  await delay(100);
  await dropTiles();
  await processMatches();
  await resolveLevelStateAfterBoardSettled();
  animating = false;
}

async function useBoosterCol(col) {
  if (animating) return;
  animating = true;
  const ps = [];
  for (let r = 0; r < GRID; r++) {
    const tile = board[r][col];
    if (!tile || tile.isWall) continue;
    if (tile.frozen) { removeFrozenOverlay(tile); tile.iceLayer = 0; continue; }
    particles(tile.mesh.position.clone(), 0x00ced1);
    ps.push(animDestroy(tile.mesh));
    tilesCleared[tile.type] = (tilesCleared[tile.type] || 0) + 1;
    totalTilesCleared++;
    board[r][col] = null;
  }
  await Promise.all(ps);
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
  if (tile.frozen) {
    removeFrozenOverlay(tile);
    tile.iceLayer = 0;
    particles(tile.mesh.position.clone(), 0xaaeeff);
  } else {
    particles(tile.mesh.position.clone(), 0xffb800);
    await animDestroy(tile.mesh);
    tilesCleared[tile.type] = (tilesCleared[tile.type] || 0) + 1;
    totalTilesCleared++;
    board[row][col] = null;
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
  const ps = [];
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const t = board[r][c];
    if (!t || t.isWall || t.frozen || t.type !== targetType) continue;
    particles(t.mesh.position.clone(), 0xff66aa);
    ps.push(animDestroy(t.mesh));
    tilesCleared[t.type] = (tilesCleared[t.type] || 0) + 1;
    totalTilesCleared++;
    board[r][c] = null;
  }
  await Promise.all(ps);
  await delay(100);
  await dropTiles();
  await processMatches();
  await resolveLevelStateAfterBoardSettled();
  animating = false;
}

async function useBoosterShuffle() {
  if (animating) return;
  animating = true;
  // Collect non-wall, non-frozen tile types
  const positions = [];
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const t = board[r][c];
    if (t && !t.isWall && !t.frozen) positions.push([r, c]);
  }
  // Remove all
  for (const [r, c] of positions) {
    scene.remove(board[r][c].mesh);
    board[r][c] = null;
  }
  // Refill avoiding matches
  for (const [r, c] of positions) {
    let type;
    do { type = randomType(); } while (
      (c >= 2 && board[r][c-1]?.type === type && board[r][c-2]?.type === type) ||
      (r >= 2 && board[r-1]?.[c]?.type === type && board[r-2]?.[c]?.type === type)
    );
    board[r][c] = createTile(type, r, c);
  }
  await delay(300);
  await resolveLevelStateAfterBoardSettled();
  animating = false;
}

function consumeBooster(type) {
  // Persist consumption to the wallet inventory (localStorage + cloud best-effort).
  const remaining = Inventory.consumeBooster(type);
  boosterCharges[type] = remaining;
  updateBoosterUI();
  if (remaining <= 0) activeBooster = null;
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

// ═══════════════════════════════════════════════════════════════
//  HUD
// ═══════════════════════════════════════════════════════════════
function updateHUD() {
  document.getElementById('scoreVal').textContent = score;
  document.getElementById('movesVal').textContent = moves;
  const sc = document.getElementById('scoreCanvas');
  const mc = document.getElementById('movesCanvas');
  if (sc) drawHUDPanel(sc);
  if (mc) drawHUDPanel(mc);
}

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
  renderer.render(scene, camera);
}

// ═══════════════════════════════════════════════════════════════
//  DEBUG — Popsicle: 2=X 3=Y 4=Z | Fish: 7=X 8=Y 9=Z
// ═══════════════════════════════════════════════════════════════
window.addEventListener('keydown', (e) => {
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
//  3D HUD PANELS
// ═══════════════════════════════════════════════════════════════
async function loadHUDPanel(canvasId, glbPath) {
  try {
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
    const box0 = new THREE.Box3().setFromObject(model);
    const sz0 = new THREE.Vector3(); box0.getSize(sz0);
    console.log(`HUD ${glbPath}: ${sz0.x.toFixed(2)} x ${sz0.y.toFixed(2)} x ${sz0.z.toFixed(2)}`);

    // Auto-detect best rotation: try 3 orientations, pick widest front face
    const rots = [
      [0, 0, 0],
      [-Math.PI/2, 0, 0],
      [0, -Math.PI/2, 0],
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

    // Tight camera that fits model exactly
    const finalBox = new THREE.Box3().setFromObject(model);
    const finalSz = new THREE.Vector3(); finalBox.getSize(finalSz);
    const pad = 1.1;
    const halfW = finalSz.x * pad / 2;
    const halfH = finalSz.y * pad / 2;
    const aspect = 640 / 350;
    const camH = Math.max(halfH, halfW / aspect);
    const pc = new THREE.OrthographicCamera(-camH*aspect, camH*aspect, camH, -camH, 0.1, 100);
    pc.position.set(0, 0, 20); pc.lookAt(0, 0, 0);
    pr.render(ps, pc);

    // Convert to 2D image
    const panelImg = new Image();
    panelImg.src = offCanvas.toDataURL();
    pr.dispose();

    // Store reference for updateHUD to redraw text onto
    const cvs = document.getElementById(canvasId);
    cvs.width = 640;
    cvs.height = 280;
    cvs._panelImg = panelImg;
    cvs._ready = false;

    panelImg.onload = () => {
      cvs._ready = true;
      drawHUDPanel(cvs);
    };

    console.log(`✓ HUD ${canvasId} rendered as 2D`);
  } catch(e) { console.warn(`HUD ${canvasId} failed:`, e); }
}

function drawHUDPanel(cvs) {
  if (!cvs._ready) return;
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  ctx.drawImage(cvs._panelImg, 0, 0, cvs.width, cvs.height);

  // Draw the number value
  const valueEl = cvs.id === 'scoreCanvas'
    ? document.getElementById('scoreVal')
    : document.getElementById('movesVal');
  const text = valueEl?.textContent || '0';

  ctx.font = 'bold 72px Fredoka, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,30,60,0.6)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillText(text, cvs.width / 2, cvs.height * 0.62);
  ctx.shadowBlur = 0;
}

async function init() {
  console.log('🐧 PenguCrush loading...');

  await preloadAssets(() => {});
  await loadGridFrame();
  await loadHUDPanel('scoreCanvas', '/assets/hud/score-panel.glb');
  await loadHUDPanel('movesCanvas', '/assets/hud/moves-panel.glb');

  updateHUD();
  setupBoosterUI();
  setupLevelPopupButtons();
  initBoard();
  animate();
  console.log('🐧 PenguCrush ready!');
}

init().catch((err) => {
  console.error(err);
});
