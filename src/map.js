// ═══════════════════════════════════════════════════════════════
//  IMAGE ASPECT RATIO — stage scales to fit viewport
// ═══════════════════════════════════════════════════════════════
const IMG_W = 2000;
const IMG_H = 1116;
const IMG_RATIO = IMG_W / IMG_H;

const stage = document.getElementById('mapStage');

function resizeStage() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const viewRatio = vw / vh;

  let w, h;
  if (viewRatio > IMG_RATIO) {
    // Viewport is wider than image — fit to height, fill width
    h = vh;
    w = vh * IMG_RATIO;
  } else {
    // Viewport is taller — fit to width, fill height
    w = vw;
    h = vw / IMG_RATIO;
  }

  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
}

resizeStage();
window.addEventListener('resize', resizeStage);

// ═══════════════════════════════════════════════════════════════
//  LEVEL DATA — x,y as % of image (pixel coords / image size)
//  Detected from grey button centers in the 2000x1116 image
// ═══════════════════════════════════════════════════════════════

const LEVELS = [
  { id: 1,  x: 11.8, y: 85.9, stars: 2, best: 4200, status: 'completed' },
  { id: 2,  x: 20.3, y: 82.9, stars: 3, best: 5100, status: 'completed' },
  { id: 3,  x: 28.7, y: 79.7, stars: 0, best: 0,    status: 'current'   },
  { id: 4,  x: 33.9, y: 71.3, stars: 0, best: 0,    status: 'locked'    },
  { id: 5,  x: 20.8, y: 60.0, stars: 0, best: 0,    status: 'locked'    },
  { id: 6,  x: 15.0, y: 51.1, stars: 0, best: 0,    status: 'locked'    },
  { id: 7,  x: 20.1, y: 42.7, stars: 0, best: 0,    status: 'locked'    },
  { id: 8,  x: 29.2, y: 39.8, stars: 0, best: 0,    status: 'locked'    },
  { id: 9,  x: 37.4, y: 41.8, stars: 0, best: 0,    status: 'locked'    },
  { id: 10, x: 45.0, y: 47.8, stars: 0, best: 0,    status: 'locked'    },
  { id: 11, x: 50.8, y: 55.9, stars: 0, best: 0,    status: 'locked'    },
  { id: 12, x: 61.5, y: 72.9, stars: 0, best: 0,    status: 'locked'    },
  { id: 13, x: 69.0, y: 78.9, stars: 0, best: 0,    status: 'locked'    },
  { id: 14, x: 77.6, y: 80.4, stars: 0, best: 0,    status: 'locked'    },
  { id: 15, x: 85.5, y: 75.7, stars: 0, best: 0,    status: 'locked'    },
  { id: 16, x: 87.8, y: 64.0, stars: 0, best: 0,    status: 'locked'    },
  { id: 17, x: 82.4, y: 54.5, stars: 0, best: 0,    status: 'locked'    },
  { id: 18, x: 74.5, y: 49.4, stars: 0, best: 0,    status: 'locked'    },
  { id: 19, x: 69.3, y: 42.4, stars: 0, best: 0,    status: 'locked'    },
  { id: 20, x: 73.2, y: 34.4, stars: 0, best: 0,    status: 'locked'    },
  { id: 21, x: 81.3, y: 31.2, stars: 0, best: 0,    status: 'locked'    },
  { id: 22, x: 87.7, y: 30.7, stars: 0, best: 0,    status: 'locked'    },
];

function getTargetScore(level) { return 3000 + (level - 1) * 500; }
function getMoves(level) { return Math.max(20, 35 - level); }

// ═══════════════════════════════════════════════════════════════
//  RENDER NODES
// ═══════════════════════════════════════════════════════════════

const nodesContainer = document.getElementById('mapNodes');

LEVELS.forEach(lv => {
  const node = document.createElement('button');
  node.className = `level-node ${lv.status}`;
  node.style.left = `${lv.x}%`;
  node.style.top = `${lv.y}%`;
  node.dataset.level = lv.id;

  // Inner div for the circular button (padding-top aspect ratio trick)
  const inner = document.createElement('div');
  inner.className = 'node-inner';
  inner.textContent = lv.id;
  node.appendChild(inner);

  // Stars for completed
  if (lv.status === 'completed' && lv.stars > 0) {
    const starsEl = document.createElement('div');
    starsEl.className = 'node-stars';
    for (let s = 0; s < 3; s++) {
      const star = document.createElement('span');
      star.className = s < lv.stars ? 'star-earned' : 'star-empty';
      star.textContent = '★';
      starsEl.appendChild(star);
    }
    node.appendChild(starsEl);
  }

  // Lock for locked
  if (lv.status === 'locked') {
    const lock = document.createElement('span');
    lock.className = 'lock-icon';
    lock.textContent = '🔒';
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

// Shake
const s = document.createElement('style');
s.textContent = `@keyframes shake {
  0%, 100% { transform: translate(-50%,-50%) translateX(0); }
  20% { transform: translate(-50%,-50%) translateX(-6px); }
  40% { transform: translate(-50%,-50%) translateX(6px); }
  60% { transform: translate(-50%,-50%) translateX(-4px); }
  80% { transform: translate(-50%,-50%) translateX(4px); }
}`;
document.head.appendChild(s);

// ═══════════════════════════════════════════════════════════════
//  POPUP
// ═══════════════════════════════════════════════════════════════
const overlay = document.getElementById('popupOverlay');
let currentPopupLevel = null;

function openPopup(lv) {
  currentPopupLevel = lv;
  document.getElementById('popupLevelNum').textContent = lv.id;
  document.getElementById('popupStars').querySelectorAll('.star')
    .forEach((s, i) => s.classList.toggle('earned', i < lv.stars));
  document.getElementById('popupTarget').textContent = getTargetScore(lv.id).toLocaleString();
  document.getElementById('popupMoves').textContent = getMoves(lv.id);
  document.getElementById('popupBest').textContent = lv.best > 0 ? lv.best.toLocaleString() : '—';
  overlay.classList.add('active');
}
function closePopup() { overlay.classList.remove('active'); currentPopupLevel = null; }

document.getElementById('popupClose').addEventListener('click', closePopup);
document.getElementById('popupBack').addEventListener('click', closePopup);
overlay.addEventListener('click', e => { if (e.target === overlay) closePopup(); });
document.getElementById('popupPlay').addEventListener('click', () => {
  if (currentPopupLevel) window.location.href = `/?level=${currentPopupLevel.id}`;
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopup(); });

// ═══════════════════════════════════════════════════════════════
//  DEV: Shift+drag, D to dump
// ═══════════════════════════════════════════════════════════════
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
  dragging.style.left = `${((e.clientX - rect.left) / rect.width * 100).toFixed(1)}%`;
  dragging.style.top = `${((e.clientY - rect.top) / rect.height * 100).toFixed(1)}%`;
});
document.addEventListener('mouseup', () => {
  if (dragging) {
    dragging.style.zIndex = '';
    console.log(`Level ${dragging.dataset.level} → x: ${parseFloat(dragging.style.left).toFixed(1)}, y: ${parseFloat(dragging.style.top).toFixed(1)}`);
    dragging = null;
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'd' || e.key === 'D') {
    console.log('── Positions ──');
    nodesContainer.querySelectorAll('.level-node').forEach(n =>
      console.log(`  { id: ${n.dataset.level}, x: ${parseFloat(n.style.left).toFixed(1)}, y: ${parseFloat(n.style.top).toFixed(1)} },`)
    );
  }
});
