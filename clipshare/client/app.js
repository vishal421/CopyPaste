/**
 * ClipShare — Room App (app.js)
 * Handles Socket.IO real-time sync, message-based chat with confidential mode,
 * typing indicators (only shown to OTHER users), QR code sharing.
 */

/* ── Extract roomId from URL /r/:roomId ───────────────────────── */
const roomId = window.location.pathname.split('/r/')[1]?.split('/')[0] || '';
if (!roomId || !/^[a-zA-Z0-9-]{3,32}$/.test(roomId)) {
  window.location.href = '/';
}

/* ── DOM refs ─────────────────────────────────────────────────── */
const messagesEl        = document.getElementById('messages');
const normalInput       = document.getElementById('normalInput');
const confidentialInput = document.getElementById('confidentialInput');
const normalTab         = document.getElementById('tabNormal');
const confidentialTab   = document.getElementById('tabConfidential');
const sendBtn           = document.getElementById('sendBtn');
const charCount         = document.getElementById('charCount');
const usersCount        = document.getElementById('usersCount');
const roomIdDisplay     = document.getElementById('roomIdDisplay');
const liveIndicatorDot  = document.getElementById('liveIndicatorDot');
const liveIndicatorTxt  = document.getElementById('liveIndicatorText');
const infoRoomId        = document.getElementById('infoRoomId');
const infoUsers         = document.getElementById('infoUsers');
const infoStatus        = document.getElementById('infoStatus');
const typingIndicator   = document.getElementById('typingIndicator');
const toast             = document.getElementById('toast');
const clearBtn          = document.getElementById('clearBtn');

/* QR elements */
const qrPanel         = document.getElementById('qrPanel');
const qrToggleBtn     = document.getElementById('qrToggleBtn');
const qrCloseBtn      = document.getElementById('qrCloseBtn');
const qrUrlDisplay    = document.getElementById('qrUrlDisplay');
const fabQrBtn        = document.getElementById('fabQrBtn');
const qrModalOverlay  = document.getElementById('qrModalOverlay');
const qrModalClose    = document.getElementById('qrModalClose');
const qrUrlMobile     = document.getElementById('qrUrlMobile');

/* ── State ────────────────────────────────────────────────────── */
const roomUrl    = `${window.location.origin}/r/${roomId}`;
let mySocketId   = null;
let myLabel      = '';
let myColor      = '#7c6ff7';
let activeTab    = 'normal';   // 'normal' | 'confidential'
let toastTimer   = null;
let qrDesktop    = null;
let qrMobile     = null;
let typingTimer  = null;
let isTyping     = false;
let typingUsers  = new Map(); // label → timeout id

/* ── Init display ─────────────────────────────────────────────── */
if (roomIdDisplay) roomIdDisplay.textContent = roomId;
if (infoRoomId)    infoRoomId.textContent    = roomId;
document.title = `ClipShare — ${roomId}`;

/* ══════════════════════════════════════════════════════════════
   SOCKET.IO
══════════════════════════════════════════════════════════════ */
const socket = io({
  reconnection:         true,
  reconnectionDelay:    1000,
  reconnectionAttempts: 10,
  transports: ['websocket', 'polling'],
});

socket.on('connect', () => {
  console.log('[socket] connected:', socket.id);
  setStatus('connecting', 'Joining room…');
  socket.emit('join-room', roomId, (response) => {
    if (response?.error) {
      setStatus('error', 'Room error');
      showToast('❌ ' + response.error, 'error', 4000);
      return;
    }
    setStatus('live', 'Live');
  });
});

