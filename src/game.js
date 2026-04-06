import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ═══════════════════════════════════════════════════════════════
//  LOADING OVERLAY (poster + WebM scrub → outro)
// ═══════════════════════════════════════════════════════════════
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
  if (bar) bar.style.transform = `scaleX(${p})`;
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
    if (!video) {
      resolve();
      return;
    }
    const finish = () => resolve();
    if (video.error) {
      finish();
      return;
    }
    const ok = () => {
      if (video.readyState >= 2) {
        finish();
        return true;
      }
      return false;
    };
    if (ok()) return;
    video.addEventListener('loadeddata', finish, { once: true });
    video.addEventListener('canplay', finish, { once: true });
    video.addEventListener('error', finish, { once: true });
    try {
      video.load();
    } catch (_) {
      finish();
    }
  });
}

function revealLoadingVideoLayer() {
  const video = document.getElementById('loadingVideo');
  const content = document.getElementById('loadingScreenContent');
  if (!video || video.error || video.readyState < 2) return;
  video.classList.add('loading-screen__video--ready');
  content?.classList.add('loading-screen__content--video-ready');
}

function advanceLoadingStep(stepRef, totalSteps) {
  stepRef.n = Math.min(stepRef.n + 1, totalSteps);
  updateLoadingUI(stepRef.n / totalSteps);
}

function finishLoadingOutro(options = {}) {
  const { redirectTo } = options;
  const screen = document.getElementById('loadingScreen');
  const app = document.getElementById('app');
  const video = document.getElementById('loadingVideo');
  updateLoadingUI(1);
  if (video?.duration && Number.isFinite(video.duration)) {
    try {
      video.currentTime = Math.max(0, video.duration - 0.03);
    } catch (_) {}
  }
  try {
    video?.pause();
  } catch (_) {}

  if (!redirectTo) {
    app?.classList.remove('app--hidden');
    app?.classList.add('app--revealed');
  }

  if (!screen) {
    if (redirectTo) window.location.replace(redirectTo);
    return;
  }
  screen.setAttribute('aria-busy', 'false');
  screen.classList.add('loading-screen--exit');

  let outroDone = false;
  const cleanup = () => {
    if (outroDone) return;
    outroDone = true;
    screen.remove();
    if (redirectTo) window.location.replace(redirectTo);
  };
  screen.addEventListener(
    'animationend',
    (e) => {
      if (e.animationName === 'loading-screen-outro' || e.animationName === 'loading-screen-outro-reduced') {
        cleanup();
      }
    },
    { once: true }
  );
  setTimeout(cleanup, 1000);
}

function recoverFromLoadingFailure(revealApp = true) {
  document.getElementById('loadingScreen')?.remove();
  if (!revealApp) return;
  const app = document.getElementById('app');
  app?.classList.remove('app--hidden');
  app?.classList.add('app--revealed');
}

const MIN_LOADING_PLAY_MS = 2500;

/** After load, play the clip forward for at least this long (loops if it ends early). */
async function holdMinLoadingVideoPlayback(video) {
  if (!video || video.error || !Number.isFinite(video.duration)) {
    await new Promise((r) => setTimeout(r, MIN_LOADING_PLAY_MS));
    return;
  }
  const deadline = performance.now() + MIN_LOADING_PLAY_MS;
  try {
    if (video.currentTime >= video.duration - 0.12) {
      video.currentTime = 0;
    }
    await video.play();
  } catch (_) {}
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (video.ended) {
      video.currentTime = 0;
      try {
        await video.play();
      } catch (_) {}
    }
  }
  try {
    video.pause();
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════
const GRID = 8;
const CELL = 1.2;
const MAX_MOVES = 30;
const TYPES = ['ice', 'popsicle', 'fish', 'frostice'];

const GLB_PATHS = {
  ice:       '/assets/ice-crystal.glb',
  popsicle:  '/assets/popsicle.glb',
  fish:      '/assets/fish.glb',
  frostice:  '/assets/frosted-ice.glb',
};

const TYPE_FIX = {
  ice:       { rx: 0, ry: 0, rz: 0, scale: 0.85 },
  popsicle:  { rx: Math.PI/2, ry: Math.PI*5/4, rz: 0, scale: 0.70 },
  fish:      { rx: 0, ry: Math.PI/2, rz: 0, scale: 0.55 },
  frostice:  { rx: 0, ry: 0, rz: 0, scale: 0.85 },
};

let board = [], selected = null, animating = false, score = 0, moves = MAX_MOVES, combo = 0;

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
const loader = new GLTFLoader();
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
}

