// ═══════════════════════════════════════════════════════════════
//  AGW SESSION KEYS — auto-execute in-game txs without prompts
//
//  After the user signs into AGW, we offer them a one-time prompt
//  to grant a 24h session key scoped to PenguCrushV2's in-game
//  selectors only (no value transfer, no shop). All subsequent
//  in-game txs execute silently via this session key.
//
//  Shop purchases (real $) DO NOT use the session key — they go
//  through the normal AGW prompt every time. This is enforced by
//  omitting the shop selectors from `callPolicies`.
// ═══════════════════════════════════════════════════════════════

import { toFunctionSelector, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { abstract } from 'viem/chains';
import { PENGUCRUSH_ADDRESS } from './onchain.js';
import { getAGWAddress } from './agw.js';

// Lazy-imported because @abstract-foundation/agw-client may have varying
// session-key export shapes across versions; if import fails we degrade
// gracefully to "no session key" mode (every tx prompts).
let _agwSessionApi = null;
async function loadAgwSessionApi() {
  if (_agwSessionApi) return _agwSessionApi;
  try {
    const mod = await import('@abstract-foundation/agw-client/sessions');
    _agwSessionApi = {
      LimitType: mod.LimitType,
      LimitUnlimited: mod.LimitUnlimited,
      LimitZero: mod.LimitZero,
      createSessionClient: mod.createSessionClient,
      prepareCreateSessionCall: mod.prepareCreateSessionCall,
    };
    return _agwSessionApi;
  } catch (err) {
    console.warn('AGW sessions module unavailable — session keys disabled:', err?.message || err);
    return null;
  }
}

const STORAGE_KEY_PREFIX = 'pengu_session_';
const SESSION_TTL_SEC = 24 * 60 * 60; // 24h
const SESSION_FEE_LIMIT_ETH = '0.05';

// Selectors that the session key is allowed to call. Adding to this list
// requires re-granting the session key (rotate the local key + revoke old).
const GAMEPLAY_METHODS = [
  'startLevel(uint16)',
  // Unvalidated submitLevel — kept in the policy so the client's
  // validator-down fallback path stays silent.
  'submitLevel((uint16,uint32,uint8,uint16,bool,uint32,bytes32[],bytes32[],uint16,uint16))',
  // V2.2 validated submission — server-signed bounds-checked path. This is
  // the normal flow once pengu-validate-level returns; MUST be in the policy
  // or every level-end will pop the AGW prompt.
  'submitLevelValidated((uint16,uint32,uint8,uint16,bool,uint32,bytes32[],bytes32[],uint16,uint16),bytes)',
  // V2.6 fused submit + startLevel(nextLevel). Single-tx path for the level
  // popup's Next / Replay buttons.
  'submitAndStartNext((uint16,uint32,uint8,uint16,bool,uint32,bytes32[],bytes32[],uint16,uint16),bytes,uint16)',
  'claimRegen()',
  'cancelCrushPass()',
  // V2.3 — one-time starter pack grant, idempotent. Session-key safe so the
  // auto-claim after first sign-in runs without prompting.
  'claimStarterPack()',
  // Wheel + signed-quote functions: included since they don't move ETH
  // (wheel takes server-signed roll; quote-signed shop functions stay OUT
  // of the policy and will fail the validator, falling back to AGW prompt
  // — exactly the desired UX for value-bearing calls).
  'spinDailyWheel((address,uint64,uint8,uint256,uint256),bytes)',
];

function storageKey(agwAddress) {
  return STORAGE_KEY_PREFIX + agwAddress.toLowerCase();
}

function loadStoredSession(agwAddress) {
  try {
    const raw = localStorage.getItem(storageKey(agwAddress));
    if (!raw) return null;
    const blob = JSON.parse(raw);
    if (!blob?.sessionPk || !blob?.session) return null;
    if (Number(blob.session.expiresAt) <= Math.floor(Date.now() / 1000) + 60) {
      // expires in less than 1 min → treat as gone
      localStorage.removeItem(storageKey(agwAddress));
      return null;
    }
    return blob;
  } catch (_) {
    return null;
  }
}

function persistSession(agwAddress, blob) {
  localStorage.setItem(storageKey(agwAddress), JSON.stringify(blob));
}

function clearStoredSession(agwAddress) {
  localStorage.removeItem(storageKey(agwAddress));
}

/**
 * Wipe the locally-stored session for a wallet without prompting the user or
 * touching chain. Called on disconnect / wallet-switch so a session can't be
 * silently resurrected on a later reconnect (audit H5).
 */
export function clearSessionForAddress(agwAddress) {
  if (!agwAddress) return;
  clearStoredSession(agwAddress);
}

/**
 * Has the user already granted a valid session key? Read-only check.
 */
export function hasActiveSession() {
  const a = getAGWAddress();
  if (!a) return false;
  return !!loadStoredSession(a);
}

// Build a fresh session spec + matching local private key. Returns both the
// spec (to feed into createSession / sendTransactionBatch) and a `commit()`
// callback the caller invokes once the on-chain registration confirms — that
// writes the session blob to localStorage so subsequent gameplay calls find
// it via getSessionClient(). Splitting build vs commit lets the batch path
// stage the spec without leaving an orphan blob in storage if the tx reverts.
async function buildSessionSpec() {
  const api = await loadAgwSessionApi();
  if (!api) throw new Error('AGW session API unavailable');
  const agwAddress = getAGWAddress();
  if (!agwAddress) throw new Error('No AGW address');

  const sessionPk = generatePrivateKey();
  const sessionSigner = privateKeyToAccount(sessionPk);

  const callPolicies = GAMEPLAY_METHODS.map(methodSig => ({
    target: PENGUCRUSH_ADDRESS,
    selector: toFunctionSelector(methodSig),
    maxValuePerUse: 0n,
    valueLimit: api.LimitZero,
    constraints: [],
  }));

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + SESSION_TTL_SEC);

  const sessionSpec = {
    signer: sessionSigner.address,
    expiresAt,
    feeLimit: {
      limitType: api.LimitType.Lifetime,
      limit: parseEther(SESSION_FEE_LIMIT_ETH),
      period: 0n,
    },
    callPolicies,
    transferPolicies: [],
  };

  function commit(createTxHash) {
    persistSession(agwAddress, {
      sessionPk,
      session: {
        ...sessionSpec,
        expiresAt: String(sessionSpec.expiresAt),
        feeLimit: {
          ...sessionSpec.feeLimit,
          limit: String(sessionSpec.feeLimit.limit),
          period: String(sessionSpec.feeLimit.period),
        },
      },
      grantedAt: Date.now(),
      createTxHash: createTxHash || null,
    });
  }

  return { api, agwAddress, sessionSpec, sessionSigner, commit };
}

