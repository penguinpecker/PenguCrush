#!/usr/bin/env node
/**
 * Static audit for level config consistency (objective vs blockers, grid capacity).
 * Also simulates blocker-break counting rules used in game.js.
 *
 * Usage: node scripts/audit-levels.mjs
 */

import LEVELS, {
  auditAllLevels,
  auditLevelConfig,
  countBlockersOnBoard,
} from '../src/levels.js';

/** Mirrors game.js damageBlocker / fullyBreakBlocker counting. */
function simulateBlockerTracking() {
  const issues = [];

  function makeTile(layers = 0) {
    return { frozen: true, iceLayer: layers };
  }

  function damageBlocker(tile, stats) {
    if (!tile?.frozen) return false;
    if ((tile.iceLayer || 0) > 1) {
      tile.iceLayer--;
      return false;
    }
    tile.frozen = false;
    tile.iceLayer = 0;
    stats.frozen = (stats.frozen || 0) + 1;
    stats.ice = (stats.ice || 0) + 1;
    return true;
  }

  function fullyBreakBlocker(tile, stats) {
    if (!tile?.frozen) return;
    tile.frozen = false;
    tile.iceLayer = 0;
    stats.frozen = (stats.frozen || 0) + 1;
    stats.ice = (stats.ice || 0) + 1;
  }

  for (const cfg of LEVELS) {
    const obj = cfg.objective;
    if (!obj) continue;

    const buildTiles = () => {
      const tiles = [];
      for (const b of cfg.blockers || []) {
        if (b.type !== 'frozen' && b.type !== 'ice') continue;
        for (let i = 0; i < (b.count || 0); i++) {
          tiles.push(makeTile(b.type === 'ice' ? (b.layers || 1) : 0));
        }
      }
      return tiles;
    };

    const maxFullBreaks = (type) => {
      const stats = {};
      for (const tile of buildTiles()) fullyBreakBlocker(tile, stats);
      return stats[type] || 0;
    };

    if (obj.type === 'breakBlocker') {
      const max = maxFullBreaks(obj.blockerType);
      if (max < obj.count) {
        issues.push(
          `Level ${cfg.level}: max ${obj.blockerType} breaks via gameplay is ${max}, objective needs ${obj.count}`
        );
      }
    }

    if (obj.type === 'combo' && obj.blockerType != null && obj.blockerCount != null) {
      const max = maxFullBreaks(obj.blockerType);
      if (max < obj.blockerCount) {
        issues.push(
          `Level ${cfg.level}: max ${obj.blockerType} combo breaks is ${max}, objective needs ${obj.blockerCount}`
        );
      }
    }
  }

  return issues;
}

const { ok, issuesByLevel } = auditAllLevels();
const simIssues = simulateBlockerTracking();

console.log('═══════════════════════════════════════════');
console.log('  PenguCrush — Level config audit');
console.log('═══════════════════════════════════════════\n');

console.log(`Levels checked: ${LEVELS.length}\n`);

if (ok && simIssues.length === 0) {
  console.log('✓ All levels passed config + blocker-count simulation.\n');
  process.exit(0);
}

if (!ok) {
  console.log('Config issues:');
  for (const [level, issues] of Object.entries(issuesByLevel)) {
    for (const msg of issues) console.log(`  ✗ ${msg}`);
  }
  console.log('');
}

if (simIssues.length) {
  console.log('Blocker tracking simulation issues:');
  for (const msg of simIssues) console.log(`  ✗ ${msg}`);
  console.log('');
}

// Summary table for breakBlocker / combo blocker levels
console.log('Blocker objective summary:');
for (const cfg of LEVELS) {
  const obj = cfg.objective;
  if (obj?.type === 'breakBlocker') {
    const onBoard = countBlockersOnBoard(cfg.blockers, obj.blockerType);
    console.log(`  L${cfg.level}: break ${obj.count} ${obj.blockerType} (${onBoard} on board)`);
  } else if (obj?.type === 'combo' && obj.blockerType) {
    const onBoard = countBlockersOnBoard(cfg.blockers, obj.blockerType);
    console.log(`  L${cfg.level}: combo break ${obj.blockerCount} ${obj.blockerType} (${onBoard} on board)`);
  } else if (obj?.type === 'breakAll') {
    const f = countBlockersOnBoard(cfg.blockers, 'frozen');
    const i = countBlockersOnBoard(cfg.blockers, 'ice');
    console.log(`  L${cfg.level}: breakAll (${f} frozen + ${i} ice on board)`);
  }
}

process.exit(ok && simIssues.length === 0 ? 0 : 1);
