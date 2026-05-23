// ═══════════════════════════════════════════════════════════════
//  ERROR MAPPER — viem/AGW errors → player-friendly text
//
//  Single source of truth for the lowBalance/noLives/sessionDead/
//  user-rejected branches that used to be sprinkled across entry.js,
//  map.js, and game.js. Returns a `{ user, cta }` object so callers
//  can show plain text AND surface a useful next action.
//
//  cta values:
//    'fund'    — wallet out of ETH; show top-up CTA / link to Abstract bridge
//    'retry'   — transient network / nonce issue; user should try again
//    'renew'   — gameplay session expired; trigger re-grant
//    'connect' — wallet client got disconnected; reconnect AGW
//    'abscan'  — give the user a chain link to debug
//    'lives'   — show shop "buy lives" CTA
//    null      — nothing to do (e.g. user cancelled)
// ═══════════════════════════════════════════════════════════════

/// Single regex per failure class, in priority order. First match wins.
const RULES = [
  { rx: /reject|denied|cancel|user (?:rejected|denied)/i,                          out: { user: 'You cancelled the transaction.', cta: null } },
  { rx: /insufficient (?:balance|funds)|out of gas|fee[-_ ]?too[-_ ]?low/i,         out: { user: 'Your AGW wallet is out of ETH on Abstract. Top up to keep playing.', cta: 'fund' } },
  { rx: /paymaster/i,                                                              out: { user: 'Gas sponsorship is unavailable. Top up your AGW wallet to keep playing.', cta: 'fund' } },
  { rx: /nolives|no lives left/i,                                                  out: { user: "You're out of lives. Wait for regen or buy more in the shop.", cta: 'lives' } },
  { rx: /starterpackalreadyclaimed/i,                                              out: { user: 'Starter pack already claimed.', cta: null } },
  { rx: /invalidlevel/i,                                                           out: { user: 'That level isn\'t unlocked yet.', cta: null } },
  { rx: /levelnotstarted/i,                                                        out: { user: 'You need to start this level first.', cta: 'retry' } },
  { rx: /nonce too (?:high|low)|nonce[- ]?(?:gap|sync)/i,                          out: { user: 'Your wallet is out of sync. Refresh and try again.', cta: 'retry' } },
  { rx: /timed?\s*out|timeout|waitfortransactionreceipttimeouterror/i,             out: { user: 'The network is slow right now. Try again in a moment.', cta: 'retry' } },
  { rx: /session.*(expired|exhaust|invalid|revoked|closed|status:\s*unset)|sessionlib|fee[-_ ]?limit/i, out: { user: 'Your gameplay session expired. Sign once to resume.', cta: 'renew' } },
  { rx: /wallet client missing|not connected|reconnect agw|wallet not connected/i, out: { user: 'Wallet disconnected. Tap Connect to reconnect.', cta: 'connect' } },
  { rx: /failed to initialize request/i,                                           out: { user: 'Wallet popup was blocked. Allow popups for this site and try again.', cta: 'retry' } },
];

const FALLBACK = { user: 'Transaction failed. Check the console for details.', cta: 'abscan' };

/**
 * Map a viem / AGW error object to a player-friendly { user, cta } pair.
 * `err` can be an Error instance, a string, or anything stringifiable —
 * never throws.
 */
export function friendlyError(err) {
  const raw = String(err?.shortMessage || err?.message || err || '').toLowerCase();
  for (const rule of RULES) if (rule.rx.test(raw)) return rule.out;
  return FALLBACK;
}

/**
 * Convenience: show an alert with the friendly text. Skips silently when
 * the user cancelled (cta === null and the rule explicitly said so) —
 * that's a no-op, not an error to surface.
 */
export function alertFriendly(err, fallbackTitle) {
  const { user, cta } = friendlyError(err);
  if (/cancelled|cancel/i.test(user) && cta === null) return; // user-initiated
  const tail = fallbackTitle ? `\n\n— ${fallbackTitle}` : '';
  alert(user + tail);
}