// ═══════════════════════════════════════════════════════════════
async function loadGridFrame() {
  try {
    const frame = await loadGLB('/assets/grid-frame.glb');

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
  // Fish inside ice
  if (type === 'fish' && glbCache['fish'] && glbCache['ice']) {
    return createInsideIceTile('fish');
  }
  // Popsicle inside ice
  if (type === 'popsicle' && glbCache['popsicle'] && glbCache['ice']) {
    return createInsideIceTile('popsicle');
  }
  // Ice crystal — standalone
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
function randomType() { return TYPES[Math.floor(Math.random() * TYPES.length)]; }

function createTile(type, row, col) {
  const mesh = createTileMesh(type);
  mesh.position.copy(gridToWorld(row, col));
  scene.add(mesh);
  return { type, mesh, row, col };
}

function initBoard() {
  board = [];
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
}

// ═══════════════════════════════════════════════════════════════
//  MATCH DETECTION
// ═══════════════════════════════════════════════════════════════
function findMatches() {
  const matched = new Set();
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID - 2; c++) {
    const t = board[r][c]?.type;
    if (t && board[r][c+1]?.type === t && board[r][c+2]?.type === t) {
      let e = c + 2;
      while (e + 1 < GRID && board[r][e+1]?.type === t) e++;
      for (let i = c; i <= e; i++) matched.add(`${r},${i}`);
    }
  }
  for (let c = 0; c < GRID; c++) for (let r = 0; r < GRID - 2; r++) {
    const t = board[r][c]?.type;
    if (t && board[r+1]?.[c]?.type === t && board[r+2]?.[c]?.type === t) {
      let e = r + 2;
      while (e + 1 < GRID && board[e+1]?.[c]?.type === t) e++;
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
  const cols = { ice: 0x4fc3f7, popsicle: 0x7cb342, fish: 0xff7043, frostice: 0xe0f0ff };
  const ps = [];
  for (const k of matched) {
    const [r, c] = k.split(',').map(Number);
    if (board[r][c]) {
      particles(board[r][c].mesh.position.clone(), cols[board[r][c].type] || 0xfff);
      ps.push(animDestroy(board[r][c].mesh));
      board[r][c] = null;
    }
  }
  await Promise.all(ps);
}

async function dropTiles() {
  const ps = [];
  for (let c = 0; c < GRID; c++) {
    let wr = GRID - 1;
    for (let r = GRID - 1; r >= 0; r--) if (board[r][c]) {
      if (r !== wr) {
        board[wr][c] = board[r][c]; board[r][c] = null;
        board[wr][c].row = wr;
        ps.push(animMove(board[wr][c].mesh, gridToWorld(wr, c), 300));
      }
      wr--;
    }
    for (let r = wr; r >= 0; r--) {
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

async function handleSwap(r1, c1, r2, c2) {
  if (animating) return; animating = true;
  await swapTiles(r1, c1, r2, c2);
  if (findMatches().size === 0) {
    await swapTiles(r2, c2, r1, c1);
    await Promise.all([animShake(board[r1][c1].mesh), animShake(board[r2][c2].mesh)]);
    showMsg('No match!', 500);
  } else {
    moves--; updateHUD(); await processMatches();
    if (moves <= 0) showMsg(`Game Over! Score: ${score}`, 4000);
  }
  animating = false;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

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

canvas.addEventListener('click', e => {
  if (animating || moves <= 0) return;
  const cl = getClicked(e);
  if (!cl) return;
  if (!selected) {
    selected = cl;
    const p = gridToWorld(cl.row, cl.col);
    selRing.position.set(p.x, p.y, 0.6); selRing.visible = true;
  } else if (selected.row === cl.row && selected.col === cl.col) {
    selected = null; selRing.visible = false;
  } else if (Math.abs(selected.row - cl.row) + Math.abs(selected.col - cl.col) === 1) {
    selRing.visible = false;
    handleSwap(selected.row, selected.col, cl.row, cl.col);
    selected = null;
  } else {
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

const LOADING_GAME_TOTAL = 8; // poster+video bundle + 4 GLBs + frame + 2 HUD (first step after media)

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
  const step = { n: 0 };
  updateLoadingUI(0);

  console.log('🐧 PenguCrush loading...');
  const loadingVideo = document.getElementById('loadingVideo');
  try {
    loadingVideo?.pause();
  } catch (_) {}

  await Promise.all([waitForLoadingPoster(), waitForLoadingVideo(loadingVideo)]);
  revealLoadingVideoLayer();
  advanceLoadingStep(step, LOADING_GAME_TOTAL);

  await preloadAssets(() => advanceLoadingStep(step, LOADING_GAME_TOTAL));

  await loadGridFrame();
  advanceLoadingStep(step, LOADING_GAME_TOTAL);

  await loadHUDPanel('scoreCanvas', '/assets/score-panel.glb');
  advanceLoadingStep(step, LOADING_GAME_TOTAL);

  await loadHUDPanel('movesCanvas', '/assets/moves-panel.glb');
  advanceLoadingStep(step, LOADING_GAME_TOTAL);

  updateHUD();
  initBoard();
  animate();
  console.log('🐧 PenguCrush ready!');

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await holdMinLoadingVideoPlayback(loadingVideo);
  finishLoadingOutro();
}

init().catch((err) => {
  console.error(err);
  recoverFromLoadingFailure(true);
});
