// Star-distribution audit for PenguCrush.
// Simulates casual (0.5-skill) play and reports what fraction of
// WINNING runs earn 0/1/2/3 stars, using the actual computeStars
// logic from src/levels.js (hybrid score + efficiency path).
//
// Usage: node scripts/sim-stars.mjs [games]

const GAMES = parseInt(process.argv[2] || '400', 10);
const CASUAL = 0.5;
const MOVE_STAR_2_PCT = 0.15;
const MOVE_STAR_3_PCT = 0.30;

const LEVELS = [
  { level:1,  grid:7, types:4, moves:35, scale:1,    target:9300,  stars:[9300,13900,17400] },
  { level:2,  grid:7, types:4, moves:34, scale:1,    target:8200,  stars:[8200,12900,16100] },
  { level:3,  grid:7, types:4, moves:33, scale:1.1,  target:9000,  stars:[9000,13400,16800] },
  { level:4,  grid:7, types:4, moves:32, scale:1.2,  target:9900,  stars:[9900,14600,18300] },
  { level:5,  grid:8, types:4, moves:30, scale:1,    target:11100, stars:[11100,16600,20900] },
  { level:6,  grid:8, types:5, moves:30, scale:3,    target:13400, stars:[13400,17400,21800] },
  { level:7,  grid:8, types:5, moves:29, scale:3.4,  target:14400, stars:[14400,18400,23000] },
  { level:8,  grid:8, types:5, moves:28, scale:3.7,  target:15400, stars:[15400,19400,24300] },
  { level:9,  grid:8, types:5, moves:27, scale:4.1,  target:16600, stars:[16600,20200,25300] },
  { level:10, grid:8, types:5, moves:26, scale:4.5,  target:21400, stars:[21400,25700,32100] },
  { level:11, grid:8, types:5, moves:26, scale:4.6,  target:17300, stars:[17300,20800,26000] },
  { level:12, grid:8, types:6, moves:25, scale:11,   target:21400, stars:[21400,25700,32100] },
  { level:13, grid:8, types:6, moves:25, scale:11.7, target:22700, stars:[22700,27200,34000] },
  { level:14, grid:8, types:6, moves:24, scale:13.1, target:24400, stars:[24400,29300,36600] },
  { level:15, grid:8, types:6, moves:23, scale:14.4, target:30900, stars:[30900,37100,46400] },
  { level:16, grid:8, types:6, moves:24, scale:12.2, target:25200, stars:[25200,30200,37800] },
  { level:17, grid:8, types:6, moves:23, scale:13.6, target:27000, stars:[27000,32400,40500] },
  { level:18, grid:8, types:6, moves:22, scale:14.8, target:29700, stars:[29700,35600,44500] },
  { level:19, grid:8, types:6, moves:21, scale:16.5, target:31300, stars:[31300,37600,47000] },
  { level:20, grid:8, types:6, moves:20, scale:18.4, target:38000, stars:[38000,45600,57000] },
];
const BLOCKERS = { 6:3,7:5,8:6,9:7,10:8,11:8,12:12,13:15,14:16,15:20,16:5,17:9,18:7,19:9,20:13 };
const disc = (lvl,g) => 1 - 0.6 * ((BLOCKERS[lvl]||0) / (g*g));

function computeStars(score, movesUsed, L) {
  const [s1,s2,s3] = L.stars;
  const scoreStars = score>=s3 ? 3 : score>=s2 ? 2 : score>=s1 ? 1 : 0;
  const pct = Math.max(0, L.moves - Math.min(movesUsed, L.moves)) / L.moves;
  const moveStars = score>=s1 ? (pct>=MOVE_STAR_3_PCT ? 3 : pct>=MOVE_STAR_2_PCT ? 2 : 1) : 0;
  return Math.max(scoreStars, moveStars);
}

