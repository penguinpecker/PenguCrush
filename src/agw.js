// ═══════════════════════════════════════════════════════════════
//  AGW — Abstract Global Wallet integration (vanilla JS)
//
//  Opens the real AGW login popup (email, Google, passkeys, etc.)
//  via @privy-io/cross-app-connect and wraps the provider with
//  @abstract-foundation/agw-client so signatures + transactions
//  route through the user's AGW smart contract wallet (EIP-1271).
// ═══════════════════════════════════════════════════════════════
import { transformEIP1193Provider } from '@abstract-foundation/agw-client';
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import { abstract } from 'viem/chains';
import { toPrivyWalletProvider } from '@privy-io/cross-app-connect';

// Abstract's Privy provider app ID (from agw-react constants)
const AGW_APP_ID = 'cm04asygd041fmry9zmcyn5o5';

let _privyProvider = null;  // raw Privy cross-app EIP-1193 provider
let _agwProvider = null;    // wrapped with AGW transformEIP1193Provider
let _walletClient = null;   // viem WalletClient
let _publicClient = null;   // viem PublicClient
let _agwClient = null;      // @abstract-foundation/agw-client higher-level client (for session keys)
let _address = null;        // AGW smart contract wallet address
let _signerAddress = null;  // underlying EOA address

const SIGNIN_KEY = 'pengu_siwe';
const SIGNIN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const CROSS_APP_STORAGE_KEY = `privy-caw:${AGW_APP_ID}:connection:smart-wallet`;

// ── helpers ────────────────────────────────────────────────────
function persist(addr) {
  if (addr) localStorage.setItem('pengu_wallet', addr);
  else localStorage.removeItem('pengu_wallet');
}

function clearSignIn() { localStorage.removeItem(SIGNIN_KEY); }

// Dynamic import to avoid the session-key.js ↔ agw.js cycle (session-key.js
// already imports getAGWAddress from here). Caller awaits.
async function clearSessionFor(addr) {
  if (!addr) return;
  try {
    const mod = await import('./session-key.js');
    mod.clearSessionForAddress?.(addr);
  } catch (_) {
    // session-key module unavailable — nothing to clear
  }
}

function getPopupFeatures(width = 440, height = 680) {
  const leftEdge = window.screenLeft ?? window.screenX ?? 0;
  const topEdge = window.screenTop ?? window.screenY ?? 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || screen.width;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || screen.height;
  const left = (viewportWidth - width) / 2 / (viewportWidth / window.screen.availWidth) + leftEdge;
  const top = (viewportHeight - height) / 2 / (viewportHeight / window.screen.availHeight) + topEdge;
  return `toolbar=0,location=0,menubar=0,height=${height},width=${width},popup=1,left=${left},top=${top}`;
}

function hasStoredCrossAppConnection() {
  try {
    const raw = localStorage.getItem(CROSS_APP_STORAGE_KEY);
    if (!raw) return false;
    const connection = JSON.parse(raw);
    return !!connection?.address && Number(connection.exp || 0) > Date.now();
  } catch (_) {
    return false;
  }
}

async function requestAccountsWithUserPopup(privy) {
  // Happy path: when localStorage already has a non-expired Privy cross-app
  // connection blob, Privy resolves eth_requestAccounts from cache without
  // opening any popup at all. Pre-opening a defensive popup in this case
  // creates a visible blank-window flash on every page navigation / silent
  // reconnect — which is exactly what was happening after the audit's
  // last-but-one round of fixes.
  if (hasStoredCrossAppConnection()) {
    await privy.request({ method: 'eth_requestAccounts' });
    return;
  }

  // No cached blob → Privy will need to open an auth popup. We're inside
  // a user-gesture handler (homePlayBtn click) so window.open is allowed.
  // Pre-open a blank popup synchronously and let Privy navigate it.
  // The cross-app connector does async setup before calling window.open
  // internally — without this pre-open the gesture is consumed by the
  // async await and Privy throws "Failed to initialize request".
  const originalOpen = window.open.bind(window);
  const popup = originalOpen('', undefined, getPopupFeatures());
  if (!popup) {
    // Browser blocked even the pre-open. Fall through and let Privy
    // surface its own popup-blocked error to the caller.
    await privy.request({ method: 'eth_requestAccounts' });
    return;
  }

  let consumed = false;
  window.open = (url, target, features) => {
    if (!consumed && !popup.closed) {
      consumed = true;
      if (url) popup.location.href = String(url);
      return popup;
    }
    return originalOpen(url, target, features);
  };

  try {
    await privy.request({ method: 'eth_requestAccounts' });
  } finally {
    window.open = originalOpen;
    if (!consumed && !popup.closed) popup.close();
  }
}

