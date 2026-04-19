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
let _address = null;        // AGW smart contract wallet address
let _signerAddress = null;  // underlying EOA address

const SIGNIN_KEY = 'pengu_siwe';
const SIGNIN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// ── helpers ────────────────────────────────────────────────────
function persist(addr) {
  if (addr) localStorage.setItem('pengu_wallet', addr);
  else localStorage.removeItem('pengu_wallet');
}

function clearSignIn() { localStorage.removeItem(SIGNIN_KEY); }

function buildSignInMessage(addr) {
  const nonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const issuedAt = new Date().toISOString();
  return {
    nonce,
    issuedAt,
    text:
      'Welcome to PenguCrush!\n\n' +
      'Sign this message to verify you control this wallet. ' +
      'This is off-chain and costs no gas.\n\n' +
      `Wallet: ${addr}\n` +
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
  return _privyProvider;
}

/** Connect via AGW — opens the Abstract login popup (email/Google/passkeys) */
export async function connectAGW() {
  if (_walletClient && _address) return _address; // idempotent

  // 1. Ensure Privy cross-app provider exists pointed at Abstract's AGW
  const privy = ensurePrivyProvider();

  // 2. Request accounts — this opens the AGW login popup (must be synchronous from user gesture)
  await privy.request({ method: 'eth_requestAccounts' });
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

/** Always true — AGW cross-app popup does not require an injected browser wallet */
export function hasInjectedWallet() {
  return true;
}

// ── re-hydrate address from localStorage on load ──────────────
// (Wallet client is NOT restored; user must reconnect to sign/transact.
//  But isSignedIn() can still be true if a valid signature is cached.)
const saved = localStorage.getItem('pengu_wallet');
if (saved) _address = saved;
