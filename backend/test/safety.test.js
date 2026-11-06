import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validateStartupConfig
} from "../src/config.js";
import {
  hashToken,
  validateInviteCode,
  resolveClientAddress,
  sanitizeNote,
  TokenBucket,
  createSafetyManager,
  REPORT_CATEGORIES
} from "../src/safety.js";
import { createMatchmaker } from "../src/matchmaker.js";

test("Phase 7a: Startup Configuration Validation", async (t) => {
  await t.test("fails safely if SERVER_SALT is missing when REQUIRE_INVITE=true", () => {
    assert.throws(
      () => {
        validateStartupConfig({
          REQUIRE_INVITE: true,
          SERVER_SALT: "",
          INVITE_CODES: ["1234567890abcdef"]
        });
      },
      (err) => {
        assert.match(err.message, /SERVER_SALT is missing or shorter than 32 characters/);
        assert.doesNotMatch(err.message, /1234567890abcdef/);
        return true;
      }
    );
  });

  await t.test("fails safely if SERVER_SALT is shorter than 32 characters", () => {
    assert.throws(
      () => {
        validateStartupConfig({
          REQUIRE_INVITE: true,
          SERVER_SALT: "short-salt-under-32-chars",
          INVITE_CODES: ["1234567890abcdef"]
        });
      },
      (err) => {
        assert.match(err.message, /SERVER_SALT is missing or shorter than 32 characters/);
        return true;
      }
    );
  });

  await t.test("fails safely if INVITE_CODES is missing or empty", () => {
    assert.throws(
      () => {
        validateStartupConfig({
          REQUIRE_INVITE: true,
          SERVER_SALT: "0123456789abcdef0123456789abcdef0123456789abcdef",
          INVITE_CODES: []
        });
      },
      (err) => {
        assert.match(err.message, /INVITE_CODES is missing or empty/);
        return true;
      }
    );
  });

  await t.test("fails safely if any invite code is shorter than 16 characters", () => {
    assert.throws(
      () => {
        validateStartupConfig({
          REQUIRE_INVITE: true,
          SERVER_SALT: "0123456789abcdef0123456789abcdef0123456789abcdef",
          INVITE_CODES: ["valid-code-longer-than-16", "short-code"]
        });
      },
      (err) => {
        assert.match(err.message, /shorter than 16 characters/);
        assert.doesNotMatch(err.message, /short-code/);
        return true;
      }
    );
  });

  await t.test("passes validation with valid salt (>=32) and codes (>=16)", () => {
    assert.doesNotThrow(() => {
      validateStartupConfig({
        REQUIRE_INVITE: true,
        SERVER_SALT: "0123456789abcdef0123456789abcdef0123456789abcdef",
        INVITE_CODES: ["1234567890abcdef", "fedcba0987654321"]
      });
    });
  });

  await t.test("passes validation when REQUIRE_INVITE=false even if salt/codes are empty", () => {
    assert.doesNotThrow(() => {
      validateStartupConfig({
        REQUIRE_INVITE: false,
        SERVER_SALT: "",
        INVITE_CODES: []
      });
    });
  });
});

test("Phase 7a: Token Hashing & Invite Verification", async (t) => {
  const salt = "0123456789abcdef0123456789abcdef0123456789abcdef";

  await t.test("HMAC-SHA256 determinism", () => {
    const hash1 = hashToken("client-token-12345", salt);
    const hash2 = hashToken("client-token-12345", salt);
    const hash3 = hashToken("client-token-67890", salt);

    assert.equal(typeof hash1, "string");
    assert.equal(hash1.length, 64);
    assert.equal(hash1, hash2);
    assert.notEqual(hash1, hash3);
  });

  await t.test("constant-time invite code comparison", () => {
    const codes = ["1234567890abcdef", "fedcba0987654321"];
    assert.equal(validateInviteCode("1234567890abcdef", codes), true);
    assert.equal(validateInviteCode("fedcba0987654321", codes), true);
    assert.equal(validateInviteCode("wrong-code-here-12345", codes), false);
    assert.equal(validateInviteCode("", codes), false);
    assert.equal(validateInviteCode(null, codes), false);
  });
});

