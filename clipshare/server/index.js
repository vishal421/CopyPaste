/**
 * ClipShare — Real-time Clipboard Sharing Server
 * Express + Socket.IO backend with room management
 * Features: per-user send, confidential mode, typing indicators
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const rateLimit  = require('express-rate-limit');
const crypto     = require('crypto');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PORT      = process.env.PORT || 3000;
const MAX_ROOMS = 1000;
const MAX_TEXT  = 100_000;
const ROOM_TTL  = 24 * 60 * 60 * 1000;

// ─── APP SETUP ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// ─── IN-MEMORY ROOM STORE ──────────────────────────────────────────────────
// rooms = Map<roomId, { messages: [], users: Map<socketId, {label, color}>, lastActivity }>
const rooms = new Map();

// User colour palette for visual distinction
const USER_COLORS = ['#7c6ff7','#22c55e','#f59e0b','#ef4444','#38bdf8','#e879f9'];

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    if (rooms.size >= MAX_ROOMS) throw new Error('Server room limit reached. Try again later.');
    rooms.set(roomId, {
      messages:     [],    // [{senderId, senderLabel, senderColor, type, content, timestamp}]
      users:        new Map(), // socketId → {label, color, joinIndex}
      nextUserIdx:  0,
      lastActivity: Date.now(),
    });
  }
  return rooms.get(roomId);
}

function deleteRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (room && room.users.size === 0) {
    rooms.delete(roomId);
    console.log(`[room] deleted empty room: ${roomId} | active: ${rooms.size}`);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.users.size === 0 || now - room.lastActivity > ROOM_TTL) {
      rooms.delete(id);
      console.log(`[cleanup] removed idle room: ${id}`);
    }
  }
}, 60 * 60 * 1000);

// ─── HTTP RATE LIMITING ────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use(limiter);

// ─── STATIC FILES ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../client')));

// ─── ROUTES ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../client/index.html')));

app.get('/r/:roomId', (req, res) => {
  const { roomId } = req.params;
  if (!/^[a-zA-Z0-9-]{3,32}$/.test(roomId)) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../client/room.html'));
});

app.get('/create-room', (req, res) => {
  const roomId = crypto.randomBytes(4).toString('hex');
  res.json({ roomId, url: `/r/${roomId}` });
});

app.get('/api/stats', (req, res) => {
  res.json({
    activeRooms: rooms.size,
    totalUsers: [...rooms.values()].reduce((n, r) => n + r.users.size, 0),
  });
});

app.use((req, res) => res.redirect('/'));

// ─── SOCKET.IO ─────────────────────────────────────────────────────────────
const socketLastEmit = new Map();
const DEBOUNCE_MS    = 50;

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);
  let currentRoom = null;

  // ── JOIN ROOM ──────────────────────────────────────────────────────────
  socket.on('join-room', (roomId, callback) => {
    try {
      if (typeof roomId !== 'string' || !/^[a-zA-Z0-9-]{3,32}$/.test(roomId)) {
        return callback?.({ error: 'Invalid room ID.' });
      }
      if (currentRoom) leaveRoom(socket, currentRoom);

      currentRoom = roomId;
      const room  = getOrCreateRoom(roomId);

      // Assign a user label and color
      const joinIndex = room.nextUserIdx++;
      const userLabel = `User ${String.fromCharCode(65 + (joinIndex % 26))}`; // User A, B, C…
      const userColor = USER_COLORS[joinIndex % USER_COLORS.length];
      room.users.set(socket.id, { label: userLabel, color: userColor, joinIndex });
      room.lastActivity = Date.now();
      socket.join(roomId);

      console.log(`[room] ${socket.id} (${userLabel}) joined: ${roomId} | users: ${room.users.size}`);

      // Send message history + own identity to new user
      socket.emit('room-init', {
        messages:  room.messages,
        myId:      socket.id,
        myLabel:   userLabel,
        myColor:   userColor,
        userCount: room.users.size,
      });

      // Notify all in room of new user count
      io.to(roomId).emit('user-count', room.users.size);

      // Broadcast join notification to OTHERS
      socket.to(roomId).emit('user-joined', { label: userLabel, color: userColor });

      callback?.({ success: true, userCount: room.users.size });
    } catch (err) {
      console.error('[join-room] error:', err.message);
      callback?.({ error: err.message });
    }
  });

  // ── SEND MESSAGE ───────────────────────────────────────────────────────
  // type: 'text' | 'confidential'
  // For confidential: server stores the real content, but broadcasts masked to others
  socket.on('send-message', (data) => {
    if (!currentRoom) return;

    const now  = Date.now();
    const last = socketLastEmit.get(socket.id) || 0;
    if (now - last < DEBOUNCE_MS) return;
    socketLastEmit.set(socket.id, now);

    const room = rooms.get(currentRoom);
    if (!room) return;
    if (typeof data?.content !== 'string') return;
    if (data.content.length > MAX_TEXT) {
      socket.emit('error-msg', `Text exceeds limit of ${MAX_TEXT.toLocaleString()} characters.`);
      return;
    }
    if (!['text','confidential'].includes(data.type)) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    const message = {
      id:          crypto.randomBytes(6).toString('hex'),
      senderId:    socket.id,
      senderLabel: user.label,
      senderColor: user.color,
      type:        data.type,
      content:     data.content,   // real content
      timestamp:   now,
    };

    room.messages.push(message);
    room.lastActivity = now;

    // Keep last 200 messages in memory
    if (room.messages.length > 200) room.messages.shift();

    // ── Broadcast ──
    // Sender gets their own message with real content (type='sent')
    socket.emit('new-message', { ...message, perspective: 'sent' });

    // Others get it — confidential content is masked
    const forOthers = {
      ...message,
      perspective: 'received',
      content: data.type === 'confidential'
        ? '••••••••••••' // masked; recipient reveals with button
        : data.content,
      maskedContent: data.type === 'confidential' ? data.content : null,
    };
    socket.to(currentRoom).emit('new-message', forOthers);
  });

  // ── TYPING INDICATOR ───────────────────────────────────────────────────
  // Only broadcast to OTHERS, not back to sender
  socket.on('typing-start', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    socket.to(currentRoom).emit('user-typing', { label: user.label, color: user.color });
  });

  socket.on('typing-stop', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    socket.to(currentRoom).emit('user-stopped-typing', { label: user.label });
  });

  // ── CLEAR ALL ─────────────────────────────────────────────────────────
  socket.on('clear-room', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.messages = [];
    io.to(currentRoom).emit('room-cleared');
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[socket] disconnected: ${socket.id} reason: ${reason}`);
    socketLastEmit.delete(socket.id);
    if (currentRoom) leaveRoom(socket, currentRoom);
  });

  function leaveRoom(sock, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users.get(sock.id);
    room.users.delete(sock.id);
    console.log(`[room] ${sock.id} left room: ${roomId} | users: ${room.users.size}`);
    if (room.users.size > 0) {
      io.to(roomId).emit('user-count', room.users.size);
      if (user) socket.to(roomId).emit('user-left', { label: user.label });
    } else {
      setTimeout(() => deleteRoomIfEmpty(roomId), 5000);
    }
  }
});

// ─── START ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 ClipShare running on http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop\n`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
