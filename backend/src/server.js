import http from "node:http";
import crypto from "node:crypto";
import { Server } from "socket.io";

const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// Sensible payload size limits to protect server memory
const MAX_SDP_BYTES = 64 * 1024; // 64 KB
const MAX_CANDIDATE_BYTES = 8 * 1024; // 8 KB

const server = http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"]
  }
});

// Phase 2 bare room state: at most 2 peers in the test room
const activeRoom = {
  peers: [], // [callerId, calleeId]
  sessionId: null
};

function getPartnerId(socketId) {
  if (activeRoom.peers.length === 2) {
    if (activeRoom.peers[0] === socketId) return activeRoom.peers[1];
    if (activeRoom.peers[1] === socketId) return activeRoom.peers[0];
  }
  return null;
}

function getPayloadSize(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj), "utf8");
  } catch {
    return Infinity;
  }
}

io.on("connection", (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Reject connections beyond the 2-peer test room limit
  if (activeRoom.peers.length >= 2) {
    console.log(`[Socket] Rejected ${socket.id}: room is full`);
    socket.emit("room-full", { message: "Test room is full (maximum 2 participants)." });
    socket.disconnect(true);
    return;
  }

  activeRoom.peers.push(socket.id);

  if (activeRoom.peers.length === 1) {
    console.log(`[Room] ${socket.id} joined as first peer (caller). Waiting for partner.`);
    socket.emit("queue-status", {
      status: "waiting",
      message: "Connected. Waiting for a partner to join..."
    });
  } else if (activeRoom.peers.length === 2) {
    const callerId = activeRoom.peers[0];
    const calleeId = activeRoom.peers[1];
    activeRoom.sessionId = crypto.randomUUID();

    console.log(`[Room] Paired ${callerId} (caller) and ${calleeId} (callee). Session: ${activeRoom.sessionId}`);

    io.to(callerId).emit("matched", {
      sessionId: activeRoom.sessionId,
      isCaller: true
    });

    io.to(calleeId).emit("matched", {
      sessionId: activeRoom.sessionId,
      isCaller: false
    });
  }

  // WebRTC Signaling: Offer
  socket.on("offer", (payload) => {
    const partnerId = getPartnerId(socket.id);
    if (!partnerId) return;

    if (
      getPayloadSize(payload) > MAX_SDP_BYTES ||
      !payload?.sdp ||
      payload.sdp.type !== "offer" ||
      typeof payload.sdp.sdp !== "string"
    ) {
      console.warn(`[Signaling] Dropped malformed or oversized offer from ${socket.id}`);
      return;
    }

    io.to(partnerId).emit("offer", payload);
  });

  // WebRTC Signaling: Answer
  socket.on("answer", (payload) => {
    const partnerId = getPartnerId(socket.id);
    if (!partnerId) return;

    if (
      getPayloadSize(payload) > MAX_SDP_BYTES ||
      !payload?.sdp ||
      payload.sdp.type !== "answer" ||
      typeof payload.sdp.sdp !== "string"
    ) {
      console.warn(`[Signaling] Dropped malformed or oversized answer from ${socket.id}`);
      return;
    }

    io.to(partnerId).emit("answer", payload);
  });

  // WebRTC Signaling: ICE Candidate
  socket.on("ice-candidate", (payload) => {
    const partnerId = getPartnerId(socket.id);
    if (!partnerId) return;

    if (
      getPayloadSize(payload) > MAX_CANDIDATE_BYTES ||
      !payload?.candidate ||
      typeof payload.candidate !== "object"
    ) {
      console.warn(`[Signaling] Dropped malformed or oversized ICE candidate from ${socket.id}`);
      return;
    }

    io.to(partnerId).emit("ice-candidate", payload);
  });

  // Handle Disconnect
  socket.on("disconnect", (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);

    const index = activeRoom.peers.indexOf(socket.id);
    if (index === -1) return;

    activeRoom.peers.splice(index, 1);
    activeRoom.sessionId = null;

    // If a partner survived, keep them as the first peer in the room and notify them
    if (activeRoom.peers.length === 1) {
      const survivingPeerId = activeRoom.peers[0];
      console.log(`[Room] Surviving peer: ${survivingPeerId}. Waiting for new partner.`);
      io.to(survivingPeerId).emit("partner-left", { reason: "disconnected" });
      io.to(survivingPeerId).emit("queue-status", {
        status: "waiting",
        message: "Partner disconnected. Waiting for a new partner to join..."
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Shuup backend running on port ${PORT}`);
  console.log(`Allowed CORS origin: ${CORS_ORIGIN}`);
});
