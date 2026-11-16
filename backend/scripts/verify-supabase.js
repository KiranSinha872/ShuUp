import pg from "pg";
const { Pool } = pg;
import { POSTGRES_SCHEMA_SQL } from "../src/storage/postgres.js";

async function runPreMigrationVerification() {
  const connectionString = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "").trim();

  if (!connectionString) {
    console.error(JSON.stringify({
      ok: false,
      error: "MISSING_CONFIG",
      message: "SUPABASE_DB_URL (or DATABASE_URL) is not set in backend/.env"
    }, null, 2));
    process.exit(1);
  }

  // Ensure SSL is enabled for Supabase hosted connections
  const isLocal = connectionString.includes("localhost") || connectionString.includes("127.0.0.1");
  const pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 10_000
  });

  const report = {
    connection: false,
    schemaCreation: false,
    tablesVerified: [],
    rlsVerified: {},
    publicPoliciesFound: 0,
    permissionTest: false,
    errors: []
  };

  let client = null;
  try {
    // 1. Verify actual connection without exposing credentials
    client = await pool.connect();
    report.connection = true;

    // 2. Apply and verify Schema DDL
    await client.query(POSTGRES_SCHEMA_SQL);
    report.schemaCreation = true;

    // 3. Verify tables exist in public schema
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('accounts', 'bans', 'call_logs', 'daily_summaries', 'reports');
    `);
    report.tablesVerified = tablesRes.rows.map((r) => r.table_name).sort();

    // 4. Verify RLS is enabled on every table
    const rlsRes = await client.query(`
      SELECT relname, relrowsecurity 
      FROM pg_class 
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace 
      WHERE pg_namespace.nspname = 'public' 
        AND relname IN ('accounts', 'bans', 'call_logs', 'daily_summaries', 'reports');
    `);
    for (const row of rlsRes.rows) {
      report.rlsVerified[row.relname] = row.relrowsecurity;
    }

    // 5. Verify no unintended public policies exist
    const policiesRes = await client.query(`
      SELECT schemaname, tablename, policyname, roles 
      FROM pg_policies 
      WHERE schemaname = 'public' 
        AND tablename IN ('accounts', 'bans', 'call_logs', 'daily_summaries', 'reports');
    `);
    report.publicPoliciesFound = policiesRes.rows.length;

    // 6. Test backend permissions with a rolled-back transaction
    await client.query("BEGIN;");
    const testId = "test-perm-" + Date.now();
    await client.query(
      `INSERT INTO bans (id, identity_hash, reason, banned_at) VALUES ($1, $2, $3, NOW());`,
      [testId, "test-hash-" + testId, "perm_check"]
    );
    const checkRes = await client.query(`SELECT 1 FROM bans WHERE id = $1;`, [testId]);
    if (checkRes.rows.length === 1) {
      report.permissionTest = true;
    }
    await client.query("ROLLBACK;");

  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK;"); } catch (_) {}
    }
    report.errors.push(err.message);
  } finally {
    if (client) client.release();
    await pool.end();
  }

  const allFiveTables = ["accounts", "bans", "call_logs", "daily_summaries", "reports"];
  const allTablesPresent = allFiveTables.every((t) => report.tablesVerified.includes(t));
  const allRlsActive = allFiveTables.every((t) => report.rlsVerified[t] === true);
  const success = report.connection && report.schemaCreation && allTablesPresent && allRlsActive && report.publicPoliciesFound === 0 && report.permissionTest;

  console.log(JSON.stringify({
    ok: success,
    connection: report.connection ? "CONNECTED" : "FAILED",
    schemaCreation: report.schemaCreation ? "SUCCESS" : "FAILED",
    tablesFound: report.tablesVerified,
    rlsStatus: report.rlsVerified,
    publicPoliciesCount: report.publicPoliciesFound,
    backendPermissions: report.permissionTest ? "VERIFIED (INSERT/SELECT/ROLLBACK)" : "FAILED",
    errors: report.errors
  }, null, 2));

  process.exit(success ? 0 : 1);
}

runPreMigrationVerification();

