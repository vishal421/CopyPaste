/**
 * ClipShare — Room App (app.js)
 * Handles Socket.IO real-time sync, QR code, copy, UI state
 */

/* ── Extract roomId from URL /r/:roomId ─────────────────────────── */
const roomId = window.location.pathname.split('/r/')[1]?.split('/')[0] || '';

if (!roomId || !/^[a-zA-Z0-9-]{3,32}$/.test(roomId)) {
  window.location.href = '/';
}

/* ── DOM refs ─────────────────────────────────────────────────────── */
const textarea         = document.getElementById('sharedTextarea');
const charCount        = document.getElementById('charCount');
const usersCount       = document.getElementById('usersCount');
const roomIdDisplay    = document.getElementById('roomIdDisplay');
const liveIndicatorDot = document.getElementById('liveIndicatorDot');
const liveIndicatorTxt = document.getElementById('liveIndicatorText');
const infoRoomId       = document.getElementById('infoRoomId');
const infoUsers        = document.getElementById('infoUsers');
const infoStatus       = document.getElementById('infoStatus');
const infoChars        = document.getElementById('infoChars');
const toast            = document.getElementById('toast');

/* QR elements */
const qrPanel          = document.getElementById('qrPanel');
const qrToggleBtn      = document.getElementById('qrToggleBtn');
const qrCloseBtn       = document.getElementById('qrCloseBtn');
const qrUrlDisplay     = document.getElementById('qrUrlDisplay');
const fabQrBtn         = document.getElementById('fabQrBtn');
const qrModalOverlay   = document.getElementById('qrModalOverlay');
const qrModalClose     = document.getElementById('qrModalClose');
const qrUrlMobile      = document.getElementById('qrUrlMobile');

/* ── State ────────────────────────────────────────────────────────── */
const roomUrl      = `${window.location.origin}/r/${roomId}`;
let isRemoteUpdate = false;   // suppress local emit when applying remote text
let toastTimer     = null;
let qrDesktop      = null;    // QRCode instance
let qrMobile       = null;    // QRCode instance (mobile modal)

/* ── Init display ────────────────────────────────────────────────── */
if (roomIdDisplay)   roomIdDisplay.textContent = roomId;
if (infoRoomId)      infoRoomId.textContent    = roomId;
document.title = `ClipShare — ${roomId}`;

/* ══════════════════════════════════════════════════════════════════
   SOCKET.IO CONNECTION
══════════════════════════════════════════════════════════════════ */
const socket = io({
  reconnection:        true,
  reconnectionDelay:   1000,
  reconnectionAttempts: 10,
  transports: ['websocket', 'polling'],
});

/* ── Connection events ────────────────────────────────────────────── */
socket.on('connect', () => {
  console.log('[socket] connected:', socket.id);
  setStatus('connecting', 'Joining room…');

  // Join the room
  socket.emit('join-room', roomId, (response) => {
    if (response?.error) {
      setStatus('error', 'Room error');
      showToast('❌ ' + response.error, 'error', 4000);
      return;
    }
    setStatus('live', 'Live');
    // Server sends 'text-update' on join — handled below
  });
});

socket.on('disconnect', (reason) => {
  console.log('[socket] disconnected:', reason);
  setStatus('error', 'Disconnected');
  showToast('⚠️ Connection lost. Reconnecting…', 'error', 3000);
});

socket.on('reconnect', () => {
  setStatus('live', 'Reconnected');
  showToast('✅ Reconnected', 'success');
});

socket.on('connect_error', (err) => {
  console.error('[socket] connect error:', err.message);
  setStatus('error', 'Connection failed');
});

/* ── Text update from server (another user typed) ─────────────────── */
socket.on('text-update', (text) => {
  isRemoteUpdate = true;
  textarea.value = text;
  isRemoteUpdate = false;
  updateCharCount(text);
  flashTextarea();
});

/* ── User count update ────────────────────────────────────────────── */
socket.on('user-count', (count) => {
  if (usersCount) usersCount.textContent = count;
  if (infoUsers)  infoUsers.textContent  = count;
});

/* ── Error message from server ────────────────────────────────────── */
socket.on('error-msg', (msg) => {
  showToast('❌ ' + msg, 'error', 4000);
});

/* ══════════════════════════════════════════════════════════════════
   TEXTAREA — DEBOUNCED EMIT
══════════════════════════════════════════════════════════════════ */
let debounceTimer = null;
const DEBOUNCE_MS = 120; // wait ms after last keystroke before emitting

textarea.addEventListener('input', () => {
  if (isRemoteUpdate) return;  // don't emit what we just received
  const text = textarea.value;
  updateCharCount(text);

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    socket.emit('text-change', { text });
  }, DEBOUNCE_MS);
});

/* Prevent tab from losing focus — insert a tab character instead */
textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = textarea.selectionStart;
    const end   = textarea.selectionEnd;
    textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 2;
    // emit immediately on tab
    socket.emit('text-change', { text: textarea.value });
  }
});

