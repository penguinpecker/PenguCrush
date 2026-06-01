// Economy lens on PenguCrush: win-rate by PLAYER SKILL (not just optimal play),
// to judge how booster-dependent the game is and where the monetisation gates sit.
//
// skill ∈ [0,1]: each move, with prob `skill` the player makes the greedy-best
// swap, else a random valid swap. Real casual match-3 players sit ~0.45–0.6;
// engaged/experienced ~0.7–0.85; 1.0 = the optimistic validator number.
//
// Usage: node scripts/sim-economy.mjs [gamesPerLevel]

const GAMES = parseInt(process.argv[2] || '300', 10);

const LEVELS = [
  { level: 1,  grid: 7, types: 4, moves: 35, scale: 1,    target: 13100 },
  { level: 5,  grid: 8, types: 4, moves: 30, scale: 1,    target: 17400 },
  { level: 8,  grid: 8, types: 5, moves: 28, scale: 3.7,  target: 19700 },
  { level: 11, grid: 8, types: 5, moves: 26, scale: 4.6,  target: 24000 },
  { level: 13, grid: 8, types: 6, moves: 25, scale: 11.7, target: 26600 },
  { level: 16, grid: 8, types: 6, moves: 24, scale: 12.2, target: 30800 },
  { level: 20, grid: 8, types: 6, moves: 20, scale: 18.4, target: 36000 },
];
const BLOCKERS = { 8:6, 11:8, 13:15, 16:5, 20:13 };
const disc = (lvl, g) => 1 - 0.6 * ((BLOCKERS[lvl] || 0) / (g*g));

const rnd = (n) => Math.floor(Math.random()*n);
function makeBoard(grid, types){const b=Array.from({length:grid},()=>Array(grid).fill(0));for(let r=0;r<grid;r++)for(let c=0;c<grid;c++){let t;do{t=rnd(types);}while((c>=2&&b[r][c-1]===t&&b[r][c-2]===t)||(r>=2&&b[r-1][c]===t&&b[r-2][c]===t));b[r][c]=t;}return b;}
function findMatches(b,grid){const s=new Set();for(let r=0;r<grid;r++)for(let c=0;c<grid;c++){if(c<=grid-3&&b[r][c]>=0&&b[r][c]===b[r][c+1]&&b[r][c]===b[r][c+2]){let cc=c;while(cc<grid&&b[r][cc]===b[r][c]){s.add(r*grid+cc);cc++;}}if(r<=grid-3&&b[r][c]>=0&&b[r][c]===b[r+1][c]&&b[r][c]===b[r+2][c]){let rr=r;while(rr<grid&&b[rr][c]===b[r][c]){s.add(rr*grid+c);rr++;}}}return s;}
function grav(b,grid,types){for(let c=0;c<grid;c++){let w=grid-1;for(let r=grid-1;r>=0;r--){if(b[r][c]>=0){b[w][c]=b[r][c];if(w!==r)b[r][c]=-1;w--;}}for(let r=w;r>=0;r--)b[r][c]=rnd(types);}}
function resolve(b,grid,types,scale){let sc=0,cm=0,m=findMatches(b,grid);while(m.size>0){cm++;sc+=m.size*10*cm*scale;for(const k of m)b[Math.floor(k/grid)][k%grid]=-1;grav(b,grid,types);m=findMatches(b,grid);}return sc;}
const clone=(b)=>b.map(r=>r.slice());
function validMoves(b,grid){const out=[];for(let r=0;r<grid;r++)for(let c=0;c<grid;c++)for(const[dr,dc]of[[0,1],[1,0]]){const nr=r+dr,nc=c+dc;if(nr>=grid||nc>=grid)continue;const t=clone(b);[t[r][c],t[nr][nc]]=[t[nr][nc],t[r][c]];if(findMatches(t,grid).size>0)out.push([r,c,nr,nc]);}return out;}
function bestOf(b,grid,types,scale,moves){let best=null,bs=-1;for(const mv of moves){const t=clone(b);[t[mv[0]][mv[1]],t[mv[2]][mv[3]]]=[t[mv[2]][mv[3]],t[mv[0]][mv[1]]];const s=resolve(clone(t),grid,types,scale);if(s>bs){bs=s;best=mv;}}return best;}

function play(L, skill){
  const b=makeBoard(L.grid,L.types);let score=0;
  for(let mv=0;mv<L.moves;mv++){
    const moves=validMoves(b,L.grid);
    if(!moves.length){const nb=makeBoard(L.grid,L.types);for(let r=0;r<L.grid;r++)for(let c=0;c<L.grid;c++)b[r][c]=nb[r][c];continue;}
    const m=(Math.random()<skill)?bestOf(b,L.grid,L.types,L.scale,moves):moves[rnd(moves.length)];
    [b[m[0]][m[1]],b[m[2]][m[3]]]=[b[m[2]][m[3]],b[m[0]][m[1]]];
    score+=resolve(b,L.grid,L.types,L.scale);
  }
  return score*disc(L.level,L.grid);
}

const SKILLS = [{n:'casual',v:0.5},{n:'engaged',v:0.72},{n:'expert',v:1.0}];
console.log(`\nPenguCrush — win% by player skill (${GAMES} games/level, NO boosters/pass)\n`);
console.log('Lvl types  target | casual(0.5) engaged(0.72) expert(1.0)');
console.log('────────────────────────────────────────────────────────');
for(const L of LEVELS){
  const cells=[];
  for(const sk of SKILLS){
    const w=Array.from({length:GAMES},()=>play(L,sk.v)).filter(s=>s>=L.target).length/GAMES*100;
    cells.push(w);
  }
  console.log(`${String(L.level).padStart(3)} ${String(L.types).padStart(5)} ${String(L.target).padStart(7)} | ${(cells[0].toFixed(0)+'%').padStart(10)} ${(cells[1].toFixed(0)+'%').padStart(12)} ${(cells[2].toFixed(0)+'%').padStart(11)}`);
}
console.log('\ncasual ≈ typical free player · engaged ≈ habitual player · expert = optimistic validator.');
console.log('Big gap between casual and expert = high skill ceiling = where boosters/pass sell.\n');
