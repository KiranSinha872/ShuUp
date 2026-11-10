import http from "node:http";
import { Server } from "socket.io";
import {
  PORT,
  CORS_ORIGIN,
  MATCH_WITH_ANYONE,
  PING_INTERVAL,
  PING_TIMEOUT,
  GHOST_SWEEP_INTERVAL_MS,
  SQLITE_DB_PATH,
  validateStartupConfig
} from "./config.js";
import { validateJoinPayload } from "./compatibility.js";
import { createMatchmaker } from "./matchmaker.js";
import { setupSignaling } from "./signaling.js";
import { createIceManager } from "./ice.js";
import { createSafetyManager } from "./safety.js";
import { createStorageAdapter } from "./storage/index.js";

// Validate required config on startup (exits safely if invalid, no secrets logged)
validateStartupConfig();

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
  pingTimeout: PING_TIMEOUT,
  maxHttpBufferSize: 100_000 // 100 KB payload limit to prevent memory exhaustion
});

const safetyManager = createSafetyManager();
const matchmaker = createMatchmaker({
  matchWithAnyone: MATCH_WITH_ANYONE,
  isBlocked: safetyManager.isBlocked
});
const iceManager = createIceManager();
iceManager.warmCache();

export const storageManager = createStorageAdapter({ dbPath: SQLITE_DB_PATH });
const activeSessionMeta = new Map(); // sessionId -> { startedAt, connectionType }