/* ══════════════════════════════════════════════════════════════════
   COPY BUTTON
══════════════════════════════════════════════════════════════════ */
document.getElementById('copyBtn').addEventListener('click', async () => {
  const text = textarea.value;
  if (!text.trim()) {
    showToast('📭 Nothing to copy yet', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('✅ Copied to clipboard!', 'success');
  } catch {
    // Fallback for older browsers / non-secure context
    textarea.select();
    document.execCommand('copy');
    showToast('✅ Copied!', 'success');
  }
});

/* ── CLEAR BUTTON ────────────────────────────────────────────────── */
document.getElementById('clearBtn').addEventListener('click', () => {
  if (!textarea.value) return;
  if (!confirm('Clear all text for everyone in this room?')) return;
  textarea.value = '';
  updateCharCount('');
  socket.emit('text-change', { text: '' });
  showToast('🗑️ Cleared', 'success');
});

/* ── COPY LINK BUTTON (nav) ───────────────────────────────────────── */
const copyLinkBtn = document.getElementById('copyLinkBtn');
if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', () => copyRoomLink());
}

async function copyRoomLink() {
  try {
    await navigator.clipboard.writeText(roomUrl);
    showToast('🔗 Room link copied!', 'success');
  } catch {
    showToast('❌ Could not copy link', 'error');
  }
}

/* Copy room link buttons in QR panels */
document.getElementById('copyRoomLinkBtn')?.addEventListener('click', copyRoomLink);
document.getElementById('copyRoomLinkMobile')?.addEventListener('click', copyRoomLink);

/* ══════════════════════════════════════════════════════════════════
   QR CODE
══════════════════════════════════════════════════════════════════ */
function buildQR(containerId, size) {
  const el = document.getElementById(containerId);
  if (!el) return null;
  el.innerHTML = ''; // clear previous
  try {
    return new QRCode(el, {
      text:          roomUrl,
      width:         size,
      height:        size,
      colorDark:     '#000000',
      colorLight:    '#ffffff',
      correctLevel:  QRCode.CorrectLevel.H,
    });
  } catch (err) {
    console.error('QRCode error:', err);
    el.textContent = 'QR unavailable';
    return null;
  }
}

/* Set URL display text */
if (qrUrlDisplay)  qrUrlDisplay.textContent  = roomUrl;
if (qrUrlMobile)   qrUrlMobile.textContent   = roomUrl;

/* ── Desktop sidebar QR (toggle) ─────────────────────────────────── */
// Build QR immediately for desktop
qrDesktop = buildQR('qrcode', 200);

if (qrToggleBtn) {
  qrToggleBtn.addEventListener('click', () => {
    const isVisible = qrPanel.style.display !== 'none';
    qrPanel.style.display = isVisible ? 'none' : '';
  });
}
if (qrCloseBtn) {
  qrCloseBtn.addEventListener('click', () => {
    qrPanel.style.display = 'none';
  });
}

/* ── Mobile FAB → Modal ───────────────────────────────────────────── */
if (fabQrBtn) {
  fabQrBtn.addEventListener('click', () => {
    qrModalOverlay.classList.add('open');
    if (!qrMobile) {
      qrMobile = buildQR('qrcodeMobile', 220);
    }
  });
}
if (qrModalClose) {
  qrModalClose.addEventListener('click', () => {
    qrModalOverlay.classList.remove('open');
  });
}
// Close modal on backdrop click
if (qrModalOverlay) {
  qrModalOverlay.addEventListener('click', (e) => {
    if (e.target === qrModalOverlay) qrModalOverlay.classList.remove('open');
  });
}

/* ══════════════════════════════════════════════════════════════════
   HELPER FUNCTIONS
══════════════════════════════════════════════════════════════════ */

/** Update character count display */
function updateCharCount(text) {
  const len = text.length;
  if (charCount) charCount.textContent = `${len.toLocaleString()} character${len !== 1 ? 's' : ''}`;
  if (infoChars) infoChars.textContent  = len.toLocaleString();
}

/** Set the live status indicator */
function setStatus(state, label) {
  if (!liveIndicatorDot || !liveIndicatorTxt) return;
  liveIndicatorDot.className = 'pulse-dot';
  if (state === 'live') {
    liveIndicatorDot.classList.add('live');
    if (infoStatus) { infoStatus.textContent = '● Live'; infoStatus.style.color = '#22c55e'; }
  } else if (state === 'error') {
    liveIndicatorDot.classList.add('error');
    if (infoStatus) { infoStatus.textContent = '● Offline'; infoStatus.style.color = '#ef4444'; }
  } else {
    if (infoStatus) { infoStatus.textContent = '● Connecting…'; infoStatus.style.color = '#f59e0b'; }
  }
  liveIndicatorTxt.textContent = label;
}

/** Flash textarea on remote update (subtle visual cue) */
function flashTextarea() {
  textarea.classList.remove('flash-update');
  void textarea.offsetWidth; // force reflow
  textarea.classList.add('flash-update');
  setTimeout(() => textarea.classList.remove('flash-update'), 500);
}

/** Show toast notification */
function showToast(message, type = 'success', duration = 2200) {
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className   = `toast show ${type}`;
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, duration);
}

/* ── Focus textarea on load ──────────────────────────────────────── */
textarea.focus();
