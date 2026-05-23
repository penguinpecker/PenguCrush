// ═══════════════════════════════════════════════════════════════
//  SETUP STATUS — visible feedback during cold-start setup flow
//
//  Injects a fixed-position status banner so the player can see
//  exactly which step is running (connecting wallet, signing message,
//  bootstrap tx in flight, etc.) instead of staring at a frozen
//  screen wondering whether the popup blocker ate something.
//
//  Also surfaces failures with the actual error message so the user
//  can copy/paste it back instead of guessing.
// ═══════════════════════════════════════════════════════════════

const STYLE_ID = 'pengu-setup-status-style';
const HOST_ID = 'pengu-setup-status';

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${HOST_ID} {
      position: fixed;
      left: 50%;
      top: 24px;
      transform: translateX(-50%);
      max-width: min(92vw, 520px);
      padding: 12px 18px;
      background: rgba(20, 40, 80, 0.96);
      color: #fff;
      font-family: Fredoka, system-ui, sans-serif;
      font-size: 15px;
      font-weight: 600;
      border-radius: 14px;
      box-shadow: 0 10px 32px rgba(0,0,0,0.35);
      z-index: 999999;
      display: none;
      line-height: 1.35;
      text-align: center;
      pointer-events: none;
    }
    #${HOST_ID}.visible { display: block; }
    #${HOST_ID}.ok { background: rgba(40, 140, 80, 0.96); }
    #${HOST_ID}.error {
      background: rgba(180, 40, 60, 0.96);
      pointer-events: auto;
      user-select: text;
    }
    #${HOST_ID} .pengu-status-step { opacity: 0.85; font-size: 12px; font-weight: 500; display: block; margin-bottom: 3px; }
    #${HOST_ID} .pengu-status-msg { display: block; }
    #${HOST_ID} .pengu-status-detail { display: block; opacity: 0.85; font-size: 12px; font-weight: 500; margin-top: 4px; word-break: break-word; }
  `;
  document.head.appendChild(style);
}

function ensureHost() {
  ensureStyle();
  let el = document.getElementById(HOST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = HOST_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Show or update the status banner. `step` is the small label (e.g. "Step 2 of 3"),
 * `msg` is the primary message, `detail` is optional secondary text shown below.
 * `tone` is 'info' | 'ok' | 'error'.
 */
export function setupStatus(msg, { step, detail, tone = 'info' } = {}) {
  try {
    const el = ensureHost();
    el.className = 'visible' + (tone === 'ok' ? ' ok' : tone === 'error' ? ' error' : '');
    el.innerHTML = '';
    if (step) {
      const s = document.createElement('span');
      s.className = 'pengu-status-step';
      s.textContent = step;
      el.appendChild(s);
    }
    const m = document.createElement('span');
    m.className = 'pengu-status-msg';
    m.textContent = msg;
    el.appendChild(m);
    if (detail) {
      const d = document.createElement('span');
      d.className = 'pengu-status-detail';
      d.textContent = detail;
      el.appendChild(d);
    }
    console.info('[setup-status]', tone, step || '', msg, detail || '');
  } catch (_) { /* DOM unavailable — fine, console covers it */ }
}

export function hideSetupStatus(afterMs = 0) {
  try {
    const el = document.getElementById(HOST_ID);
    if (!el) return;
    if (afterMs > 0) {
      setTimeout(() => { el.classList.remove('visible'); }, afterMs);
    } else {
      el.classList.remove('visible');
    }
  } catch (_) { /* ignore */ }
}
