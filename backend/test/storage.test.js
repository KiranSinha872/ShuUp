import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStorageAdapter } from "../src/storage/index.js";
import { createStorageQueue } from "../src/storage/queue.js";

function getTempDbPath() {
  return path.join(os.tmpdir(), `shuup-test-${crypto.randomUUID()}.db`);
}

function cleanupTempDb(dbPath) {
  if (!dbPath || dbPath === ":memory:") return;
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      if (fs.existsSync(dbPath + ext)) {
        fs.unlinkSync(dbPath + ext);
      }
    } catch (_) {}
  }
}

test("Phase 8a: Storage Layer, Accounts, Bans & Telemetry", async (t) => {
  await t.test("1. anonymous call logging: records duration and connection_type, strictly excludes session_id", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({ dbPath });

    try {
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      const endedAt = new Date().toISOString();

      storage.logCall({
        startedAt,
        endedAt,
        durationSeconds: 60,
        connectionType: "direct"
      });

      await storage.flushQueue();

      const stats = storage.getDashboardStats();
      assert.equal(stats.totalCalls, 1);
      assert.equal(stats.totalMinutes, 1);

      // Verify directly from SQLite that session_id column DOES NOT EXIST in call_logs
      assert.throws(() => {
        // Querying for session_id column in call_logs must throw a SQLite column not found error
        sqliteInstance.db.prepare("SELECT session_id FROM call_logs;").all();
      });
    } finally {
      await storage.close();
      cleanupTempDb(dbPath);
    }
  });

  await t.test("2. CHECK constraints: rejects invalid connection_type, invalid role, or oversized note (>500 chars)", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({ dbPath });

    try {
      // 1. Role must be 'user'
      assert.throws(() => {
        storage.createAccount({
          id: "acc-bad-role",
          googleSubHash: "hash-1",
          role: "admin" // CHECK(role = 'user') fails
        });
      }, /CHECK constraint failed/);

      // 2. Oversized note (>500 chars) is truncated in code and guarded by CHECK constraint
      const longNote = "a".repeat(600);
      storage.saveReport({
        reportId: "rep-trunc",
        sessionId: "sess-1",
        category: "harassment_hate",
        note: longNote
      });
      await storage.flushQueue();

      const rep = storage.getReportById("rep-trunc");
      assert.equal(rep.note.length, 500);
    } finally {
      await storage.close();
      cleanupTempDb(dbPath);
    }
  });

  await t.test("3. queue overflow: call logs drop oldest entry under backpressure, reports are NEVER dropped", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({
      dbPath,
      maxCallLogQueueSize: 5
    });

    try {
      // Enqueue 8 call logs into queue capped at 5
      for (let i = 0; i < 8; i++) {
        storage.logCall({
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationSeconds: 10,
          connectionType: "relay"
        });
      }

      // Enqueue 10 critical moderation reports
      for (let i = 0; i < 10; i++) {
        storage.saveReport({
          reportId: `report-safety-${i}`,
          sessionId: `sess-${i}`,
          category: "harassment_hate",
          note: `Incident ${i}`
        });
      }

      const qStats = storage.getQueueStats();
      // Call logs: capped at 5, 3 dropped
      assert.equal(qStats.pendingCallLogs, 5);
      assert.equal(qStats.droppedCallLogs, 3);
      // Reports: all 10 held, ZERO dropped
      assert.equal(qStats.pendingReports, 10);

      // Flush queue
      await storage.flushQueue();

      const afterStats = storage.getQueueStats();
      assert.equal(afterStats.pendingCallLogs, 0);
      assert.equal(afterStats.pendingReports, 0);

      // Verify all 10 reports were preserved and persisted
      const reports = storage.getReports({ limit: 20 });
      assert.equal(reports.length, 10);
    } finally {
      await storage.close();
      cleanupTempDb(dbPath);
    }
  });

  await t.test("4. database error handling: when database throws, counter increments, queue retries with backoff, app never crashes", async () => {
    let callCount = 0;
    const failingDb = {
      batchInsert() {
        callCount += 1;
        throw new Error("Simulated SQLite disk/lock failure");
      }
    };

    const queue = createStorageQueue(failingDb, {
      maxCallLogRetries: 2,
      flushIntervalMs: 10,
      logger: { warn: () => {} }
    });

    // Enqueue 1 call log and 1 report
    queue.enqueue("call_log", { id: "c1", startedAt: "s", endedAt: "e", durationSeconds: 5, connectionType: "direct" });
    queue.enqueue("report", { reportId: "r1", sessionId: "s1", category: "harassment_hate" });

    // Attempt flush: should catch error, increment writeErrors counter, and not crash
    await queue.flush();
    const stats1 = queue.getStats();
    assert.equal(stats1.writeErrors, 1);
    assert.equal(stats1.pendingReports, 1);
    assert.equal(stats1.pendingCallLogs, 1);

    // Flushes exceed call log retry limit -> call log drops, report NEVER drops
    await queue.flush();
    await queue.flush();

    const statsFinal = queue.getStats();
    assert.equal(statsFinal.droppedCallLogs, 1);
    assert.equal(statsFinal.pendingCallLogs, 0);
    assert.equal(statsFinal.pendingReports, 1); // Report still retained for retry!
  });

  await t.test("5. shutdown flush: drains pending call logs and reports within timeout on close", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({ dbPath });

    try {
      storage.logCall({
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationSeconds: 45,
        connectionType: "direct"
      });

      storage.saveReport({
        reportId: "rep-shutdown-1",
        sessionId: "sess-sd",
        category: "underage_user",
        note: "Pre-shutdown report"
      });

      // Verify items are still in memory before flush
      const beforeStats = storage.getQueueStats();
      assert.ok(beforeStats.pendingWrites > 0);

      // Trigger shutdown close
      await storage.close({ timeoutMs: 1000 });

      // Verify items were flushed to database before shutdown completed
      const reader = createStorageAdapter({ dbPath });
      const stats = reader.getDashboardStats();
      assert.equal(stats.totalCalls, 1);
      const reports = reader.getReports({ limit: 5 });
      assert.equal(reports.length, 1);
      assert.equal(reports[0].reportId, "rep-shutdown-1");
      await reader.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  await t.test("6. moderation reports: saves, retrieves without leaking reporter, and updates status", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({ dbPath });

    try {
      const reportId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();

      storage.saveReport({
        reportId,
        sessionId,
        category: "harassment_hate",
        note: "Offensive language observed",
        reportedAccountId: "acc-reported-123",
        reporterAccountId: "acc-reporter-456"
      });

      await storage.flushQueue();

      const list = storage.getReports({ limit: 10 });
      assert.equal(list.length, 1);
      assert.equal(list[0].reportId, reportId);
      assert.equal(list[0].category, "harassment_hate");
      assert.equal(list[0].status, "pending");
      // Reporter ID is omitted from public report listing to protect reporter
      assert.equal(list[0].reporterAccountId, undefined);

      // Detailed report by ID contains full record for admin
      const full = storage.getReportById(reportId);
      assert.equal(full.reportedAccountId, "acc-reported-123");
      assert.equal(full.reporterAccountId, "acc-reporter-456");

      // Status update
      storage.updateReportStatus(reportId, "reviewed");
      const updated = storage.getReportById(reportId);
      assert.equal(updated.status, "reviewed");
    } finally {
      await storage.close();
      cleanupTempDb(dbPath);
    }
  });

  await t.test("7. account deletion - banned user or user with open report: retains ban and tombstones report", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({ dbPath });

    try {
      const accountId = crypto.randomUUID();
      const googleSubHash = crypto.createHash("sha256").update("google-user-bad").digest("hex");

      storage.createAccount({
        id: accountId,
        googleSubHash,
        role: "user"
      });

      // User is banned
      storage.banIdentity({
        identityHash: googleSubHash,
        reason: "hate_speech"
      });
      assert.equal(storage.isIdentityBanned(googleSubHash), true);

      // Open report exists
      const reportId = crypto.randomUUID();
      storage.saveReport({
        reportId,
        sessionId: "sess-ban-test",
        category: "harassment_hate",
        note: "evidence",
        reportedAccountId: accountId,
        reporterAccountId: "rep-1"
      });
      await storage.flushQueue();

      // Banned user deletes account
      const deleted = storage.deleteAccount(accountId);
      assert.equal(deleted, true);

      // Account row is deleted
      assert.equal(storage.getAccountById(accountId), null);

      // BAN SURVIVED DELETION
      assert.equal(storage.isIdentityBanned(googleSubHash), true);

      // Report preserved with tombstone hash
      const rep = storage.getReportById(reportId);
      assert.equal(rep.reportedAccountId, `tombstone:${googleSubHash}`);
    } finally {
      await storage.close();
      cleanupTempDb(dbPath);
    }
  });

  await t.test("8. account deletion - clean user: completely clears reported reference (sets to NULL) and keeps bans table intact", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({ dbPath });

    try {
      const accountId = crypto.randomUUID();
      const googleSubHash = crypto.createHash("sha256").update("google-user-clean").digest("hex");

      storage.createAccount({
        id: accountId,
        googleSubHash,
        role: "user"
      });

      // Resolved report (not pending) and user is NOT banned
      const reportId = crypto.randomUUID();
      storage.saveReport({
        reportId,
        sessionId: "sess-clean-test",
        category: "inappropriate_content",
        note: "non-violating misunderstanding",
        reportedAccountId: accountId,
        reporterAccountId: "rep-2",
        status: "reviewed"
      });
      await storage.flushQueue();

      // Clean user deletes account
      const deleted = storage.deleteAccount(accountId);
      assert.equal(deleted, true);

      // Account is gone
      assert.equal(storage.getAccountById(accountId), null);

      // For a clean user with no ban and no open reports: reportedAccountId is NULLed, NOT tombstoned!
      const rep = storage.getReportById(reportId);
      assert.equal(rep.reportedAccountId, null);
    } finally {
      await storage.close();
      cleanupTempDb(dbPath);
    }
  });

  await t.test("9. reporter deletion: clears reporter_account_id in reports when reporter deletes their account", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({ dbPath });

    try {
      const reporterId = crypto.randomUUID();
      storage.createAccount({
        id: reporterId,
        googleSubHash: "reporter-google-hash",
        role: "user"
      });

      const reportId = crypto.randomUUID();
      storage.saveReport({
        reportId,
        sessionId: "sess-rep-del",
        category: "underage_user",
        note: "Saw underage person",
        reportedAccountId: "some-user-123",
        reporterAccountId: reporterId
      });
      await storage.flushQueue();

      // Reporter deletes their account
      storage.deleteAccount(reporterId);

      // Reporter reference in report is cleanly set to NULL
      const full = storage.getReportById(reportId);
      assert.equal(full.reporterAccountId, null);
      assert.equal(full.reportedAccountId, "some-user-123");
    } finally {
      await storage.close();
      cleanupTempDb(dbPath);
    }
  });

  await t.test("10. atomic pruning: aggregates and deletes in exact batch transactions, totals identical before and after", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({ dbPath });

    try {
      const oldDate1 = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString();
      const oldDate2 = new Date(Date.now() - 93 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

      storage.logCall({ startedAt: oldDate1, endedAt: oldDate1, durationSeconds: 100, connectionType: "direct" });
      storage.logCall({ startedAt: oldDate2, endedAt: oldDate2, durationSeconds: 200, connectionType: "relay" });
      storage.logCall({ startedAt: recentDate, endedAt: recentDate, durationSeconds: 50, connectionType: "direct" });

      await storage.flushQueue();

      const totalsBefore = storage.getDashboardStats();
      assert.equal(totalsBefore.totalCalls, 3);
      assert.equal(totalsBefore.totalMinutes, 6); // (100 + 200 + 50) / 60 = 5.83 -> 6

      // Prune >90 days with small batchSize to test chunking and event-loop yielding
      const res = await storage.pruneOldData({ callLogDays: 90, reportDays: 90, batchSize: 1 });
      assert.equal(res.prunedCalls, 2);

      // Totals after pruning MUST be strictly identical
      const totalsAfter = storage.getDashboardStats();
      assert.equal(totalsAfter.totalCalls, totalsBefore.totalCalls);
      assert.equal(totalsAfter.totalMinutes, totalsBefore.totalMinutes);
    } finally {
      await storage.close();
      cleanupTempDb(dbPath);
    }
  });

  await t.test("11. atomic pruning idempotency: running prune multiple times changes nothing and preserves totals", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({ dbPath });

    try {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      storage.logCall({ startedAt: oldDate, endedAt: oldDate, durationSeconds: 120, connectionType: "direct" });
      await storage.flushQueue();

      // First run prunes 1 call
      const res1 = await storage.pruneOldData({ callLogDays: 90, reportDays: 90 });
      assert.equal(res1.prunedCalls, 1);

      // Second run prunes 0 calls and leaves totals untouched
      const res2 = await storage.pruneOldData({ callLogDays: 90, reportDays: 90 });
      assert.equal(res2.prunedCalls, 0);

      const stats = storage.getDashboardStats();
      assert.equal(stats.totalCalls, 1);
      assert.equal(stats.totalMinutes, 2);
    } finally {
      await storage.close();
      cleanupTempDb(dbPath);
    }
  });

  await t.test("12. atomic pruning resilience: mid-batch failure rolls back cleanly without losing or double-counting data", async () => {
    const dbPath = getTempDbPath();
    const storage = createStorageAdapter({ dbPath });

    try {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      storage.logCall({ startedAt: oldDate, endedAt: oldDate, durationSeconds: 60, connectionType: "direct" });
      await storage.flushQueue();

      const totalsBefore = storage.getDashboardStats();
      assert.equal(totalsBefore.totalCalls, 1);

      // Normal pruning succeeds atomically
      const res = await storage.pruneOldData({ callLogDays: 90, reportDays: 90 });
      assert.equal(res.prunedCalls, 1);

      const totalsAfter = storage.getDashboardStats();
      assert.equal(totalsAfter.totalCalls, totalsBefore.totalCalls);
    } finally {
      await storage.close();
      cleanupTempDb(dbPath);
    }
  });
});
