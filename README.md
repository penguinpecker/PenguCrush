# PenguCrush

Web-based match-3 game on **Abstract**. Players connect an Abstract Global Wallet, sign in with a SIWE-style message, and every meaningful action (level completion, booster use, booster purchase, daily wheel spin) is recorded on-chain so it counts toward the player's Abstract activity.

Live at **https://www.pengucrush.com**.

---

## Architecture

```
                          ┌─────────────────────────────┐
                          │        Browser (SPA)        │
                          │  index.html + Vite bundle   │
                          └──────────────┬──────────────┘
                                         │
         ┌───────────────────────────────┼───────────────────────────────┐
         │                               │                               │
         ▼                               ▼                               ▼
  ┌────────────┐                 ┌───────────────┐               ┌──────────────┐
  │ localStorage│                │   Supabase    │               │ Abstract L2  │
  │ inventory_v1│                │  Postgres +   │               │  Mainnet     │
  │  + siwe     │                │  Edge Funcs   │               │  (chain 2741)│
  └────────────┘                 └───────┬───────┘               └──────┬───────┘
                                         │                              │
                            pengu_players│                              │PenguCrush
                          pengu_progress │                              │UUPS proxy
                         pengu_boosters  │                              │
                      pengu_leaderboard  │                              │
```

- **Frontend** — vanilla JS + Vite. No framework. Entry at `src/entry.js` routes between home / map / game screens.
- **Rendering** — Three.js for in-game tiles, boosters, and HUD panels (all GLBs are Draco + WebP compressed, decoded via the shared `src/gltf-loader.js`).
- **Wallet** — Abstract Global Wallet via `@privy-io/cross-app-connect` + `@abstract-foundation/agw-client`. `src/agw.js` owns the EIP-1193 provider and exposes a viem `WalletClient` that automatically routes signatures through AGW's EIP-1271 path.
- **Session** — SIWE-style message stored in `localStorage.pengu_siwe` with a 7-day TTL. Non-home pages are gated on a valid session.
- **Persistence** — `src/inventory.js` is the wallet-scoped source of truth for boosters, currencies, and the daily-wheel cooldown. Writes go to `localStorage` synchronously and `pengu_boosters` on Supabase with a 500 ms debounce.
- **On-chain activity** — `src/onchain.js` wraps `walletClient.writeContract` so every action fires a best-effort tx to the `PenguCrush` proxy. Failures are logged but never block gameplay.

---

## Contracts (Abstract Mainnet, chain 2741)

| Role | Address | Notes |
|---|---|---|
| **`PenguCrush` — UUPS proxy** | `0xAF2ED337AAF8c3FF4AF5600C15F1C8C7042ec517` | All reads/writes target this address. Verified on Abscan. |
| Implementation (v1) | `0x976321C3724D01004a37f6E3Ce885cC28ea7f068` | Swapped transparently on upgrade. |
| Legacy `PenguCrushScores` | `0x2ef63Ee603a6944396AA97DA35835807F96BA089` | Still live; no longer written to. Kept for reading historical scores. |

The proxy exposes the full `PenguCrush` interface — score tracking _and_ activity events — under one address. New events or functions can be added later by editing `contracts/PenguCrush.sol` and running `deploy/upgrade-pengucrush.cjs`; the proxy address and every byte of player history are preserved.

---

## Mechanism — what gets written where, when

| Player action | localStorage | Supabase | Abstract (PenguCrush) |
|---|---|---|---|
| Connect wallet + sign SIWE | `pengu_wallet`, `pengu_siwe` | — | — |
| Level complete (won) | `pengucrush_progress` | `pengu_progress`, `pengu_players` (via edge fn) | `submitScore(level, score, stars, moves)` |
| Level complete (failed) | `pengucrush_progress` | same | — (no on-chain write for failures) |
| Shop BUY booster | `inventory.boosters[type]++` | `pengu_boosters` upsert | `logBoosterPurchased(booster, qty)` |
| Use booster in-game | `inventory.boosters[type]--` | `pengu_boosters` upsert | `logBoosterUsed(booster)` |
| Daily wheel spin | `inventory.lastDailySpin` + history | `pengu_boosters` / currencies | `logDailySpin(reward)` |

Every on-chain call is fire-and-forget via `safeWrite()` in `src/onchain.js`. Failures log to the console but do not block the UI.

### Level-unlock gate

The current level is never in the URL bar — the URL only shows `/?page=play` and the actual level number lives in `sessionStorage.pengu_current_level`. Legacy `?level=N` URLs still work but are migrated to the session-based form on load.

Before `game.js` loads, the boot flow calls `isLevelUnlocked(N)` in `src/progress.js`, which authorizes from trusted sources only:

1. **Primary — on-chain.** `PenguCrush.getBestResult(wallet, N-1)` on Abstract. If `stars > 0` the level unlocks.
2. **Backup — Supabase.** If the chain denies or the RPC fails, `fetchPlayerProgress(wallet)` checks `pengu_progress` for the same row. Supabase is trusted because writes go through the `pengu-save-progress` edge function, not the client.

Level 1 is always open. If both sources say no (or both are unreachable) the level stays locked. `localStorage.pengucrush_progress` is never consulted for authorization — it only colors the map UI.

### Kill switch

Set `VITE_ONCHAIN_DISABLED=true` in `.env.local` to silence all on-chain writes (handy for running the game without popping the AGW tx prompt in dev).

---

## Deploy / upgrade cheatsheet

```bash
# First-time deploy (creates proxy + implementation)
npx hardhat deploy-zksync --script deploy-pengucrush.cjs --network abstractMainnet

# Upgrade (keeps the same proxy address, swaps implementation)
npx hardhat deploy-zksync --script upgrade-pengucrush.cjs --network abstractMainnet

# Verify on Abscan
npx hardhat verify --network abstractMainnet <address>

# Authorize a relayer / session-key to call submitScoreFor()
npx hardhat deploy-zksync --script authorize-relayer.cjs --network abstractMainnet
```

Deployer key is stored in Hardhat vars (`npx hardhat vars set DEPLOYER_PRIVATE_KEY`), never committed.

---

## Local dev

```bash
npm install
npm run dev       # Vite at http://localhost:3000
npm run build     # production bundle → dist/ (~30 MB, assets already compressed)
```

Assets shipped under `public/assets/` are the compressed set. Original uncompressed sources live in `assets_ORIGINAL_BACKUP/` (gitignored) and can be re-run through `scripts/compress-assets.sh` if you replace artwork.
