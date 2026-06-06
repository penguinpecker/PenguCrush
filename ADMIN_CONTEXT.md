# PenguCrush — Consolidated Context (for PenguAdmin work)

> Snapshot so we don't depend on the long chat history. Covers the game's
> backend surface, the logging system, and the plan for a separate admin app.

## 1. The game (PenguCrush)

- **Stack:** Vite + vanilla JS (no framework), Three.js (3D match-3 board),
  Supabase (DB + edge functions), Abstract chain (chainId 2741) via AGW
  session keys. Node 20 to build (`~/.nvm/versions/node/v20.19.4`).
- **Repo root:** `/Users/lazydevpro/VSCodeProjects/puffles/PenguCrush`
- **Build:** `npm run build` · **Dev:** `npm run dev` (runs on 5173, we've been on 5175)
- **Audits:** `npm run audit:levels`, `audit:winnability`, `audit:stars`
  (sim scripts in `scripts/sim-*.mjs`)

## 2. Supabase backend

**Project REST base:** `https://saftqlwxmdqxzfuwdgtu.supabase.co`
(edge functions at `/functions/v1`, REST at `/rest/v1`)

### Tables
| Table | Key columns |
|---|---|
| `pengu_players` | wallet_address, total_stars, highest_level, total_score, games_played |
| `pengu_progress` | player_id→players, level, stars, best_score, attempts |
| `pengu_boosters` | player_id, booster_type, charges |
| `pengu_game_snapshots` | wallet, level, snapshot(jsonb) |
| `pengu_client_logs` | **NEW** — session_id, wallet, level, tag, msg, data(jsonb), ua, url, client_ts, created_at |

### Admin views (created in client_logs migration)
- `pengu_recent_errors` — last 24h errors
- `pengu_error_frequency` — error count + unique wallets by tag (7d)
- `pengu_wallet_log_summary` — per-wallet error/warn counts (7d)
- `pengu_leaderboard` — players ranked by stars/score

### Edge functions (`supabase/functions/`)
- `pengu-validate-level` — EIP-712 signs level journals
- `pengu-quote-price` — shop price quotes
- `pengu-wheel-roll` — daily wheel
- `pengu-regen-sweep` — life regen cron
- `pengu-log` — **NEW** — ingests client logs into pengu_client_logs

### RLS note
`pengu_client_logs` has RLS enabled, **no public policies** — only the
service-role key (used by edge fn / admin) can read/write. Anon writes to
`pengu_players`/`pengu_progress` were revoked May 2026 (audit fix H2), so
`saveLevelResult()` in the game is a deliberate no-op.

## 3. On-chain (Abstract mainnet, chainId 2741)

- **PenguCrushV2 proxy:** `0x06aCb91c46aD1359825560B19A9556118Aeb1896`
- ABI: `contracts/PenguCrushABI.json` · Source: `contracts/PenguCrushV2.sol`
- Key reads: `getBestResult(wallet, level)`, `getPlayers`, leaderboard batch
- Key writes: `startLevel`, `submitLevel`, `submitAndStartNext`, wheel, shop
- `startLevel` does NOT enforce progression order on-chain (debits a life +
  records `levelStartedAt`). Progression gating is client-side (progress.js).

## 4. Logging system (just built)

- **`src/logger.js`** — client logger. LogLevel DEBUG/INFO/WARN/ERROR.
  Rolling 200-entry memory buffer; last 60 persisted to localStorage
  (`pengucrush_logs`). WARN+ERROR shipped to `pengu-log` edge fn (ERROR
  immediate, WARN batched every 10s; flush on tab hide/unload). Global
  window.onerror + unhandledrejection capture. Wallet attached via
  `window.__penguWallet`.
- **Console helpers:** `__pengu.copyLogs() / getLogs() / showLogs() / clearLogs()`
- **Tags in use:** `onchain.*`, `progress.unlock`, `game.levelEnd`,
  `game.next`, `game.replay`, `game.mapSubmit`, `entry.connect`,
  `global.error`, `global.promise`
- **`public/dev-logs.html`** — standalone viewer with two modes:
  *This device* (reads localStorage) and *All users* (reads pengu_client_logs
  via pasted Supabase URL + service-role key, stored in `pengu_logviewer_cfg`).
  This is the prototype that PenguAdmin will supersede.

## 5. Notable recent fixes (this session)

- Level progression could permanently lock after clicking "Map" post-win
  (Supabase save was a no-op + Map discarded the chain submit). Fixed:
  `isLevelUnlocked` now falls back to localStorage; Map fires a background
  `submitLevel`.
- Full difficulty rebalance: gated curve (easy onboarding ~90% casual win,
  era-end gates ~32-38%), per-level `scoreScale`, booster points = 9% of
  target per booster, star thresholds fixed (esp. L15).
- Audio: full SFX/BGM system, separate music/sfx toggles, dropdown control,
  wheel spin/win sounds.
- Crush Pass: "Extend +1 week" wording, removed cancel trap, extend-specific perks.

## 6. PenguAdmin — the plan

**Goal:** A dedicated admin dashboard (separate from the game) to:
1. **Logs** — browse/search/filter pengu_client_logs across all users
   (supersedes dev-logs.html remote mode); error frequency dashboard.
2. **Players** — look up by wallet: progression (per-level stars/score),
   inventory (boosters/shards), lives, pass status, snapshots.
3. **Health** — recent errors, error trends, active sessions.
4. (later) **Live ops** — read on-chain state, maybe trigger admin txs.

**Open decisions (to confirm):**
- Stack: plain HTML/Vite-vanilla (match game) vs React/Vite.
- Hosting: local-run tool (paste service key) vs deployed app w/ Supabase
  Auth + admin allowlist + RLS read policies.
- Location: new top-level dir `penguadmin/` (separate package.json) vs
  subfolder in this repo.
