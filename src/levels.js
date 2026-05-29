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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    objective: { type: 'breakBlocker', blockerType: 'frozen', count: 5 },
    blockers: [{ type: 'frozen', count: 5 }],
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    blockers: [{ type: 'ice', count: 6, layers: 2 }, { type: 'wall', count: 3 }],
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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
    blockers: [{ type: 'ice', count: 6, layers: 2 }, { type: 'wall', count: 3 }, { type: 'faller', interval: 3 }],
    boosters: ['row', 'col', 'colorBomb', 'hammer', 'shuffle'],
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

const TILE_LABELS = {
  ice: 'Ice',
  fish: 'Fish',
  popsicle: 'Popsicle',
  frostice: 'Frost Ice',
  shrimp: 'Shrimp',
  crab: 'Crab',
};

const BLOCKER_LABELS = {
  frozen: 'Frozen',
  ice: 'Ice Block',
};

const OBJECTIVE_ICONS = {
  tile: '/assets/ui/objectives/tile.svg',
  frozen: '/assets/ui/objectives/frozen.svg',
  ice: '/assets/ui/objectives/ice.svg',
};

/** Chip metadata for map / in-game objective containers. */
export function getObjectiveChip(cfg) {
  const obj = cfg?.objective;
  if (!obj || obj.type === 'score') return null;
  switch (obj.type) {
    case 'clearTile': {
      const tileType = obj.tileType || 'any';
      return {
        icon: OBJECTIVE_ICONS.tile,
        label: tileType === 'any' ? 'Tiles' : (TILE_LABELS[tileType] || tileType),
        target: obj.count,
      };
    }
    case 'breakBlocker':
      return {
        icon: obj.blockerType === 'frozen' ? OBJECTIVE_ICONS.frozen : OBJECTIVE_ICONS.ice,
        label: BLOCKER_LABELS[obj.blockerType] || obj.blockerType,
        target: obj.count,
      };
    case 'breakAll':
      return {
        icon: OBJECTIVE_ICONS.frozen,
        label: 'Blockers',
        target: null,
      };
    case 'clearPercent':
      return {
        icon: OBJECTIVE_ICONS.tile,
        label: 'Tiles',
        target: Math.ceil((cfg.grid || 8) ** 2 * obj.percent / 100),
      };
    case 'combo': {
      if (obj.blockerType != null && obj.blockerCount != null) {
        return {
          icon: obj.blockerType === 'frozen' ? OBJECTIVE_ICONS.frozen : OBJECTIVE_ICONS.ice,
          label: BLOCKER_LABELS[obj.blockerType] || obj.blockerType,
          target: obj.blockerCount,
        };
      }
      if (obj.surviveDrops != null) {
        return {
          icon: OBJECTIVE_ICONS.ice,
          label: 'Drops',
          target: obj.surviveDrops,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Human-readable primary objective (excluding score gate). */
export function formatLevelObjective(cfg) {
  const obj = cfg?.objective;
  if (!obj) return '';
  switch (obj.type) {
    case 'score':
      return '';
    case 'clearTile': {
      if (obj.tileType === 'any') return `Clear ${obj.count} tiles`;
      const label = TILE_LABELS[obj.tileType] || obj.tileType;
      return `Clear ${obj.count} ${label}`;
    }
    case 'breakBlocker': {
      const label = BLOCKER_LABELS[obj.blockerType] || obj.blockerType;
      return `Break ${obj.count} ${label}`;
    }
    case 'breakAll':
      return 'Break all blockers';
    case 'clearPercent':
      return `Clear ${obj.percent}% of tiles`;
    case 'combo': {
      const parts = [];
      if (obj.blockerType && obj.blockerCount != null) {
        const label = BLOCKER_LABELS[obj.blockerType] || obj.blockerType;
        parts.push(`Break ${obj.blockerCount} ${label}`);
      }
      if (obj.surviveDrops != null) parts.push(`Survive ${obj.surviveDrops} faller drops`);
      return parts.join(' · ') || '';
    }
    default:
      return '';
  }
}

export function getLevel(n) {
  return LEVELS.find(l => l.level === n) || LEVELS[0];
}

export function hasLevel(n) {
  return LEVELS.some(l => l.level === n);
}

export function getLevelCount() {
  return LEVELS.length;
}

/** Min % of base move budget left for 2★ / 3★ via the efficiency path. */
export const MOVE_STAR_2_PCT = 0.15;
export const MOVE_STAR_3_PCT = 0.30;

/**
 * Base-budget moves saved at win — crown bonus moves don't inflate this.
 * @param {number} movesUsed total moves consumed (base + shard bonus)
 * @param {number} baseBudget level's CONFIG.moves
 */
export function movesRemainingForStars(movesUsed, baseBudget) {
  return Math.max(0, baseBudget - Math.min(movesUsed, baseBudget));
}

/**
 * Hybrid stars: best of score thresholds or moves-remaining efficiency.
 * @param {number} score
 * @param {number} movesUsed total moves consumed this run
 * @param {{ moves: number, stars: [number, number, number] }} cfg level config
 */
export function computeStars(score, movesUsed, cfg) {
  const [s1, s2, s3] = cfg.stars;
  const budget = cfg.moves;

  const scoreStars =
    score >= s3 ? 3 :
    score >= s2 ? 2 :
    score >= s1 ? 1 : 0;

  // Efficiency stars only apply after the score gate (s1 === targetScore) is met.
  const pct = budget > 0 ? movesRemainingForStars(movesUsed, budget) / budget : 0;
  const moveStars = score >= s1
    ? (pct >= MOVE_STAR_3_PCT ? 3 : pct >= MOVE_STAR_2_PCT ? 2 : 1)
    : 0;

  return Math.max(scoreStars, moveStars);
}

/** Count placed blockers of a given type (frozen | ice | wall | faller config rows). */
export function countBlockersOnBoard(blockers, type) {
  return (blockers || [])
    .filter(b => b.type === type)
    .reduce((sum, b) => sum + (b.count || 0), 0);
}

/** Interior cells available for random blocker placement (matches game.js margin). */
export function maxBlockerSlots(grid) {
  const interior = Math.max(0, (grid || 8) - 2);
  return interior * interior;
}

/**
 * Static audit for unwinnable / inconsistent level configs.
 * Returns human-readable issue strings (empty = OK).
 */
export function auditLevelConfig(cfg) {
  const issues = [];
  const level = cfg?.level ?? '?';
  const prefix = `Level ${level}:`;
  const obj = cfg?.objective;
  const blockers = cfg.blockers || [];
  const grid = cfg.grid || 8;

  if (!Array.isArray(cfg.stars) || cfg.stars.length !== 3) {
    issues.push(`${prefix} stars must be [s1, s2, s3]`);
  } else if (cfg.stars[0] !== cfg.targetScore) {
    issues.push(`${prefix} stars[0] (${cfg.stars[0]}) !== targetScore (${cfg.targetScore})`);
  }

  const placed = blockers.reduce((s, b) => s + (b.count || 0), 0);
  const slots = maxBlockerSlots(grid);
  if (placed > slots) {
    issues.push(`${prefix} ${placed} blockers exceed ${slots} interior slots — some may not spawn`);
  }

  if (!obj) {
    issues.push(`${prefix} missing objective`);
    return issues;
  }

  switch (obj.type) {
    case 'breakBlocker': {
      const onBoard = countBlockersOnBoard(blockers, obj.blockerType);
      if (onBoard < obj.count) {
        issues.push(
          `${prefix} breakBlocker requires ${obj.count} ${obj.blockerType} but only ${onBoard} on board`
        );
      }
      break;
    }
    case 'combo': {
      if (obj.blockerType != null && obj.blockerCount != null) {
        const onBoard = countBlockersOnBoard(blockers, obj.blockerType);
        if (onBoard < obj.blockerCount) {
          issues.push(
            `${prefix} combo requires ${obj.blockerCount} ${obj.blockerType} breaks but only ${onBoard} on board`
          );
        }
      }
      if (obj.surviveDrops != null && !blockers.some(b => b.type === 'faller')) {
        issues.push(`${prefix} surviveDrops objective but no faller blocker configured`);
      }
      break;
    }
    case 'breakAll': {
      const breakable = countBlockersOnBoard(blockers, 'frozen') + countBlockersOnBoard(blockers, 'ice');
      if (breakable === 0) {
        issues.push(`${prefix} breakAll but no frozen/ice blockers on board`);
      }
      break;
    }
    case 'clearPercent': {
      const need = Math.ceil(grid * grid * obj.percent / 100);
      const walls = countBlockersOnBoard(blockers, 'wall');
      const maxClearable = grid * grid - walls;
      if (need > maxClearable) {
        issues.push(
          `${prefix} clear ${obj.percent}% (${need} tiles) exceeds ${maxClearable} clearable cells (${walls} walls)`
        );
      }
      break;
    }
    default:
      break;
  }

  return issues;
}

/** Run auditLevelConfig on every level; returns { ok, issuesByLevel }. */
export function auditAllLevels(levels = LEVELS) {
  const issuesByLevel = {};
  for (const cfg of levels) {
    const issues = auditLevelConfig(cfg);
    if (issues.length) issuesByLevel[cfg.level] = issues;
  }
  return {
    ok: Object.keys(issuesByLevel).length === 0,
    issuesByLevel,
  };
}

export default LEVELS;
