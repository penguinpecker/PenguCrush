// Daily wheel — slice labels, daily booster rotation, receipt decoding.
import { decodeEventLog, keccak256, encodePacked } from 'viem';
import { sku } from './onchain.js';
import penguCrushAbiJson from '../contracts/PenguCrushABI.json';

const penguCrushAbi = Array.isArray(penguCrushAbiJson) ? penguCrushAbiJson : penguCrushAbiJson.abi || [];

/** Matches on-chain pool.dailyboost member order. */
export const DAILY_BOOSTER_SKUS = [
  'booster.row',
  'booster.col',
  'booster.colorBomb',
  'booster.hammer',
  'booster.shuffle',
];

export const BOOSTER_DISPLAY = {
  row: 'Row Clear',
  col: 'Column Clear',
  colorBomb: 'Color Bomb',
  hammer: 'Hammer',
  shuffle: 'Shuffle',
};

export const SHARD_DISPLAY = {
  necklace: 'Necklace Shard',
  crown: 'Crown Shard',
  plooshie: 'Plooshie Shard',
};

const SKU_LABELS = new Map([
  [sku('currency.xp'), 'XP'],
  [sku('currency.gems'), 'Gems'],
  [sku('currency.coins'), 'Coins'],
  [sku('booster.row'), 'Row Clear'],
  [sku('booster.col'), 'Column Clear'],
  [sku('booster.colorBomb'), 'Color Bomb'],
  [sku('booster.hammer'), 'Hammer'],
  [sku('booster.shuffle'), 'Shuffle'],
  [sku('shard.necklace'), 'Necklace Shard'],
  [sku('shard.crown'), 'Crown Shard'],
  [sku('shard.plooshie'), 'Plooshie Shard'],
  [sku('life.regular'), 'Life'],
]);

/** WheelPrizeKind — must match PenguCrushV2.sol enum order. */
export const WHEEL_PRIZE_KIND = {
  None: 0,
  Currency: 1,
  Booster: 2,
  Shard: 3,
  Lives: 4,
  TryAgain: 5,
};

export function utcDayIndex(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / 86400);
}

/** Same index as `_resolveDailyPool` on-chain for pool.dailyboost. */
export function resolveDailyBoosterId(dayUtc = utcDayIndex()) {
  const hash = keccak256(encodePacked(['uint64'], [BigInt(dayUtc)]));
  const idx = Number(BigInt(hash) % BigInt(DAILY_BOOSTER_SKUS.length));
  const name = DAILY_BOOSTER_SKUS[idx].replace('booster.', '');
  return name;
}

export function dailyBoosterLabel(dayUtc = utcDayIndex()) {
  return BOOSTER_DISPLAY[resolveDailyBoosterId(dayUtc)] || 'Booster';
}

/** Slice labels for the 6 wheel segments (index = on-chain slotIndex). */
export function getDailyWheelSliceLabels(dayUtc = utcDayIndex()) {
  return [
    'Try Again',
    '100 XP',
    '250 XP',
    dailyBoosterLabel(dayUtc),
    '1 Life',
    '1 Shard',
  ];
}

export function labelFromSkuHash(skuHash) {
  if (!skuHash) return '';
  const key = String(skuHash).toLowerCase();
  for (const [h, label] of SKU_LABELS) {
    if (String(h).toLowerCase() === key) return label;
  }
  return '';
}

export function formatDailySpinPrize({ kind, sku: prizeSku, amount }) {
  const k = Number(kind);
  if (k === WHEEL_PRIZE_KIND.TryAgain || k === WHEEL_PRIZE_KIND.None) return 'Try Again';
  if (k === WHEEL_PRIZE_KIND.Currency) {
    const cur = labelFromSkuHash(prizeSku) || 'XP';
    return `${amount} ${cur}`;
  }
  if (k === WHEEL_PRIZE_KIND.Booster) {
    return labelFromSkuHash(prizeSku) || 'Booster';
  }
  if (k === WHEEL_PRIZE_KIND.Shard) {
    return labelFromSkuHash(prizeSku) || 'Shard';
  }
  if (k === WHEEL_PRIZE_KIND.Lives) {
    return amount === 1 ? '1 Life' : `${amount} Lives`;
  }
  return 'Reward';
}

export function decodeDailySpinFromReceipt(receipt, contractAddress) {
  const logs = receipt?.logs || [];
  const addr = contractAddress?.toLowerCase();
  for (const log of logs) {
    if (addr && log.address?.toLowerCase() !== addr) continue;
    try {
      const decoded = decodeEventLog({
        abi: penguCrushAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== 'DailySpin') continue;
      const { day, slotIndex, kind, sku: prizeSku, amount } = decoded.args;
      return {
        day: Number(day),
        slotIndex: Number(slotIndex),
        kind: Number(kind),
        sku: prizeSku,
        amount: Number(amount),
        prizeText: formatDailySpinPrize({ kind, sku: prizeSku, amount }),
      };
    } catch (_) {
      // not DailySpin
    }
  }
  return null;
}