function buildSignInMessage(addr) {
  const nonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const issuedAt = new Date().toISOString();
  // SIWE-style: include origin so the wallet UI shows what site is asking.
  // Works the same on https://www.pengucrush.com, https://pengucrush.com, and localhost.
  const origin = typeof location !== 'undefined' ? location.origin : 'https://www.pengucrush.com';
  const host = typeof location !== 'undefined' ? location.host : 'www.pengucrush.com';
  return {
    nonce,
    issuedAt,
    origin,
    text:
      `${host} wants you to sign in with your Abstract Global Wallet.\n\n` +
      'Welcome to PenguCrush! Sign this message to verify you control this wallet. ' +
      'This is off-chain and costs no gas.\n\n' +
      `URI: ${origin}\n` +
      `Wallet: ${addr}\n` +
      `Chain ID: 2741\n` +
      `Issued: ${issuedAt}\n` +
      `Nonce: ${nonce}`,
  };
}

export function isSignedIn() {
  try {
    const raw = localStorage.getItem(SIGNIN_KEY);
    if (!raw) return false;
    const { address, issuedAt } = JSON.parse(raw);
    if (!address || !_address) return false;
    if (address.toLowerCase() !== _address.toLowerCase()) return false;
    if (issuedAt && Date.now() - new Date(issuedAt).getTime() > SIGNIN_TTL_MS) {
      clearSignIn();
      return false;
    }
    return true;
  } catch (_) { return false; }
}

// ── public API ─────────────────────────────────────────────────

/** Lazily create the Privy cross-app provider so it's ready when the user clicks. */
function ensurePrivyProvider() {
  if (_privyProvider) return _privyProvider;
  _privyProvider = toPrivyWalletProvider({
    providerAppId: AGW_APP_ID,
    chains: [abstract],
    chainId: abstract.id,
    smartWalletMode: true,
  });
  // accountsChanged listener: catches the case where the user switches
  // their AGW account in another tab / via Privy UI. Without this we'd
  // keep signing txs for the OLD account until next page reload.
  // Strategy: drop everything (session blob, read cache, in-memory
  // clients) and force a fresh connectAGW from a user gesture.
  try {
    _privyProvider.on?.('accountsChanged', async (accounts) => {
      const next = (accounts?.[0] || '').toLowerCase();
      const prev = (_signerAddress || '').toLowerCase();
      // CRITICAL: skip when prev is empty. Privy emits accountsChanged
      // during the very first eth_requestAccounts resolution to deliver
      // the freshly-connected EOA to listeners — that's NOT a wallet
      // switch, it's the initial connect itself. Without this guard,
      // every cold-start would trigger disconnectAGW + a reload 50ms
      // after the user successfully connects, looking like the connect
      // silently failed and dumping them back on the home screen.
      if (!prev) return;
      if (next === prev) return; // identity — nothing to do
      // Same guard for the "disconnected externally" case — accounts
      // can be []. If we never had a wallet, ignore.
      if (!next && !prev) return;
      console.warn('[agw] accountsChanged detected', { prev, next });
      // Drop wallet-scoped session blob for the prior signer so it
      // can't be reused under the new identity.
      const priorSmartWallet = _address;
      try { await clearSessionFor(priorSmartWallet); } catch (_) {}
      // Bust the chain-read cache — old wallet's cached lives /
      // inventory / best-results would otherwise leak into the new
      // wallet's UI.
      try {
        const { bustReadCache } = await import('./onchain.js');
        bustReadCache();
      } catch (_) {}
      // Tear down in-memory state and force the user to re-connect
      // from a click (avoids consuming a popup gesture without one).
      disconnectAGW();
      // Notify the rest of the app via a custom event so screens can
      // re-render / redirect to home without polling.
      try { window.dispatchEvent(new CustomEvent('pengu:walletSwitched', { detail: { next, prev } })); } catch (_) {}
      // Belt-and-braces: hard reload so any retained references in
      // closures (Three.js scenes, viem clients) come up clean.
      try { setTimeout(() => { location.href = '/'; }, 50); } catch (_) {}
    });
  } catch (err) {
    console.warn('[agw] failed to attach accountsChanged listener:', err?.message || err);
  }
  return _privyProvider;
}

