// ═══════════════════════════════════════════════════════════════
//  SHARDS — rarity-tiered collectibles awarded on level completion
//
//  Drop table (rolled once per completed level):
//    Necklace  — common     65%
//    Crown     — rare       28%
//    Plooshie  — legendary   7%
//
//  All counts live on the wallet-scoped Inventory record (shards.{id}).
//  This module only owns the catalogue + drop roll + render helpers.
// ═══════════════════════════════════════════════════════════════

export const SHARDS = [
  { id: 'necklace', name: 'Necklace', rarity: 'common',    weight: 65, img: '/assets/shards/necklace.webp' },
  { id: 'crown',    name: 'Crown',    rarity: 'rare',      weight: 28, img: '/assets/shards/crown.webp'    },
  { id: 'plooshie', name: 'Plooshie', rarity: 'legendary', weight:  7, img: '/assets/shards/plooshie.webp' },
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

export function rollShardDrop() {
  const total = SHARDS.reduce((n, s) => n + s.weight, 0);
  let r = Math.random() * total;
  for (const s of SHARDS) {
    r -= s.weight;
    if (r < 0) return s.id;
  }
  return SHARDS[0].id;
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
