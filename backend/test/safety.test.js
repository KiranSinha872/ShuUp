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
  resolveClientAddress,
  sanitizeNote,
  TokenBucket,
  createSafetyManager,
  REPORT_CATEGORIES
} from "../src/safety.js";
import { createMatchmaker } from "../src/matchmaker.js";

test("Phase 7a: Startup Configuration Validation", async (t) => {
  await t.test("fails safely if SERVER_SALT is missing", () => {
    assert.throws(
      () => {
        validateStartupConfig({
          SERVER_SALT: ""
        });
      },
      (err) => {
        assert.match(err.message, /SERVER_SALT is missing or shorter than 32 characters/);
        return true;
      }
    );
  });

  await t.test("fails safely if SERVER_SALT is shorter than 32 characters", () => {
    assert.throws(
      () => {
        validateStartupConfig({
          SERVER_SALT: "short-salt-under-32-chars"
        });
      },
      (err) => {
        assert.match(err.message, /SERVER_SALT is missing or shorter than 32 characters/);
        return true;
      }
    );
  });

  await t.test("passes validation with valid salt (>=32)", () => {
    assert.doesNotThrow(() => {
      validateStartupConfig({
        SERVER_SALT: "0123456789abcdef0123456789abcdef0123456789abcdef"
      });
    });
  });
});

test("Phase 7a: Token Hashing & Client Identity", async (t) => {
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
});

