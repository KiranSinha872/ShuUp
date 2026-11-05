import crypto from "node:crypto";
import { isCompatible } from "./compatibility.js";
import {
  BROADEN_WAIT_SECONDS,
  RECENT_PARTNER_LIMIT,
  RECENT_PARTNER_TTL_MS
} from "./config.js";

export function createMatchmaker(options = {}) {
  const matchWithAnyone = Boolean(options.matchWithAnyone);
  const broadenWaitSeconds = options.broadenWaitSeconds ?? BROADEN_WAIT_SECONDS;
  const recentPartnerLimit = options.recentPartnerLimit ?? RECENT_PARTNER_LIMIT;
  const recentPartnerTtlMs = options.recentPartnerTtlMs ?? RECENT_PARTNER_TTL_MS;

  // Injected clock and timer scheduler for deterministic testing
  const now = options.timeProvider || (() => Date.now());
  const scheduleTimeout = options.scheduleTimeout || ((fn, ms) => setTimeout(fn, ms));
  const cancelTimeout = options.cancelTimeout || ((id) => clearTimeout(id));

  const waitingQueue = []; // array of { socketId, identity, preferences, joinedAt, hasPromptedBroaden, isWidened, broadenTimer }
  const activeSessions = new Map(); // sessionId -> { callerId, calleeId, createdAt }
  const userSessions = new Map(); // socketId -> { sessionId, partnerId }
  const recentPartners = new Map(); // socketId -> Array<{ partnerId: string, expiresAt: number }>

  function isQueued(socketId) {
    return waitingQueue.some((item) => item.socketId === socketId);
  }

  function isInSession(socketId) {
    return userSessions.has(socketId);
  }

  function recordRecentPartners(socketA, socketB) {
    const currentTime = now();

    function addPartner(source, target) {
      let list = recentPartners.get(source) || [];
      // Remove any existing entry for target to refresh with new expiry
      list = list.filter((item) => item.partnerId !== target);
      list.unshift({ partnerId: target, expiresAt: currentTime + recentPartnerTtlMs });
      if (list.length > recentPartnerLimit) {
        list = list.slice(0, recentPartnerLimit);
      }
      recentPartners.set(source, list);
    }

    addPartner(socketA, socketB);
    addPartner(socketB, socketA);
  }

  function isRecentPartner(socketA, socketB) {
    const currentTime = now();
    const list = recentPartners.get(socketA);
    if (!list) return false;
    return list.some((item) => item.partnerId === socketB && item.expiresAt > currentTime);
  }

  function clearRecentPartners(socketId) {
    recentPartners.delete(socketId);
  }

  function getEffectiveUser(entry) {
    return {
      identity: entry.identity,
      preferences: entry.isWidened ? ["Anyone"] : entry.preferences
    };
  }

  function clearBroadenTimer(entry) {
    if (entry && entry.broadenTimer) {
      cancelTimeout(entry.broadenTimer);
      entry.broadenTimer = null;
    }
  }

  function startBroadenTimer(entry, onBroadenPrompt) {
    clearBroadenTimer(entry);
    entry.broadenTimer = scheduleTimeout(() => {
      entry.broadenTimer = null;
      entry.hasPromptedBroaden = true;
      if (onBroadenPrompt) {
        onBroadenPrompt(entry.socketId, broadenWaitSeconds);
      }
    }, broadenWaitSeconds * 1000);

    if (typeof entry.broadenTimer?.unref === "function") {
      entry.broadenTimer.unref();
    }
  }

  function enqueueUser(user, isSocketConnected = () => true, onBroadenPrompt = null) {
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
        clearBroadenTimer(candidate);
        waitingQueue.splice(candidateIndex, 1);
        continue;
      }

      // Check recent partner exclusion (recent partners are never rematched within TTL)
      if (isRecentPartner(candidate.socketId, socketId)) {
        candidateIndex++;
        continue;
      }

      // Check mutual compatibility using effective preferences
      const candidateEffective = getEffectiveUser(candidate);
      const userEffective = { identity, preferences };
      const compatible = matchWithAnyone || isCompatible(candidateEffective, userEffective);

      if (compatible) {
        // Synchronous atomic match-and-remove block (no awaits)
        clearBroadenTimer(candidate);
        waitingQueue.splice(candidateIndex, 1);
        const sessionId = crypto.randomUUID();

        activeSessions.set(sessionId, {
          callerId: candidate.socketId,
          calleeId: socketId,
          createdAt: now()
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
    const queueEntry = {
      socketId,
      identity,
      preferences,
      joinedAt: now(),
      hasPromptedBroaden: false,
      isWidened: false,
      broadenTimer: null
    };

    waitingQueue.push(queueEntry);
    startBroadenTimer(queueEntry, onBroadenPrompt);

    return { status: "waiting" };
  }

  function broadenAccept(socketId, isSocketConnected = () => true) {
    const entryIndex = waitingQueue.findIndex((item) => item.socketId === socketId);
    if (entryIndex === -1) {
      return { status: "ignored_not_queued" };
    }

    const entry = waitingQueue[entryIndex];
    if (!entry.hasPromptedBroaden) {
      return { status: "ignored_not_prompted" };
    }
    if (entry.isWidened) {
      return { status: "ignored_already_widened" };
    }

    entry.isWidened = true;

    // Immediately run a synchronous scan of the queue to pair if a compatible match now exists
    let candidateIndex = 0;
    while (candidateIndex < waitingQueue.length) {
      if (candidateIndex === entryIndex) {
        candidateIndex++;
        continue;
      }

      const candidate = waitingQueue[candidateIndex];

      if (!isSocketConnected(candidate.socketId)) {
        clearBroadenTimer(candidate);
        waitingQueue.splice(candidateIndex, 1);
        continue;
      }

      // Broaden never overrides recent-partner rule
      if (isRecentPartner(candidate.socketId, socketId)) {
        candidateIndex++;
        continue;
      }

      const candidateEffective = getEffectiveUser(candidate);
      const entryEffective = getEffectiveUser(entry);

      if (matchWithAnyone || isCompatible(candidateEffective, entryEffective)) {
        // Matched!
        clearBroadenTimer(candidate);
        clearBroadenTimer(entry);

        // Remove both from queue
        const [firstRemoved, secondRemoved] =
          entryIndex > candidateIndex
            ? [waitingQueue.splice(entryIndex, 1)[0], waitingQueue.splice(candidateIndex, 1)[0]]
            : [waitingQueue.splice(candidateIndex, 1)[0], waitingQueue.splice(entryIndex, 1)[0]];

        const caller = candidateIndex < entryIndex ? candidate : entry;
        const callee = caller === candidate ? entry : candidate;

        const sessionId = crypto.randomUUID();
        activeSessions.set(sessionId, {
          callerId: caller.socketId,
          calleeId: callee.socketId,
          createdAt: now()
        });

        userSessions.set(caller.socketId, { sessionId, partnerId: callee.socketId });
        userSessions.set(callee.socketId, { sessionId, partnerId: caller.socketId });

        return {
          status: "matched",
          sessionId,
          callerId: caller.socketId,
          calleeId: callee.socketId
        };
      }

      candidateIndex++;
    }

    return { status: "widened" };
  }

  function leaveSession(socketId) {
    const qIndex = waitingQueue.findIndex((item) => item.socketId === socketId);
    if (qIndex !== -1) {
      const [entry] = waitingQueue.splice(qIndex, 1);
      clearBroadenTimer(entry);
      return { wasWaiting: true };
    }

    const sessionInfo = userSessions.get(socketId);
    if (sessionInfo) {
      const { sessionId, partnerId } = sessionInfo;
      userSessions.delete(socketId);
      userSessions.delete(partnerId);
      activeSessions.delete(sessionId);

      // Record recent partners in both directions
      recordRecentPartners(socketId, partnerId);

      return { wasInSession: true, sessionId, partnerId };
    }

    return { wasIdle: true };
  }

  function disconnectUser(socketId) {
    const result = leaveSession(socketId);
    clearRecentPartners(socketId);
    return result;
  }

  function sweepGhosts(isSocketConnected) {
    const currentTime = now();
    const orphanedNotifications = [];

    // 1. Purge disconnected sockets from waiting queue
    let i = 0;
    while (i < waitingQueue.length) {
      const entry = waitingQueue[i];
      if (!isSocketConnected(entry.socketId)) {
        clearBroadenTimer(entry);
        waitingQueue.splice(i, 1);
      } else {
        i++;
      }
    }

    // 2. Dissolve orphaned sessions where either party disconnected
    for (const [sessionId, session] of activeSessions.entries()) {
      const callerConnected = isSocketConnected(session.callerId);
      const calleeConnected = isSocketConnected(session.calleeId);

      if (!callerConnected || !calleeConnected) {
        activeSessions.delete(sessionId);
        userSessions.delete(session.callerId);
        userSessions.delete(session.calleeId);

        if (callerConnected && !calleeConnected) {
          orphanedNotifications.push({ notifySocketId: session.callerId, sessionId });
        } else if (calleeConnected && !callerConnected) {
          orphanedNotifications.push({ notifySocketId: session.calleeId, sessionId });
        }
      }
    }

    // 3. Drop expired entries in recentPartners map
    for (const [sId, list] of recentPartners.entries()) {
      const activeList = list.filter((item) => item.expiresAt > currentTime);
      if (activeList.length === 0) {
        recentPartners.delete(sId);
      } else {
        recentPartners.set(sId, activeList);
      }
    }

    return orphanedNotifications;
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

  function getRecentPartners(socketId) {
    return recentPartners.get(socketId) ? [...recentPartners.get(socketId)] : [];
  }

  return {
    enqueueUser,
    broadenAccept,
    leaveSession,
    disconnectUser,
    sweepGhosts,
    getSessionInfo,
    getPartnerId,
    isQueued,
    isInSession,
    getWaitingQueue,
    getRecentPartners,
    isRecentPartner
  };
}
