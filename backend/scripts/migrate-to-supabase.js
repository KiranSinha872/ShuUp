import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
const { Pool } = pg;

/**
 * Creates a timestamped cold backup of the entire data directory.
 * Preserves shuup.db, WAL/SHM files, and reports.jsonl with strict 0600 file permissions.
 */
export function createDataBackup({ dataDir = "backend/data", backupBaseDir = "backend/backups" } = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.resolve(backupBaseDir, `data-backup-${timestamp}`);

  if (!fs.existsSync(dataDir)) {
    return { ok: false, error: "DATA_DIR_NOT_FOUND", backupDir: null, files: [] };
  }

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const copiedFiles = [];
  const entries = fs.readdirSync(dataDir);
  for (const entry of entries) {
    const srcPath = path.join(dataDir, entry);
    const destPath = path.join(backupDir, entry);
    const stat = fs.statSync(srcPath);

    if (stat.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      try {
        fs.chmodSync(destPath, 0o600);
      } catch (_) {}
      copiedFiles.push({ file: entry, size: stat.size });
    }
  }

  return {
    ok: true,
    backupDir,
    timestamp,
    files: copiedFiles
  };
}

/**
 * Verifies SQLite database integrity before reading.
 */
export function verifySqliteIntegrity(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { ok: true, exists: false, integrity: "NOT_PRESENT" };
  }

  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const check = db.prepare("PRAGMA integrity_check;").get();
    db.close();
    return {
      ok: check && (check.integrity_check === "ok" || Object.values(check)[0] === "ok"),
      exists: true,
      integrity: check ? (check.integrity_check || Object.values(check)[0]) : "unknown"
    };
  } catch (err) {
    return { ok: false, exists: true, error: err.message };
  }
}

/**
 * Compares two records field-by-field, normalizing nulls, undefined, and date strings.
 */
export function compareRecords(sourceRec, targetRec, fields = []) {
  const keys = fields.length > 0 ? fields : Object.keys(sourceRec);
  const mismatches = [];

  for (const key of keys) {
    let srcVal = sourceRec[key];
    let tgtVal = targetRec[key];

    // Normalize null / undefined
    if (srcVal === undefined) srcVal = null;
    if (tgtVal === undefined) tgtVal = null;

    // Normalize Date / ISO timestamps
    if (srcVal instanceof Date) srcVal = srcVal.toISOString();
    if (tgtVal instanceof Date) tgtVal = tgtVal.toISOString();

    if (typeof srcVal === "string" && typeof tgtVal === "string") {
      // Check if both are ISO dates with differing precision
      const srcDate = Date.parse(srcVal);
      const tgtDate = Date.parse(tgtVal);
      if (!Number.isNaN(srcDate) && !Number.isNaN(tgtDate) && (srcVal.includes("T") || srcVal.includes("-"))) {
        if (srcDate === tgtDate) {
          continue;
        }
      }
    }

    if (srcVal !== tgtVal) {
      mismatches.push({ field: key, source: typeof srcVal, target: typeof tgtVal });
    }
  }

  return {
    isIdentical: mismatches.length === 0,
    mismatches
  };
}

/**
 * Parses reports.jsonl line-by-line and evaluates reconciliation and privacy requirements.
 */
