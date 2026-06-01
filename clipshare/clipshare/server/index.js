/**
 * ClipShare — Real-time Clipboard Sharing Server
 * Express + Socket.IO backend with room management
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const rateLimit  = require('express-rate-limit');
const crypto     = require('crypto');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const MAX_ROOMS   = 1000;          // safety cap
const MAX_TEXT    = 100_000;       // chars per room (~100 KB)
const ROOM_TTL    = 24 * 60 * 60 * 1000; // auto-cleanup idle rooms after 24 h

// ─── APP SETUP ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// ─── IN-MEMORY ROOM STORE ──────────────────────────────────────────────────
// rooms = Map<roomId, { text: string, users: Set<socketId>, lastActivity: Date }>
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    if (rooms.size >= MAX_ROOMS) {
      throw new Error('Server room limit reached. Try again later.');
    }
    rooms.set(roomId, {
      text:         '',
      users:        new Set(),
      lastActivity: Date.now(),
    });
  }
  return rooms.get(roomId);
}

function deleteRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (room && room.users.size === 0) {
    rooms.delete(roomId);
    console.log(`[room] deleted empty room: ${roomId} | active rooms: ${rooms.size}`);
  }
}

// Periodic cleanup of idle rooms (no users but somehow not deleted)
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.users.size === 0 || now - room.lastActivity > ROOM_TTL) {
      rooms.delete(id);
      console.log(`[cleanup] removed idle room: ${id}`);
    }
  }
}, 60 * 60 * 1000); // run every hour

// ─── HTTP RATE LIMITING ────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max:      120,          // 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use(limiter);

// ─── STATIC FILES ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../client')));

// ─── ROUTES ────────────────────────────────────────────────────────────────

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Room page — any /r/:roomId route serves the room UI
app.get('/r/:roomId', (req, res) => {
  const { roomId } = req.params;
  // Basic validation: alphanumeric + hyphens, 3–32 chars
  if (!/^[a-zA-Z0-9-]{3,32}$/.test(roomId)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, '../client/room.html'));
});

// API: Create a new random room and redirect
app.get('/create-room', (req, res) => {
  const roomId = crypto.randomBytes(4).toString('hex'); // e.g. "a3f9c21b"
  res.json({ roomId, url: `/r/${roomId}` });
});

// API: Room stats (optional — for debugging)
app.get('/api/stats', (req, res) => {
  res.json({
    activeRooms: rooms.size,
    totalUsers:  [...rooms.values()].reduce((n, r) => n + r.users.size, 0),
  });
});

// Catch-all: redirect unknown paths to home
app.use((req, res) => res.redirect('/'));

// ─── SOCKET.IO ─────────────────────────────────────────────────────────────
// Per-socket text-change debounce tracking
const socketLastEmit = new Map(); // socketId → timestamp
const DEBOUNCE_MS    = 50;        // min ms between accepted text-change events

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);
  let currentRoom = null;

  // ── JOIN ROOM ────────────────────────────────────────────────────────────
  socket.on('join-room', (roomId, callback) => {
    try {
      // Validate roomId
      if (typeof roomId !== 'string' || !/^[a-zA-Z0-9-]{3,32}$/.test(roomId)) {
        return callback?.({ error: 'Invalid room ID.' });
      }

      // Leave previous room if reconnecting
      if (currentRoom) {
        leaveRoom(socket, currentRoom);
      }

      currentRoom = roomId;
      const room = getOrCreateRoom(roomId);

      room.users.add(socket.id);
      room.lastActivity = Date.now();
      socket.join(roomId);

      console.log(`[room] ${socket.id} joined room: ${roomId} | users: ${room.users.size}`);

      // Send current text to the newly joined user
      socket.emit('text-update', room.text);

      // Broadcast updated user count to everyone in room
      io.to(roomId).emit('user-count', room.users.size);

      callback?.({ success: true, text: room.text, userCount: room.users.size });

    } catch (err) {
      console.error('[join-room] error:', err.message);
      callback?.({ error: err.message });
    }
  });

  // ── TEXT CHANGE (from client typing) ────────────────────────────────────
  socket.on('text-change', (data) => {
    if (!currentRoom) return;

    // Server-side rate limit per socket
    const now  = Date.now();
    const last = socketLastEmit.get(socket.id) || 0;
    if (now - last < DEBOUNCE_MS) return; // drop too-rapid events
    socketLastEmit.set(socket.id, now);

    const room = rooms.get(currentRoom);
    if (!room) return;

    // Validate payload
    if (typeof data?.text !== 'string') return;
    if (data.text.length > MAX_TEXT) {
      socket.emit('error-msg', `Text exceeds maximum limit of ${MAX_TEXT.toLocaleString()} characters.`);
      return;
    }

    room.text         = data.text;
    room.lastActivity = now;

    // Broadcast to all OTHER users in the room (not back to sender)
    socket.to(currentRoom).emit('text-update', room.text);
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[socket] disconnected: ${socket.id} reason: ${reason}`);
    socketLastEmit.delete(socket.id);
    if (currentRoom) leaveRoom(socket, currentRoom);
  });

  // ── HELPER: leave a room cleanly ────────────────────────────────────────
  function leaveRoom(sock, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.users.delete(sock.id);
    console.log(`[room] ${sock.id} left room: ${roomId} | users: ${room.users.size}`);

    if (room.users.size > 0) {
      // Notify remaining users of new count
      io.to(roomId).emit('user-count', room.users.size);
    } else {
      // Schedule deletion to allow brief reconnects
      setTimeout(() => deleteRoomIfEmpty(roomId), 5000);
    }
  }
});

// ─── START SERVER ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 ClipShare running on http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('\nSIGINT received — shutting down gracefully');
  server.close(() => process.exit(0));
});
