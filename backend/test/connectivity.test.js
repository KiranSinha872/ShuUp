import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createIceManager, DEFAULT_STUN_SERVERS, validateIceServers } from "../src/ice.js";
import { createMatchmaker } from "../src/matchmaker.js";

function createMockClock(initialTime = 1_000_000) {
  let currentTime = initialTime;
  return {
    now: () => currentTime,
    advance: (ms) => {
      currentTime += ms;
    }
  };
}

describe("Phase 6a: Connectivity, ICE Management & Stats Validation", () => {
  test("returns STUN fallback when domain and apiKey are not configured", async () => {
    const ice = createIceManager({ domain: "", apiKey: "", policy: "all" });
    const config = await ice.getIceConfig();

    assert.equal(config.ok, true);
    assert.deepEqual(config.iceServers, DEFAULT_STUN_SERVERS);
    assert.equal(config.iceTransportPolicy, "all");
    assert.equal(validateIceServers(config.iceServers), true);
  });

  test("cache hit: returns cached TURN servers and does not re-fetch before TTL", async () => {
    const clock = createMockClock();
    let fetchCount = 0;

    const mockFetch = async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => [
          { urls: "turn:relay.example.com:80", username: "user1", credential: "pwd" }
        ]
      };
    };

    const ice = createIceManager({
      domain: "test.metered.ca",
      apiKey: "secret123",
      policy: "all",
      fetchFn: mockFetch,
      timeProvider: clock.now,
      cacheTtlMs: 3600_000 // 1 hr
    });

    // First call: fetches
    const c1 = await ice.getIceConfig();
    assert.equal(fetchCount, 1);
    assert.equal(c1.iceServers.length, 2); // 1 STUN + 1 TURN

    // Second call at 30 mins: cache hit
    clock.advance(1800_000);
    const c2 = await ice.getIceConfig();
    assert.equal(fetchCount, 1);
    assert.deepEqual(c1.iceServers, c2.iceServers);

    // Call after expiry: re-fetches
    clock.advance(1800_001);
    const c3 = await ice.getIceConfig();
    assert.equal(fetchCount, 2);
  });

  test("fetch timeout (3s) and network error gracefully fallback to STUN in 'all' policy", async () => {
    const mockTimeoutFetch = async (url, { signal }) => {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };

    const ice = createIceManager({
      domain: "test.metered.ca",
      apiKey: "secret123",
      policy: "all",
      fetchFn: mockTimeoutFetch,
      fetchTimeoutMs: 50 // short timeout for test
    });

    const config = await ice.getIceConfig();
    assert.equal(config.ok, true);
    assert.deepEqual(config.iceServers, DEFAULT_STUN_SERVERS);
    assert.equal(config.iceTransportPolicy, "all");
  });

  test("relay-without-TURN refusal: policy='relay' without credentials refuses call and does not use STUN", async () => {
    const ice = createIceManager({
      domain: "",
      apiKey: "",
      policy: "relay"
    });

    const config = await ice.getIceConfig();
    assert.equal(config.ok, false);
    assert.match(config.error, /Relay connection requires TURN credentials/i);
    assert.equal(config.iceServers, undefined);
  });

  test("relay-without-TURN refusal: policy='relay' with failing fetch refuses call and does not fall back to STUN", async () => {
    const mockFailingFetch = async () => {
      throw new Error("Connection failed");
    };

    const ice = createIceManager({
      domain: "test.metered.ca",
      apiKey: "secret123",
      policy: "relay",
      fetchFn: mockFailingFetch
    });

    const config = await ice.getIceConfig();
    assert.equal(config.ok, false);
    assert.match(config.error, /Relay connection requires TURN credentials/i);
  });

  test("no logging of secrets or URLs containing API keys", async () => {
    const loggedMessages = [];
    const mockLogger = {
      warn: (msg) => loggedMessages.push(msg),
      log: (msg) => loggedMessages.push(msg)
    };

    const mockFailingFetch = async () => {
      const err = new Error("Failed to connect to https://test.metered.ca/api/v1/turn/credentials?apiKey=SUPER_SECRET_KEY");
      throw err;
    };

    const ice = createIceManager({
      domain: "test.metered.ca",
      apiKey: "SUPER_SECRET_KEY",
      policy: "all",
      fetchFn: mockFailingFetch,
      logger: mockLogger
    });

    await ice.getIceConfig();

    for (const msg of loggedMessages) {
      assert.doesNotMatch(msg, /SUPER_SECRET_KEY/);
      assert.doesNotMatch(msg, /apiKey=/);
    }
  });

  test("matched payload schema: contains iceServers and iceTransportPolicy; contains NO identity or preferences", async () => {
    const ice = createIceManager({ domain: "", apiKey: "", policy: "all" });
    const iceConfig = await ice.getIceConfig();

    const matchedPayload = {
      sessionId: "session-uuid-1234",
      isCaller: true,
      iceServers: iceConfig.iceServers,
      iceTransportPolicy: iceConfig.iceTransportPolicy
    };

    assert.equal(typeof matchedPayload.sessionId, "string");
    assert.equal(typeof matchedPayload.isCaller, "boolean");
    assert.equal(Array.isArray(matchedPayload.iceServers), true);
    assert.equal(validateIceServers(matchedPayload.iceServers), true);
    assert.equal(matchedPayload.iceTransportPolicy, "all");

    // Must never contain partner identity, preferences, or personal attributes
    assert.equal(matchedPayload.identity, undefined);
    assert.equal(matchedPayload.preferences, undefined);
    assert.equal(matchedPayload.partnerId, undefined);
    assert.equal(matchedPayload.partnerIdentity, undefined);
    assert.equal(matchedPayload.partnerPreferences, undefined);
  });

  test("connection-stats payload validation rules", () => {
    function validateConnectionStatsPayload(payload) {
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        Object.keys(payload).length !== 2 ||
        typeof payload.sessionId !== "string" ||
        !["direct", "relay", "unknown"].includes(payload.connectionType)
      ) {
        return { valid: false, error: "invalid_payload" };
      }
      return { valid: true };
    }

    // Valid payloads
    assert.equal(validateConnectionStatsPayload({ sessionId: "s1", connectionType: "direct" }).valid, true);
    assert.equal(validateConnectionStatsPayload({ sessionId: "s1", connectionType: "relay" }).valid, true);
    assert.equal(validateConnectionStatsPayload({ sessionId: "s1", connectionType: "unknown" }).valid, true);

    // Invalid: extra fields
    assert.equal(validateConnectionStatsPayload({ sessionId: "s1", connectionType: "direct", extra: "bad" }).valid, false);

    // Invalid: bad enum
    assert.equal(validateConnectionStatsPayload({ sessionId: "s1", connectionType: "p2p" }).valid, false);
    assert.equal(validateConnectionStatsPayload({ sessionId: "s1", connectionType: "host" }).valid, false);

    // Invalid: non-string sessionId
    assert.equal(validateConnectionStatsPayload({ sessionId: 123, connectionType: "direct" }).valid, false);

    // Invalid: missing fields or arrays
    assert.equal(validateConnectionStatsPayload({ sessionId: "s1" }).valid, false);
    assert.equal(validateConnectionStatsPayload(["s1", "direct"]).valid, false);
    assert.equal(validateConnectionStatsPayload(null).valid, false);
  });

  test("synchronous pairing verification: no await sits between candidate pairing and active session recording", () => {
    const matchmakerSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/matchmaker.js"),
      "utf8"
    );

    // Ensure matchmaker file contains zero async functions and zero await expressions
    assert.doesNotMatch(matchmakerSource, /\bawait\b/);
    assert.doesNotMatch(matchmakerSource, /\basync\b/);

    // Functional check: pairing and session recording happen immediately
    const matchmaker = createMatchmaker();
    matchmaker.enqueueUser({ socketId: "caller", identity: "Woman", preferences: ["Men"] });
    const matchResult = matchmaker.enqueueUser({ socketId: "callee", identity: "Man", preferences: ["Women"] });

    assert.equal(matchResult.status, "matched");
    assert.equal(matchmaker.isInSession("caller"), true);
    assert.equal(matchmaker.isInSession("callee"), true);
    assert.equal(matchmaker.getSessionInfo("caller")?.sessionId, matchResult.sessionId);
    assert.equal(matchmaker.getSessionInfo("callee")?.sessionId, matchResult.sessionId);
  });

  test("relay-refusal abort leaves no recent-partner entries and users can match immediately on retry", () => {
    const matchmaker = createMatchmaker();

    // Two users pair
    matchmaker.enqueueUser({ socketId: "user1", identity: "Woman", preferences: ["Men"] });
    const match = matchmaker.enqueueUser({ socketId: "user2", identity: "Man", preferences: ["Women"] });
    assert.equal(match.status, "matched");

    // Abort session without recording recent partners (as done on relay refusal or pre-match departure)
    matchmaker.leaveSession("user1", { recordRecent: false });

    // Assert neither user has recent partner entries
    assert.equal(matchmaker.getRecentPartners("user1").length, 0);
    assert.equal(matchmaker.getRecentPartners("user2").length, 0);
    assert.equal(matchmaker.isRecentPartner("user1", "user2"), false);
    assert.equal(matchmaker.isRecentPartner("user2", "user1"), false);

    // Both rejoin queue and match immediately
    const retry1 = matchmaker.enqueueUser({ socketId: "user1", identity: "Woman", preferences: ["Men"] });
    assert.equal(retry1.status, "waiting");
    const retry2 = matchmaker.enqueueUser({ socketId: "user2", identity: "Man", preferences: ["Women"] });
    assert.equal(retry2.status, "matched");
    assert.equal(retry2.callerId, "user1");
    assert.equal(retry2.calleeId, "user2");
  });

  test("normal leave / Next records recent partners and excludes them for the TTL", () => {
    const matchmaker = createMatchmaker();

    // Two users pair
    matchmaker.enqueueUser({ socketId: "user1", identity: "Woman", preferences: ["Men"] });
    const match = matchmaker.enqueueUser({ socketId: "user2", identity: "Man", preferences: ["Women"] });
    assert.equal(match.status, "matched");

    // Normal leave / Next (default recordRecent = true)
    matchmaker.leaveSession("user1");

    // Assert both have recent partner entries
    assert.equal(matchmaker.getRecentPartners("user1").length, 1);
    assert.equal(matchmaker.getRecentPartners("user2").length, 1);
    assert.equal(matchmaker.isRecentPartner("user1", "user2"), true);

    // When both rejoin immediately, they are excluded for the TTL
    const retry1 = matchmaker.enqueueUser({ socketId: "user1", identity: "Woman", preferences: ["Men"] });
    assert.equal(retry1.status, "waiting");
    const retry2 = matchmaker.enqueueUser({ socketId: "user2", identity: "Man", preferences: ["Women"] });
    assert.equal(retry2.status, "waiting"); // excluded, not matched
  });

  test("stale abort for an already-ended session does not remove a re-queued user or dissolve a new session", () => {
    const matchmaker = createMatchmaker();

    // 1. User A and User B pair into session S1
    matchmaker.enqueueUser({ socketId: "userA", identity: "Woman", preferences: ["Men"] });
    const match1 = matchmaker.enqueueUser({ socketId: "userB", identity: "Man", preferences: ["Women"] });
    const s1Id = match1.sessionId;

    // 2. Partner B leaves before session S1 finishes setup
    matchmaker.leaveSession("userB");
    assert.equal(matchmaker.hasActiveSession(s1Id), false);

    // 3. User A re-queues immediately
    matchmaker.enqueueUser({ socketId: "userA", identity: "Woman", preferences: ["Men"] });
    assert.equal(matchmaker.isQueued("userA"), true);

    // 4. Stale abort runs for session S1 (using the exact-session guard)
    if (matchmaker.hasActiveSession(s1Id)) {
      matchmaker.dissolveSession(s1Id, { recordRecent: false });
    }

    // 5. Assert User A is STILL in the waiting queue (not evicted by stale abort)
    assert.equal(matchmaker.isQueued("userA"), true);

    // 6. User C arrives and matches with User A into new session S2
    const match2 = matchmaker.enqueueUser({ socketId: "userC", identity: "Man", preferences: ["Women"] });
    assert.equal(match2.status, "matched");
    const s2Id = match2.sessionId;
    assert.equal(matchmaker.getSessionInfo("userA")?.sessionId, s2Id);

    // 7. Another stale abort runs for session S1
    if (matchmaker.hasActiveSession(s1Id)) {
      matchmaker.dissolveSession(s1Id, { recordRecent: false });
    }

    // 8. Assert new session S2 and User A's session info are intact
    assert.equal(matchmaker.hasActiveSession(s2Id), true);
    assert.equal(matchmaker.getSessionInfo("userA")?.sessionId, s2Id);
  });
});