// Minimal board engine (same as other sims)
const rnd=(n)=>Math.floor(Math.random()*n);
function mk(g,t){const b=Array.from({length:g},()=>Array(g).fill(0));for(let r=0;r<g;r++)for(let c=0;c<g;c++){let x;do{x=rnd(t);}while((c>=2&&b[r][c-1]===x&&b[r][c-2]===x)||(r>=2&&b[r-1][c]===x&&b[r-2][c]===x));b[r][c]=x;}return b;}
function fm(b,g){const s=new Set();for(let r=0;r<g;r++)for(let c=0;c<g;c++){if(c<=g-3&&b[r][c]>=0&&b[r][c]===b[r][c+1]&&b[r][c]===b[r][c+2]){let cc=c;while(cc<g&&b[r][cc]===b[r][c]){s.add(r*g+cc);cc++;}}if(r<=g-3&&b[r][c]>=0&&b[r][c]===b[r+1][c]&&b[r][c]===b[r+2][c]){let rr=r;while(rr<g&&b[rr][c]===b[r][c]){s.add(rr*g+c);rr++;}}}return s;}
function gv(b,g,t){for(let c=0;c<g;c++){let w=g-1;for(let r=g-1;r>=0;r--){if(b[r][c]>=0){b[w][c]=b[r][c];if(w!==r)b[r][c]=-1;w--;}}for(let r=w;r>=0;r--)b[r][c]=rnd(t);}}
function rz(b,g,t,sc){let s=0,cm=0,m=fm(b,g);while(m.size>0){cm++;s+=m.size*10*cm*sc;for(const k of m)b[Math.floor(k/g)][k%g]=-1;gv(b,g,t);m=fm(b,g);}return s;}
const cl=(b)=>b.map(r=>r.slice());
function vm(b,g){const o=[];for(let r=0;r<g;r++)for(let c=0;c<g;c++)for(const[dr,dc]of[[0,1],[1,0]]){const nr=r+dr,nc=c+dc;if(nr>=g||nc>=g)continue;const t=cl(b);[t[r][c],t[nr][nc]]=[t[nr][nc],t[r][c]];if(fm(t,g).size>0)o.push([r,c,nr,nc]);}return o;}
function best(b,g,t,sc,mv){let B=null,bs=-1;for(const m of mv){const x=cl(b);[x[m[0]][m[1]],x[m[2]][m[3]]]=[x[m[2]][m[3]],x[m[0]][m[1]]];const s=rz(cl(x),g,t,sc);if(s>bs){bs=s;B=m;}}return B;}

function play(L, skill) {
  const b=mk(L.grid,L.types); let sc=0, mv=0;
  for(let i=0;i<L.moves;i++){
    const moves=vm(b,L.grid);
    if(!moves.length){const nb=mk(L.grid,L.types);for(let r=0;r<L.grid;r++)for(let c=0;c<L.grid;c++)b[r][c]=nb[r][c];continue;}
    const m=(Math.random()<skill)?best(b,L.grid,L.types,L.scale,moves):moves[rnd(moves.length)];
    [b[m[0]][m[1]],b[m[2]][m[3]]]=[b[m[2]][m[3]],b[m[0]][m[1]]];
    sc+=rz(b,L.grid,L.types,L.scale); mv++;
  }
  return { score: sc * disc(L.level, L.grid), movesUsed: mv };
}

console.log(`\nPenguCrush — star distribution (${GAMES} games/level, casual skill ${CASUAL})\n`);
console.log('     ── of ALL plays ──    ── of WINS only ──');
console.log('Lvl  fail  ★    ★★   ★★★  |   ★    ★★   ★★★   flag');
console.log('─────────────────────────────────────────────────');

let issues = 0;
for (const L of LEVELS) {
  const results = Array.from({length:GAMES}, () => play(L, CASUAL));
  const stars = results.map(r => computeStars(r.score, r.movesUsed, L));
  const wins = results.filter(r => r.score >= L.target);
  const winStars = wins.map(r => computeStars(r.score, r.movesUsed, L));

  const pct = (arr, val) => (arr.filter(s=>s===val).length/arr.length*100).toFixed(0)+'%';
  const pctW = (arr, val) => wins.length ? (arr.filter(s=>s===val).length/arr.length*100).toFixed(0)+'%' : 'n/a';

  const s1all = +pct(stars,1).replace('%','');
  const s2all = +pct(stars,2).replace('%','');
  const s3all = +pct(stars,3).replace('%','');
  const s3wins = wins.length ? +pctW(winStars,3).replace('%','') : 0;

  let flag = '';
  // 3★ unreachable even for winners → threshold too high
  if (s3all < 3 && wins.length > 10) { flag = '⚠ 3★ unreachable'; issues++; }
  // 2★ unreachable for winners → threshold too high
  else if (s2all < 3 && wins.length > 10) { flag = '⚠ 2★ unreachable'; issues++; }
  // All wins give 3★ → thresholds too easy
  else if (s3wins > 85 && wins.length > 10) { flag = '~ 3★ too easy'; }

  console.log(
    `${String(L.level).padStart(3)}  ${pct(stars,0).padStart(4)} ${pct(stars,1).padStart(4)} ${pct(stars,2).padStart(4)} ${pct(stars,3).padStart(4)}  | ` +
    `${pctW(winStars,1).padStart(4)} ${pctW(winStars,2).padStart(4)} ${pctW(winStars,3).padStart(4)}   ${flag}`
  );
}
console.log(`\n${issues===0 ? '✓ Star distribution looks healthy.' : `⚠ ${issues} level(s) need star threshold adjustment.`}\n`);