/** Connect via AGW — opens the Abstract login popup (email/Google/passkeys) */
export async function connectAGW() {
  if (_walletClient && _address) return _address; // idempotent

  // 1. Ensure Privy cross-app provider exists pointed at Abstract's AGW
  const privy = ensurePrivyProvider();

  // 2. Request accounts — this opens the AGW login popup (must be synchronous from user gesture)
  await requestAccountsWithUserPopup(privy);
  const accounts = await privy.request({ method: 'eth_accounts' });
  if (!accounts?.length) throw new Error('No accounts returned from AGW');

  _signerAddress = accounts[0]; // EOA from Privy

  // 3. Wrap with AGW's transformEIP1193Provider for smart contract wallet routing
  _agwProvider = transformEIP1193Provider({
    provider: privy,
    chain: abstract,
    isPrivyCrossApp: true,
  });

  // 4. Get AGW smart contract wallet address
  const agwAccounts = await _agwProvider.request({ method: 'eth_accounts' });
  const newAddress = agwAccounts[0] || _signerAddress;

  // Wallet switch: drop any session key bound to the previous address before
  // overwriting `_address`, so a switch can't silently inherit prior auth
  // (audit H5).
  if (_address && newAddress && _address.toLowerCase() !== newAddress.toLowerCase()) {
    await clearSessionFor(_address);
  }
  _address = newAddress;

  // 5. Build viem clients
  _walletClient = createWalletClient({
    account: _address,
    chain: abstract,
    transport: custom(_agwProvider),
  });

  _publicClient = createPublicClient({
    chain: abstract,
    transport: http(getAbstractRpcUrl()),
  });

  // Build the higher-level AGW client for session-key APIs. Falls back to null
  // if the agw-client package doesn't export the helper.
  try {
    const agwMod = await import('@abstract-foundation/agw-client');
    if (typeof agwMod.createAbstractClient === 'function') {
      const signerAccount = await import('viem/accounts').then(m =>
        m.toAccount({ address: _signerAddress, signMessage: async ({ message }) => privy.request({
          method: 'personal_sign', params: [typeof message === 'string' ? message : message.raw, _signerAddress]
        }), signTransaction: async () => { throw new Error('not used'); }, signTypedData: async () => { throw new Error('not used'); } })
      ).catch(() => null);
      if (signerAccount) {
        _agwClient = await agwMod.createAbstractClient({
          chain: abstract,
          signer: signerAccount,
          transport: custom(privy),
          // CRITICAL: without this flag, AGW routes batch / session
          // transactions through the EOA's signTypedData (which our
          // toAccount intentionally rejects with "not used") and the
          // call throws — bootstrapBatch then silently falls back to
          // the legacy multi-prompt path. With isPrivyCrossApp=true,
          // signing routes through Privy's privy_signSmartWalletTx
          // method, which uses the same popup we already pre-opened
          // and reuses the user's Privy session.
          isPrivyCrossApp: true,
        });
      }
    }
  } catch (err) {
    console.warn('AGW high-level client init failed (session keys disabled):', err?.message || err);
    _agwClient = null;
  }

  persist(_address);
  return _address;
}

/** Higher-level AGW client (used for session-key createSession / revokeSessions). */
export function getAgwClient() {
  return _agwClient;
}

// Pre-create the Privy provider on module load so the popup opens instantly on click,
// without a network fetch stealing the user-gesture context.
try { ensurePrivyProvider(); } catch (err) { console.warn('Privy init deferred:', err); }

