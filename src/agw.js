// ═══════════════════════════════════════════════════════════════
//  AGW — Abstract Global Wallet integration (vanilla JS)
//
//  Uses @abstract-foundation/agw-client to wrap an injected
//  EIP-1193 provider (MetaMask, Rabby, etc.) so transactions
//  route through the user's AGW smart contract wallet.
// ═══════════════════════════════════════════════════════════════
import { transformEIP1193Provider } from '@abstract-foundation/agw-client';
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import { abstract } from 'viem/chains';

let _agwProvider = null;   // wrapped EIP-1193 provider
let _walletClient = null;  // viem WalletClient
let _publicClient = null;  // viem PublicClient
let _address = null;       // AGW smart contract wallet address
let _signerAddress = null; // underlying EOA address

// ── helpers ────────────────────────────────────────────────────
function persist(addr) {
  if (addr) localStorage.setItem('pengu_wallet', addr);
  else localStorage.removeItem('pengu_wallet');
}

// ── public API ─────────────────────────────────────────────────

/** true when an injected provider exists */
export function hasInjectedWallet() {
  return typeof window !== 'undefined' && !!window.ethereum;
}

/** Connect via AGW — returns the smart-contract wallet address */
export async function connectAGW() {
  if (!window.ethereum) throw new Error('No wallet detected. Install MetaMask or another browser wallet.');

  // Wrap the injected provider with AGW
  _agwProvider = transformEIP1193Provider({
    provider: window.ethereum,
    chain: abstract,
  });

  // Request accounts (triggers MetaMask popup)
  const accounts = await _agwProvider.request({ method: 'eth_requestAccounts' });
  if (!accounts?.length) throw new Error('No accounts returned');

  _address = accounts[0];       // AGW smart contract wallet
  _signerAddress = accounts[1]; // underlying EOA

  // Build viem clients
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
  _agwProvider = null;
  _walletClient = null;
  _publicClient = null;
  _address = null;
  _signerAddress = null;
  persist(null);
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

// ── re-hydrate from localStorage on load ──────────────────────
// (just the address — actual provider reconnects on next connectAGW call)
const saved = localStorage.getItem('pengu_wallet');
if (saved) _address = saved;
