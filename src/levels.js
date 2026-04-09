// ═══════════════════════════════════════════════════════════════
//  PenguCrush — Level Configuration
//
//  Tile types:
//    Shells (standalone):  'ice', 'frostice'
//    Inners (inside ice):  'fish', 'popsicle', 'shrimp', 'crab'
//
//  Eras:
//    1 = Shallow Ice    (bg-arctic)        levels 1–5
//    2 = Penguin City   (bg-penguin-city)  levels 6–10
//    3 = Volcano Ice    (bg-volcano-ice)   levels 11–15
//    4 = Northern Skylands (bg-skylands)   levels 16–20
//
//  Blocker types:
//    'frozen'   — tile locked in ice, match adjacent to free
//    'ice1/2/3' — layered ice, each match removes one layer
//    'wall'     — immovable, unbreakable, blocks grid cell
//    'faller'   — drops 1 row per turn, penalty on bottom hit
//
//  Booster types:
//    'row'      — clear entire row
//    'col'      — clear entire column
//    'colorBomb' — clear all tiles of one type
//    'hammer'   — remove any single tile
//    'shuffle'  — re-randomize all non-blocker tiles
// ═══════════════════════════════════════════════════════════════

const LEVELS = [

  // ═══════════════════════════════════════════════════
  //  LEVEL 0 — TEST (not on map, 2 moves to trigger popup fast)
  // ═══════════════════════════════════════════════════

  {
    level: 99,
    era: 1,
    grid: 5,
    moves: 2,
    targetScore: 10,
    tiles: ['ice', 'fish', 'popsicle', 'frostice'],
    objective: { type: 'score', target: 10 },
    blockers: [],
    boosters: ['row', 'col', 'colorBomb'],
    stars: [10, 50, 100],
    bg: '/assets/board/bg-arctic.png',
    gridTint: 0x88DDFF,
  },

  // ═══════════════════════════════════════════════════
  //  ERA 1 — SHALLOW ICE (levels 1–5)
  //  Teach the basics. Generous moves, no blockers.
  // ═══════════════════════════════════════════════════

  {
    level: 1,
    era: 1,
    grid: 7,
    moves: 35,
    targetScore: 3000,
    tiles: ['ice', 'fish', 'popsicle', 'frostice'],
    objective: { type: 'score', target: 3000 },
    blockers: [],
    boosters: [],
    stars: [3000, 4000, 5500],
    bg: '/assets/board/bg-arctic.png',
    gridTint: 0x88DDFF,
  },

  {
    level: 2,
    era: 1,
    grid: 7,
    moves: 34,
    targetScore: 3500,
    tiles: ['ice', 'fish', 'popsicle', 'frostice'],
    objective: { type: 'score', target: 3500 },
    blockers: [],
    boosters: [],
    stars: [3500, 4500, 6000],
    bg: '/assets/board/bg-arctic.png',
    gridTint: 0x88DDFF,
  },

  {
    level: 3,
    era: 1,
    grid: 7,
    moves: 33,
    targetScore: 4000,
    tiles: ['ice', 'fish', 'popsicle', 'frostice'],
    objective: { type: 'score', target: 4000 },
    blockers: [],
    boosters: [],
    stars: [4000, 5500, 7000],
    bg: '/assets/board/bg-arctic.png',
    gridTint: 0x88DDFF,
  },

  {
    level: 4,
    era: 1,
    grid: 7,
    moves: 32,
    targetScore: 4500,
    tiles: ['ice', 'fish', 'popsicle', 'frostice'],
    objective: { type: 'clearTile', tileType: 'fish', count: 10 },
    blockers: [],
    boosters: [],
    stars: [4500, 6000, 8000],
    bg: '/assets/board/bg-arctic.png',
    gridTint: 0x88DDFF,
  },

  {
    level: 5,
    era: 1,
    grid: 8,
    moves: 30,
    targetScore: 5000,
    tiles: ['ice', 'fish', 'popsicle', 'frostice'],
    objective: { type: 'clearTile', tileType: 'ice', count: 12 },
    blockers: [],
    boosters: [],
    stars: [5000, 7000, 9000],
    bg: '/assets/board/bg-arctic.png',
    gridTint: 0x88DDFF,
  },

  // ═══════════════════════════════════════════════════
  //  ERA 2 — PENGUIN CITY (levels 6–10)
  //  Frozen tiles + 5th tile type (shrimp) + first boosters
  // ═══════════════════════════════════════════════════

  {
    level: 6,
    era: 2,
    grid: 8,
    moves: 30,
    targetScore: 5500,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp'],
    objective: { type: 'breakBlocker', blockerType: 'frozen', count: 3 },
    blockers: [{ type: 'frozen', count: 3 }],
    boosters: ['row'],
    stars: [5500, 7500, 10000],
    bg: '/assets/board/bg-penguin-city.png',
    gridTint: 0xFFB74D,
  },

  {
    level: 7,
    era: 2,
    grid: 8,
    moves: 29,
    targetScore: 6000,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp'],
    objective: { type: 'score', target: 6000 },
    blockers: [{ type: 'frozen', count: 5 }],
    boosters: ['row'],
    stars: [6000, 8000, 11000],
    bg: '/assets/board/bg-penguin-city.png',
    gridTint: 0xFFB74D,
  },

  {
    level: 8,
    era: 2,
    grid: 8,
    moves: 28,
    targetScore: 6500,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp'],
    objective: { type: 'breakBlocker', blockerType: 'frozen', count: 6 },
    blockers: [{ type: 'frozen', count: 6 }],
    boosters: ['row', 'col'],
    stars: [6500, 8500, 11500],
    bg: '/assets/board/bg-penguin-city.png',
    gridTint: 0xFFB74D,
  },

  {
    level: 9,
    era: 2,
    grid: 8,
    moves: 27,
    targetScore: 7500,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp'],
    objective: { type: 'clearTile', tileType: 'shrimp', count: 15 },
    blockers: [{ type: 'frozen', count: 7 }],
    boosters: ['row', 'col'],
    stars: [7500, 10000, 13000],
    bg: '/assets/board/bg-penguin-city.png',
    gridTint: 0xFFB74D,
  },

  {
    level: 10,
    era: 2,
    grid: 8,
    moves: 26,
    targetScore: 8000,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp'],
    objective: { type: 'combo', scoreTarget: 8000, blockerType: 'frozen', blockerCount: 8 },
    blockers: [{ type: 'frozen', count: 8 }],
    boosters: ['row', 'col'],
    stars: [8000, 10500, 14000],
    bg: '/assets/board/bg-penguin-city.png',
    gridTint: 0xFFB74D,
  },

  // ═══════════════════════════════════════════════════
  //  ERA 3 — VOLCANO ICE (levels 11–15)
  //  Layered ice + stone walls + 6th tile (crab) + Color Bomb
  // ═══════════════════════════════════════════════════

  {
    level: 11,
    era: 3,
    grid: 8,
    moves: 26,
    targetScore: 8500,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp'],
    objective: { type: 'breakBlocker', blockerType: 'ice', count: 4 },
    blockers: [{ type: 'ice', count: 4, layers: 2 }],
    boosters: ['row', 'col', 'colorBomb'],
    stars: [8500, 11000, 15000],
    bg: '/assets/board/bg-volcano-ice.png',
    gridTint: 0xFF6B3D,
  },

  {
    level: 12,
    era: 3,
    grid: 8,
    moves: 25,
    targetScore: 9000,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp', 'crab'],
    objective: { type: 'clearTile', tileType: 'crab', count: 10 },
    blockers: [{ type: 'ice', count: 5, layers: 2 }, { type: 'wall', count: 2 }],
    boosters: ['row', 'col', 'colorBomb'],
    stars: [9000, 12000, 16000],
    bg: '/assets/board/bg-volcano-ice.png',
    gridTint: 0xFF6B3D,
  },

  {
    level: 13,
    era: 3,
    grid: 8,
    moves: 25,
    targetScore: 9500,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp', 'crab'],
    objective: { type: 'combo', scoreTarget: 9500, blockerType: 'ice', blockerCount: 6 },
    blockers: [{ type: 'ice', count: 3, layers: 3 }, { type: 'wall', count: 3 }],
    boosters: ['row', 'col', 'colorBomb'],
    stars: [9500, 13000, 17000],
    bg: '/assets/board/bg-volcano-ice.png',
    gridTint: 0xFF6B3D,
  },

  {
    level: 14,
    era: 3,
    grid: 8,
    moves: 24,
    targetScore: 10500,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp', 'crab'],
    objective: { type: 'clearTile', tileType: 'any', count: 20 },
    blockers: [{ type: 'ice', count: 4, layers: 3 }, { type: 'wall', count: 4 }],
    boosters: ['row', 'col', 'colorBomb'],
    stars: [10500, 14000, 18000],
    bg: '/assets/board/bg-volcano-ice.png',
    gridTint: 0xFF6B3D,
  },

  {
    level: 15,
    era: 3,
    grid: 8,
    moves: 23,
    targetScore: 11000,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp', 'crab'],
    objective: { type: 'breakAll' },
    blockers: [{ type: 'ice', count: 5, layers: 3 }, { type: 'wall', count: 5 }],
    boosters: ['row', 'col', 'colorBomb'],
    stars: [11000, 15000, 20000],
    bg: '/assets/board/bg-volcano-ice.png',
    gridTint: 0xFF6B3D,
  },

  // ═══════════════════════════════════════════════════
  //  ERA 4 — NORTHERN SKYLANDS (levels 16–20)
  //  Falling blockers + all previous + Hammer & Shuffle
  // ═══════════════════════════════════════════════════

  {
    level: 16,
    era: 4,
    grid: 8,
    moves: 24,
    targetScore: 10500,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp', 'crab'],
    objective: { type: 'combo', scoreTarget: 10500, surviveDrops: 8 },
    blockers: [{ type: 'frozen', count: 3 }, { type: 'wall', count: 2 }, { type: 'faller', interval: 3 }],
    boosters: ['row', 'col', 'colorBomb', 'hammer'],
    stars: [10500, 14000, 18000],
    bg: '/assets/board/bg-skylands.png',
    gridTint: 0xBB88FF,
  },

  {
    level: 17,
    era: 4,
    grid: 8,
    moves: 23,
    targetScore: 11500,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp', 'crab'],
    objective: { type: 'combo', scoreTarget: 11500, blockerType: 'ice', blockerCount: 6 },
    blockers: [{ type: 'ice', count: 3, layers: 2 }, { type: 'wall', count: 3 }, { type: 'faller', interval: 3 }],
    boosters: ['row', 'col', 'colorBomb', 'hammer'],
    stars: [11500, 15000, 20000],
    bg: '/assets/board/bg-skylands.png',
    gridTint: 0xBB88FF,
  },

  {
    level: 18,
    era: 4,
    grid: 8,
    moves: 22,
    targetScore: 12000,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp', 'crab'],
    objective: { type: 'clearTile', tileType: 'any', count: 25 },
    blockers: [{ type: 'ice', count: 4, layers: 3 }, { type: 'wall', count: 3 }, { type: 'faller', interval: 2 }],
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
    stars: [12000, 16000, 22000],
    bg: '/assets/board/bg-skylands.png',
    gridTint: 0xBB88FF,
  },

  {
    level: 19,
    era: 4,
    grid: 8,
    moves: 21,
    targetScore: 13000,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp', 'crab'],
    objective: { type: 'breakAll' },
    blockers: [{ type: 'ice', count: 3, layers: 3 }, { type: 'frozen', count: 3 }, { type: 'wall', count: 3 }, { type: 'faller', interval: 2 }],
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
    stars: [13000, 17500, 24000],
    bg: '/assets/board/bg-skylands.png',
    gridTint: 0xBB88FF,
  },

  {
    level: 20,
    era: 4,
    grid: 8,
    moves: 20,
    targetScore: 14000,
    tiles: ['ice', 'fish', 'popsicle', 'frostice', 'shrimp', 'crab'],
    objective: { type: 'clearPercent', percent: 80 },
    blockers: [{ type: 'ice', count: 5, layers: 3 }, { type: 'frozen', count: 4 }, { type: 'wall', count: 4 }, { type: 'faller', interval: 2 }],
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
    stars: [14000, 19000, 26000],
    bg: '/assets/board/bg-skylands.png',
    gridTint: 0xBB88FF,
  },

];

export function getLevel(n) {
  return LEVELS.find(l => l.level === n) || LEVELS[0];
}

export function getLevelCount() {
  return LEVELS.length;
}

export default LEVELS;