export async function parseAndReconcileJsonl({
  jsonlPath = "backend/data/reports.jsonl",
  validAccountIds = new Set(),
  existingSqliteReportIds = new Set(),
  existingSupabaseReports = new Map()
} = {}) {
  const summary = {
    totalLines: 0,
    validJsonLines: 0,
    malformedLines: [],
    sqliteMatches: 0,
    isolatedReports: [], // Reports requiring manual review due to privacy or unmapped identity
    stagedForMigration: [],
    duplicateIdentical: [],
    conflicts: []
  };

  if (!fs.existsSync(jsonlPath)) {
    return summary;
  }

  const fileStream = fs.createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const rawLine of rl) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line) continue;

    summary.totalLines++;

    let record = null;
    try {
      record = JSON.parse(line);
      summary.validJsonLines++;
    } catch (parseErr) {
      summary.malformedLines.push({
        lineNumber,
        error: "MALFORMED_JSON",
        snippetLength: line.length
      });
      continue;
    }

    const { reportId, timestamp, sessionId, category, note, reportedHashedToken, reporterHashedToken } = record;

    if (!reportId || !category) {
      summary.malformedLines.push({
        lineNumber,
        error: "MISSING_REQUIRED_FIELDS",
        reportId: reportId || null
      });
      continue;
    }

    // Check if report ID is already tracked in SQLite
    const inSqlite = existingSqliteReportIds.has(reportId);
    if (inSqlite) {
      summary.sqliteMatches++;
    }

    // Privacy Validation:
    // 1. Account IDs must map to real internal accounts (never invent mappings or use raw browser token hashes)
    // 2. Do not persist temporary session identifiers
    const mappedReportedAccount = validAccountIds.has(reportedHashedToken) ? reportedHashedToken : null;
    const mappedReporterAccount = validAccountIds.has(reporterHashedToken) ? reporterHashedToken : null;

    const cannotMapToInternalAccount = !mappedReportedAccount || !mappedReporterAccount;

    if (cannotMapToInternalAccount) {
      // Isolate for manual review per Mandatory Privacy Validation
      summary.isolatedReports.push({
        lineNumber,
        reportId,
        reason: "UNMAPPED_ANONYMOUS_TOKEN_OR_SESSION_ID",
        detail: {
          hasReportedAccount: Boolean(mappedReportedAccount),
          hasReporterAccount: Boolean(mappedReporterAccount),
          hasSessionId: Boolean(sessionId)
        },
        rawRecord: {
          reportId,
          timestamp,
          category,
          note: note ? note.slice(0, 500) : null
          // Prohibited raw tokens and session IDs are sequestered in review manifest, not inserted into public schema
        }
      });
      continue;
    }

    // If report maps safely to internal accounts, check Supabase status
    const existingTarget = existingSupabaseReports.get(reportId);
    if (existingTarget) {
      const cmp = compareRecords(
        {
          report_id: reportId,
          created_at: timestamp,
          category,
          note: note || null,
          reported_account_id: mappedReportedAccount,
          reporter_account_id: mappedReporterAccount
        },
        existingTarget,
        ["report_id", "category", "note", "reported_account_id", "reporter_account_id"]
      );

      if (cmp.isIdentical) {
        summary.duplicateIdentical.push(reportId);
      } else {
        summary.conflicts.push({
          reportId,
          mismatches: cmp.mismatches
        });
      }
    } else {
      summary.stagedForMigration.push({
        reportId,
        createdAt: timestamp,
        category,
        note: note ? note.slice(0, 500) : null,
        reportedAccountId: mappedReportedAccount,
        reporterAccountId: mappedReporterAccount,
        status: "pending"
      });
    }
  }

  return summary;
}

/**
 * Migration planner and executor.
 * Defaults to dry-run inspection mode unless explicitly passed isExecute: true.
 */