socket.on('disconnect', () => {
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

/* ── Room init: history + identity ───────────────────────────── */
socket.on('room-init', ({ messages, myId, myLabel: label, myColor: color, userCount }) => {
  mySocketId = myId;
  myLabel    = label;
  myColor    = color;

  if (usersCount) usersCount.textContent = userCount;
  if (infoUsers)  infoUsers.textContent  = userCount;

  // Show own label badge
  const badge = document.getElementById('myLabelBadge');
  if (badge) {
    badge.textContent = label;
    badge.style.background = color;
  }
  const myLabelInfo = document.getElementById('myLabelInfo');
  if (myLabelInfo) { myLabelInfo.textContent = label; myLabelInfo.style.color = color; }

  // Render history
  if (messages && messages.length > 0) {
    messagesEl.innerHTML = '';
    messages.forEach(msg => {
      const isMine = msg.senderId === myId;
      renderMessage(msg, isMine ? 'sent' : 'received');
    });
  } else {
    renderWelcome();
  }

  scrollToBottom();
});

/* ── Incoming message (from other user) ──────────────────────── */
socket.on('new-message', (msg) => {
  renderMessage(msg, msg.perspective);
  scrollToBottom();
  if (msg.perspective === 'received') flashMessages();
});

/* ── User count ───────────────────────────────────────────────── */
socket.on('user-count', (count) => {
  if (usersCount) usersCount.textContent = count;
  if (infoUsers)  infoUsers.textContent  = count;
});

/* ── Typing indicators (only received from OTHER users) ──────── */
socket.on('user-typing', ({ label, color }) => {
  // Clear existing timeout for this user
  if (typingUsers.has(label)) clearTimeout(typingUsers.get(label));
  const t = setTimeout(() => {
    typingUsers.delete(label);
    updateTypingDisplay();
  }, 2500);
  typingUsers.set(label, t);
  updateTypingDisplay();
});

socket.on('user-stopped-typing', ({ label }) => {
  if (typingUsers.has(label)) {
    clearTimeout(typingUsers.get(label));
    typingUsers.delete(label);
  }
  updateTypingDisplay();
});

function updateTypingDisplay() {
  if (!typingIndicator) return;
  if (typingUsers.size === 0) {
    typingIndicator.style.display = 'none';
    typingIndicator.textContent   = '';
    return;
  }
  const names = [...typingUsers.keys()];
  typingIndicator.style.display = 'flex';
  typingIndicator.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>${names.join(', ')} is typing…`;
}

/* ── Join/leave notifications ─────────────────────────────────── */
socket.on('user-joined', ({ label, color }) => {
  renderSystemMsg(`${label} joined the room`, color);
});
socket.on('user-left', ({ label }) => {
  renderSystemMsg(`${label} left the room`, '#8b8ba7');
});

/* ── Room cleared ─────────────────────────────────────────────── */
socket.on('room-cleared', () => {
  messagesEl.innerHTML = '';
  renderWelcome();
  showToast('🗑️ Room cleared', 'success');
});

/* ── Error from server ────────────────────────────────────────── */
socket.on('error-msg', (msg) => showToast('❌ ' + msg, 'error', 4000));

/* ══════════════════════════════════════════════════════════════
   TABS (Normal / Confidential)
══════════════════════════════════════════════════════════════ */
function switchTab(tab) {
  activeTab = tab;
  normalTab.classList.toggle('tab-active', tab === 'normal');
  confidentialTab.classList.toggle('tab-active', tab === 'confidential');
  document.getElementById('normalInputWrap').style.display      = tab === 'normal'       ? '' : 'none';
  document.getElementById('confidentialInputWrap').style.display = tab === 'confidential' ? '' : 'none';
  getCurrentInput().focus();
  updateCharDisplay();
}

normalTab.addEventListener('click', () => switchTab('normal'));
confidentialTab.addEventListener('click', () => switchTab('confidential'));

function getCurrentInput() {
  return activeTab === 'normal' ? normalInput : confidentialInput;
}

/* ══════════════════════════════════════════════════════════════
   SEND MESSAGE
══════════════════════════════════════════════════════════════ */
function sendMessage() {
  const input   = getCurrentInput();
  const content = input.value.trim();
  if (!content) return;

  socket.emit('send-message', { type: activeTab, content });
  input.value = '';
  updateCharDisplay();
  stopTyping();
}

sendBtn.addEventListener('click', sendMessage);

[normalInput, confidentialInput].forEach(inp => {
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inp.addEventListener('input', () => {
    updateCharDisplay();
    handleTyping();
  });
});

/* ── Typing emit (throttled) ────────────────────────────────── */
function handleTyping() {
  if (!isTyping) {
    isTyping = true;
    socket.emit('typing-start');
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 1500);
}

function stopTyping() {
  if (isTyping) {
    isTyping = false;
    socket.emit('typing-stop');
  }
  clearTimeout(typingTimer);
}

function updateCharDisplay() {
  const len = getCurrentInput().value.length;
  if (charCount) charCount.textContent = `${len.toLocaleString()} / 100,000`;
}

/* ══════════════════════════════════════════════════════════════
   RENDER MESSAGES
══════════════════════════════════════════════════════════════ */
function renderWelcome() {
  const div = document.createElement('div');
  div.className = 'welcome-msg';
  div.innerHTML = `
    <div class="welcome-icon">💬</div>
    <p>Room <strong>${roomId}</strong> is ready.</p>
    <p>Type a message below and hit <strong>Send</strong> or <strong>Enter</strong>.</p>
  `;
  messagesEl.appendChild(div);
}

function renderSystemMsg(text, color) {
  // Remove welcome if present
  const welcome = messagesEl.querySelector('.welcome-msg');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = 'system-msg';
  div.style.color = color || '#8b8ba7';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function renderMessage(msg, perspective) {
  // Remove welcome placeholder on first real message
  const welcome = messagesEl.querySelector('.welcome-msg');
  if (welcome) welcome.remove();

  const isSent = perspective === 'sent';
  const wrap = document.createElement('div');
  wrap.className = `msg-wrap ${isSent ? 'msg-sent' : 'msg-received'}`;
  wrap.dataset.msgId = msg.id;

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${msg.type === 'confidential' ? 'msg-confidential' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const labelEl = document.createElement('span');
  labelEl.className = 'msg-label';
  labelEl.textContent = isSent ? `${msg.senderLabel} (You)` : msg.senderLabel;
  labelEl.style.color = msg.senderColor || '#7c6ff7';

  const timeEl = document.createElement('span');
  timeEl.className = 'msg-time';
  timeEl.textContent = formatTime(msg.timestamp);
  meta.append(labelEl, timeEl);

  const contentEl = document.createElement('div');
  contentEl.className = 'msg-content';

  if (msg.type === 'confidential') {
    // Lock icon header
    const lockBadge = document.createElement('div');
    lockBadge.className = 'confidential-badge';
    lockBadge.innerHTML = `🔒 Confidential`;
    bubble.appendChild(lockBadge);

    if (isSent) {
      // Sender always sees their own content
      contentEl.textContent = msg.content;
    } else {
      // Receiver: show masked by default, toggle to reveal
      const maskedEl  = document.createElement('span');
      maskedEl.className = 'masked-text';
      maskedEl.textContent = '••••••••••••••••';

      const realEl    = document.createElement('span');
      realEl.className = 'real-text hidden';
      realEl.textContent = msg.maskedContent || msg.content;

      const revealBtn = document.createElement('button');
      revealBtn.className = 'btn-reveal';
      revealBtn.textContent = '👁 Reveal';
      revealBtn.addEventListener('click', () => {
        const isHidden = realEl.classList.contains('hidden');
        realEl.classList.toggle('hidden', !isHidden);
        maskedEl.classList.toggle('hidden', isHidden);
        revealBtn.textContent = isHidden ? '🙈 Hide' : '👁 Reveal';
      });

      contentEl.append(maskedEl, realEl);
      bubble.appendChild(contentEl);
      bubble.appendChild(revealBtn);
    }
  }

  if (msg.type !== 'confidential' || isSent) {
    contentEl.textContent = msg.content;
    bubble.appendChild(contentEl);
  }

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-copy-btn';
  copyBtn.title = 'Copy';
  copyBtn.innerHTML = '📋';
  copyBtn.addEventListener('click', async () => {
    const textToCopy = msg.maskedContent || msg.content;
    try {
      await navigator.clipboard.writeText(textToCopy);
      showToast('✅ Copied!', 'success');
    } catch {
      showToast('❌ Copy failed', 'error');
    }
  });

  bubble.prepend(meta);
  wrap.appendChild(bubble);
  wrap.appendChild(copyBtn);
  messagesEl.appendChild(wrap);
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom() {
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function flashMessages() {
  messagesEl.classList.remove('flash-update');
  void messagesEl.offsetWidth;
  messagesEl.classList.add('flash-update');
  setTimeout(() => messagesEl.classList.remove('flash-update'), 500);
}

/* ── CLEAR ────────────────────────────────────────────────────── */
if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear all messages for everyone in this room?')) return;
    socket.emit('clear-room');
  });
}

/* ══════════════════════════════════════════════════════════════
   QR CODE
══════════════════════════════════════════════════════════════ */
function buildQR(containerId, size) {
  const el = document.getElementById(containerId);
  if (!el) return null;
  el.innerHTML = '';
  try {
    return new QRCode(el, {
      text:         roomUrl,
      width:        size,
      height:       size,
      colorDark:    '#000000',
      colorLight:   '#ffffff',
      correctLevel: QRCode.CorrectLevel.H,
    });
  } catch (err) {
    el.textContent = 'QR unavailable';
    return null;
  }
}

if (qrUrlDisplay) qrUrlDisplay.textContent = roomUrl;
if (qrUrlMobile)  qrUrlMobile.textContent  = roomUrl;

qrDesktop = buildQR('qrcode', 200);

if (qrToggleBtn) {
  qrToggleBtn.addEventListener('click', () => {
    qrPanel.style.display = qrPanel.style.display === 'none' ? '' : 'none';
  });
}
if (qrCloseBtn) {
  qrCloseBtn.addEventListener('click', () => { qrPanel.style.display = 'none'; });
}
if (fabQrBtn) {
  fabQrBtn.addEventListener('click', () => {
    qrModalOverlay.classList.add('open');
    if (!qrMobile) qrMobile = buildQR('qrcodeMobile', 220);
  });
}
if (qrModalClose) {
  qrModalClose.addEventListener('click', () => qrModalOverlay.classList.remove('open'));
}
if (qrModalOverlay) {
  qrModalOverlay.addEventListener('click', (e) => {
    if (e.target === qrModalOverlay) qrModalOverlay.classList.remove('open');
  });
}

/* ── COPY LINK ────────────────────────────────────────────────── */
async function copyRoomLink() {
  try {
    await navigator.clipboard.writeText(roomUrl);
    showToast('🔗 Room link copied!', 'success');
  } catch {
    showToast('❌ Could not copy link', 'error');
  }
}

document.getElementById('copyLinkBtn')?.addEventListener('click', copyRoomLink);
document.getElementById('copyRoomLinkBtn')?.addEventListener('click', copyRoomLink);
document.getElementById('copyRoomLinkMobile')?.addEventListener('click', copyRoomLink);

/* ── STATUS & TOAST ────────────────────────────────────────────── */
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

function showToast(message, type = 'success', duration = 2200) {
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className   = `toast show ${type}`;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, duration);
}

/* ── Init tab ─────────────────────────────────────────────────── */
switchTab('normal');
normalInput.focus();