test("Phase 7a: Handshake Authentication & Connection Caps", async (t) => {
  const salt = "0123456789abcdef0123456789abcdef0123456789abcdef";

  const safety = createSafetyManager({
    serverSalt: salt,
    maxSocketsPerAddress: 50,
    maxConnections: 100,
    bannedTokens: [hashToken("banned-token-uuid", salt)]
  });

  await t.test("rejects missing or short client tokens", () => {
    const res = safety.authenticateHandshake({
      address: "1.2.3.4",
      auth: { clientToken: "short" }
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "INVALID_CLIENT_TOKEN");
  });

  await t.test("rejects banned token", () => {
    const res = safety.authenticateHandshake({
      address: "1.2.3.4",
      auth: { clientToken: "banned-token-uuid" }
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "BANNED");
  });

  await t.test("valid tokens connect successfully", () => {
    for (let i = 0; i < 10; i++) {
      const res = safety.authenticateHandshake({
        address: `10.0.0.${i}`,
        auth: { clientToken: `valid-token-${i}-xyz` }
      });
      assert.equal(res.ok, true);
    }
  });

  await t.test("enforces maxSocketsPerAddress and maxConnections (SERVER_FULL)", () => {
    const limitedSafety = createSafetyManager({
      serverSalt: salt,
      maxSocketsPerAddress: 2,
      maxConnections: 3
    });

    const conn1 = limitedSafety.authenticateHandshake({
      address: "10.0.0.1",
      auth: { clientToken: "token-1-abc" }
    });
    assert.equal(conn1.ok, true);

    const conn2 = limitedSafety.authenticateHandshake({
      address: "10.0.0.1",
      auth: { clientToken: "token-2-def" }
    });
    assert.equal(conn2.ok, true);

    // 3rd from same IP rejected by maxSocketsPerAddress
    const conn3 = limitedSafety.authenticateHandshake({
      address: "10.0.0.1",
      auth: { clientToken: "token-3-ghi" }
    });
    assert.equal(conn3.ok, false);
    assert.equal(conn3.error, "MAX_ADDRESS_CONNECTIONS_REACHED");

    // From different IP allowed, hits total max (3)
    const conn4 = limitedSafety.authenticateHandshake({
      address: "10.0.0.2",
      auth: { clientToken: "token-4-jkl" }
    });
    assert.equal(conn4.ok, true);

    // 4th overall rejected by maxConnections with SERVER_FULL
    const conn5 = limitedSafety.authenticateHandshake({
      address: "10.0.0.3",
      auth: { clientToken: "token-5-mno" }
    });
    assert.equal(conn5.ok, false);
    assert.equal(conn5.error, "SERVER_FULL");

    // Releasing connection frees slot
    limitedSafety.releaseConnection("10.0.0.1");
    const conn6 = limitedSafety.authenticateHandshake({
      address: "10.0.0.3",
      auth: { clientToken: "token-6-pqr" }
    });
    assert.equal(conn6.ok, true);
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
      socketId: "socket-1",
      sessionId: "session-xyz",
      partnerHashedToken: "token-partner-hash",
      expiresAt: currentTime + 120_000
    });

    // Advance clock by 121 seconds
    currentTime += 121_000;
    assert.equal(safety.getGraceRecord("socket-1"), null);
  });

  await t.test("disconnect removes socket grace records, leaves other sockets untouched, and partner can still report", () => {
    // Session between socket-A and socket-B
    safety.setGracePeriod("socket-A", "session-AB", "hash-B");
    safety.setGracePeriod("socket-B", "session-AB", "hash-A");

    // Also socket-C has an unrelated ended session
    safety.setGracePeriod("socket-C", "session-CD", "hash-D");

    // socket-A disconnects -> clearGraceRecord("socket-A")
    safety.clearGraceRecord("socket-A");

    // All records for socket-A must be deleted
    assert.equal(safety.getGraceRecord("socket-A", "session-AB"), null);
    assert.equal(safety.getGraceRecord("socket-A"), null);

    // Other sockets' records must remain untouched
    const socketCRecord = safety.getGraceRecord("socket-C", "session-CD");
    assert.ok(socketCRecord);
    assert.equal(socketCRecord.partnerHashedToken, "hash-D");

    // The partner (socket-B) of disconnected user A can still retrieve and report user A within the window
    const partnerBRecord = safety.getGraceRecord("socket-B", "session-AB");
    assert.ok(partnerBRecord);
    assert.equal(partnerBRecord.partnerHashedToken, "hash-A");
  });

  await t.test("grace records preserved per ended session across multiple calls", () => {
    safety.setGracePeriod("socket-1", "session-1", "token-partner-1");
    // User matches and ends a second session within 30s
    currentTime += 30_000;
    safety.setGracePeriod("socket-1", "session-2", "token-partner-2");

    // Both ended sessions must be retrievable by sessionId
    const grace1 = safety.getGraceRecord("socket-1", "session-1");
    const grace2 = safety.getGraceRecord("socket-1", "session-2");

    assert.ok(grace1, "session-1 grace record must not be overwritten by session-2");
    assert.equal(grace1.partnerHashedToken, "token-partner-1");
    assert.ok(grace2, "session-2 grace record must exist");
    assert.equal(grace2.partnerHashedToken, "token-partner-2");

    // Advance clock past session-1 expiry (session 1 expiresAt + 1)
    currentTime = grace1.expiresAt + 1;
    assert.equal(safety.getGraceRecord("socket-1", "session-1"), null);
    // session-2 was created 30s later -> still active!
    assert.ok(safety.getGraceRecord("socket-1", "session-2"));
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

  await t.test("log audit: zero network address in stdout/stderr during lockout, rejection and cap limits", () => {
    const logs = [];
    const testLogger = {
      warn: (msg) => logs.push(String(msg)),
      log: (msg) => logs.push(String(msg)),
      error: (msg) => logs.push(String(msg))
    };

    const auditSafety = createSafetyManager({
      logger: testLogger,
      serverSalt: "0123456789abcdef0123456789abcdef0123456789abcdef",
      maxSocketsPerAddress: 1
    });

    const testIP1 = "198.51.100.42";
    const testIP2 = "203.0.113.19";
    const testIP3 = "2001:db8::8a2e:370:7334";

    // Trigger connection cap rejection
    auditSafety.authenticateHandshake({ address: testIP1, auth: { clientToken: "token-cap-1" } });
    auditSafety.authenticateHandshake({ address: testIP1, auth: { clientToken: "token-cap-2" } });
    auditSafety.authenticateHandshake({ address: testIP2, auth: { clientToken: "token-cap-3" } });
    auditSafety.authenticateHandshake({ address: testIP2, auth: { clientToken: "token-cap-4" } });
    auditSafety.authenticateHandshake({ address: testIP3, auth: { clientToken: "token-cap-5" } });
    auditSafety.authenticateHandshake({ address: testIP3, auth: { clientToken: "token-cap-6" } });

    const combinedLog = logs.join("\n");
    // Assert no IPv4 pattern
    assert.doesNotMatch(combinedLog, /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/);
    // Assert no IPv6 pattern
    assert.doesNotMatch(combinedLog, /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/);
    // Explicitly assert test IPs never appear
    assert.equal(combinedLog.includes(testIP1), false);
    assert.equal(combinedLog.includes(testIP2), false);
    assert.equal(combinedLog.includes(testIP3), false);
  });

  // Cleanup tmp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
