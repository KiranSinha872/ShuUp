import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMatchmaker } from "../src/matchmaker.js";

describe("Matchmaker queue and pairing logic", () => {
  test("reproduces 6-user arrival scenario from section 6.4 of the brief", () => {
    const matchmaker = createMatchmaker();
    const connectedSockets = new Set(["aman", "priya", "sara", "ravi", "neha", "alex"]);
    const isConnected = (id) => connectedSockets.has(id);

    // 1. Aman joins (Man, wants Women) -> Queue empty, waits
    const r1 = matchmaker.enqueueUser(
      { socketId: "aman", identity: "Man", preferences: ["Women"] },
      isConnected
    );
    assert.equal(r1.status, "waiting");

    // 2. Priya joins (Woman, wants Men) -> Aman & Priya compatible -> Matched!
    const r2 = matchmaker.enqueueUser(
      { socketId: "priya", identity: "Woman", preferences: ["Men"] },
      isConnected
    );
    assert.equal(r2.status, "matched");
    assert.equal(r2.callerId, "aman");
    assert.equal(r2.calleeId, "priya");
    assert.ok(r2.sessionId);

    // 3. Sara joins (Woman, wants Women) -> Queue empty, waits
    const r3 = matchmaker.enqueueUser(
      { socketId: "sara", identity: "Woman", preferences: ["Women"] },
      isConnected
    );
    assert.equal(r3.status, "waiting");

    // 4. Ravi joins (Man, wants Anyone) -> Sara wants Women only -> Incompatible, waits
    const r4 = matchmaker.enqueueUser(
      { socketId: "ravi", identity: "Man", preferences: ["Anyone"] },
      isConnected
    );
    assert.equal(r4.status, "waiting");

    // 5. Neha joins (Woman, wants Men) -> Sara first (fails), Ravi next (matches!) -> Matched with Ravi!
    const r5 = matchmaker.enqueueUser(
      { socketId: "neha", identity: "Woman", preferences: ["Men"] },
      isConnected
    );
    assert.equal(r5.status, "matched");
    assert.equal(r5.callerId, "ravi");
    assert.equal(r5.calleeId, "neha");

    // 6. Alex joins (Non-binary, wants Anyone) -> Sara wants Women only -> Incompatible, waits
    const r6 = matchmaker.enqueueUser(
      { socketId: "alex", identity: "Non-binary", preferences: ["Anyone"] },
      isConnected
    );
    assert.equal(r6.status, "waiting");

    // Assert final queue state: Sara and Alex are still waiting in order
    const queue = matchmaker.getWaitingQueue();
    assert.equal(queue.length, 2);
    assert.equal(queue[0].socketId, "sara");
    assert.equal(queue[1].socketId, "alex");

    // Verify session mappings for paired users
    assert.equal(matchmaker.getPartnerId("aman"), "priya");
    assert.equal(matchmaker.getPartnerId("priya"), "aman");
    assert.equal(matchmaker.getPartnerId("ravi"), "neha");
    assert.equal(matchmaker.getPartnerId("neha"), "ravi");
    assert.equal(matchmaker.getPartnerId("sara"), null);
    assert.equal(matchmaker.getPartnerId("alex"), null);
  });

  test("two compatible users waiting: newcomer matches with the longest waiter", () => {
    const matchmaker = createMatchmaker();
    const isConnected = () => true;

    // User 1 arrives first (Woman, wants Men)
    const r1 = matchmaker.enqueueUser(
      { socketId: "woman_1", identity: "Woman", preferences: ["Men"] },
      isConnected
    );
    assert.equal(r1.status, "waiting");

    // User 2 arrives second (Woman, wants Men)
    const r2 = matchmaker.enqueueUser(
      { socketId: "woman_2", identity: "Woman", preferences: ["Men"] },
      isConnected
    );
    assert.equal(r2.status, "waiting");

    // User 3 arrives (Man, wants Women) -> Compatible with both woman_1 and woman_2
    const r3 = matchmaker.enqueueUser(
      { socketId: "man_3", identity: "Man", preferences: ["Women"] },
      isConnected
    );

    // Assert matched with woman_1 (longest waiter)
    assert.equal(r3.status, "matched");
    assert.equal(r3.callerId, "woman_1");
    assert.equal(r3.calleeId, "man_3");

    // Assert woman_2 is still waiting
    const remainingQueue = matchmaker.getWaitingQueue();
    assert.equal(remainingQueue.length, 1);
    assert.equal(remainingQueue[0].socketId, "woman_2");
  });

  test("discards disconnected sockets during queue scan", () => {
    const matchmaker = createMatchmaker();
    const liveSockets = new Set(["waiter_1", "waiter_2"]);
    const isConnected = (id) => liveSockets.has(id);

    // waiter_1 enters
    matchmaker.enqueueUser(
      { socketId: "waiter_1", identity: "Woman", preferences: ["Men"] },
      isConnected
    );

    // waiter_1 loses connection
    liveSockets.delete("waiter_1");

    // newcomer enters
    const r = matchmaker.enqueueUser(
      { socketId: "waiter_2", identity: "Man", preferences: ["Women"] },
      isConnected
    );

    // waiter_1 was purged because it was disconnected; waiter_2 waits
    assert.equal(r.status, "waiting");
    const queue = matchmaker.getWaitingQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].socketId, "waiter_2");
  });

  test("MATCH_WITH_ANYONE feature flag bypasses preference check", () => {
    const matchmaker = createMatchmaker({ matchWithAnyone: true });
    const isConnected = () => true;

    // User 1 (Woman wants Women)
    matchmaker.enqueueUser(
      { socketId: "user_1", identity: "Woman", preferences: ["Women"] },
      isConnected
    );

    // User 2 (Man wants Men) -> normally incompatible, but feature flag pairs them
    const r2 = matchmaker.enqueueUser(
      { socketId: "user_2", identity: "Man", preferences: ["Men"] },
      isConnected
    );

    assert.equal(r2.status, "matched");
    assert.equal(r2.callerId, "user_1");
    assert.equal(r2.calleeId, "user_2");
  });
});

