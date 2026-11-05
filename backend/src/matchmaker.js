import crypto from "node:crypto";
import { isCompatible } from "./compatibility.js";

export function createMatchmaker(options = {}) {
  const matchWithAnyone = Boolean(options.matchWithAnyone);
  const waitingQueue = []; // array of { socketId, identity, preferences, joinedAt }
  const activeSessions = new Map(); // sessionId -> { callerId, calleeId, createdAt }
  const userSessions = new Map(); // socketId -> { sessionId, partnerId }

  function isQueued(socketId) {
    return waitingQueue.some((item) => item.socketId === socketId);
  }

  function isInSession(socketId) {
    return userSessions.has(socketId);
  }

  function enqueueUser(user, isSocketConnected = () => true) {
    const { socketId, identity, preferences } = user;

    // Discard duplicates or users already in an active session
    if (isQueued(socketId) || isInSession(socketId)) {
      return { status: "already_queued_or_in_session" };
    }

    // Scan waiting queue in arrival order (longest-waiter-first)
    let candidateIndex = 0;
    while (candidateIndex < waitingQueue.length) {
      const candidate = waitingQueue[candidateIndex];

      // Discard stale or disconnected sockets
      if (!isSocketConnected(candidate.socketId)) {
        waitingQueue.splice(candidateIndex, 1);
        continue;
      }

      // Check compatibility
      const compatible = matchWithAnyone || isCompatible(candidate, user);

      if (compatible) {
        // Synchronous atomic match-and-remove block (no awaits)
        waitingQueue.splice(candidateIndex, 1);
        const sessionId = crypto.randomUUID();

        activeSessions.set(sessionId, {
          callerId: candidate.socketId,
          calleeId: socketId,
          createdAt: Date.now()
        });

        userSessions.set(candidate.socketId, { sessionId, partnerId: socketId });
        userSessions.set(socketId, { sessionId, partnerId: candidate.socketId });

        return {
          status: "matched",
          sessionId,
          callerId: candidate.socketId,
          calleeId: socketId
        };
      }

      candidateIndex++;
    }

    // No compatible candidate found; append user to waiting queue
    waitingQueue.push({
      socketId,
      identity,
      preferences,
      joinedAt: Date.now()
    });

    return { status: "waiting" };
  }

  function leaveSession(socketId) {
    const qIndex = waitingQueue.findIndex((item) => item.socketId === socketId);
    if (qIndex !== -1) {
      waitingQueue.splice(qIndex, 1);
      return { wasWaiting: true };
    }

    const sessionInfo = userSessions.get(socketId);
    if (sessionInfo) {
      const { sessionId, partnerId } = sessionInfo;
      userSessions.delete(socketId);
      userSessions.delete(partnerId);
      activeSessions.delete(sessionId);
      return { wasInSession: true, sessionId, partnerId };
    }

    return { wasIdle: true };
  }

  function getSessionInfo(socketId) {
    return userSessions.get(socketId) || null;
  }

  function getPartnerId(socketId) {
    return userSessions.get(socketId)?.partnerId || null;
  }

  function getWaitingQueue() {
    return waitingQueue.map((item) => ({ ...item }));
  }

  return {
    enqueueUser,
    leaveSession,
    getSessionInfo,
    getPartnerId,
    isQueued,
    isInSession,
    getWaitingQueue
  };
}
