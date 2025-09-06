"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Static assets
app.use(express.static(path.join(__dirname, "public")));
// JSON body parser for prefs API
app.use(express.json({ limit: "1mb" }));

// File uploads setup
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir, { maxAge: "1y" }));

function extFromMime(m) {
  if (!m || typeof m !== "string") return "";
  if (m.startsWith("image/")) {
    if (m.endsWith("jpeg") || m.endsWith("jpg")) return ".jpg";
    if (m.endsWith("png")) return ".png";
    if (m.endsWith("gif")) return ".gif";
    if (m.endsWith("webp")) return ".webp";
    return ".img";
  }
  if (m.startsWith("video/")) {
    if (m.endsWith("mp4")) return ".mp4";
    if (m.endsWith("webm")) return ".webm";
    if (m.endsWith("ogg")) return ".ogv";
    return ".vid";
  }
  if (m.startsWith("audio/")) {
    if (m.endsWith("mpeg")) return ".mp3";
    if (m.endsWith("ogg")) return ".ogg";
    if (m.endsWith("webm")) return ".webm";
    if (m.endsWith("wav")) return ".wav";
    return ".aud";
  }
  return path.extname(m) || "";
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = extFromMime(file.mimetype) || path.extname(file.originalname) || ".bin";
    const id = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    cb(null, id + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\//.test(file.mimetype) || /^video\//.test(file.mimetype) || /^audio\//.test(file.mimetype);
    cb(null, ok);
  },
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const f = req.file;
  return res.json({
    url: `/uploads/${f.filename}`,
    mime: f.mimetype,
    size: f.size,
    originalName: f.originalname,
  });
});

// In-memory user store: socket.id -> username
const users = new Map();

// In-memory messages store for delete permissions
const messages = new Map(); // id -> { owner, type, url }
const messageOrder = [];
// Persist messages to disk (append-only JSONL)
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const messagesFile = path.join(dataDir, "messages.jsonl");
const prefsPath = path.join(dataDir, "prefs.json");
let prefs = {};
try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")); } catch {}
function savePrefsToDisk() { try { fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2)); } catch {} }
function newId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}
function rememberMessage(m) {
  messages.set(m.id, { owner: m.username, type: m.type, url: m.url || null });
  messageOrder.push(m.id);
  // No in-memory limit: we keep IDs to allow delete checks
  try {
    fs.appendFile(messagesFile, JSON.stringify(m) + "\n", () => {});
  } catch {}
}

async function lookupMessageOwner(id) {
  try {
    const data = await fs.promises.readFile(messagesFile, "utf8");
    const lines = data.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (!obj) continue;
        if (obj.type === "delete" && obj.id === id) return { deleted: true };
        if (obj.id === id && obj.username) return { owner: obj.username, deleted: false };
      } catch {}
    }
  } catch {}
  return { owner: null, deleted: false };
}

// Read last N messages from disk (JSONL), applying delete tombstones
function readRecentMessages(limit = 200) {
  return new Promise((resolve) => {
    fs.readFile(messagesFile, "utf8", (err, data) => {
      if (err) return resolve([]);
      const lines = data.split(/\r?\n/).filter(Boolean);
      // If file is large, slice last 5000 lines max to cap memory
      const maxScan = 5000;
      const start = Math.max(0, lines.length - Math.max(limit * 5, maxScan));
      const slice = lines.slice(start);
      const tombstones = new Set();
      const all = [];
      for (const line of slice) {
        try {
          const obj = JSON.parse(line);
          if (obj && obj.type === "delete" && obj.id) { tombstones.add(obj.id); continue; }
          if (obj && obj.id) all.push(obj);
        } catch {}
      }
      // Remove deleted and sort chronologically
      const filtered = all.filter(m => !tombstones.has(m.id));
      filtered.sort((a,b) => (a.timestamp||0)-(b.timestamp||0));
      resolve(filtered.slice(Math.max(0, filtered.length - limit)));
    });
  });
}

// Expose history endpoint
app.get("/messages", async (req, res) => {
  const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 200));
  const items = await readRecentMessages(limit);
  res.json(items);
});

// Preferences endpoints
app.get("/prefs", (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.json({});
  res.json(prefs[name] || {});
});

app.post("/prefs", (req, res) => {
  const { name, avatarUrl, bgColor, bgImageUrl, bgFit } = req.body || {};
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });
  const key = name.trim();
  const current = prefs[key] || {};
  if (typeof avatarUrl === "string") current.avatarUrl = avatarUrl.trim();
  if (typeof bgColor === "string") current.bgColor = bgColor.trim();
  if (typeof bgImageUrl === "string") current.bgImageUrl = bgImageUrl.trim();
  if (typeof bgFit === "string") current.bgFit = bgFit.trim();
  prefs[key] = current;
  savePrefsToDisk();
  res.json({ ok: true, prefs: current });
});

