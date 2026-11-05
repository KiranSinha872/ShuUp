import crypto from "node:crypto";

export function createMatchmaker() {
  const waitingQueue = []; // array of socket IDs
  const activeSessions = new Map(); // sessionId -> { callerId, calleeId, createdAt }
  const userSessions = new Map(); // socketId -> { sessionId, partnerId }

  function isQueued(socketId) {
    return waitingQueue.includes(socketId);
  }

  function isInSession(socketId) {
    return userSessions.has(socketId);
  }

  function enqueueUser(socketId, isSocketConnected) {
    // Discard duplicates and users currently in an active call
    if (isQueued(socketId) || isInSession(socketId)) {
      return { status: "already_queued_or_in_session" };
    }

    // Inspect waiting queue; purge any disconnected sockets encountered
    while (waitingQueue.length > 0) {
      const candidateId = waitingQueue.shift();

      if (isSocketConnected && isSocketConnected(candidateId)) {
        // Synchronous atomic pairing block (no awaits)
        const sessionId = crypto.randomUUID();

        activeSessions.set(sessionId, {
          callerId: candidateId,
          calleeId: socketId,
          createdAt: Date.now()
        });

        userSessions.set(candidateId, { sessionId, partnerId: socketId });
        userSessions.set(socketId, { sessionId, partnerId: candidateId });

        return {
          status: "matched",
          sessionId,
          callerId: candidateId,
          calleeId: socketId
        };
      }
      // Candidate was disconnected; dropped from queue
    }

    // Queue was empty or all candidates were stale; enqueue socket
    waitingQueue.push(socketId);
    return { status: "waiting" };
  }

  function leaveSession(socketId) {
    // 1. If user was waiting in the queue, remove them
    const qIndex = waitingQueue.indexOf(socketId);
    if (qIndex !== -1) {
      waitingQueue.splice(qIndex, 1);
      return { wasWaiting: true };
    }

    // 2. If user was in an active session, dissolve session
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

  return {
    enqueueUser,
    leaveSession,
    getSessionInfo,
    getPartnerId,
    isQueued,
    isInSession
  };
}

