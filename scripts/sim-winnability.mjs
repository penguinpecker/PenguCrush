// Winnability validator for PenguCrush.
//
// Replicates the core match-3 scoring loop from src/game.js:
//   combo starts 0; each cascade pass: combo++, score += m.size*10*combo*scoreScale
// then plays each level GAMES times with a greedy player and reports the share
// of games that reach the level's targetScore on the move budget alone.
//
// Optimistic by design (no blocker area loss, perfect greedy, no boosters/pass/
// shards), so real win rates are a bit LOWER — treat these as an upper bound.
// A healthy curve: Era 1 ~90%+, easing to ~60% by level 20.
//
// Usage: node scripts/sim-winnability.mjs [gamesPerLevel]

const GAMES = parseInt(process.argv[2] || '400', 10);

// Mirror of src/levels.js (grid, tile-type count, moves, scoreScale, target).
// Keep in sync when levels change — this is the regression guard for balance.
const LEVELS = [
  { level: 1,  grid: 7, types: 4, moves: 35, scale: 1,    target: 13100 },
  { level: 2,  grid: 7, types: 4, moves: 34, scale: 1,    target: 12200 },
  { level: 3,  grid: 7, types: 4, moves: 33, scale: 1.1,  target: 13500 },
  { level: 4,  grid: 7, types: 4, moves: 32, scale: 1.2,  target: 14800 },
  { level: 5,  grid: 8, types: 4, moves: 30, scale: 1,    target: 17400 },
  { level: 6,  grid: 8, types: 5, moves: 30, scale: 3,    target: 17000 },
  { level: 7,  grid: 8, types: 5, moves: 29, scale: 3.4,  target: 18900 },
  { level: 8,  grid: 8, types: 5, moves: 28, scale: 3.7,  target: 19700 },
  { level: 9,  grid: 8, types: 5, moves: 27, scale: 4.1,  target: 21300 },
  { level: 10, grid: 8, types: 5, moves: 26, scale: 4.5,  target: 22700 },
  { level: 11, grid: 8, types: 5, moves: 26, scale: 4.6,  target: 24000 },
  { level: 12, grid: 8, types: 6, moves: 25, scale: 11,   target: 24500 },
  { level: 13, grid: 8, types: 6, moves: 25, scale: 11.7, target: 26600 },
  { level: 14, grid: 8, types: 6, moves: 24, scale: 13.1, target: 27800 },
  { level: 15, grid: 8, types: 6, moves: 23, scale: 14.4, target: 29400 },
  { level: 16, grid: 8, types: 6, moves: 24, scale: 12.2, target: 30800 },
  { level: 17, grid: 8, types: 6, moves: 23, scale: 13.6, target: 31900 },
  { level: 18, grid: 8, types: 6, moves: 22, scale: 14.8, target: 32600 },
  { level: 19, grid: 8, types: 6, moves: 21, scale: 16.5, target: 34900 },
  { level: 20, grid: 8, types: 6, moves: 20, scale: 18.4, target: 36000 },
];

// Blocker interior-cell counts → area-loss discount applied to the optimistic score.
const BLOCKERS = {
  6:3, 7:5, 8:6, 9:7, 10:8, 11:8, 12:12, 13:15, 14:16, 15:20,
  16:5, 17:9, 18:7, 19:9, 20:13,
};
function blockerDiscount(level, grid) {
  return 1 - 0.6 * ((BLOCKERS[level] || 0) / (grid * grid));
}

const rnd = (n) => Math.floor(Math.random() * n);

function makeBoard(grid, types) {
  const b = Array.from({ length: grid }, () => Array(grid).fill(0));
  for (let r = 0; r < grid; r++)
    for (let c = 0; c < grid; c++) {
      let t;
      do { t = rnd(types); } while (
        (c >= 2 && b[r][c-1] === t && b[r][c-2] === t) ||
        (r >= 2 && b[r-1][c] === t && b[r-2][c] === t)
      );
      b[r][c] = t;
    }
  return b;
}