/** Sign the SIWE message via AGW (EIP-1271). Opens the real AGW signature popup. */
export async function signInWithAGW() {
  if (!_walletClient || !_address) {
    await connectAGW();
  }
  const { nonce, issuedAt, text } = buildSignInMessage(_address);

  // Routed through AGW transformEIP1193Provider → smart-wallet signMessage (EIP-1271)
  const signature = await _walletClient.signMessage({
    account: _address,
    message: text,
  });

  localStorage.setItem(SIGNIN_KEY, JSON.stringify({
    address: _address, signature, nonce, issuedAt,
  }));
  return signature;
}

/** Disconnect (clear local state + revoke permissions) */
export function disconnectAGW() {
  // Wipe the local session key for the wallet we're about to drop so a later
  // reconnect to the same wallet can't silently resurrect it (audit H5).
  // Fire-and-forget — clearing localStorage doesn't need to block disconnect.
  const prev = _address;
  if (prev) clearSessionFor(prev).catch(() => {});
  // Invalidate the chain-read cache so a fresh connect (potentially to a
  // different wallet) doesn't see the prior wallet's cached state.
  import('./onchain.js').then(m => m.bustReadCache?.()).catch(() => {});
  if (_privyProvider) {
    try {
      _privyProvider.request({
        method: 'wallet_revokePermissions',
        params: [{ eth_accounts: {} }],
      });
    } catch (_) {}
  }
  _privyProvider = null;
  _agwProvider = null;
  _walletClient = null;
  _publicClient = null;
  _address = null;
  _signerAddress = null;
  persist(null);
  clearSignIn();
}

/** Get current AGW address (or null) */
export function getAGWAddress() {
  return _address;
}

/** Get the signer EOA address */
export function getSignerAddress() {
  return _signerAddress;
}

/** Get viem WalletClient (for sending txs). Returns null if not yet connected. */
export function getWalletClient() {
  return _walletClient;
}

/**
 * Returns a usable walletClient. If we have an `_address` cached from
 * localStorage but the in-memory walletClient is null (page reload after a
 * SIWE-cached session), this performs a SILENT reconnect via Privy's stored
 * cross-app connection — no popup, no SIWE re-prompt — and rebuilds the
 * viem clients. Throws if no cached identity exists.
 *
 * Every chain write should funnel through this instead of `getWalletClient`
 * directly so reloads stop tripping on "wallet client missing".
 */
export async function ensureWalletClient() {
  if (_walletClient) return _walletClient;
  if (!_address) throw new Error('not signed in');
  await connectAGW();
  if (!_walletClient) throw new Error('wallet reconnect failed');
  return _walletClient;
}

/// Resolve the Abstract mainnet RPC URL. Prefers a custom URL injected at
/// build time via VITE_ABSTRACT_RPC_URL (typically an Alchemy/Infura/QuickNode
/// dedicated endpoint, set in Vercel env so it never lands in git). Falls back
/// to viem's default public RPC if unset — rate-limited but functional.
function getAbstractRpcUrl() {
  const fromEnv = (import.meta.env?.VITE_ABSTRACT_RPC_URL || '').trim();
  return fromEnv || undefined;
}

/** Get viem PublicClient (for reads) */
export function getPublicClient() {
  return _publicClient || createPublicClient({ chain: abstract, transport: http(getAbstractRpcUrl()) });
}

/** Read contract (convenience) */
export async function readContract(args) {
  const client = getPublicClient();
  return client.readContract(args);
}

/** Write contract via AGW wallet */
export async function writeContract(args) {
  if (!_walletClient) throw new Error('Wallet not connected');
  return _walletClient.writeContract(args);
}

/** Short display address: 0x1234…abcd */
export function shortAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Always true — AGW cross-app popup does not require an injected browser wallet */
export function hasInjectedWallet() {
  return true;
}

// ── re-hydrate address from localStorage on load ──────────────
// (Wallet client is NOT restored; user must reconnect to sign/transact.
//  But isSignedIn() can still be true if a valid signature is cached.)
const saved = localStorage.getItem('pengu_wallet');
if (saved) _address = saved;
