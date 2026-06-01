// Gated-economy tuner for PenguCrush.
//
// Sets each level's targetScore from the CASUAL (0.5-skill) score distribution
// to hit a designed win-curve: easy onboarding, gentle ramp, sharp era-end gates.
// Then models 2–3 booster uses to verify the "strong swing" goal (gate ~30%→~75%),
// tuning the per-tile booster point value if needed.
//
// scoreScale is held at its shipped value (normalises magnitudes); only targets,
// stars, and the booster point value are (re)derived here.
//
// Usage: node scripts/sim-tune.mjs [gamesPerLevel]

const GAMES = parseInt(process.argv[2] || '180', 10);
const CASUAL = 0.5; // free-player skill

// Designed casual win-rate per level (the gated curve). Gates at era ends 10/15/20.
const DESIRED = {
  1:0.92, 2:0.92, 3:0.90, 4:0.90, 5:0.88,      // onboarding
  6:0.80, 7:0.78, 8:0.75, 9:0.72, 10:0.38,     // ramp → GATE
  11:0.70, 12:0.68, 13:0.65, 14:0.62, 15:0.35, // ramp → GATE
  16:0.62, 17:0.58, 18:0.55, 19:0.52, 20:0.32, // ramp → GATE
};
const GATES = new Set([10, 15, 20]);

const LEVELS = [
  { level:1, grid:7, types:4, moves:35, scale:1 },   { level:2, grid:7, types:4, moves:34, scale:1 },
  { level:3, grid:7, types:4, moves:33, scale:1.1 }, { level:4, grid:7, types:4, moves:32, scale:1.2 },
  { level:5, grid:8, types:4, moves:30, scale:1 },   { level:6, grid:8, types:5, moves:30, scale:3 },
  { level:7, grid:8, types:5, moves:29, scale:3.4 }, { level:8, grid:8, types:5, moves:28, scale:3.7 },
  { level:9, grid:8, types:5, moves:27, scale:4.1 }, { level:10, grid:8, types:5, moves:26, scale:4.5 },
  { level:11, grid:8, types:5, moves:26, scale:4.6 },{ level:12, grid:8, types:6, moves:25, scale:11 },
  { level:13, grid:8, types:6, moves:25, scale:11.7 },{ level:14, grid:8, types:6, moves:24, scale:13.1 },
  { level:15, grid:8, types:6, moves:23, scale:14.4 },{ level:16, grid:8, types:6, moves:24, scale:12.2 },
  { level:17, grid:8, types:6, moves:23, scale:13.6 },{ level:18, grid:8, types:6, moves:22, scale:14.8 },
  { level:19, grid:8, types:6, moves:21, scale:16.5 },{ level:20, grid:8, types:6, moves:20, scale:18.4 },
];
const BLOCKERS = { 6:3,7:5,8:6,9:7,10:8,11:8,12:12,13:15,14:16,15:20,16:5,17:9,18:7,19:9,20:13 };
const disc = (lvl,g)=>1-0.6*((BLOCKERS[lvl]||0)/(g*g));

// Booster economy model (DECOUPLED from scoreScale): a booster is worth a flat
// fraction of the level's target, so its swing is consistent everywhere instead
// of being distorted by the per-level display scale. PCT is auto-tuned below.
let PCT = 0.04; // per-booster value as a fraction of targetScore
const perBooster = (target) => PCT * target;

const rnd=(n)=>Math.floor(Math.random()*n);
function mk(g,t){const b=Array.from({length:g},()=>Array(g).fill(0));for(let r=0;r<g;r++)for(let c=0;c<g;c++){let x;do{x=rnd(t);}while((c>=2&&b[r][c-1]===x&&b[r][c-2]===x)||(r>=2&&b[r-1][c]===x&&b[r-2][c]===x));b[r][c]=x;}return b;}
function fm(b,g){const s=new Set();for(let r=0;r<g;r++)for(let c=0;c<g;c++){if(c<=g-3&&b[r][c]>=0&&b[r][c]===b[r][c+1]&&b[r][c]===b[r][c+2]){let cc=c;while(cc<g&&b[r][cc]===b[r][c]){s.add(r*g+cc);cc++;}}if(r<=g-3&&b[r][c]>=0&&b[r][c]===b[r+1][c]&&b[r][c]===b[r+2][c]){let rr=r;while(rr<g&&b[rr][c]===b[r][c]){s.add(rr*g+c);rr++;}}}return s;}
function gv(b,g,t){for(let c=0;c<g;c++){let w=g-1;for(let r=g-1;r>=0;r--){if(b[r][c]>=0){b[w][c]=b[r][c];if(w!==r)b[r][c]=-1;w--;}}for(let r=w;r>=0;r--)b[r][c]=rnd(t);}}
function rz(b,g,t,sc){let s=0,cm=0,m=fm(b,g);while(m.size>0){cm++;s+=m.size*10*cm*sc;for(const k of m)b[Math.floor(k/g)][k%g]=-1;gv(b,g,t);m=fm(b,g);}return s;}
const cl=(b)=>b.map(r=>r.slice());
function vm(b,g){const o=[];for(let r=0;r<g;r++)for(let c=0;c<g;c++)for(const[dr,dc]of[[0,1],[1,0]]){const nr=r+dr,nc=c+dc;if(nr>=g||nc>=g)continue;const t=cl(b);[t[r][c],t[nr][nc]]=[t[nr][nc],t[r][c]];if(fm(t,g).size>0)o.push([r,c,nr,nc]);}return o;}
function best(b,g,t,sc,mv){let B=null,bs=-1;for(const m of mv){const x=cl(b);[x[m[0]][m[1]],x[m[2]][m[3]]]=[x[m[2]][m[3]],x[m[0]][m[1]]];const s=rz(cl(x),g,t,sc);if(s>bs){bs=s;B=m;}}return B;}
function play(L,skill){const b=mk(L.grid,L.types);let s=0;for(let i=0;i<L.moves;i++){const mv=vm(b,L.grid);if(!mv.length){const nb=mk(L.grid,L.types);for(let r=0;r<L.grid;r++)for(let c=0;c<L.grid;c++)b[r][c]=nb[r][c];continue;}const m=(Math.random()<skill)?best(b,L.grid,L.types,L.scale,mv):mv[rnd(mv.length)];[b[m[0]][m[1]],b[m[2]][m[3]]]=[b[m[2]][m[3]],b[m[0]][m[1]]];s+=rz(b,L.grid,L.types,L.scale);}return s*disc(L.level,L.grid);}
const pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(p*(s.length-1))];};
const r100=(n)=>Math.max(100,Math.round(n/100)*100);

