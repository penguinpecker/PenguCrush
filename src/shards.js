// ═══════════════════════════════════════════════════════════════
//  SHARDS — rarity-tiered collectibles earned in-play
//
//  Drop trigger: a match of 4+ tiles. Each shard is rolled
//  INDEPENDENTLY so a single match can yield 0..3 shards:
//    Necklace  — common     20% per 4+ match
//    Crown     — rare       10% per 4+ match
//    Plooshie  — legendary   5% per 4+ match
//
//  All counts live on the wallet-scoped Inventory record (shards.{id}).
//  This module only owns the catalogue + drop roll + render helpers.
// ═══════════════════════════════════════════════════════════════

export const SHARDS = [
  { id: 'necklace', name: 'Necklace', rarity: 'common',    dropChance: 0.20, img: '/assets/shards/necklace.webp' },
  { id: 'crown',    name: 'Crown',    rarity: 'rare',      dropChance: 0.10, img: '/assets/shards/crown.webp'    },
  { id: 'plooshie', name: 'Plooshie', rarity: 'legendary', dropChance: 0.05, img: '/assets/shards/plooshie.webp' },
];

const SHARD_BY_ID = Object.fromEntries(SHARDS.map(s => [s.id, s]));

export function getShardDef(id) { return SHARD_BY_ID[id] || null; }

/**
 * Compute the passive traits unlocked by the player's current shard inventory.
 * Returns the buffs applied to this run.
 *   scoreMultiplier — 1.0 + (0.0025 * necklace) + (0.02 * plooshie), each capped
 *   bonusMoves      — floor(crown / 5), capped at 5
 */
export function computeTraits(counts = {}) {
  const necklace = Math.max(0, counts.necklace || 0);
  const crown    = Math.max(0, counts.crown    || 0);
  const plooshie = Math.max(0, counts.plooshie || 0);

  const necklaceBonus = Math.min(0.10, necklace * 0.0025); // cap +10%
  const plooshieBonus = Math.min(0.30, plooshie * 0.02);   // cap +30%
  const bonusMoves    = Math.min(5, Math.floor(crown / 5));

  return {
    scoreMultiplier: 1 + necklaceBonus + plooshieBonus,
    bonusMoves,
    breakdown: {
      necklace: +(necklaceBonus * 100).toFixed(1),
      plooshie: +(plooshieBonus * 100).toFixed(1),
      crown: bonusMoves,
    },
  };
}

/**
 * Roll shard drops for a single 4+ match. Each shard is rolled
 * independently, so a match can award 0, 1, 2, or all 3 shards.
 * Returns an array of earned shard ids (in catalogue order).
 */
export function rollShardsForMatch() {
  const earned = [];
  for (const s of SHARDS) {
    if (Math.random() < s.dropChance) earned.push(s.id);
  }
  return earned;
}

/**
 * Render three shard slots into `container`. Each slot shows the
 * transparent PNG icon, a rarity tint, and the current x-count.
 *   opts.counts    — { necklace, crown, plooshie } (required)
 *   opts.highlight — shard id to briefly pulse (e.g. the one just earned)
 *   opts.variant   — 'hud' | 'card' (styling hook)
 */
export function renderShardSlots(container, { counts, highlight = null, variant = 'card' } = {}) {
  if (!container) return;
  container.innerHTML = '';
  container.classList.add('shard-row', `shard-row--${variant}`);
  for (const s of SHARDS) {
    const slot = document.createElement('div');
    slot.className = `shard-slot shard-slot--${s.rarity}`;
    slot.dataset.shard = s.id;
    if (highlight === s.id) slot.classList.add('shard-slot--awarded');

    const img = document.createElement('img');
    img.className = 'shard-slot__icon';
    img.src = s.img;
    img.alt = `${s.name} shard (${s.rarity})`;
    img.draggable = false;

    const qty = document.createElement('span');
    qty.className = 'shard-slot__qty';
    qty.textContent = `x${counts?.[s.id] || 0}`;

    slot.appendChild(img);
    slot.appendChild(qty);

    if (highlight === s.id) {
      const badge = document.createElement('span');
      badge.className = 'shard-slot__badge';
      badge.textContent = '+1';
      slot.appendChild(badge);
    }

    container.appendChild(slot);
  }
}
