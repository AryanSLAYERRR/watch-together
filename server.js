import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

const rooms = new Map();
const clients = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readJson(req);
      const room = createRoom(body);
      sendJson(res, 201, {
        code: room.code,
        hostKey: room.hostKey,
        room: publicRoom(room)
      });
      return;
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})$/);
    if (req.method === "GET" && roomMatch) {
      const room = rooms.get(roomMatch[1]);
      if (!room) {
        sendJson(res, 404, { error: "Room not found" });
        return;
      }
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Unexpected server error" });
  }
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const client = {
    id: crypto.randomUUID(),
    socket,
    buffer: Buffer.alloc(0),
    roomCode: null,
    name: "Friend",
    isHost: false,
    media: { audio: false, video: false },
    joinedAt: Date.now()
  };

  clients.set(client.id, client);

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    parseFrames(client);
  });
  socket.on("close", () => disconnect(client));
  socket.on("error", () => disconnect(client));

  send(client, { type: "hello", clientId: client.id });
});

server.listen(port, () => {
  console.log(`Watch Together is running at http://localhost:${port}`);
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.clients.size === 0 && Date.now() - room.emptySince > 1000 * 60 * 20) {
      rooms.delete(room.code);
    }
  }
}, 1000 * 60);

function createRoom(body = {}) {
  const code = uniqueCode();
  const hostKey = crypto.randomBytes(18).toString("base64url");
  const now = Date.now();
  const sourceUrl = normalizeUrl(body.sourceUrl || "");

  const room = {
    code,
    hostKey,
    title: cleanText(body.title, 80) || "Watch room",
    source: {
      url: sourceUrl,
      label: sourceUrl ? hostname(sourceUrl) : "No source selected"
    },
    mode: body.mode === "remote-browser" ? "remote-browser" : "direct-sync",
    settings: {
      hostOnlyControls: body.hostOnlyControls !== false,
      chatEnabled: body.chatEnabled !== false,
      voiceEnabled: body.voiceEnabled !== false,
      videoEnabled: body.videoEnabled !== false,
      driftTolerance: 0.85,
      latencyMode: body.latencyMode === "quality" ? "quality" : "balanced"
    },
    playback: {
      state: "idle",
      currentTime: 0,
      duration: 0,
      rate: 1,
      updatedAt: now
    },
    messages: [],
    reactions: [],
    clients: new Set(),
    createdAt: now,
    emptySince: now,
    remoteBrowser: {
      status: "not-connected",
      note: "Attach a Linux browser worker/SFU here for server-rendered playback."
    }
  };

  rooms.set(code, room);
  return room;
}

function handleMessage(client, message) {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "join") {
    const code = String(message.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      send(client, { type: "error", error: "Room not found" });
      return;
    }

    if (client.roomCode && client.roomCode !== code) {
      leaveRoom(client);
    }

    client.roomCode = code;
    client.name = cleanText(message.name, 32) || "Friend";
    client.isHost = Boolean(message.hostKey && message.hostKey === room.hostKey);
    room.clients.add(client.id);
    room.emptySince = 0;

    send(client, {
      type: "joined",
      clientId: client.id,
      isHost: client.isHost,
      room: publicRoom(room)
    });
    broadcastPresence(room);
    broadcastSystem(room, `${client.name} joined`);
    return;
  }

  const room = getClientRoom(client);
  if (!room) {
    send(client, { type: "error", error: "Join a room first" });
    return;
  }

  if (message.type === "leave") {
    leaveRoom(client);
    send(client, { type: "left" });
    return;
  }

  if (message.type === "chat") {
    if (!room.settings.chatEnabled) return;
    const text = cleanText(message.text, 600);
    if (!text) return;

    const chat = {
      id: crypto.randomUUID(),
      type: "chat",
      from: client.id,
      name: client.name,
      text,
      createdAt: Date.now()
    };
    room.messages.push(chat);
    room.messages = room.messages.slice(-60);
    broadcast(room, { type: "chat", message: chat });
    return;
  }

  if (message.type === "reaction") {
    const emoji = cleanReaction(message.emoji);
    if (!emoji) {
      send(client, { type: "error", error: "Reactions can be up to 5 words" });
      return;
    }
    broadcast(room, {
      type: "reaction",
      reaction: {
        id: crypto.randomUUID(),
        from: client.id,
        name: client.name,
        emoji,
        createdAt: Date.now()
      }
    });
    return;
  }

  if (message.type === "playback") {
    if (!canControl(client, room)) return;
    room.playback = {
      state: ["playing", "paused", "idle"].includes(message.state) ? message.state : room.playback.state,
      currentTime: finiteNumber(message.currentTime, room.playback.currentTime),
      duration: finiteNumber(message.duration, room.playback.duration),
      rate: finiteNumber(message.rate, room.playback.rate || 1),
      updatedAt: Date.now()
    };
    broadcast(room, { type: "playback", playback: room.playback, from: client.id }, client.id);
    return;
  }

  if (message.type === "source:update") {
    if (!canControl(client, room)) return;
    const nextUrl = normalizeUrl(message.sourceUrl || "");
    room.source = {
      url: nextUrl,
      label: nextUrl ? hostname(nextUrl) : "No source selected"
    };
    room.playback = {
      state: "idle",
      currentTime: 0,
      duration: 0,
      rate: 1,
      updatedAt: Date.now()
    };
    broadcast(room, { type: "room:update", room: publicRoom(room) });
    broadcastSystem(room, `${client.name} changed the source`);
    return;
  }

  if (message.type === "settings:update") {
    if (!client.isHost) return;
    room.settings = {
      ...room.settings,
      hostOnlyControls: message.settings?.hostOnlyControls !== false,
      chatEnabled: message.settings?.chatEnabled !== false,
      voiceEnabled: message.settings?.voiceEnabled !== false,
      videoEnabled: message.settings?.videoEnabled !== false,
      latencyMode: message.settings?.latencyMode === "quality" ? "quality" : "balanced"
    };
    broadcast(room, { type: "room:update", room: publicRoom(room) });
    return;
  }

  if (message.type === "mode:update") {
    if (!client.isHost) return;
    room.mode = message.mode === "remote-browser" ? "remote-browser" : "direct-sync";
    broadcast(room, { type: "room:update", room: publicRoom(room) });
    return;
  }

  if (message.type === "media-state") {
    client.media = {
      audio: Boolean(message.audio),
      video: Boolean(message.video)
    };
    broadcastPresence(room);
    return;
  }

  if (message.type === "signal") {
    const target = clients.get(message.to);
    if (!target || target.roomCode !== client.roomCode) return;
    send(target, {
      type: "signal",
      from: client.id,
      signal: message.signal
    });
    return;
  }

  if (message.type === "remote-browser:request") {
    if (!client.isHost) return;
    room.remoteBrowser = {
      status: "queued",
      note: "A production worker would claim this room and publish a WebRTC stream."
    };
    broadcast(room, { type: "room:update", room: publicRoom(room) });
    broadcastSystem(room, `${client.name} requested a server browser session`);
  }
}

