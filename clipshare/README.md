# ClipShare — Real-time Copy-Paste Sharing Tool

A production-ready real-time clipboard sharing web app built with Node.js, Express, and Socket.IO.

---

## Features

- **Real-time text sync** — changes appear instantly on all connected devices
- **QR Code invite** — scan to join a room from any phone
- **Room management** — auto-create, auto-delete when empty
- **Mobile responsive** — works perfectly on all screen sizes
- **No signup required** — just create a room and share the link
- **Rate limiting** — built-in protection against spam
- **Dark theme UI** — clean, modern interface

---

## Project Structure

```
clipshare/
├── server/
│   └── index.js          ← Express + Socket.IO backend
├── client/
│   ├── index.html        ← Landing page (SEO optimized)
│   ├── room.html         ← Room / editor page
│   ├── app.js            ← Client-side JS (Socket.IO, QR, copy)
│   └── style.css         ← Global dark theme CSS
└── package.json
```

---

## Quick Start (Local)

### 1. Install dependencies

```bash
npm install
```

### 2. Start the server

```bash
npm start
```

Open your browser at: **http://localhost:3000**

### 3. Change the port (optional)

```bash
PORT=8080 npm start
```

Or set it in a `.env` file (requires `dotenv` package):
```
PORT=8080
```

---

## How It Works

1. Visit `/` → click **Start Sharing** → a unique room is created
2. Share the room URL (`/r/abc123`) or click **QR** to show a scannable QR code
3. All users in the same room see live text updates as you type
4. Click **Copy All** to copy the entire shared text to clipboard
5. Room is automatically deleted when all users disconnect

---

## Socket.IO Events

| Event         | Direction         | Description                            |
|--------------|-------------------|----------------------------------------|
| `join-room`  | Client → Server   | Join a room by ID                      |
| `text-change`| Client → Server   | User typed/pasted — send new text      |
| `text-update`| Server → Client   | Broadcast updated text to other users  |
| `user-count` | Server → Client   | Updated number of users in room        |
| `error-msg`  | Server → Client   | Error notification (e.g. text too long)|

---

## Production Deployment

### Option 1: Run with PM2 (recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start the app
pm2 start server/index.js --name clipshare

# Auto-restart on reboot
pm2 startup
pm2 save

# Useful PM2 commands
pm2 status          # check status
pm2 logs clipshare  # view logs
pm2 restart clipshare
pm2 stop clipshare
```

### Option 2: Expose with Cloudflare Tunnel (zero config HTTPS)

```bash
# Install cloudflared (one time)
# Linux:
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb

# macOS (Homebrew):
brew install cloudflare/cloudflare/cloudflared

# Start your server
npm start

# In a new terminal — create a quick tunnel (no login needed)
cloudflared tunnel --url http://localhost:3000
```

Cloudflare will give you a public HTTPS URL like:
`https://random-words.trycloudflare.com`

For a permanent tunnel with your own domain, follow: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/

### Option 3: Deploy on Railway / Render / Fly.io

1. Push to GitHub
2. Connect repo to Railway/Render
3. Set `PORT` environment variable if needed
4. Deploy — done!

---

## Environment Variables

| Variable | Default | Description     |
|----------|---------|-----------------|
| `PORT`   | `3000`  | Server port     |

---

## Rate Limits

- **HTTP**: 120 requests per minute per IP
- **Socket text-change**: 50ms minimum between accepted events per socket
- **Max text size**: 100,000 characters per room
- **Max rooms**: 1,000 concurrent rooms
- **Room TTL**: Deleted when all users disconnect (5s grace period)

---

## Browser Support

Works in all modern browsers: Chrome, Firefox, Safari, Edge, and mobile browsers.
Requires JavaScript enabled.