// Admin: clear all messages (no auth; intended for local dev)
app.post("/admin/clear", (req, res) => {
  try {
    messages.clear();
    messageOrder.length = 0;
    fs.writeFileSync(messagesFile, "");
    io.emit("cleared", {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function usersList() {
  return Array.from(users.values()).sort((a, b) => a.localeCompare(b));
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join", (raw, ack) => {
    let name = "";
    let avatarUrl = null;
    if (raw && typeof raw === "object") {
      name = typeof raw.name === "string" ? raw.name.trim() : "";
      const url = typeof raw.avatarUrl === "string" ? raw.avatarUrl.trim() : "";
      if (url.startsWith("/uploads/")) avatarUrl = url;
    } else if (typeof raw === "string") {
      name = raw.trim();
    }
    if (!name) name = "User-" + socket.id.slice(0, 5);
    if (name.length > 30) name = name.slice(0, 30);

    // Merge stored prefs
    const existing = prefs[name] || {};
    if (!avatarUrl && existing.avatarUrl) avatarUrl = existing.avatarUrl;
    if (avatarUrl) {
      prefs[name] = { ...existing, avatarUrl };
      savePrefsToDisk();
    }

    users.set(socket.id, name);
    socket.data.username = name;
    socket.data.avatarUrl = avatarUrl;

    // Update everyone with the users list
    io.emit("users", usersList());

    // Announce join to others
    socket.broadcast.emit("user_joined", { username: name });

    if (typeof ack === "function") ack({ ok: true, prefs: prefs[name] || {} });
    console.log(`User joined: ${name} (${socket.id})`);
  });

  socket.on("update_avatar", (url) => {
    if (typeof url === "string" && url.startsWith("/uploads/")) {
      socket.data.avatarUrl = url.trim();
    }
  });

  socket.on("message", (data) => {
    const name = socket.data.username || users.get(socket.id) || "Anonymous";

    let payload = null;
    if (typeof data === "string") {
      const msg = data.trim().slice(0, 1000);
      if (!msg) return;
      payload = { id: newId(), type: "text", username: name, text: msg, timestamp: Date.now(), avatarUrl: socket.data.avatarUrl || null };
    } else if (data && typeof data === "object") {
      const type = data.type;
      if (type === "image" || type === "video" || type === "audio") {
        const url = typeof data.url === "string" ? data.url.trim() : "";
        if (!url.startsWith("/uploads/")) return; // only allow our uploaded files
        payload = {
          id: newId(),
          type,
          username: name,
          url,
          mime: typeof data.mime === "string" ? data.mime : null,
          text: typeof data.text === "string" ? data.text.slice(0, 300) : "",
          timestamp: Date.now(),
          avatarUrl: socket.data.avatarUrl || null,
        };
      } else {
        return; // unsupported
      }
    } else {
      return;
    }

    rememberMessage(payload);
    io.emit("message", payload);
  });

  socket.on("delete_message", async (id, ack) => {
    if (typeof id !== "string") { if (typeof ack === "function") ack(false); return; }
    const me = socket.data.username || users.get(socket.id) || "";
    if (!me) { if (typeof ack === "function") ack(false); return; }

    let rec = messages.get(id);
    let owner = rec?.owner;
    if (!owner) {
      const info = await lookupMessageOwner(id);
      if (info.deleted) { if (typeof ack === "function") ack(false); return; }
      owner = info.owner;
    }
    if (!owner || owner !== me) { if (typeof ack === "function") ack(false); return; }

    messages.delete(id);
    // Persist tombstone
    try { fs.appendFile(messagesFile, JSON.stringify({ type: "delete", id, timestamp: Date.now(), by: me }) + "\n", () => {}); } catch {}
    io.emit("message_deleted", { id });
    if (typeof ack === "function") ack(true);
  });

  socket.on("typing", (isTyping) => {
    const name = socket.data.username || users.get(socket.id);
    if (!name) return;
    socket.broadcast.emit("typing", { username: name, isTyping: !!isTyping });
  });

  socket.on("disconnect", () => {
    const name = users.get(socket.id);
    users.delete(socket.id);
    if (name) {
      socket.broadcast.emit("user_left", { username: name });
      io.emit("users", usersList());
      console.log(`User left: ${name} (${socket.id})`);
    } else {
      console.log("Client disconnected:", socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