function recordSessionEnd(sessionId) {
  const meta = activeSessionMeta.get(sessionId);
  if (!meta) return;
  activeSessionMeta.delete(sessionId);
  const endedAt = Date.now();
  const durationSeconds = Math.max(0, Math.round((endedAt - meta.startedAt) / 1000));
  storageManager.logCall({
    startedAt: new Date(meta.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSeconds,
    connectionType: meta.connectionType
  });
}

// Handshake authentication middleware
io.use((socket, next) => {
  const result = safetyManager.authenticateHandshake(socket.handshake);
  if (!result.ok) {
    return next(new Error(result.error));
  }
  socket.hashedToken = result.hashedToken;
  socket.clientAddress = result.address;
  socket.limiter = safetyManager.createSocketLimiter();
  next();
});

// Track reported connection-stats (capped to avoid memory bloat)
const reportedStats = new Set();
function recordStat(key) {
  if (reportedStats.size > 1000) {
    reportedStats.clear();
  }
  reportedStats.add(key);
}

async function handleMatchedSession(sessionId, callerId, calleeId) {
  const iceResult = await iceManager.getIceConfig();

  // Verify neither socket disconnected or left while fetching ICE servers
  const callerSocket = io.sockets.sockets.get(callerId);
  const calleeSocket = io.sockets.sockets.get(calleeId);

  const callerSession = matchmaker.getSessionInfo(callerId);
  const calleeSession = matchmaker.getSessionInfo(calleeId);

  if (
    !callerSocket ||
    !calleeSocket ||
    !callerSession ||
    !calleeSession ||
    callerSession.sessionId !== sessionId ||
    calleeSession.sessionId !== sessionId
  ) {
    console.log(`[Matchmaker] Partner left before session ${sessionId} could be started`);
    if (matchmaker.hasActiveSession(sessionId)) {
      matchmaker.dissolveSession(sessionId, { recordRecent: false });
    }
    return;
  }

  // If relay-only was required but no TURN credentials exist: refuse call and abort session
  if (!iceResult.ok) {
    console.warn(`[Matchmaker] Aborted session ${sessionId}: ${iceResult.error}`);
    if (matchmaker.hasActiveSession(sessionId)) {
      matchmaker.dissolveSession(sessionId, { recordRecent: false });
    }

    callerSocket?.emit("queue-status", {
      status: "rejected",
      message: `Call aborted: ${iceResult.error}`
    });
    calleeSocket?.emit("queue-status", {
      status: "rejected",
      message: `Call aborted: ${iceResult.error}`
    });
    return;
  }

  // Record verified pairing for cooldown legitimacy check
  safetyManager.recordSessionPairing(callerSocket.hashedToken, calleeSocket.hashedToken);

  const { iceServers, iceTransportPolicy } = iceResult;

  callerSocket.join(`session:${sessionId}`);
  callerSocket.emit("matched", {
    sessionId,
    isCaller: true,
    iceServers,
    iceTransportPolicy
  });

  calleeSocket.join(`session:${sessionId}`);
  calleeSocket.emit("matched", {
    sessionId,
    isCaller: false,
    iceServers,
    iceTransportPolicy
  });

  // Track session metadata for anonymous call logging (Phase 8a)
  activeSessionMeta.set(sessionId, { startedAt: Date.now(), connectionType: "unknown" });
}

export function startGhostSweep(ioInstance, matchmakerInstance, safetyInstance = safetyManager, intervalMs = GHOST_SWEEP_INTERVAL_MS) {
  const timer = setInterval(() => {
    const isConnected = (id) => Boolean(ioInstance.sockets.sockets.get(id)?.connected);
    const orphaned = matchmakerInstance.sweepGhosts(isConnected);
    for (const { notifySocketId, sessionId } of orphaned) {
      recordSessionEnd(sessionId);
      const socket = ioInstance.sockets.sockets.get(notifySocketId);
      if (socket) {
        socket.leave(`session:${sessionId}`);
        socket.emit("partner-left", { reason: "disconnected" });
      }
    }
    safetyInstance.sweepExpired();
  }, intervalMs);
  timer.unref();
  return timer;
}

// Start periodic ghost and safety sweep
startGhostSweep(io, matchmaker, safetyManager);

function isValidEmptyPayload(payload) {
  return !payload || (typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length === 0);
}

io.on("connection", (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Rate-limiting middleware: inspect event before dispatch
  socket.use(([event], next) => {
    if (socket.limiter) {
      const check = socket.limiter.checkEvent(event);
      if (!check.allow) {
        if (check.disconnect) {
          console.warn(`[Safety] Disconnecting flooding socket ${socket.id}`);
          socket.disconnect(true);
        }
        return; // Drop excessive event
      }
    }
    next();
  });

  // User requests to enter matchmaking queue
  socket.on("join-queue", (payload) => {
    // Check if user is currently under cooldown
    if (safetyManager.checkCooldown(socket.hashedToken)) {
      socket.emit("queue-status", {
        status: "rejected",
        message: "Account temporarily suspended due to safety reports."
      });
      return;
    }

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
        preferences: validation.preferences,
        hashedToken: socket.hashedToken
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
      handleMatchedSession(sessionId, callerId, calleeId);
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
      handleMatchedSession(sessionId, callerId, calleeId);
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
      recordSessionEnd(result.sessionId);
      socket.leave(`session:${result.sessionId}`);
      const partnerSocket = io.sockets.sockets.get(result.partnerId);

      // Set grace period so partner or leaver can still report/block within 120s
      if (partnerSocket && partnerSocket.hashedToken) {
        safetyManager.setGracePeriod(socket.id, result.sessionId, partnerSocket.hashedToken);
        safetyManager.setGracePeriod(result.partnerId, result.sessionId, socket.hashedToken);
      }

      if (partnerSocket) {
        partnerSocket.leave(`session:${result.sessionId}`);
        partnerSocket.emit("partner-left", { reason: "left" });
      }
    }
  });

  // Client reports user for safety violations
  socket.on("report-user", async (payload, callback) => {
    if (!payload || typeof payload !== "object") return;
    const { sessionId, category, note } = payload;
    if (typeof sessionId !== "string" || typeof category !== "string") return;

    let reportedHashedToken = null;
    const session = matchmaker.getActiveSession(sessionId);

    if (session && (session.callerId === socket.id || session.calleeId === socket.id)) {
      reportedHashedToken = session.callerId === socket.id ? session.calleeToken : session.callerToken;
    } else {
      const grace = safetyManager.getGraceRecord(socket.id, sessionId);
      if (grace && grace.sessionId === sessionId) {
        reportedHashedToken = grace.partnerHashedToken;
      }
    }

    if (!reportedHashedToken) {
      if (typeof callback === "function") callback({ ok: false, error: "INVALID_SESSION" });
      return;
    }

    const result = await safetyManager.recordReport({
      sessionId,
      category,
      rawNote: note,
      reporterHashedToken: socket.hashedToken,
      reportedHashedToken
    });

    if (result.ok) {
      storageManager.saveReport({
        reportId: result.reportId,
        sessionId,
        category,
        note,
        reportedAccountId: reportedHashedToken,
        reporterAccountId: socket.hashedToken
      });
    }

    if (typeof callback === "function") {
      callback(result);
    }
  });

  // Client blocks user
  socket.on("block-user", (payload, callback) => {
    if (!payload || typeof payload !== "object") return;
    const { sessionId } = payload;
    if (typeof sessionId !== "string") return;

    let partnerSocketId = null;
    let partnerHashedToken = null;
    const session = matchmaker.getActiveSession(sessionId);

    if (session && (session.callerId === socket.id || session.calleeId === socket.id)) {
      partnerSocketId = session.callerId === socket.id ? session.calleeId : session.callerId;
      partnerHashedToken = session.callerId === socket.id ? session.calleeToken : session.callerToken;
    } else {
      const grace = safetyManager.getGraceRecord(socket.id, sessionId);
      if (grace && grace.sessionId === sessionId) {
        partnerHashedToken = grace.partnerHashedToken;
      }
    }

    if (!partnerHashedToken) {
      if (typeof callback === "function") callback({ ok: false, error: "INVALID_SESSION" });
      return;
    }

    // Record block in memory
    safetyManager.recordBlock(socket.hashedToken, partnerHashedToken);

    // If active session: dissolve immediately and notify partner
    if (partnerSocketId) {
      recordSessionEnd(sessionId);
      matchmaker.leaveSession(socket.id, { recordRecent: false });
      const partnerSocket = io.sockets.sockets.get(partnerSocketId);
      if (partnerSocket) {
        partnerSocket.leave(`session:${sessionId}`);
        partnerSocket.emit("partner-left", { reason: "blocked" });
      }
      socket.leave(`session:${sessionId}`);
    }

    if (typeof callback === "function") {
      callback({ ok: true });
    }
  });

  // Client reports WebRTC candidate connection type for telemetry
  socket.on("connection-stats", (payload) => {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 2 ||
      typeof payload.sessionId !== "string" ||
      !["direct", "relay", "unknown"].includes(payload.connectionType)
    ) {
      console.warn(`[Stats] Dropped invalid connection-stats payload from ${socket.id}`);
      return;
    }

    const session = matchmaker.getSessionInfo(socket.id);
    if (!session || session.sessionId !== payload.sessionId) {
      console.warn(`[Stats] Dropped connection-stats from ${socket.id} for non-matching session ${payload.sessionId}`);
      return;
    }

    const key = `${payload.sessionId}:${socket.id}`;
    if (reportedStats.has(key)) {
      return; // Rate-limited: accept only once per session per socket
    }
    recordStat(key);

    const meta = activeSessionMeta.get(payload.sessionId);
    if (meta) {
      meta.connectionType = payload.connectionType;
    }

    console.log(`[Stats] Session ${payload.sessionId} reported connectionType: ${payload.connectionType}`);
  });

  // Attach WebRTC signaling router
  setupSignaling(io, socket, matchmaker);

  // Handle client disconnect
  socket.on("disconnect", (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
    safetyManager.releaseConnection(socket.clientAddress);

    const result = matchmaker.disconnectUser(socket.id);

    if (result.wasInSession) {
      recordSessionEnd(result.sessionId);
      const partnerSocket = io.sockets.sockets.get(result.partnerId);
      if (partnerSocket && partnerSocket.hashedToken) {
        safetyManager.setGracePeriod(result.partnerId, result.sessionId, socket.hashedToken);
      }

      if (partnerSocket) {
        partnerSocket.leave(`session:${result.sessionId}`);
        partnerSocket.emit("partner-left", { reason: "disconnected" });
      }
    }

    safetyManager.clearGraceRecord(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Shuup backend running on port ${PORT}`);
  console.log(`Allowed CORS origin: ${CORS_ORIGIN}`);
});

// Background maintenance: prune raw call logs older than 90 days into daily_summaries
// Run once shortly after startup (5s non-blocking delay) so frequent restarts still prune, plus on 24h interval
const initialPruneTimer = setTimeout(() => {
  storageManager.pruneOldData().catch((err) => {
    console.warn("[Storage] Initial startup prune error:", err.message);
  });
}, 5_000);
initialPruneTimer.unref();

const pruneTimer = setInterval(() => {
  storageManager.pruneOldData().catch((err) => {
    console.warn("[Storage] Daily prune error:", err.message);
  });
}, 24 * 60 * 60 * 1000);
pruneTimer.unref();

// Graceful shutdown: flush pending write queues on termination signals
async function handleShutdown(signal) {
  console.log(`[Server] Received ${signal}. Draining storage queues before shutdown...`);
  try {
    await storageManager.close({ timeoutMs: 2000 });
    console.log("[Server] Storage queues flushed cleanly.");
  } catch (err) {
    console.warn("[Server] Storage flush error on shutdown:", err.message);
  }
  process.exit(0);
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
