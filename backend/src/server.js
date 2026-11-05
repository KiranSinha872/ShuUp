import http from "node:http";
import { Server } from "socket.io";
import {
  PORT,
  CORS_ORIGIN,
  MATCH_WITH_ANYONE,
  PING_INTERVAL,
  PING_TIMEOUT,
  GHOST_SWEEP_INTERVAL_MS
} from "./config.js";
import { validateJoinPayload } from "./compatibility.js";
import { createMatchmaker } from "./matchmaker.js";
import { setupSignaling } from "./signaling.js";

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
  },
  pingInterval: PING_INTERVAL,
  pingTimeout: PING_TIMEOUT
});

const matchmaker = createMatchmaker({ matchWithAnyone: MATCH_WITH_ANYONE });

export function startGhostSweep(ioInstance, matchmakerInstance, intervalMs = GHOST_SWEEP_INTERVAL_MS) {
  const timer = setInterval(() => {
    const isConnected = (id) => Boolean(ioInstance.sockets.sockets.get(id)?.connected);
    const orphaned = matchmakerInstance.sweepGhosts(isConnected);
    for (const { notifySocketId, sessionId } of orphaned) {
      const socket = ioInstance.sockets.sockets.get(notifySocketId);
      if (socket) {
        socket.leave(`session:${sessionId}`);
        socket.emit("partner-left", { reason: "disconnected" });
      }
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

// Start periodic ghost sweep
startGhostSweep(io, matchmaker);

function isValidEmptyPayload(payload) {
  return !payload || (typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length === 0);
}

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
    const onBroadenPrompt = (socketId, waitSeconds) => {
      io.to(socketId).emit("broaden-prompt", { waitSeconds });
    };

    const result = matchmaker.enqueueUser(
      {
        socketId: socket.id,
        identity: validation.identity,
        preferences: validation.preferences
      },
      isSocketConnected,
      onBroadenPrompt
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

  // User opts in to broaden preferences
  socket.on("broaden-accept", (payload) => {
    if (!isValidEmptyPayload(payload)) {
      console.warn(`[Matchmaker] Dropped malformed broaden-accept from ${socket.id}`);
      return;
    }

    const isSocketConnected = (id) => Boolean(io.sockets.sockets.get(id)?.connected);
    const result = matchmaker.broadenAccept(socket.id, isSocketConnected);

    if (result.status === "matched") {
      const { sessionId, callerId, calleeId } = result;
      console.log(`[Matchmaker] Broaden match: paired ${callerId} and ${calleeId}. Session: ${sessionId}`);

      const callerSocket = io.sockets.sockets.get(callerId);
      const calleeSocket = io.sockets.sockets.get(calleeId);

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
  socket.on("leave-session", (payload) => {
    if (!isValidEmptyPayload(payload)) {
      console.warn(`[Matchmaker] Dropped malformed leave-session payload from ${socket.id}`);
      return;
    }

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
    const result = matchmaker.disconnectUser(socket.id);

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
