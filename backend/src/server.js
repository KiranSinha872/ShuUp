import http from "node:http";
import { Server } from "socket.io";
import { validateJoinPayload } from "./compatibility.js";
import { createMatchmaker } from "./matchmaker.js";
import { setupSignaling } from "./signaling.js";

const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
const MATCH_WITH_ANYONE = process.env.MATCH_WITH_ANYONE === "true";

if (MATCH_WITH_ANYONE) {
  console.warn("[WARNING] MATCH_WITH_ANYONE feature flag is enabled. Preference matching is bypassed.");
}

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

const matchmaker = createMatchmaker({ matchWithAnyone: MATCH_WITH_ANYONE });

io.on("connection", (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // User requests to enter matchmaking queue
  socket.on("join-queue", (payload) => {
    const validation = validateJoinPayload(payload);

    if (!validation.valid) {
      console.warn(`[Matchmaker] Rejected invalid join-queue payload from ${socket.id}: ${validation.error}`);
      socket.emit("queue-status", {
        status: "rejected",
        message: `Queue entry rejected: ${validation.error}`
      });
      return;
    }

    const isSocketConnected = (id) => Boolean(io.sockets.sockets.get(id)?.connected);
    const result = matchmaker.enqueueUser(
      {
        socketId: socket.id,
        identity: validation.identity,
        preferences: validation.preferences
      },
      isSocketConnected
    );

    if (result.status === "already_queued_or_in_session") {
      console.log(`[Matchmaker] Ignored duplicate join-queue from ${socket.id}`);
      return;
    }

    if (result.status === "waiting") {
      console.log(`[Matchmaker] User ${socket.id} entered waiting queue`);
      socket.emit("queue-status", {
        status: "waiting",
        message: "Waiting for a compatible partner..."
      });
      return;
    }

    if (result.status === "matched") {
      const { sessionId, callerId, calleeId } = result;
      console.log(`[Matchmaker] Paired ${callerId} (caller) and ${calleeId} (callee). Session: ${sessionId}`);

      const callerSocket = io.sockets.sockets.get(callerId);
      const calleeSocket = io.sockets.sockets.get(calleeId);

      // Join named private session room; matched event contains ONLY sessionId and caller role
      if (callerSocket) {
        callerSocket.join(`session:${sessionId}`);
        callerSocket.emit("matched", { sessionId, isCaller: true });
      }

      if (calleeSocket) {
        calleeSocket.join(`session:${sessionId}`);
        calleeSocket.emit("matched", { sessionId, isCaller: false });
      }
    }
  });

  // User intentionally leaves queue or call
  socket.on("leave-session", () => {
    console.log(`[Socket] ${socket.id} requested leave-session`);
    const result = matchmaker.leaveSession(socket.id);

    if (result.wasInSession) {
      socket.leave(`session:${result.sessionId}`);
      const partnerSocket = io.sockets.sockets.get(result.partnerId);
      if (partnerSocket) {
        partnerSocket.leave(`session:${result.sessionId}`);
        partnerSocket.emit("partner-left", { reason: "left" });
      }
    }
  });

  // Attach WebRTC signaling router
  setupSignaling(io, socket, matchmaker);

  // Handle client disconnect
  socket.on("disconnect", (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
    const result = matchmaker.leaveSession(socket.id);

    if (result.wasInSession) {
      const partnerSocket = io.sockets.sockets.get(result.partnerId);
      if (partnerSocket) {
        partnerSocket.leave(`session:${result.sessionId}`);
        partnerSocket.emit("partner-left", { reason: "disconnected" });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Shuup backend running on port ${PORT}`);
  console.log(`Allowed CORS origin: ${CORS_ORIGIN}`);
});
