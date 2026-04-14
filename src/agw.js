// ═══════════════════════════════════════════════════════════════
//  AGW — Abstract Global Wallet integration (vanilla JS)
//
//  Uses @privy-io/cross-app-connect to open the real AGW login
//  popup (email, Google, passkeys, etc.) and then wraps the
//  provider with @abstract-foundation/agw-client so transactions
//  route through the user's AGW smart contract wallet.
//
//  Local dev: Privy is not loaded until you connect for real — see
//  useWalletBypass() (localhost / Vite dev / VITE_PRIVY_BYPASS).
// ═══════════════════════════════════════════════════════════════
import { transformEIP1193Provider } from '@abstract-foundation/agw-client';
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import { abstract } from 'viem/chains';

// Abstract's Privy provider app ID (from agw-react constants)
const AGW_APP_ID = 'cm04asygd041fmry9zmcyn5o5';

const DEFAULT_DEV_WALLET = '0x1111111111111111111111111111111111111111';

let _privyProvider = null;  // raw Privy cross-app EIP-1193 provider
let _agwProvider = null;    // wrapped with AGW transformEIP1193Provider
let _walletClient = null;   // viem WalletClient
let _publicClient = null;   // viem PublicClient
let _address = null;        // AGW smart contract wallet address
let _signerAddress = null;  // underlying EOA address
let _devBypass = false;     // true when using local stub (no Privy)

// ── helpers ────────────────────────────────────────────────────
function persist(addr) {
  if (addr) localStorage.setItem('pengu_wallet', addr);
  else localStorage.removeItem('pengu_wallet');
}

/**
 * Skip Privy / cross-app connect on local machines so the app loads without wallet infra.
 * Set VITE_PRIVY_BYPASS=false in .env to force real Privy on localhost.
 * Set VITE_PRIVY_BYPASS=true to force bypass even on non-local hosts (optional).
 */
export function useWalletBypass() {
  try {
    if (import.meta.env?.VITE_PRIVY_BYPASS === 'false') return false;
    if (import.meta.env?.VITE_PRIVY_BYPASS === 'true') return true;
    if (import.meta.env?.DEV) return true;
  } catch (_) {}
  if (typeof location === 'undefined') return false;
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function devWalletAddress() {
  try {
    const w = import.meta.env?.VITE_DEV_WALLET;
    if (w && typeof w === 'string' && w.startsWith('0x') && w.length >= 10) return w;
  } catch (_) {}
  return DEFAULT_DEV_WALLET;
}

// ── public API ─────────────────────────────────────────────────

/** Connect via AGW — opens the Abstract login popup (email/Google/passkeys) */
export async function connectAGW() {
  if (useWalletBypass()) {
    _devBypass = true;
    _privyProvider = null;
    _agwProvider = null;
    _walletClient = null;
    _signerAddress = null;
    _publicClient = null;
    const addr = devWalletAddress();
    _address = addr;
    persist(addr);
    console.log('🐧 AGW dev bypass — no Privy; wallet:', addr);
    return addr;
  }

  _devBypass = false;
  const { toPrivyWalletProvider } = await import('@privy-io/cross-app-connect');

  // 1. Create Privy cross-app provider pointed at Abstract's AGW
  _privyProvider = toPrivyWalletProvider({
    providerAppId: AGW_APP_ID,
    chains: [abstract],
    chainId: abstract.id,
    smartWalletMode: true,
  });

  // 2. Request accounts — this opens the AGW login popup
  await _privyProvider.request({ method: 'eth_requestAccounts' });
  const accounts = await _privyProvider.request({ method: 'eth_accounts' });
  if (!accounts?.length) throw new Error('No accounts returned from AGW');

  _signerAddress = accounts[0]; // EOA from Privy

  // 3. Wrap with AGW's transformEIP1193Provider for smart contract wallet routing
  _agwProvider = transformEIP1193Provider({
    provider: _privyProvider,
    chain: abstract,
    isPrivyCrossApp: true,
  });

  // 4. Get AGW smart contract wallet address
  const agwAccounts = await _agwProvider.request({ method: 'eth_accounts' });
  _address = agwAccounts[0] || _signerAddress;

  // 5. Build viem clients
  _walletClient = createWalletClient({
    account: _address,
    chain: abstract,
    transport: custom(_agwProvider),
  });

  _publicClient = createPublicClient({
    chain: abstract,
    transport: http(),
  });

  persist(_address);
  console.log(`🐧 AGW connected — wallet: ${_address} (signer: ${_signerAddress})`);
  return _address;
}

/** Disconnect (clear local state) */
export function disconnectAGW() {
  if (_privyProvider) {
    try { _privyProvider.request({ method: 'wallet_revokePermissions' }); } catch (_) {}
  }
  _privyProvider = null;
  _agwProvider = null;
  _walletClient = null;
  _publicClient = null;
  _address = null;
  _signerAddress = null;
  _devBypass = false;
  persist(null);
}

/** Get current AGW address (or null) */
export function getAGWAddress() {
  return _address;
}

/** True when using the local dev stub (no on-chain signer) */
export function isDevWalletBypass() {
  return !!_devBypass;
}

/** Get the signer EOA address */
export function getSignerAddress() {
  return _signerAddress;
}

/** Get viem WalletClient (for sending txs) */
export function getWalletClient() {
  return _walletClient;
}

/** Get viem PublicClient (for reads) */
export function getPublicClient() {
  return _publicClient || createPublicClient({ chain: abstract, transport: http() });
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

/** Always true — AGW / dev bypass do not require an injected browser wallet */
export function hasInjectedWallet() {
  return true;
}

// ── re-hydrate from localStorage on load ──────────────────────
const saved = localStorage.getItem('pengu_wallet');
if (saved) {
  _address = saved;
  if (useWalletBypass()) _devBypass = true;
}