// Collect casual score distributions once.
const dist = {};
for (const L of LEVELS) dist[L.level] = Array.from({length:GAMES},()=>play(L,CASUAL));

function winRate(L, target, boosters=0) {
  const bonus = boosters * perBooster(L.scale);
  return dist[L.level].filter(s => s + bonus >= target).length / GAMES * 100;
}

// Derive proposed targets first, then auto-tune PCT so every gate averages ~75%
// with 3 boosters. The booster value is a fraction of that level's own target so
// the swing is the same everywhere regardless of scoreScale magnitude.
const proposals = {};
for (const L of LEVELS) {
  proposals[L.level] = r100(pct(dist[L.level], 1 - DESIRED[L.level]));
}

function gateSwing3(pctVal) {
  return [...GATES].map(g => {
    const L = LEVELS.find(x => x.level === g);
    return dist[L.level].filter(s => s + 3 * pctVal * proposals[g] >= proposals[g]).length / GAMES * 100;
  });
}
// Search PCT in 0.01..0.20 for mean gate-3-booster win-rate closest to 75%
let bestPct = 0.04, bestErr = 1e9;
for (let p = 1; p <= 20; p++) {
  const pv = p / 100;
  const sw = gateSwing3(pv);
  const mean = sw.reduce((a, b) => a + b, 0) / sw.length;
  const err = Math.abs(mean - 75);
  if (err < bestErr) { bestErr = err; bestPct = pv; }
}
PCT = bestPct;

// Build final table
console.log(`\nPenguCrush — gated retune @ casual skill ${CASUAL} (${GAMES} games/level)`);
console.log(`Tuned per-booster value: ${(PCT * 100).toFixed(0)}% of level target per booster\n`);
console.log('Lvl  gate  target  | casualWin  +2boost  +3boost  | stars');
console.log('────────────────────────────────────────────────────────────────');
const out = {};
for (const L of LEVELS) {
  const lvl = L.level;
  const target = proposals[lvl];
  const bonus = (n) => n * PCT * target;
  let s2 = r100(Math.max(target * 1.2, pct(dist[lvl], 0.55)));
  let s3 = r100(Math.max(s2   * 1.25, pct(dist[lvl], 0.80)));
  if (s2 <= target) s2 = r100(target * 1.20);
  if (s3 <= s2)     s3 = r100(s2     * 1.25);
  out[lvl] = { target, stars: [target, s2, s3] };
  const w0 = dist[lvl].filter(s => s           >= target).length / GAMES * 100;
  const w2 = dist[lvl].filter(s => s + bonus(2) >= target).length / GAMES * 100;
  const w3 = dist[lvl].filter(s => s + bonus(3) >= target).length / GAMES * 100;
  console.log(
    `${String(lvl).padStart(3)} ${(GATES.has(lvl) ? 'GATE' : '    ')} ${String(target).padStart(7)}  | ` +
    `${(w0.toFixed(0)+'%').padStart(8)} ${(w2.toFixed(0)+'%').padStart(8)} ${(w3.toFixed(0)+'%').padStart(8)}  | ` +
    `[${out[lvl].stars.join(',')}]`
  );
}

console.log('\n── Paste-ready ──');
for (const L of LEVELS) {
  const o = out[L.level];
  console.log(`  L${String(L.level).padStart(2)}: targetScore: ${o.target}, stars: [${o.stars.join(', ')}],`);
}
// Reverse-engineer concrete per-tile pts that approximate PCT*target at L10
// (mid-game reference). Row/col clears ~7 tiles, cascades add ~1.6× on top.
const AVG_TILES = 7, CASCADE_MULT = 1.6;
const refTarget = proposals[10];
const ptsPerTileRaw = (PCT * refTarget) / (AVG_TILES * CASCADE_MULT);
const PTS_TILE_NEW      = Math.round(ptsPerTileRaw);
const PTS_HAMMER_NEW    = Math.round(ptsPerTileRaw * 1.33);
const PTS_ICE_NEW       = Math.round(ptsPerTileRaw / 3);
const PTS_HAMMER_ICE_NEW= Math.round(ptsPerTileRaw * 0.67);
console.log(`\nConcrete game.js constants (calibrated to L10 target ${refTarget}, ${(PCT*100).toFixed(0)}% per booster):`);
console.log(`  BOOSTER_PTS_TILE       = ${PTS_TILE_NEW}`);
console.log(`  BOOSTER_PTS_HAMMER     = ${PTS_HAMMER_NEW}`);
console.log(`  BOOSTER_PTS_ICE        = ${PTS_ICE_NEW}`);
console.log(`  BOOSTER_PTS_HAMMER_ICE = ${PTS_HAMMER_ICE_NEW}\n`);