/**
 * Grant a fresh 24h session key. Requires one explicit AGW prompt.
 * After this, in-game txs execute silently.
 *
 * `agwClient` must be the user-facing AbstractClient (with `createSession`).
 */
export async function grantSession(agwClient) {
  const { agwAddress, sessionSpec, sessionSigner, commit } = await buildSessionSpec();

  // The agwClient.createSession signature varies by package version;
  // try the documented form first, then a positional fallback.
  let createResult;
  try {
    createResult = await agwClient.createSession({ session: sessionSpec });
  } catch (e1) {
    try {
      createResult = await agwClient.createSession(sessionSpec);
    } catch (e2) {
      throw e1;
    }
  }

  commit(createResult?.transactionHash);
  return { sessionAddress: sessionSigner.address, txHash: createResult?.transactionHash, agwAddress };
}

/**
 * Prepare the session-registration on-chain call WITHOUT sending it, so the
 * caller can bundle it into a larger `sendTransactionBatch` (createSession +
 * claimStarterPack + startLevel in one user prompt). Returns the raw
 * { to, data, value } and a `commit()` to call after the batch confirms.
 */
export async function prepareSessionGrantCall(agwClient) {
  const { api, agwAddress, sessionSpec, sessionSigner, commit } = await buildSessionSpec();
  if (!api.prepareCreateSessionCall) {
    throw new Error('prepareCreateSessionCall not exported by this agw-client version');
  }
  const call = await api.prepareCreateSessionCall(agwAddress, agwClient, sessionSpec);
  return { call, commit, sessionAddress: sessionSigner.address };
}

/**
 * Returns a viem-compatible WalletClient bound to the session key, or null
 * if no active session exists for the given function. Currently the policy
 * is uniform across all gameplay methods, so the function name is a hint
 * for future per-method scoping.
 */
export async function getSessionClient(_functionName) {
  const api = await loadAgwSessionApi();
  if (!api) return null;
  const agwAddress = getAGWAddress();
  if (!agwAddress) return null;
  const stored = loadStoredSession(agwAddress);
  if (!stored) return null;

  const sessionSigner = privateKeyToAccount(stored.sessionPk);
  const { http } = await import('viem');

  // Re-hydrate session object (BigInts come back as strings from localStorage)
  const session = {
    ...stored.session,
    expiresAt: BigInt(stored.session.expiresAt),
    feeLimit: {
      limitType: stored.session.feeLimit.limitType,
      limit: BigInt(stored.session.feeLimit.limit),
      period: BigInt(stored.session.feeLimit.period),
    },
    callPolicies: stored.session.callPolicies.map(p => ({
      ...p,
      maxValuePerUse: BigInt(p.maxValuePerUse || 0),
      valueLimit: api.LimitZero, // gameplay = no value
    })),
    transferPolicies: [],
  };

  try {
    return api.createSessionClient({
      account: agwAddress,
      chain: abstract,
      signer: sessionSigner,
      session,
      transport: http(),
    });
  } catch (err) {
    console.warn('createSessionClient failed:', err?.message || err);
    return null;
  }
}

/** Revoke locally + on chain (best-effort). User-initiated. */
export async function revokeSession(agwClient) {
  const agwAddress = getAGWAddress();
  if (!agwAddress) return;
  const stored = loadStoredSession(agwAddress);
  clearStoredSession(agwAddress);
  if (!stored || !agwClient?.revokeSessions) return;
  try {
    const session = {
      ...stored.session,
      expiresAt: BigInt(stored.session.expiresAt),
      feeLimit: {
        ...stored.session.feeLimit,
        limit: BigInt(stored.session.feeLimit.limit),
        period: BigInt(stored.session.feeLimit.period),
      },
    };
    await agwClient.revokeSessions({ session });
  } catch (err) {
    console.warn('revokeSession on chain failed (local cleared):', err?.message || err);
  }
}
