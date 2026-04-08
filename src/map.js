import { getLevel, getLevelCount } from './levels.js';

const IMG_W = 2000, IMG_H = 1116;
const IMG_RATIO = IMG_W / IMG_H;

// Map node positions + player progress (will come from chain/localStorage later)
const MAP_NODES = [
  { id: 1,  x: 11.8, y: 85.9, stars: 2, best: 4200, status: 'completed' },
  { id: 2,  x: 20.3, y: 82.9, stars: 3, best: 5100, status: 'completed' },
  { id: 3,  x: 28.7, y: 79.7, stars: 0, best: 0,    status: 'current'   },
  { id: 4,  x: 33.9, y: 71.3, stars: 0, best: 0,    status: 'locked'    },
  { id: 5,  x: 20.8, y: 60.0, stars: 0, best: 0,    status: 'locked'    },
  { id: 6,  x: 15.0, y: 51.1, stars: 0, best: 0,    status: 'locked'    },
  { id: 7,  x: 20.1, y: 42.7, stars: 0, best: 0,    status: 'locked'    },
  { id: 8,  x: 28.2, y: 39.9, stars: 0, best: 0,    status: 'locked'    },
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
];

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

  MAP_NODES.forEach(lv => {
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

  const s = document.createElement('style');
  s.textContent = '@keyframes shake { 0%, 100% { transform: translate(-50%,-50%) translateX(0); } 20% { transform: translate(-50%,-50%) translateX(-6px); } 40% { transform: translate(-50%,-50%) translateX(6px); } 60% { transform: translate(-50%,-50%) translateX(-4px); } 80% { transform: translate(-50%,-50%) translateX(4px); } }';
  document.head.appendChild(s);

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
