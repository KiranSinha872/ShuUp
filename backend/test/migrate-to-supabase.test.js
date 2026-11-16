import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  createDataBackup,
  verifySqliteIntegrity,
  compareRecords,
  parseAndReconcileJsonl
} from "../scripts/migrate-to-supabase.js";

describe("Phase 4 Data Migration & Reconciliation Safety Tests", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuup-migrate-test-"));
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("createDataBackup creates cold copy preserving original and sets strict 0600 mode", () => {
    const mockDataDir = path.join(tmpDir, "data");
    const mockBackupBase = path.join(tmpDir, "backups");
    fs.mkdirSync(mockDataDir, { recursive: true });

    const testDb = path.join(mockDataDir, "shuup.db");
    const testJsonl = path.join(mockDataDir, "reports.jsonl");
    fs.writeFileSync(testDb, "sqlite-dummy-bytes", { mode: 0o600 });
    fs.writeFileSync(testJsonl, '{"reportId":"test-1"}\n', { mode: 0o600 });

    const backupResult = createDataBackup({ dataDir: mockDataDir, backupBaseDir: mockBackupBase });

    assert.equal(backupResult.ok, true);
    assert.equal(backupResult.files.length, 2);
    assert.ok(fs.existsSync(backupResult.backupDir));

    // Verify original files were never mutated or deleted
    assert.ok(fs.existsSync(testDb));
    assert.ok(fs.existsSync(testJsonl));
    assert.equal(fs.readFileSync(testDb, "utf8"), "sqlite-dummy-bytes");

    // Verify backup copy permissions (owner-only read/write)
    const backupDbStat = fs.statSync(path.join(backupResult.backupDir, "shuup.db"));
    assert.equal(backupDbStat.mode & 0o777, 0o600);
  });

  it("verifySqliteIntegrity validates SQLite database health", () => {
    const dbPath = path.join(tmpDir, "integrity.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE test (id TEXT PRIMARY KEY, val TEXT);");
    db.exec("INSERT INTO test VALUES ('1', 'hello');");
    db.close();

    const res = verifySqliteIntegrity(dbPath);
    assert.equal(res.ok, true);
    assert.equal(res.integrity, "ok");
  });

  it("compareRecords correctly identifies identical records and field mismatches", () => {
    const rec1 = {
      id: "acc-1",
      email: "user@example.com",
      created_at: "2026-11-12T10:00:00.000Z",
      role: "user"
    };

    // Identical record
    const rec2 = {
      id: "acc-1",
      email: "user@example.com",
      created_at: "2026-11-12T10:00:00.000Z",
      role: "user"
    };
    const identicalCheck = compareRecords(rec1, rec2);
    assert.equal(identicalCheck.isIdentical, true);
    assert.equal(identicalCheck.mismatches.length, 0);

    // Mismatched role
    const rec3 = { ...rec2, role: "admin" };
    const mismatchCheck = compareRecords(rec1, rec3);
    assert.equal(mismatchCheck.isIdentical, false);
    assert.equal(mismatchCheck.mismatches.length, 1);
    assert.equal(mismatchCheck.mismatches[0].field, "role");
  });

  it("parseAndReconcileJsonl identifies malformed JSON lines with exact line numbers", async () => {
    const jsonlPath = path.join(tmpDir, "malformed-test.jsonl");
    const content = [
      JSON.stringify({ reportId: "r-1", category: "spam", timestamp: "2026-11-12T10:00:00Z" }),
      "THIS_IS_CORRUPT_NOT_JSON",
      JSON.stringify({ reportId: "r-2", category: "harassment", timestamp: "2026-11-12T10:01:00Z" })
    ].join("\n");
    fs.writeFileSync(jsonlPath, content);

    const summary = await parseAndReconcileJsonl({ jsonlPath });
    assert.equal(summary.totalLines, 3);
    assert.equal(summary.validJsonLines, 2);
    assert.equal(summary.malformedLines.length, 1);
    assert.equal(summary.malformedLines[0].lineNumber, 2);
    assert.equal(summary.malformedLines[0].error, "MALFORMED_JSON");
  });

  it("parseAndReconcileJsonl enforces Mandatory Privacy Validation by isolating unmapped anonymous tokens", async () => {
    const jsonlPath = path.join(tmpDir, "privacy-test.jsonl");

    // Two records:
    // 1. One with unmapped anonymous browser token hashes (must be isolated, never imported)
    // 2. One with mapped internal account IDs (eligible for migration)
    const validAccountIds = new Set(["acc-valid-reported", "acc-valid-reporter"]);
    const existingSqliteReportIds = new Set(["rep-sqlite-1"]);

    const records = [
      // Line 1: Anonymous session token hashes - no account mapping exists
      JSON.stringify({
        reportId: "rep-anon-1",
        timestamp: "2026-11-12T12:00:00Z",
        sessionId: "sess-temp-123",
        category: "hate_speech",
        note: "Anonymous abuse",
        reportedHashedToken: "raw-anon-token-hash-reported",
        reporterHashedToken: "raw-anon-token-hash-reporter"
      }),
      // Line 2: Mapped to verified internal account IDs
      JSON.stringify({
        reportId: "rep-mapped-2",
        timestamp: "2026-11-12T12:05:00Z",
        sessionId: "sess-temp-456",
        category: "nudity",
        note: "Account holder report",
        reportedHashedToken: "acc-valid-reported",
        reporterHashedToken: "acc-valid-reporter"
      })
    ].join("\n");

    fs.writeFileSync(jsonlPath, records);

    const summary = await parseAndReconcileJsonl({
      jsonlPath,
      validAccountIds,
      existingSqliteReportIds
    });

    // Verify unmapped anonymous report is quarantined
    assert.equal(summary.isolatedReports.length, 1);
    assert.equal(summary.isolatedReports[0].reportId, "rep-anon-1");
    assert.equal(summary.isolatedReports[0].reason, "UNMAPPED_ANONYMOUS_TOKEN_OR_SESSION_ID");

    // Verify safely mapped report is staged
    assert.equal(summary.stagedForMigration.length, 1);
    assert.equal(summary.stagedForMigration[0].reportId, "rep-mapped-2");
    assert.equal(summary.stagedForMigration[0].reportedAccountId, "acc-valid-reported");
    assert.equal(summary.stagedForMigration[0].reporterAccountId, "acc-valid-reporter");
  });

  it("parseAndReconcileJsonl flags identical duplicates and field value conflicts against target Supabase records", async () => {
    const jsonlPath = path.join(tmpDir, "conflict-test.jsonl");
    const validAccountIds = new Set(["acc-1", "acc-2"]);

    const existingSupabaseReports = new Map([
      ["rep-dup", {
        report_id: "rep-dup",
        category: "spam",
        note: "Same note",
        reported_account_id: "acc-1",
        reporter_account_id: "acc-2"
      }],
      ["rep-conflict", {
        report_id: "rep-conflict",
        category: "spam",
        note: "Old initial note",
        reported_account_id: "acc-1",
        reporter_account_id: "acc-2"
      }]
    ]);

    const lines = [
      // Identical record
      JSON.stringify({
        reportId: "rep-dup",
        timestamp: "2026-11-12T12:00:00Z",
        sessionId: "s1",
        category: "spam",
        note: "Same note",
        reportedHashedToken: "acc-1",
        reporterHashedToken: "acc-2"
      }),
      // Conflicting record (differing note)
      JSON.stringify({
        reportId: "rep-conflict",
        timestamp: "2026-11-12T12:01:00Z",
        sessionId: "s2",
        category: "spam",
        note: "Modified divergent note",
        reportedHashedToken: "acc-1",
        reporterHashedToken: "acc-2"
      })
    ].join("\n");

    fs.writeFileSync(jsonlPath, lines);

    const summary = await parseAndReconcileJsonl({
      jsonlPath,
      validAccountIds,
      existingSupabaseReports
    });

    assert.equal(summary.duplicateIdentical.length, 1);
    assert.equal(summary.duplicateIdentical[0], "rep-dup");

    assert.equal(summary.conflicts.length, 1);
    assert.equal(summary.conflicts[0].reportId, "rep-conflict");
    assert.equal(summary.conflicts[0].mismatches[0].field, "note");
  });
});