function findMatches(b, grid) {
  const set = new Set();
  for (let r = 0; r < grid; r++)
    for (let c = 0; c < grid; c++) {
      if (c <= grid - 3 && b[r][c] >= 0 && b[r][c] === b[r][c+1] && b[r][c] === b[r][c+2]) {
        let cc = c; while (cc < grid && b[r][cc] === b[r][c]) { set.add(r*grid+cc); cc++; }
      }
      if (r <= grid - 3 && b[r][c] >= 0 && b[r][c] === b[r+1][c] && b[r][c] === b[r+2][c]) {
        let rr = r; while (rr < grid && b[rr][c] === b[r][c]) { set.add(rr*grid+c); rr++; }
      }
    }
  return set;
}

function applyGravity(b, grid, types) {
  for (let c = 0; c < grid; c++) {
    let write = grid - 1;
    for (let r = grid - 1; r >= 0; r--) {
      if (b[r][c] >= 0) { b[write][c] = b[r][c]; if (write !== r) b[r][c] = -1; write--; }
    }
    for (let r = write; r >= 0; r--) b[r][c] = rnd(types);
  }
}

function resolve(b, grid, types, scale) {
  let score = 0, combo = 0;
  let m = findMatches(b, grid);
  while (m.size > 0) {
    combo++;
    score += m.size * 10 * combo * scale;
    for (const k of m) { b[Math.floor(k/grid)][k%grid] = -1; }
    applyGravity(b, grid, types);
    m = findMatches(b, grid);
  }
  return score;
}

const clone = (b) => b.map(row => row.slice());

function bestMove(b, grid, types, scale) {
  let best = null, bestScore = -1;
  for (let r = 0; r < grid; r++)
    for (let c = 0; c < grid; c++) {
      for (const [dr, dc] of [[0,1],[1,0]]) {
        const nr = r+dr, nc = c+dc;
        if (nr >= grid || nc >= grid) continue;
        const t = clone(b);
        [t[r][c], t[nr][nc]] = [t[nr][nc], t[r][c]];
        if (findMatches(t, grid).size === 0) continue;
        const sc = resolve(clone(t), grid, types, scale);
        if (sc > bestScore) { bestScore = sc; best = [r, c, nr, nc]; }
      }
    }
  return best;
}

function playGame(L) {
  const b = makeBoard(L.grid, L.types);
  let score = 0;
  for (let mv = 0; mv < L.moves; mv++) {
    const move = bestMove(b, L.grid, L.types, L.scale);
    if (!move) {
      const nb = makeBoard(L.grid, L.types);
      for (let r=0;r<L.grid;r++) for (let c=0;c<L.grid;c++) b[r][c]=nb[r][c];
      continue;
    }
    const [r,c,nr,nc] = move;
    [b[r][c], b[nr][nc]] = [b[nr][nc], b[r][c]];
    score += resolve(b, L.grid, L.types, L.scale);
  }
  return score * blockerDiscount(L.level, L.grid); // apply area loss
}

const pctile = (arr, p) => { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(p*(s.length-1))]; };

let warnings = 0;
console.log(`\nPenguCrush — winnability validation (${GAMES} greedy games/level)\n`);
console.log('Lvl types mv  scale  target   median    win%   verdict');
console.log('──────────────────────────────────────────────────────');
for (const L of LEVELS) {
  const scores = Array.from({ length: GAMES }, () => playGame(L));
  const med = Math.round(pctile(scores, 0.5));
  const win = scores.filter(s => s >= L.target).length / scores.length * 100;
  // Healthy band: 55–96%. Outside → flag.
  let verdict = 'ok';
  if (win < 50) { verdict = '⚠ too hard'; warnings++; }
  else if (win < 58) verdict = '~ hard';
  else if (win > 97) { verdict = '⚠ trivial'; warnings++; }
  console.log(
    `${String(L.level).padStart(3)} ${String(L.types).padStart(5)} ${String(L.moves).padStart(2)} ${('x'+L.scale).padStart(6)} ${String(L.target).padStart(7)} ${String(med).padStart(8)} ${String(win.toFixed(0)).padStart(6)}   ${verdict}`
  );
}
console.log('\nwin% = greedy games hitting targetScore on moves alone (optimistic; real is lower).');
console.log(warnings === 0
  ? '✓ All levels in a healthy difficulty band.\n'
  : `⚠ ${warnings} level(s) outside the healthy band — review.\n`);
process.exit(warnings === 0 ? 0 : 1);