function parseFrames(client) {
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      const high = client.buffer.readUInt32BE(offset);
      const low = client.buffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }

    const maskOffset = masked ? 4 : 0;
    if (client.buffer.length < offset + maskOffset + length) return;

    let payload = client.buffer.subarray(offset + maskOffset, offset + maskOffset + length);
    if (masked) {
      const mask = client.buffer.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    client.buffer = client.buffer.subarray(offset + maskOffset + length);

    if (opcode === 0x8) {
      disconnect(client);
      return;
    }

    if (opcode === 0x9) {
      client.socket.write(encodeFrame(payload, 0xA));
      continue;
    }

    if (opcode !== 0x1) continue;

    try {
      handleMessage(client, JSON.parse(payload.toString("utf8")));
    } catch {
      send(client, { type: "error", error: "Invalid message" });
    }
  }
}

function send(client, payload) {
  if (!client.socket.writable) return;
  client.socket.write(encodeFrame(Buffer.from(JSON.stringify(payload)), 0x1));
}

function broadcast(room, payload, exceptId = null) {
  for (const clientId of room.clients) {
    if (clientId === exceptId) continue;
    const client = clients.get(clientId);
    if (client) send(client, payload);
  }
}

function broadcastPresence(room) {
  broadcast(room, {
    type: "presence",
    participants: participants(room)
  });
}

function broadcastSystem(room, text) {
  const message = {
    id: crypto.randomUUID(),
    type: "system",
    text,
    createdAt: Date.now()
  };
  room.messages.push(message);
  room.messages = room.messages.slice(-60);
  broadcast(room, { type: "chat", message });
}

function encodeFrame(payload, opcode = 0x1) {
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  }
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function disconnect(client) {
  if (!clients.has(client.id)) return;
  leaveRoom(client);
  clients.delete(client.id);
  try {
    client.socket.end();
  } catch {}
}

function leaveRoom(client) {
  const room = getClientRoom(client);
  if (!room) return;
  room.clients.delete(client.id);
  broadcastPresence(room);
  broadcastSystem(room, `${client.name} left`);
  if (room.clients.size === 0) room.emptySince = Date.now();
  client.roomCode = null;
}

function getClientRoom(client) {
  return client.roomCode ? rooms.get(client.roomCode) : null;
}

function publicRoom(room) {
  return {
    code: room.code,
    title: room.title,
    source: room.source,
    mode: room.mode,
    settings: room.settings,
    playback: room.playback,
    messages: room.messages,
    participants: participants(room),
    remoteBrowser: room.remoteBrowser,
    createdAt: room.createdAt
  };
}

function participants(room) {
  return [...room.clients]
    .map((clientId) => clients.get(clientId))
    .filter(Boolean)
    .map((client) => ({
      id: client.id,
      name: client.name,
      isHost: client.isHost,
      media: client.media,
      joinedAt: client.joinedAt
    }));
}

function canControl(client, room) {
  return client.isHost || !room.settings.hostOnlyControls;
}

function uniqueCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  do {
    let code = "";
    for (let index = 0; index < 6; index += 1) {
      code += alphabet[crypto.randomInt(alphabet.length)];
    }
    if (!rooms.has(code)) return code;
  } while (true);
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanReaction(value) {
  const words = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length === 0 || words.length > 5) return "";
  return words.join(" ").slice(0, 180);
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "Source";
  }
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(safePath);
  const filePath = path.normalize(path.join(publicDir, decoded));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(content);
  });
}
