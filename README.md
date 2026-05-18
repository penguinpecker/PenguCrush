# PenguCrush

A web-based match-3 game on **Abstract** (zkSync L2, chain id 2741), built around a thesis that every meaningful in-game action — life consumption, boosters used, shards earned, level results, purchases — should be recorded on-chain as the canonical source of truth. The frontend is a thin, optimistic renderer over an upgradeable Solidity contract; localStorage and Supabase serve only as caches and edge-services around the chain.

**Live:** [pengucrush.com](https://www.pengucrush.com) — Abstract Global Wallet sign-in required.

---

## System architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Browser (Vite SPA)                              │
│                                                                          │
│   src/entry.js  ──route──▶  home / map / play / leaderboard              │
│         │                                                                │
│         ├── src/agw.js          Abstract Global Wallet (Privy cross-app  │
│         │                       + @abstract-foundation/agw-client)       │
│         │                                                                │
│         ├── src/session-key.js  AGW session key with a scoped allowlist  │
│         │                       so gameplay txs don't prompt the wallet  │
│         │                                                                │
│         ├── src/onchain.js      viem WalletClient + chainWrite() —       │
│         │                       every contract call is logged to         │
│         │                       pengu_tx_log on Supabase                 │
│         │                                                                │
│         ├── src/inventory.js    Wallet-scoped cache; hydrateFromChain()  │
│         │                       reconciles against on-chain getInventory │
│         │                       and getLives on every wallet event       │
│         │                                                                │
│         ├── src/map.js          Map screen, level popup, daily wheel,    │
│         │                       Crush Pass UI, in-game HUD chrome        │
│         │                                                                │
│         ├── src/game.js         Match-3 engine (Three.js renderer),      │
│         │                       per-level journal builder, mid-game      │
│         │                       checkpoint stream                        │
│         │                                                                │
│         └── src/supabase.js     Anon client; fetchLeaderboard reads      │
│                                 chain directly (table mirror retired)    │
│                                                                          │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────────┐
        │                      │                          │
        ▼                      ▼                          ▼
┌────────────────┐    ┌──────────────────┐      ┌─────────────────────┐
│   Supabase     │    │   Abstract L2    │      │  Alchemy RPC        │
│ (ap-south-1)   │    │  (mainnet 2741)  │      │  (dedicated quota,  │
│                │    │                  │      │  origin-locked)     │
│  edge functions│    │  PenguCrushV2    │      └─────────────────────┘
│  ─────────────▶│    │  UUPS proxy +    │
│  • pengu-quote-│    │  implementation  │
│    price       │    │                  │
│  • pengu-      │    │  Owner   = EOA   │
│    validate-   │    │  Treasury = 2/2  │
│    level       │    │             Safe │
│  • pengu-wheel-│    │  Relayer  = EOA  │
│    roll        │    │  (signs quotes, │
│  • pengu-regen-│    │   rolls wheel,  │
│    sweep       │    │   sweeps regen) │
│                │    └──────────────────┘
│  postgres      │
│  • pengu_tx_log│
│    (mirror of  │
│     every      │
│     chain tx)  │
│  • pengu_game_ │
│    snapshots   │
│    (anti-cheat │
│     trail)     │
└────────────────┘
```

The proxy address is the only on-chain identity the player ever sees. Implementations are swapped in place; player state, leaderboards, and event history persist across every upgrade.

---

## Smart contract

`PenguCrushV2` is a UUPS-upgradeable Solidity 0.8.26 contract deployed on Abstract Mainnet. The contract is the source of truth for every player-facing piece of state.

### Storage layout

| Mapping / variable | Purpose |
|---|---|
| `items: bytes32 sku => ItemConfig` | Registry of every Booster / Shard / Currency / Lives / Pass SKU, including kind, enabled flag, USD micros price, max balance. |
| `boosterBalance, shardBalance, currencyBalance` | Per-player per-SKU counts. Settled atomically in `submitLevel` from the journal. |
| `lifeAccount: address => LifeAccount` | Regular + ice (frozen) life counts, `lastConsumedAt` regen anchor. |
| `crushPass: address => CrushPass` | Weekly pass `expiresAt`, streak weeks, last-purchase-week. |
| `bestResults: address => uint16 => LevelResult` | Per-level high-water: score, stars, moves used, timestamp. |
| `playerStats: address => PlayerStats` | Aggregate totalScore (saturating uint32), totalStars, gamesPlayed/Won/Failed, highestLevel. |
| `players: address[]` | Append-only roster for paginated leaderboard reads. |
| `levelStartedAt: address => uint16 => uint64` | Set in `startLevel`, required non-zero by `submitLevel` (anti-replay). |
| `usedNonces, usedWheelNonces` | Replay protection for signed quotes and signed wheel rolls (separated so the price-relayer and wheel-relayer can't collide on nonce space). |
| `validatorRelayer, priceRelayer, wheelRelayer` | Three distinct relayer roles, each set independently. The current production deploy routes all three to the same operator-owned EOA; they're separable for future hardening. |
| `treasury` | Receiver of every shop ETH/USDC payment. Currently a 2-of-2 Gnosis Safe. |

### External surface

| Function | Description | Session-key safe? |
|---|---|---|
| `startLevel(uint16 level)` | Debits one life (regular before frozen) and stamps `levelStartedAt`. Required precondition for any later `submitLevel*` call. | yes |
| `submitLevel(LevelJournal)` | Settles a finished run: increments boosters spent, grants shards earned, updates best-result + player stats, emits `LevelSubmitted`. Reverts if `levelStartedAt == 0`. | yes |
| `submitLevelValidated(LevelJournal, bytes sig)` | Same as `submitLevel` but gated by an EIP-712 signature from the off-chain validator. Off-chain leaderboards filter on the extra `LevelValidated` event for cheat resistance. | yes |
| `submitAndStartNext(LevelJournal, bytes sig, uint16 nextLevel)` | Fused atomic version. Settles current level *and* starts the next level in one tx. Reverts atomically — if the destination can't start (no lives, paused), the submit reverts too. | yes |
| `levelCheckpoint(uint16, uint16, bytes32)` | Mid-game tamper-detection trail. Fire-and-forget, no state change beyond the event. | yes |
| `claimRegen() / claimRegenFor(addr) / claimRegenBatch(addr[])` | Materialize accrued life regen ticks. View functions compute `eligibleRegular` virtually so the UI never needs to call these. | yes |
| `claimStarterPack()` | Idempotent — grants one of every enabled Booster SKU on first call, reverts on subsequent. Fires silently after the first sign-in. | yes |
| `cancelCrushPass()` | Zeros `crushPass.expiresAt` and drops frozen lives. | yes |
| `spinDailyWheel(WheelRoll, bytes sig)` | Server-signed RNG. Wheel relayer rolls a slot index off-chain; contract verifies signature, marks the day as spun, credits the slot's reward. | yes |
| `buyBoosterETH / buyLivesETH / buyCrushPassETH` | Player pays exactly `q.amount` ETH; contract verifies the EIP-712 quote signature and forwards ETH to treasury. USDC variants exist via `safeTransferFrom`. | **no** (value-bearing — wallet prompts) |
| `getLives, getInventory, getBestResult, getPlayers, getLeaderboardBatch, getPlayerCount, getNextRegenIn` | Read-only views, called via Alchemy RPC. | n/a |

### Constants (V2.7)

| Constant | Value |
|---|---|
| `MAX_REGULAR_LIVES` | 5 |
| `REGEN_CAP_REGULAR` | 5 (regen fills every regular slot) |
| `MAX_FROZEN_LIVES` | 2 (Crush Pass grant) |
| `REGEN_PERIOD` | 8 hours |
| `MAX_SHARDS_PER_SUBMIT` | 16 (anti-DoS on the journal array) |

### Security model

- **Ownable2Step + UUPS** — owner upgrades the implementation. Owner is the deployer EOA; treasury (revenue) was rotated to a 2-of-2 Safe multisig.
- **Pausable on two axes** — `paused` (master kill) and `shopPaused` / `gameplayPaused` (independent).
- **Inline nonReentrant** — OZ's ReentrancyGuard tripped the UUPS upgrades plugin, so the contract ships a minimal uint256-status reentrancy guard.
- **Exact payment** — every ETH shop function requires `msg.value == q.amount`. No silent excess to treasury.
- **EIP-712 quotes + nonces** — every shop / wheel / validation call recovers the signer from a typed-data digest with a per-domain nonce + deadline. Two separate nonce mappings (shop + wheel) so cross-relayer replay is impossible.
- **`startLevel`-required precondition** — `submitLevel*` reverts if `levelStartedAt[player][level] == 0`. Closes the "submit a level you never started" exploit.
- **Saturating totals** — `playerStats.totalScore` is uint32 with saturating addition (no revert, no overflow).
- **`receive()` / `fallback()` revert** — no accidental ETH deposits.

---

## Game design

### Eras + difficulty curve

The 20 published levels are grouped into four thematic eras. Each era introduces a new blocker type and ratchets the score target / move budget.

| Era | Levels | Theme | Background | New blocker |
|---|---|---|---|---|
| 1 | 1–5 | Shallow Ice | bg-arctic | none — tutorial era, 7×7 grid, 30–35 moves |
| 2 | 6–10 | Penguin City | bg-penguin-city | `frozen` — tiles locked in ice; match adjacent to free them, 8×8 grid |
| 3 | 11–15 | Volcano Ice | bg-volcano-ice | `ice1/ice2/ice3` — multi-layer ice (1–3 layers, each match peels one) + `wall` (immovable, blocks grid cells) |
| 4 | 16–20 | Northern Skylands | bg-skylands | `faller` — drops 1 row per turn; bottom-hit triggers a score penalty, every 2–3 moves |

By level 20 the board carries every blocker class simultaneously (ice + frozen + wall + faller), the move budget is down to ~22, and the objective is to clear 80 % of the board in fewer moves than levels 1–5.

### Objective types

Each level has one of six objective shapes. The score target is checked separately for star awards; the objective is what's required to win at all.

| Objective | Win condition |
|---|---|
| `score` | Reach `target` in points before moves run out. |
| `clearTile { tileType, count }` | Clear N tiles of a specific type (e.g. 10 fish in level 4). `tileType: 'any'` counts every clear. |
| `breakBlocker { blockerType, count }` | Break N blockers of a specific class (frozen / ice). |
| `combo { scoreTarget, blockerType?, blockerCount?, surviveDrops? }` | Hit the score target *and* an additional sub-goal (break X blockers, or survive N faller drops). |
| `breakAll` | Break every blocker on the board. |
| `clearPercent { percent }` | Clear `percent` % of all clearable tiles. Level 20 final boss. |

### Per-level configuration

Pulled directly from `src/levels.js`:

| Lvl | Era | Grid | Moves | Target | Star thresholds | Objective | Blockers |
|----:|:---:|:----:|:-----:|-------:|----------------:|---|---|
|  1 | 1 | 7×7 | 35 | 3 000 | 3000 / 4000 / 5500 | Score 3 000 | — |
|  2 | 1 | 7×7 | 34 | 3 500 | 3500 / 4500 / 6000 | Score 3 500 | — |
|  3 | 1 | 7×7 | 33 | 4 000 | 4000 / 5500 / 7000 | Score 4 000 | — |
|  4 | 1 | 7×7 | 32 | 4 500 | 4500 / 6000 / 8000 | Clear 10 fish | — |
|  5 | 1 | 8×8 | 30 | 5 000 | 5000 / 7000 / 9000 | Clear 12 ice | — |
|  6 | 2 | 8×8 | 30 | 5 500 | 5500 / 7500 / 9500 | Break 3 frozen | 3 frozen |
|  7 | 2 | 8×8 | 29 | 6 000 | 6000 / 8000 / 10000 | Score 6 000 | 5 frozen |
|  8 | 2 | 8×8 | 28 | 6 500 | 6500 / 8500 / 11000 | Break 6 frozen | 6 frozen |
|  9 | 2 | 8×8 | 27 | 7 500 | 7500 / 9500 / 12000 | Clear 15 shrimp | 7 frozen |
| 10 | 2 | 8×8 | 26 | 8 000 | 8000 / 10500 / 13000 | Combo: score 8000 + break 8 frozen | 8 frozen |
| 11 | 3 | 8×8 | 26 | 8 500 | 8500 / 11000 / 14000 | Break 4 ice (2 layers each) | 4 ice ×2L |
| 12 | 3 | 8×8 | 25 | 9 000 | 9000 / 11500 / 14500 | Clear 10 crab | 5 ice ×2L + 2 walls |
| 13 | 3 | 8×8 | 25 | 9 500 | 9500 / 12000 / 15500 | Combo: score 9500 + break 6 ice | 3 ice ×3L + 3 walls |
| 14 | 3 | 8×8 | 24 | 10 500 | 10500 / 13000 / 16500 | Clear any 20 tiles | 4 ice ×3L + 4 walls |
| 15 | 3 | 8×8 | 22 | 11 000 | 11000 / 14000 / 17500 | Break every blocker on the board | 5 ice ×3L + 5 walls |
| 16 | 4 | 8×8 | 24 | 10 500 | 10500 / 13500 / 17000 | Score 10500 + survive 8 drops | 3 frozen + 2 walls + faller |
| 17 | 4 | 8×8 | 24 | 11 500 | 11500 / 14500 / 18000 | Score 11500 + break 6 ice | 3 ice ×2L + 3 walls + faller |
| 18 | 4 | 8×8 | 23 | 12 000 | 12000 / 15000 / 19000 | Clear any 25 tiles | 4 ice ×3L + 3 walls + fast faller |
| 19 | 4 | 8×8 | 23 | 13 000 | 13000 / 16500 / 20500 | Break every blocker | 3 ice + 3 frozen + 3 walls + fast faller |
| 20 | 4 | 8×8 | 22 | 14 000 | 14000 / 17500 / 22000 | Clear 80 % of the board | 5 ice ×3L + 4 frozen + 4 walls + fast faller |

Stars are awarded by score thresholds against the same run, *regardless of objective type*: 1★ at the target, 2★ ~+30 %, 3★ ~+80 %. The objective gate is necessary to win at all — failing the objective even with a 3★ score returns a loss.

### Match-3 engine

`src/game.js` runs a deterministic match-3 board with the following loop:

1. **Generate** a board respecting per-level config (target score, move budget, blockers, tile pool).
2. **Player swaps** two adjacent tiles. A valid swap requires the resulting state to contain at least one match of 3+.
3. **Resolve matches** in cascades — matches of 4 spawn a row- or column-clear special tile (depending on match orientation); matches of 5+ in a straight line spawn a color bomb; T/L matches spawn a different combinator.
4. **Gravity + refill** drops surviving tiles and fills empty cells from the top with new random tiles weighted by the level's `tiles[]` pool.
5. **Cascading matches** chain — each subsequent cascade increments a `combo` multiplier that compounds the score.
6. **Boosters** can be consumed during a turn — `row-clear`, `col-clear`, `hammer`, `color-bomb`, `shuffle`. Each tracked in `journal.boostersUsed` for chain settlement on submit.
7. **Shards** drop probabilistically on matches of 4+. Each shard type rolls independently — a single 4-match can yield 0, 1, 2, or all 3 shard types.
8. **Move count exhausts or target hit** → `showLevelPopup(won)` evaluates the objective and computes star count.

### Scoring formula

```
matchScore = match.size × 10 × combo × shardMultiplier × inventoryMultiplier
```

- `match.size` — number of tiles in the resolved match (3, 4, 5, …)
- `combo` — number of cascades resolved this turn (starts at 1, increments per resolution wave)
- `shardMultiplier` — passive trait, see Shards table below
- `inventoryMultiplier` — Crush Pass score boost (1.5× during an active pass)

A long cascade triggered by a single swap can easily 5–10× a base match through the combo multiplier alone. Stacking shard traits + an active pass on top of a 5-combo cascade is the path to top-1 leaderboard scores.

### Tile types

- **Shells** (stand-alone): `ice`, `frostice`
- **Inners** (occupy an inner cell, can be inside ice): `fish`, `popsicle`, `shrimp`, `crab`
- Each level's `tiles[]` array picks 4 from this pool; only those colors appear on the board.

### Blockers

| Type | Behavior |
|---|---|
| `frozen` | Tile locked in ice. Match adjacent to free the inner tile. |
| `ice1` / `ice2` / `ice3` | Layered ice — each adjacent match peels one layer until the cell is clear. |
| `wall` | Immovable, unbreakable. Blocks the grid cell entirely; cascades route around it. |
| `faller` | Drops 1 row per turn (interval set per level — 2 or 3 turns). Bottom-hit triggers `fallerPenalty` recorded on the journal. Surviving N drops is a winnable objective on its own (level 16). |

### Boosters

| SKU | Effect on use | Shop price | Pack size |
|---|---|---|---|
| `booster.row` | Clears the entire row of the target tile | $2.98 | 4 |
| `booster.col` | Clears the entire column of the target tile | $2.98 | 4 |
| `booster.colorBomb` | Clears every tile of the target's type on the board | $2.98 | 4 |
| `booster.hammer` | Removes any single tile (including inside `frozen`/`ice`) | $2.98 | 4 |
| `booster.shuffle` | Re-randomizes all non-blocker tiles on the board | $2.98 | 4 |
| `life.regular` | Adds a regular life (up to MAX_REGULAR_LIVES = 5) | $2.99 | 5 |
| `pass.weekly` | Activates Crush Pass for 7 days | $4.99 | 1 |

Boosters consumed mid-run are tracked client-side in `journal.boostersUsed` and settled atomically on chain when `submitLevel*` lands. Server-side validator (`pengu-validate-level`) bounds-checks every counted booster against the player's on-chain balance plus what could have been earned in that run, then signs the journal hash. Trying to spend a booster you don't own gets rejected before the chain ever sees the journal.

### Shards

Earned only in-play; never sold in the shop. Each shard rolled independently per match-of-4+:

| Shard | Rarity | Drop chance per 4+ match | Trait | Cap |
|---|---|---|---|---|
| `necklace` | common | 20 % | +0.25 % score per necklace | +10 % score |
| `crown` | rare | 10 % | +1 move per 5 crowns | +5 moves |
| `plooshie` | legendary | 5 % | +2 % score per plooshie | +30 % score |

Traits stack at run start — the move bonus is added to the level's base budget, and the score multiplier is applied to every match. A high-shard wallet can compound an 8 % crown move-bonus + 25 % score-bonus on top of every level's base config, which is the long-game progression hook.

Per-level shard tally is mirrored to `localStorage.pengucrush_level_shards_v1` so the pre-game popup can show "you've earned X necklaces *from this level*" rather than lifetime totals.

### Lives

- **Regen cap = 5.** Every 8 hours of inactivity (since the last life consumed) returns one regular heart, up to 5.
- **Storage cap = 5.** Purchased lives stack into regular slots up to 5; the 6th, 7th, etc. are wasted on chain. (Wallets that ran past 5 during the V2.4 window keep their excess on chain; it burns off as the player consumes lives.)
- **Frozen lives = 2.** Crush Pass grants up to 2 ice hearts. They sit on top of regular lives, are spent only after regular hearts hit 0, and expire when the pass window ends.
- **HUD always paints 5 slots.** Regular hearts fill from the left; ice hearts fill the remaining slots up to 5. A player at 5 regular shows zero ice (regulars displaced them); a player at 3 regular + 2 ice shows the classic 3-pink + 2-ice layout.
- **Regen runs server-free.** `getLives` computes `eligibleRegular` virtually from `lastConsumedAt`, `block.timestamp`, and `REGEN_PERIOD`. No cron is required for the UI to display the correct count. The off-chain sweeper exists to emit `LifeRegenerated` events for indexers.

### Crush Pass (weekly)

- **$4.99 / week** — extends `crushPass.expiresAt` by 7 days, additive across renewals.
- **+2 ice hearts** granted on purchase.
- **+3 of each booster SKU** as a one-time signing bonus.
- **1 random shard** drawn from a weighted pool (rare/legendary skew configurable on chain).
- **1.5× score multiplier** active for every level played during the pass window.
- **Weekly streak tracking** — `streakWeeks` increments each consecutive ISO week of renewal; reset to 1 on a skip.

Cancellation zeros `expiresAt` and immediately drops the ice hearts on chain.

### Daily wheel

- Six configurable slots, each holding either a fixed reward (e.g. "Gem ×5", "Coin ×100", "XP ×50") or a random pool reference (e.g. "Random booster", weighted on chain).
- One spin per UTC day per wallet, enforced on chain via `lastWheelDay[player]`.
- Server-signed RNG: frontend POSTs to `pengu-wheel-roll`, gets back a typed-data `WheelRoll` + signature. Contract verifies the signature recovers to `wheelRelayer`, decodes the slot index, picks the reward (resolving any random pool with a chain-side modulo), and credits the player.
- Visual rotation animates only after the on-chain receipt lands and the slot index is decoded from the `DailySpin` event. No client-side guess of the result.
- Pass-active players are eligible for a 2× multiplier on slots that support it (configured on chain per slot).

### Leaderboard

Read directly from chain via `getPlayerCount` + `getPlayers(offset, limit)` + `getLeaderboardBatch(address[])`. Ranking order: `totalStars` ↓, ties broken by `totalScore` ↓, then `highestLevel` ↓. The Supabase mirror table was retired in the V2 audit (anon write path was a leaderboard-inflation vector).

---

## Off-chain services

### Edge functions (Supabase, Deno runtime)

| Function | Purpose | Trust boundary |
|---|---|---|
| `pengu-quote-price` | Returns an EIP-712 `ShopQuote` for the requested SKU + currency. Server is the single source of truth for bundle size and price; client `qty` is ignored. | Price relayer signature recovered on chain. |
| `pengu-validate-level` | Bounds-checks a `LevelJournal` against per-level config (moves used ≤ allowed, score ≤ target × ceiling, stars recomputed) and signs `Validation(player, journalHash)`. | Validator relayer signature recovered on chain. |
| `pengu-wheel-roll` | Rolls a wheel slot index, returns `WheelRoll` + signature. Once-per-UTC-day server-enforced. | Wheel relayer signature recovered on chain. |
| `pengu-regen-sweep` | Hourly cron via `pg_cron + pg_net`. Fetches a batch of wallets eligible for regen and calls `claimRegenBatch` so off-chain indexers see `LifeRegenerated` events even when players are idle. | `x-cron-secret` header (constant-time compared); 401 without. |

All four use the operator-owned relayer EOA. Relayer keys are stored in Supabase Vault (encrypted at rest by pgsodium) and read via the `public.get_vault_secret` security-definer RPC, callable only by `service_role`.

### Data tables

| Table | Use |
|---|---|
| `pengu_tx_log` | Mirror of every client-fired chain tx — `wallet`, `tx_type`, `status` (submitted/success/reverted/error), `tx_hash`, `block_number`, `details`, `error`. Cap: 10000 rows/wallet via INSERT trigger. RLS allows anon insert/update only for rows matching `0x + 40 hex` wallet format. |
| `pengu_game_snapshots` | Mid-game state for the anti-cheat trail. RLS-enforced wallet format + 30-row cap per wallet. |
| `pengu_players`, `pengu_progress`, `pengu_boosters` | Legacy mirror tables from V1. Anon writes were revoked in the V2 audit; reads still allowed but the tables are no longer authoritative. |

### RPC

Public reads route through a dedicated Alchemy endpoint (`VITE_ABSTRACT_RPC_URL`, baked at build time). Per-key quotas and origin allow-listing are the protection model; the URL is visible in the production JS bundle by design. Falls back to viem's shared public RPC if the env var is absent.

---

## Frontend conventions

- **Session keys.** After SIWE, AGW grants a session key scoped to an allowlist of gameplay selectors (`startLevel`, `submitLevel`, `submitLevelValidated`, `submitAndStartNext`, `levelCheckpoint`, `claimRegen`, `claimStarterPack`, `cancelCrushPass`, `spinDailyWheel`, plus signed-quote functions). Any tx outside this list triggers an AGW prompt.
- **Chain is truth.** No optimistic UI claims a state change before the chain confirms it. Shop buttons show "Sign tx…" → "✓ Confirmed" only on a real receipt; the daily wheel animates after the on-chain slot is decoded from the event log; the level popup's Next button awaits the fused submit + start before navigating.
- **Local cache is for instant repaint.** `Inventory.hydrateFromChain` runs on every wallet-connect, every successful chain write, and (with one 400 ms retry on null reads) on every level transition. The cache is wallet-scoped; switching wallets switches cache namespaces.
- **No client-side authority on progress.** `isLevelUnlocked` reads `getBestResult(wallet, N-1)` directly from chain (or Supabase as a backup), never localStorage. The map renders from the cache for instant visual feedback, then re-renders against chain truth via `hydrateProgressFromChain`.
- **Errors surface.** Insufficient gas, no lives, validator down, user reject — each is detected and translated into an actionable in-UI message ("Fund your AGW wallet on Abstract", "No lives left, wait for regen or buy more") rather than viem's raw error string.

---

## Upgrade history

The proxy is `0x06aCb91c46aD1359825560B19A9556118Aeb1896`; implementations were swapped via UUPS:

| Version | Implementation | Headline change |
|---|---|---|
| V2.0 | `0xa742dd48E82B970770A557f89f062769B5A764B9` | Initial deploy — items registry, wheel, regen, signed shop quotes. |
| V2.1 | `0xe45A09e7B5816a16f6DA0cAd18c265DBFa174B91` | Audit hardening — `startLevel` precondition, shard array cap, exact payment, journalHash in event, separate wheel-nonce mapping. |
| V2.2 | `0x0dB9cB1Aa682f50EaF1b6820f39210336c834f01` | `submitLevelValidated` — EIP-712 validator gate on per-level journal. Saturating uint32 totalScore. |
| V2.3 | (impl shared with V2.4) | `claimStarterPack` — idempotent one-time per-wallet booster grant. |
| V2.4 | `0x857d1DA040c501133782f68ca071296F1c47d522` | Lives stack to 10 (regen still 3). Reverted in V2.5. |
| V2.5 | `0x6C321B967fbd6aB80bFa0B8106062141d9396a88` | Hard cap on regular lives = 5. Purchases past 5 waste. |
| V2.6 | `0x13586C19fb0c441EBC6CA38514ef4c4297Ae0274` | `submitAndStartNext` — fused atomic single-tx Next button. |
| V2.7 | `0x4F82066ae2924B1EAd467A22C79FD1606718193E` | Regen target = 5. HUD "Full!" matches reality. |

Upgrade transactions, block numbers, and post-deploy state checks are recorded in `records.txt`.

---

## License

UNLICENSED — proprietary to the operator. Contact the operator for licensing inquiries.
