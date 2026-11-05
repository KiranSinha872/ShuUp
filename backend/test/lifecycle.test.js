import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMatchmaker } from "../src/matchmaker.js";
import { parseNumber } from "../src/config.js";

describe("Phase 5: Session Lifecycle, Recent Partners & Broaden Logic", () => {
  function createMockClock(initialTime = 1000) {
    let currentTime = initialTime;
    let nextTimerId = 1;
    const timers = new Map();

    const timeProvider = () => currentTime;

    const scheduleTimeout = (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, fireAt: currentTime + ms });
      return id;
    };

    const cancelTimeout = (id) => {
      timers.delete(id);
    };

    const advanceTime = (ms) => {
      currentTime += ms;
      // Fire any scheduled timers whose fireAt <= currentTime
      const toFire = [];
      for (const [id, timer] of timers.entries()) {
        if (timer.fireAt <= currentTime) {
          toFire.push({ id, fn: timer.fn });
        }
      }
      for (const { id, fn } of toFire) {
        timers.delete(id);
        fn();
      }
    };

    const hasTimer = (id) => timers.has(id);
    const activeTimerCount = () => timers.size;

    return {
      timeProvider,
      scheduleTimeout,
      cancelTimeout,
      advanceTime,
      hasTimer,
      activeTimerCount
    };
  }

  test("recent partners are not rematched within TTL, but are matchable again after expiry", () => {
    const clock = createMockClock();
    const matchmaker = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
      recentPartnerTtlMs: 120_000
    });

    const isConnected = () => true;

    // 1. User A (Woman, wants Men) & User B (Man, wants Women) join and match
    matchmaker.enqueueUser({ socketId: "userA", identity: "Woman", preferences: ["Men"] }, isConnected);
    const m1 = matchmaker.enqueueUser({ socketId: "userB", identity: "Man", preferences: ["Women"] }, isConnected);
    assert.equal(m1.status, "matched");

    // 2. Session ends (e.g. Next / Leave)
    matchmaker.leaveSession("userA");

    // 3. User A and User B re-enter queue immediately (at t = 1000)
    const qA = matchmaker.enqueueUser({ socketId: "userA", identity: "Woman", preferences: ["Men"] }, isConnected);
    const qB = matchmaker.enqueueUser({ socketId: "userB", identity: "Man", preferences: ["Women"] }, isConnected);

    // They must NOT rematch because they are recent partners
    assert.equal(qA.status, "waiting");
    assert.equal(qB.status, "waiting");
    assert.equal(matchmaker.getWaitingQueue().length, 2);

    // 4. Advance time past TTL (120s + 1s)
    clock.advanceTime(121_000);

    // 5. User A leaves and re-enters
    matchmaker.leaveSession("userA");
    const m2 = matchmaker.enqueueUser({ socketId: "userA", identity: "Woman", preferences: ["Men"] }, isConnected);

    // Now they match because recent-partner TTL has expired
    assert.equal(m2.status, "matched");
    assert.equal(m2.callerId, "userB");
    assert.equal(m2.calleeId, "userA");
  });

  test("recent-partner skip continues to the next compatible candidate in queue", () => {
    const clock = createMockClock();
    const matchmaker = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
      recentPartnerTtlMs: 120_000
    });
    const isConnected = () => true;

    // Pair A and B, then end session
    matchmaker.enqueueUser({ socketId: "userA", identity: "Woman", preferences: ["Men"] }, isConnected);
    matchmaker.enqueueUser({ socketId: "userB", identity: "Man", preferences: ["Women"] }, isConnected);
    matchmaker.leaveSession("userA");

    // Queue userB (Man, wants Women)
    matchmaker.enqueueUser({ socketId: "userB", identity: "Man", preferences: ["Women"] }, isConnected);

    // Queue userC (Man, wants Women)
    matchmaker.enqueueUser({ socketId: "userC", identity: "Man", preferences: ["Women"] }, isConnected);

    // User A joins (Woman, wants Men). B is recent partner, so matchmaker skips B and pairs A with C!
    const result = matchmaker.enqueueUser({ socketId: "userA", identity: "Woman", preferences: ["Men"] }, isConnected);
    assert.equal(result.status, "matched");
    assert.equal(result.callerId, "userC");
    assert.equal(result.calleeId, "userA");

    // B is still waiting in queue
    const queue = matchmaker.getWaitingQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].socketId, "userB");
  });

  test("cleanup on disconnect deletes socket from recent-partners cache", () => {
    const clock = createMockClock();
    const matchmaker = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout
    });
    const isConnected = () => true;

    // Pair A and B in an active session
    matchmaker.enqueueUser({ socketId: "userA", identity: "Woman", preferences: ["Men"] }, isConnected);
    matchmaker.enqueueUser({ socketId: "userB", identity: "Man", preferences: ["Women"] }, isConnected);
    assert.equal(matchmaker.isInSession("userA"), true);
    assert.equal(matchmaker.isInSession("userB"), true);

    // User A disconnects while in active session
    const disconnRes = matchmaker.disconnectUser("userA");
    assert.equal(disconnRes.wasInSession, true);
    assert.equal(disconnRes.partnerId, "userB");

    // Disconnected socket userA has no key left in recent-partner map
    assert.equal(matchmaker.getRecentPartners("userA").length, 0);

    // Surviving partner userB re-enters queue and can match with someone else (userC)
    matchmaker.enqueueUser({ socketId: "userB", identity: "Man", preferences: ["Women"] }, isConnected);
    const match = matchmaker.enqueueUser({ socketId: "userC", identity: "Woman", preferences: ["Men"] }, isConnected);

    assert.equal(match.status, "matched");
    assert.equal(match.callerId, "userB");
    assert.equal(match.calleeId, "userC");
  });

  test("broaden timer fires broaden-prompt after broadenWaitSeconds, only once", () => {
    const clock = createMockClock();
    const matchmaker = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
      broadenWaitSeconds: 30
    });

    let promptCount = 0;
    let promptedSocket = null;
    const onPrompt = (socketId) => {
      promptCount++;
      promptedSocket = socketId;
    };

    matchmaker.enqueueUser({ socketId: "sara", identity: "Woman", preferences: ["Women"] }, () => true, onPrompt);

    // At 20s, timer has not fired
    clock.advanceTime(20_000);
    assert.equal(promptCount, 0);

    // At 30s, timer fires exactly once
    clock.advanceTime(10_000);
    assert.equal(promptCount, 1);
    assert.equal(promptedSocket, "sara");

    // Advancing further does not fire again
    clock.advanceTime(40_000);
    assert.equal(promptCount, 1);
  });

  test("broaden-accept is ignored from non-queued, unprompted, or already-widened sockets", () => {
    const clock = createMockClock();
    const matchmaker = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
      broadenWaitSeconds: 30
    });

    // 1. Non-queued socket
    assert.equal(matchmaker.broadenAccept("ghost").status, "ignored_not_queued");

    // 2. Queued but unprompted socket (0 seconds in queue)
    matchmaker.enqueueUser({ socketId: "userX", identity: "Woman", preferences: ["Women"] }, () => true);
    assert.equal(matchmaker.broadenAccept("userX").status, "ignored_not_prompted");

    // Advance 30s to trigger prompt
    clock.advanceTime(30_000);

    // 3. Prompted socket accepts -> accepted (status: widened)
    assert.equal(matchmaker.broadenAccept("userX").status, "widened");

    // 4. Accepting again when already widened is ignored
    assert.equal(matchmaker.broadenAccept("userX").status, "ignored_already_widened");
  });

  test("widening applies to that queue entry only; does not persist to next queue entry", () => {
    const clock = createMockClock();
    const matchmaker = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
      broadenWaitSeconds: 30
    });
    const isConnected = () => true;

    // Sara joins seeking Women only
    matchmaker.enqueueUser({ socketId: "sara", identity: "Woman", preferences: ["Women"] }, isConnected);
    clock.advanceTime(30_000);

    // Sara widens
    matchmaker.broadenAccept("sara", isConnected);
    assert.equal(matchmaker.getWaitingQueue()[0].isWidened, true);

    // Sara leaves queue
    matchmaker.leaveSession("sara");

    // Sara re-joins with original preferences ["Women"]
    matchmaker.enqueueUser({ socketId: "sara", identity: "Woman", preferences: ["Women"] }, isConnected);
    assert.equal(matchmaker.getWaitingQueue()[0].isWidened, false);
    assert.deepEqual(matchmaker.getWaitingQueue()[0].preferences, ["Women"]);
  });

  test("broaden-accept matches Sara and Alex, but does not match when other side rejects", () => {
    const clock = createMockClock();
    const matchmaker = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
      broadenWaitSeconds: 30
    });
    const isConnected = () => true;

    // Sara (Woman, wants Women)
    matchmaker.enqueueUser({ socketId: "sara", identity: "Woman", preferences: ["Women"] }, isConnected);

    // Alex (Non-binary, wants Anyone) -> incompatible with Sara
    matchmaker.enqueueUser({ socketId: "alex", identity: "Non-binary", preferences: ["Anyone"] }, isConnected);

    assert.equal(matchmaker.getWaitingQueue().length, 2);

    // Trigger broaden prompt for Sara
    clock.advanceTime(30_000);

    // Sara accepts broaden
    const result = matchmaker.broadenAccept("sara", isConnected);

    // Now Sara accepts Alex (because Sara is widened to Anyone, and Alex accepts Anyone)
    assert.equal(result.status, "matched");
    assert.equal(matchmaker.getWaitingQueue().length, 0);

    // Counter-test: User M (Man, wants Women) accepts broaden, but User W (Woman, wants Women) still rejects Men
    const m3 = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
      broadenWaitSeconds: 30
    });

    m3.enqueueUser({ socketId: "userM", identity: "Man", preferences: ["Women"] }, isConnected);
    m3.enqueueUser({ socketId: "userW", identity: "Woman", preferences: ["Women"] }, isConnected);
    clock.advanceTime(30_000);

    // User M widens to Anyone, but User W only wants Women -> mutual compatibility fails!
    const widenResult = m3.broadenAccept("userM", isConnected);
    assert.equal(widenResult.status, "widened");
    assert.equal(m3.getWaitingQueue().length, 2);
  });

  test("broaden timers are cancelled on leave, match and disconnect", () => {
    const clock = createMockClock();
    const matchmaker = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout,
      broadenWaitSeconds: 30
    });

    let promptCount = 0;
    const onPrompt = () => promptCount++;

    // 1. Enqueue and leave before 30s
    matchmaker.enqueueUser({ socketId: "user1", identity: "Man", preferences: ["Women"] }, () => true, onPrompt);
    assert.equal(clock.activeTimerCount(), 1);
    matchmaker.leaveSession("user1");
    assert.equal(clock.activeTimerCount(), 0);

    // 2. Enqueue and match before 30s
    matchmaker.enqueueUser({ socketId: "user2", identity: "Man", preferences: ["Women"] }, () => true, onPrompt);
    assert.equal(clock.activeTimerCount(), 1);
    matchmaker.enqueueUser({ socketId: "user3", identity: "Woman", preferences: ["Men"] }, () => true, onPrompt);
    assert.equal(clock.activeTimerCount(), 0);

    // 3. Enqueue and disconnect before 30s
    matchmaker.enqueueUser({ socketId: "user4", identity: "Man", preferences: ["Women"] }, () => true, onPrompt);
    assert.equal(clock.activeTimerCount(), 1);
    matchmaker.disconnectUser("user4");
    assert.equal(clock.activeTimerCount(), 0);

    // Advance 30s; prompt should never fire
    clock.advanceTime(30_000);
    assert.equal(promptCount, 0);
  });

  test("ghost sweep removes dead sockets and dissolves orphaned sessions", () => {
    const clock = createMockClock();
    const matchmaker = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout
    });

    const liveSockets = new Set(["live1", "deadWaiting", "deadPartner", "survivingPartner"]);
    const isConnected = (id) => liveSockets.has(id);

    // 1. Queue live1 (Woman wants Women) and deadWaiting (Man wants Men) -> Incompatible, both wait
    matchmaker.enqueueUser({ socketId: "live1", identity: "Woman", preferences: ["Women"] }, isConnected);
    matchmaker.enqueueUser({ socketId: "deadWaiting", identity: "Man", preferences: ["Men"] }, isConnected);

    // 2. Pair deadPartner & survivingPartner into an active session
    matchmaker.enqueueUser({ socketId: "deadPartner", identity: "Man", preferences: ["Women"] }, isConnected);
    matchmaker.enqueueUser({ socketId: "survivingPartner", identity: "Woman", preferences: ["Men"] }, isConnected);

    // Simulate dead sockets
    liveSockets.delete("deadWaiting");
    liveSockets.delete("deadPartner");

    // Perform sweep
    const orphaned = matchmaker.sweepGhosts(isConnected);

    // Assert deadWaiting was purged from queue
    const queue = matchmaker.getWaitingQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].socketId, "live1");

    // Assert orphaned session was dissolved and surviving partner notified
    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0].notifySocketId, "survivingPartner");
    assert.equal(matchmaker.getSessionInfo("survivingPartner"), null);
  });

  test("rapid Next cannot double-queue", () => {
    const clock = createMockClock();
    const matchmaker = createMatchmaker({
      timeProvider: clock.timeProvider,
      scheduleTimeout: clock.scheduleTimeout,
      cancelTimeout: clock.cancelTimeout
    });
    const isConnected = () => true;

    // User enqueues
    const r1 = matchmaker.enqueueUser({ socketId: "userFast", identity: "Man", preferences: ["Women"] }, isConnected);
    assert.equal(r1.status, "waiting");

    // User attempts duplicate enqueue
    const r2 = matchmaker.enqueueUser({ socketId: "userFast", identity: "Man", preferences: ["Women"] }, isConnected);
    assert.equal(r2.status, "already_queued_or_in_session");

    assert.equal(matchmaker.getWaitingQueue().length, 1);
  });

  test("config parseNumber handles missing, invalid, NaN, negative, and valid numbers", () => {
    assert.equal(parseNumber(undefined, 30), 30);
    assert.equal(parseNumber(null, 30), 30);
    assert.equal(parseNumber("", 30), 30);
    assert.equal(parseNumber("not-a-number", 30), 30);
    assert.equal(parseNumber("-5", 30), 30);
    assert.equal(parseNumber("0", 30), 30);
    assert.equal(parseNumber("45", 30), 45);
    assert.equal(parseNumber(60, 30), 60);
  });
});