export async function planAndExecuteMigration({
  dbPath = "backend/data/shuup.db",
  jsonlPath = "backend/data/reports.jsonl",
  backupBaseDir = "backend/backups",
  supabaseUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
  isExecute = false
} = {}) {
  const result = {
    mode: isExecute ? "EXECUTE" : "DRY_RUN",
    backup: null,
    sqliteIntegrity: null,
    sqliteRecords: {
      accounts: { scanned: 0, migrated: 0, duplicates: 0, conflicts: [] },
      bans: { scanned: 0, migrated: 0, duplicates: 0, conflicts: [] },
      call_logs: { scanned: 0, migrated: 0, duplicates: 0, conflicts: [] },
      daily_summaries: { scanned: 0, migrated: 0, duplicates: 0, conflicts: [] },
      reports: { scanned: 0, migrated: 0, duplicates: 0, conflicts: [], isolatedPrivacyReports: [] }
    },
    jsonlReconciliation: null,
    quarantineManifestPath: null,
    errors: []
  };

  // 1. Mandatory Pre-Migration Backup (performed in both dry-run verification and execute mode)
  result.backup = createDataBackup({ backupBaseDir });

  // 2. Verify SQLite integrity
  result.sqliteIntegrity = verifySqliteIntegrity(dbPath);
  if (!result.sqliteIntegrity.ok) {
    result.errors.push(`SQLite integrity check failed: ${result.sqliteIntegrity.error || result.sqliteIntegrity.integrity}`);
    return result;
  }

  // 3. Connect to Supabase
  if (!supabaseUrl) {
    result.errors.push("Missing SUPABASE_DB_URL or DATABASE_URL configuration");
    return result;
  }

  const isLocal = supabaseUrl.includes("localhost") || supabaseUrl.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: supabaseUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 10_000
  });

  let pgClient = null;
  try {
    pgClient = await pool.connect();

    // Fetch existing registered accounts from Supabase to validate identity constraints
    const accountsRes = await pgClient.query("SELECT id FROM accounts;");
    const validAccountIds = new Set(accountsRes.rows.map(r => r.id));

    // Also load existing accounts from SQLite if present
    let sqliteAccounts = [];
    let sqliteBans = [];
    let sqliteCallLogs = [];
    let sqliteDailySummaries = [];
    let sqliteReports = [];
    const existingSqliteReportIds = new Set();

    if (fs.existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });

      try {
        sqliteAccounts = db.prepare("SELECT id, google_sub_hash, role, created_at, email, password_hash FROM accounts;").all();
        for (const acc of sqliteAccounts) validAccountIds.add(acc.id);
      } catch (_) {}

      try {
        sqliteBans = db.prepare("SELECT id, identity_hash, reason, banned_at FROM bans;").all();
      } catch (_) {}

      try {
        sqliteCallLogs = db.prepare("SELECT id, started_at, ended_at, duration_seconds, connection_type FROM call_logs;").all();
      } catch (_) {}

      try {
        sqliteDailySummaries = db.prepare("SELECT date, total_calls, total_seconds, direct_calls, relay_calls, unknown_calls FROM daily_summaries;").all();
      } catch (_) {}

      try {
        sqliteReports = db.prepare("SELECT report_id, created_at, session_id, category, note, reported_account_id, reporter_account_id, status FROM reports;").all();
        for (const r of sqliteReports) existingSqliteReportIds.add(r.report_id);
      } catch (_) {}

      db.close();
    }

    // 4. Reconcile and Migrate SQLite tables
    // A. Accounts
    result.sqliteRecords.accounts.scanned = sqliteAccounts.length;
    for (const acc of sqliteAccounts) {
      const existing = await pgClient.query("SELECT id, google_sub_hash, role, created_at, email, password_hash FROM accounts WHERE id = $1;", [acc.id]);
      if (existing.rows.length === 0) {
        if (isExecute) {
          await pgClient.query(
            `INSERT INTO accounts (id, google_sub_hash, role, created_at, email, password_hash)
             VALUES ($1, $2, $3, $4, $5, $6);`,
            [acc.id, acc.google_sub_hash, acc.role || "user", acc.created_at, acc.email, acc.password_hash]
          );
        }
        result.sqliteRecords.accounts.migrated++;
      } else {
        const cmp = compareRecords(acc, existing.rows[0], ["id", "google_sub_hash", "role", "email", "password_hash"]);
        if (cmp.isIdentical) {
          result.sqliteRecords.accounts.duplicates++;
        } else {
          result.sqliteRecords.accounts.conflicts.push({ id: acc.id, mismatches: cmp.mismatches });
        }
      }
    }

    // B. Bans
    result.sqliteRecords.bans.scanned = sqliteBans.length;
    for (const ban of sqliteBans) {
      const existing = await pgClient.query("SELECT id, identity_hash, reason, banned_at FROM bans WHERE id = $1;", [ban.id]);
      if (existing.rows.length === 0) {
        if (isExecute) {
          await pgClient.query(
            `INSERT INTO bans (id, identity_hash, reason, banned_at)
             VALUES ($1, $2, $3, $4);`,
            [ban.id, ban.identity_hash, ban.reason, ban.banned_at]
          );
        }
        result.sqliteRecords.bans.migrated++;
      } else {
        const cmp = compareRecords(ban, existing.rows[0], ["id", "identity_hash", "reason"]);
        if (cmp.isIdentical) {
          result.sqliteRecords.bans.duplicates++;
        } else {
          result.sqliteRecords.bans.conflicts.push({ id: ban.id, mismatches: cmp.mismatches });
        }
      }
    }

    // C. Call Logs
    result.sqliteRecords.call_logs.scanned = sqliteCallLogs.length;
    for (const call of sqliteCallLogs) {
      const existing = await pgClient.query("SELECT id, started_at, ended_at, duration_seconds, connection_type FROM call_logs WHERE id = $1;", [call.id]);
      if (existing.rows.length === 0) {
        if (isExecute) {
          await pgClient.query(
            `INSERT INTO call_logs (id, started_at, ended_at, duration_seconds, connection_type)
             VALUES ($1, $2, $3, $4, $5);`,
            [call.id, call.started_at, call.ended_at, call.duration_seconds, call.connection_type]
          );
        }
        result.sqliteRecords.call_logs.migrated++;
      } else {
        const cmp = compareRecords(call, existing.rows[0], ["id", "duration_seconds", "connection_type"]);
        if (cmp.isIdentical) {
          result.sqliteRecords.call_logs.duplicates++;
        } else {
          result.sqliteRecords.call_logs.conflicts.push({ id: call.id, mismatches: cmp.mismatches });
        }
      }
    }

    // D. Daily Summaries
    result.sqliteRecords.daily_summaries.scanned = sqliteDailySummaries.length;
    for (const summary of sqliteDailySummaries) {
      const existing = await pgClient.query("SELECT date, total_calls, total_seconds, direct_calls, relay_calls, unknown_calls FROM daily_summaries WHERE date = $1;", [summary.date]);
      if (existing.rows.length === 0) {
        if (isExecute) {
          await pgClient.query(
            `INSERT INTO daily_summaries (date, total_calls, total_seconds, direct_calls, relay_calls, unknown_calls)
             VALUES ($1, $2, $3, $4, $5, $6);`,
            [summary.date, summary.total_calls, summary.total_seconds, summary.direct_calls, summary.relay_calls, summary.unknown_calls]
          );
        }
        result.sqliteRecords.daily_summaries.migrated++;
      } else {
        const cmp = compareRecords(summary, existing.rows[0], ["date", "total_calls", "total_seconds", "direct_calls", "relay_calls", "unknown_calls"]);
        if (cmp.isIdentical) {
          result.sqliteRecords.daily_summaries.duplicates++;
        } else {
          result.sqliteRecords.daily_summaries.conflicts.push({ date: summary.date, mismatches: cmp.mismatches });
        }
      }
    }

    // E. Reports from SQLite with Privacy Validation
    result.sqliteRecords.reports.scanned = sqliteReports.length;
    for (const report of sqliteReports) {
      // Privacy check: Are the account IDs mapped to registered accounts?
      const reportedAccountValid = report.reported_account_id ? validAccountIds.has(report.reported_account_id) : true;
      const reporterAccountValid = report.reporter_account_id ? validAccountIds.has(report.reporter_account_id) : true;

      if (!reportedAccountValid || !reporterAccountValid) {
        result.sqliteRecords.reports.isolatedPrivacyReports.push({
          reportId: report.report_id,
          reason: "UNMAPPED_ACCOUNT_ID_IN_SQLITE",
          detail: {
            reported_account_id: report.reported_account_id,
            reporter_account_id: report.reporter_account_id
          }
        });
        continue;
      }

      const existing = await pgClient.query("SELECT report_id, created_at, category, note, reported_account_id, reporter_account_id, status FROM reports WHERE report_id = $1;", [report.report_id]);
      if (existing.rows.length === 0) {
        if (isExecute) {
          await pgClient.query(
            `INSERT INTO reports (report_id, created_at, session_id, category, note, reported_account_id, reporter_account_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
            [report.report_id, report.created_at, report.session_id || "omitted", report.category, report.note, report.reported_account_id, report.reporter_account_id, report.status || "pending"]
          );
        }
        result.sqliteRecords.reports.migrated++;
      } else {
        const cmp = compareRecords(report, existing.rows[0], ["report_id", "category", "note", "reported_account_id", "reporter_account_id", "status"]);
        if (cmp.isIdentical) {
          result.sqliteRecords.reports.duplicates++;
        } else {
          result.sqliteRecords.reports.conflicts.push({ reportId: report.report_id, mismatches: cmp.mismatches });
        }
      }
    }

    // 5. Reconcile reports.jsonl
    const existingReportsRes = await pgClient.query("SELECT report_id, created_at, category, note, reported_account_id, reporter_account_id, status FROM reports;");
    const existingSupabaseReports = new Map(existingReportsRes.rows.map(r => [r.report_id, r]));

    result.jsonlReconciliation = await parseAndReconcileJsonl({
      jsonlPath,
      validAccountIds,
      existingSqliteReportIds,
      existingSupabaseReports
    });

    // Execute insertion for safely staged JSONL reports if execute flag is set
    if (isExecute && result.jsonlReconciliation.stagedForMigration.length > 0) {
      for (const staged of result.jsonlReconciliation.stagedForMigration) {
        await pgClient.query(
          `INSERT INTO reports (report_id, created_at, session_id, category, note, reported_account_id, reporter_account_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
          [staged.reportId, staged.createdAt, "omitted", staged.category, staged.note, staged.reportedAccountId, staged.reporterAccountId, staged.status]
        );
      }
    }

    // 6. Write quarantine manifest for manual review if isolated reports exist
    const allIsolated = [
      ...result.sqliteRecords.reports.isolatedPrivacyReports,
      ...result.jsonlReconciliation.isolatedReports
    ];

    if (allIsolated.length > 0) {
      const quarantineDir = result.backup ? result.backup.backupDir : "backend/backups";
      const quarantinePath = path.join(quarantineDir, "quarantined-privacy-reports.json");
      fs.writeFileSync(quarantinePath, JSON.stringify(allIsolated, null, 2), { mode: 0o600 });
      result.quarantineManifestPath = quarantinePath;
    }

  } catch (err) {
    result.errors.push(err.message);
  } finally {
    if (pgClient) pgClient.release();
    await pool.end();
  }

  return result;
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith("migrate-to-supabase.js")) {
  const isExecute = process.argv.includes("--execute");
  planAndExecuteMigration({ isExecute })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.errors.length === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
      process.exit(1);
    });
}