test("Phase 7a: Handshake Authentication & Shared-Address Lockout", async (t) => {
  let currentTime = 1_000_000;
  const timeProvider = () => currentTime;
  const salt = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const validCode = "1234567890abcdef";

  const safety = createSafetyManager({
    timeProvider,
    serverSalt: salt,
    inviteCodes: [validCode],
    requireInvite: true,
    maxSocketsPerAddress: 50,
    maxTotalConnections: 100,
    bannedTokens: [hashToken("banned-token-uuid", salt)]
  });

  await t.test("rejects missing or short client tokens", () => {
    const res = safety.authenticateHandshake({
      address: "1.2.3.4",
      auth: { inviteCode: validCode, clientToken: "short" }
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "INVALID_CLIENT_TOKEN");
  });

  await t.test("rejects banned token", () => {
    const res = safety.authenticateHandshake({
      address: "1.2.3.4",
      auth: { inviteCode: validCode, clientToken: "banned-token-uuid" }
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "BANNED");
  });

  await t.test("correct code never triggers lockout", () => {
    for (let i = 0; i < 10; i++) {
      const res = safety.authenticateHandshake({
        address: `10.0.0.${i}`,
        auth: { inviteCode: validCode, clientToken: `valid-token-${i}-xyz` }
      });
      assert.equal(res.ok, true);
    }
  });

  await t.test("5 failed attempts locks out specific address + clientToken pair", () => {
    const addr = "192.168.1.100";
    const tokenA = "attacker-token-alpha";

    for (let i = 0; i < 4; i++) {
      const res = safety.authenticateHandshake({
        address: addr,
        auth: { inviteCode: "wrong-code-try", clientToken: tokenA }
      });
      assert.equal(res.ok, false);
      assert.equal(res.error, "INVALID_INVITE_CODE");
    }

    // 5th attempt locks out
    const fifth = safety.authenticateHandshake({
      address: addr,
      auth: { inviteCode: "wrong-code-try", clientToken: tokenA }
    });
    assert.equal(fifth.ok, false);
    assert.equal(fifth.error, "INVALID_INVITE_CODE");

    // 6th attempt is locked out even with correct code
    const sixth = safety.authenticateHandshake({
      address: addr,
      auth: { inviteCode: validCode, clientToken: tokenA }
    });
    assert.equal(sixth.ok, false);
    assert.equal(sixth.error, "INVITE_LOCKED_OUT");
  });

  await t.test("shared address does NOT lock out a different clientToken", () => {
    const addr = "192.168.1.100";
    const tokenB = "innocent-roommate-token";

    // Innocent token on same shared Wi-Fi IP connects successfully with valid code
    const res = safety.authenticateHandshake({
      address: addr,
      auth: { inviteCode: validCode, clientToken: tokenB }
    });
    assert.equal(res.ok, true);
  });

  await t.test("enforces maxSocketsPerAddress and maxTotalConnections", () => {
    const limitedSafety = createSafetyManager({
      serverSalt: salt,
      inviteCodes: [validCode],
      requireInvite: true,
      maxSocketsPerAddress: 2,
      maxTotalConnections: 3
    });

    const conn1 = limitedSafety.authenticateHandshake({
      address: "10.0.0.1",
      auth: { inviteCode: validCode, clientToken: "token-1-abc" }
    });
    assert.equal(conn1.ok, true);

    const conn2 = limitedSafety.authenticateHandshake({
      address: "10.0.0.1",
      auth: { inviteCode: validCode, clientToken: "token-2-def" }
    });
    assert.equal(conn2.ok, true);

    // 3rd from same IP rejected by maxSocketsPerAddress
    const conn3 = limitedSafety.authenticateHandshake({
      address: "10.0.0.1",
      auth: { inviteCode: validCode, clientToken: "token-3-ghi" }
    });
    assert.equal(conn3.ok, false);
    assert.equal(conn3.error, "MAX_ADDRESS_CONNECTIONS_REACHED");

    // From different IP allowed, hits total max (3)
    const conn4 = limitedSafety.authenticateHandshake({
      address: "10.0.0.2",
      auth: { inviteCode: validCode, clientToken: "token-4-jkl" }
    });
    assert.equal(conn4.ok, true);

    // 4th overall rejected by maxTotalConnections
    const conn5 = limitedSafety.authenticateHandshake({
      address: "10.0.0.3",
      auth: { inviteCode: validCode, clientToken: "token-5-mno" }
    });
    assert.equal(conn5.ok, false);
    assert.equal(conn5.error, "MAX_SERVER_CONNECTIONS_REACHED");

    // Releasing connection frees slot
    limitedSafety.releaseConnection("10.0.0.1");
    const conn6 = limitedSafety.authenticateHandshake({
      address: "10.0.0.3",
      auth: { inviteCode: validCode, clientToken: "token-6-pqr" }
    });
    assert.equal(conn6.ok, true);
  });

  await t.test("rotating 200 fresh tokens from one address gets locked out at the address threshold", () => {
    const rotAddr = "192.168.20.1";
    // 50 attempts return INVALID_INVITE_CODE
    for (let i = 0; i < 50; i++) {
      const res = safety.authenticateHandshake({
        address: rotAddr,
        auth: { inviteCode: "bad_code_try", clientToken: `token-rot-${i}-abcdef` }
      });
      assert.equal(res.ok, false);
      assert.equal(res.error, "INVALID_INVITE_CODE");
    }

    // 51st through 200th attempts are locked out by address lockout
    for (let i = 50; i < 200; i++) {
      const res = safety.authenticateHandshake({
        address: rotAddr,
        auth: { inviteCode: "bad_code_try", clientToken: `token-rot-${i}-abcdef` }
      });
      assert.equal(res.ok, false);
      assert.equal(res.error, "INVITE_LOCKED_OUT");
    }

    // Even valid code is blocked while address is locked out
    const validBlocked = safety.authenticateHandshake({
      address: rotAddr,
      auth: { inviteCode: validCode, clientToken: "token-rot-fresh-valid" }
    });
    assert.equal(validBlocked.ok, false);
    assert.equal(validBlocked.error, "INVITE_LOCKED_OUT");
  });

  await t.test("different address is unaffected when first address is locked out", () => {
    const freshAddr = "192.168.20.2";
    const res = safety.authenticateHandshake({
      address: freshAddr,
      auth: { inviteCode: validCode, clientToken: "token-fresh-addr-ok" }
    });
    assert.equal(res.ok, true);
  });

  await t.test("valid codes from a shared address never trip either counter", () => {
    const sharedAddr = "192.168.30.1";
    for (let i = 0; i < 60; i++) {
      const res = safety.authenticateHandshake({
        address: sharedAddr,
        auth: { inviteCode: validCode, clientToken: `shared-valid-token-${i}` }
      });
      assert.equal(res.ok, true, `Attempt ${i} should succeed`);
      safety.releaseConnection(sharedAddr);
    }
    assert.equal(safety.isLockedOut(sharedAddr, "shared-valid-token-any"), false);
    assert.equal(safety._getAddressLockouts().has(sharedAddr), false);
  });

  await t.test("old records are removed by sweepExpired()", () => {
    const partialAddr = "192.168.40.1";
    const partialToken = "token-partial-attempts";
    // 2 failed attempts (under 5 token limit and 50 address limit)
    safety.authenticateHandshake({
      address: partialAddr,
      auth: { inviteCode: "wrong-code", clientToken: partialToken }
    });
    safety.authenticateHandshake({
      address: partialAddr,
      auth: { inviteCode: "wrong-code", clientToken: partialToken }
    });

    assert.ok(safety._getLockouts().has(`${partialAddr}:${partialToken}`));
    assert.ok(safety._getAddressLockouts().has(partialAddr));

    // Advance clock past lockout window (15 minutes + 1 ms)
    currentTime += 15 * 60 * 1000 + 1;
    safety.sweepExpired();

    // Both partial records must be purged
    assert.equal(safety._getLockouts().has(`${partialAddr}:${partialToken}`), false);
    assert.equal(safety._getAddressLockouts().has(partialAddr), false);
  });

  await t.test("cap holds under 100,000 simulated rotating-token attempts without unbounded growth", () => {
    const cappedSafety = createSafetyManager({
      timeProvider,
      serverSalt: salt,
      inviteCodes: [validCode],
      requireInvite: true,
      maxTrackedLockouts: 500,
      maxTrackedAddressLockouts: 500,
      inviteAddressLockoutAttempts: 500_000 // avoid early lockout so all attempts register
    });

    for (let i = 0; i < 100_000; i++) {
      cappedSafety.authenticateHandshake({
        address: `10.${(i >> 8) & 255}.${i & 255}.1`,
        auth: { inviteCode: "wrong", clientToken: `rot-token-${i}` }
      });
    }

    assert.ok(cappedSafety._getLockouts().size <= 500, `Token lockouts size ${cappedSafety._getLockouts().size} should not exceed cap 500`);
    assert.ok(cappedSafety._getAddressLockouts().size <= 500, `Address lockouts size ${cappedSafety._getAddressLockouts().size} should not exceed cap 500`);
  });
});

test("Phase 7a: Token Bucket Rate Limiting (ICE Burst & Flood Defense)", async (t) => {
  let currentTime = 1_000_000;
  const timeProvider = () => currentTime;
  const safety = createSafetyManager({ timeProvider });
  const limiter = safety.createSocketLimiter();

  await t.test("normal call setup ICE candidate burst (15 candidates) is never dropped", () => {
    for (let i = 0; i < 15; i++) {
      const check = limiter.checkEvent("ice-candidate");
      assert.equal(check.allow, true, `Candidate ${i} should be allowed`);
    }
  });

  await t.test("strict events (join-queue) throttle on rapid burst", () => {
    const check1 = limiter.checkEvent("join-queue");
    const check2 = limiter.checkEvent("join-queue");
    assert.equal(check1.allow, true);
    assert.equal(check2.allow, true);

    // 3rd rapid join-queue exceeds bucket capacity (capacity: 2)
    const check3 = limiter.checkEvent("join-queue");
    assert.equal(check3.allow, false);

    // After 2 seconds refill, join-queue is allowed again
    currentTime += 2000;
    const check4 = limiter.checkEvent("join-queue");
    assert.equal(check4.allow, true);
  });

  await t.test("global flood limit drops events and disconnects after sustained flood", () => {
    const floodLimiter = safety.createSocketLimiter();
    let drops = 0;
    let disconnected = false;

    // Send 80 rapid events in 0ms (bucket capacity is 50)
    for (let i = 0; i < 80; i++) {
      const check = floodLimiter.checkEvent("leave-session");
      if (!check.allow) {
        drops++;
      }
      if (check.disconnect) {
        disconnected = true;
      }
    }

    assert.ok(drops > 0, "Excess flood events should be dropped");
    assert.equal(disconnected, true, "Sustained flood should signal disconnect");
  });
});

test("Phase 7a: Last-Partner Grace Window & Block Enforcement", async (t) => {
  let currentTime = 1_000_000;
  const timeProvider = () => currentTime;
  const safety = createSafetyManager({ timeProvider, gracePeriodMs: 120_000, maxBlocksPerUser: 2 });

  await t.test("grace record holds partner for 120s after session ends", () => {
    safety.setGracePeriod("socket-1", "session-xyz", "token-partner-hash");
    assert.deepEqual(safety.getGraceRecord("socket-1"), {
      sessionId: "session-xyz",
      partnerHashedToken: "token-partner-hash",
      expiresAt: currentTime + 120_000
    });

    // Advance clock by 121 seconds
    currentTime += 121_000;
    assert.equal(safety.getGraceRecord("socket-1"), null);
  });

  await t.test("block enforcement in both directions and oldest eviction", () => {
    safety.recordBlock("token-user-a", "token-user-b");
    assert.equal(safety.isBlocked("token-user-a", "token-user-b"), true);
    assert.equal(safety.isBlocked("token-user-b", "token-user-a"), true);
    assert.equal(safety.isBlocked("token-user-a", "token-user-c"), false);

    // Evicts oldest when maxBlocksPerUser (2) is exceeded
    safety.recordBlock("token-user-a", "token-user-c");
    safety.recordBlock("token-user-a", "token-user-d");
    // token-user-b should be evicted
    assert.equal(safety.isBlocked("token-user-a", "token-user-b"), false);
    assert.equal(safety.isBlocked("token-user-a", "token-user-d"), true);
  });

  await t.test("synchronous matchmaker integration honors blocks", () => {
    const matchmaker = createMatchmaker({
      isBlocked: safety.isBlocked,
      timeProvider
    });

    // Enqueue user B (blocked by user A)
    matchmaker.enqueueUser({
      socketId: "socket-b",
      identity: "Man",
      preferences: ["Women"],
      hashedToken: "token-user-d"
    });

    // Enqueue user A (has blocked user D)
    const result = matchmaker.enqueueUser({
      socketId: "socket-a",
      identity: "Woman",
      preferences: ["Men"],
      hashedToken: "token-user-a"
    });

    // Despite mutual preference compatibility, matchmaker skips blocked user D and waits
    assert.equal(result.status, "waiting");

    // Enqueue unblocked user C
    const resultC = matchmaker.enqueueUser({
      socketId: "socket-c",
      identity: "Woman",
      preferences: ["Men"],
      hashedToken: "token-user-e"
    });

    // User C matches with User B immediately
    assert.equal(resultC.status, "matched");
    assert.equal(resultC.callerId, "socket-b");
    assert.equal(resultC.calleeId, "socket-c");
  });
});

test("Phase 7a: Reporting, Sanitization, Cooldown & Zero Leak Audit", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuup-test-"));
  const reportsFile = path.join(tmpDir, "reports.jsonl");

  let currentTime = 1_000_000;
  const timeProvider = () => currentTime;
  let loggedAlert = null;
  const mockLogger = {
    warn: (msg) => { loggedAlert = msg; },
    log: () => {}
  };

  const safety = createSafetyManager({
    timeProvider,
    reportsFilePath: reportsFile,
    maxReportsFileSize: 1024 * 1024,
    cooldownReportThreshold: 3,
    cooldownWindowMs: 3600_000,
    cooldownDurationMs: 3600_000,
    logger: mockLogger
  });

  // Verify pairing for reporters
  safety.recordSessionPairing("rep-1", "bad-actor");
  safety.recordSessionPairing("rep-2", "bad-actor");
  safety.recordSessionPairing("rep-3", "bad-actor");

  await t.test("strips control characters and caps note to 200 chars", () => {
    const dirtyNote = "Hello\nWorld\r\t\x00Log-Injection\x1b[31mRed\x7f" + "a".repeat(300);
    const sanitized = sanitizeNote(dirtyNote);
    assert.doesNotMatch(sanitized, /[\n\r\t\x00\x1b\x7f]/);
    assert.ok(sanitized.length <= 200);
  });

  await t.test("urgent report prints terminal alert with NO note or personal data", async () => {
    loggedAlert = null;
    const res = await safety.recordReport({
      sessionId: "session-123",
      category: "urgent_minor_safety",
      rawNote: "Suspicious activity note that must never be in logs",
      reporterHashedToken: "rep-1",
      reportedHashedToken: "bad-actor"
    });

    assert.equal(res.ok, true);
    assert.ok(loggedAlert, "Urgent alert should be logged");
    assert.match(loggedAlert, /\[URGENT SAFETY ALERT\]/);
    assert.match(loggedAlert, /urgent_minor_safety/);
    assert.match(loggedAlert, /session-123/);
    assert.doesNotMatch(loggedAlert, /Suspicious activity note/);
    assert.doesNotMatch(loggedAlert, /rep-1/);
    assert.doesNotMatch(loggedAlert, /bad-actor/);
  });

  await t.test("deduplicates report from same reporter in same session", async () => {
    const res = await safety.recordReport({
      sessionId: "session-123",
      category: "harassment_hate",
      rawNote: "Second report",
      reporterHashedToken: "rep-1",
      reportedHashedToken: "bad-actor"
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "DUPLICATE_REPORT");
  });

  await t.test("cooldown triggers only with 3 DISTINCT verified reporters", async () => {
    // 1 report recorded so far from rep-1
    assert.equal(safety.checkCooldown("bad-actor"), false);

    // 2nd report from rep-2
    await safety.recordReport({
      sessionId: "session-456",
      category: "harassment_hate",
      rawNote: "Note 2",
      reporterHashedToken: "rep-2",
      reportedHashedToken: "bad-actor"
    });
    assert.equal(safety.checkCooldown("bad-actor"), false);

    // Duplicate report from rep-2 in a different session does NOT increment distinct tally
    await safety.recordReport({
      sessionId: "session-789",
      category: "harassment_hate",
      rawNote: "Note from rep-2 again",
      reporterHashedToken: "rep-2",
      reportedHashedToken: "bad-actor"
    });
    assert.equal(safety.checkCooldown("bad-actor"), false);

    // 3rd report from rep-3 triggers cooldown
    await safety.recordReport({
      sessionId: "session-999",
      category: "nudity_sexual_content",
      rawNote: "Note 3",
      reporterHashedToken: "rep-3",
      reportedHashedToken: "bad-actor"
    });
    assert.equal(safety.checkCooldown("bad-actor"), true);
  });

  await t.test("reports file never contains IP addresses or raw tokens", () => {
    const content = fs.readFileSync(reportsFile, "utf8");
    const lines = content.trim().split("\n");
    assert.ok(lines.length >= 3);

    for (const line of lines) {
      const record = JSON.parse(line);
      assert.ok(record.reportId);
      assert.ok(record.timestamp);
      assert.ok(record.sessionId);
      assert.ok(record.category);
      assert.ok(record.reportedHashedToken);
      assert.ok(record.reporterHashedToken);
      // Confirm no IP addresses or raw client token indicators
      assert.equal(record.ip, undefined);
      assert.equal(record.address, undefined);
      assert.equal(record.clientToken, undefined);
      assert.doesNotMatch(line, /192\.168\./);
      assert.doesNotMatch(line, /127\.0\.0\.1/);
    }
  });

  // Cleanup tmp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
