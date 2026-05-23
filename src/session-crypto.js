// ═══════════════════════════════════════════════════════════════
//  SESSION-BLOB ENCRYPTION
//
//  Wraps the session-key blob in AES-GCM (WebCrypto, 256-bit) before
//  putting it in localStorage. The key itself is kept in localStorage
//  too, so this is NOT a defense against a determined attacker who
//  can read arbitrary LS keys — but it does protect against:
//
//    • Browser extensions / DOM-scrapers that grep for 0x-prefixed
//      64-char hex strings (private-key shape) inside LS values
//    • Crash / error reporting tools that dump LS verbatim
//    • Casual inspection in DevTools (the blob is base64 noise)
//
//  This is the same trade-off Abstract-Foundation's canonical
//  session-keys-local-storage example takes. If the encryption key
//  ever needs to be re-derivable from a wallet signature instead of
//  stored raw, the API surface is small enough to swap without
//  touching callers.
// ═══════════════════════════════════════════════════════════════

const KEY_PREFIX = 'pengu_enc_';

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

async function getOrCreateKey(address) {
  const slot = KEY_PREFIX + address.toLowerCase();
  const existing = localStorage.getItem(slot);
  if (existing) {
    try {
      const raw = hexToBytes(existing);
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    } catch (_) {
      // Stored key is corrupt — discard and regenerate. Any blobs encrypted
      // with the old key are lost, which forces a fresh session grant. Fine.
      localStorage.removeItem(slot);
    }
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  localStorage.setItem(slot, bytesToHex(raw));
  return key;
}

/**
 * Encrypt a JSON-serialisable object for the given address. Returns a
 * compact string of the form `v1:<ivHex>:<ciphertextHex>` so a future
 * version bump can be detected and migrated.
 */
export async function encryptForAddress(plain, address) {
  if (!address) throw new Error('encryptForAddress: address required');
  const key = await getOrCreateKey(address);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(plain));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return 'v1:' + bytesToHex(iv) + ':' + bytesToHex(ciphertext);
}

/**
 * Decrypt a string produced by `encryptForAddress`. Returns null if the
 * payload doesn't parse, the version doesn't match, or AES-GCM
 * authentication fails — never throws. Callers treat null as "no
 * session" (forces a re-grant), which is the desired failure mode.
 */
export async function decryptForAddress(blob, address) {
  if (!blob || !address) return null;
  try {
    const parts = String(blob).split(':');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const iv = hexToBytes(parts[1]);
    const ct = hexToBytes(parts[2]);
    const key = await getOrCreateKey(address);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (_) {
    return null;
  }
}

/**
 * Drop the per-wallet encryption key (used on disconnect so a future
 * session under the same wallet gets fresh crypto material).
 */
export function clearEncryptionKey(address) {
  if (!address) return;
  localStorage.removeItem(KEY_PREFIX + address.toLowerCase());
}
