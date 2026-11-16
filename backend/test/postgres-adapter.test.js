import test from "node:test";
import assert from "node:assert/strict";
import { validateStartupConfig } from "../src/config.js";
import { createStorageAdapter } from "../src/storage/index.js";
import { POSTGRES_SCHEMA_SQL, createPostgresDatabase } from "../src/storage/postgres.js";

test("Phase 2 & 3: PostgreSQL Adapter, Configuration & Schema Validation", async (t) => {
  await t.test("1. Production config guard: fails safely if SUPABASE_DB_URL is missing in production", () => {
    assert.throws(
      () => {
        validateStartupConfig({
          SERVER_SALT: "a-very-long-test-salt-that-is-at-least-32-chars-long",
          NODE_ENV: "production",
          STORAGE_BACKEND: "postgres",
          SUPABASE_DB_URL: ""
        });
      },
      {
        message: /SUPABASE_DB_URL is missing in production environment/
      }
    );
  });

  await t.test("2. Production config guard: fails safely if SQLite is attempted in production", () => {
    assert.throws(
      () => {
        validateStartupConfig({
          SERVER_SALT: "a-very-long-test-salt-that-is-at-least-32-chars-long",
          NODE_ENV: "production",
          STORAGE_BACKEND: "sqlite"
        });
      },
      {
        message: /SQLite storage backend is not permitted in production/
      }
    );
  });

  await t.test("3. Schema SQL audit: contains all 5 required tables and RLS enabled on every table", () => {
    const requiredTables = ["accounts", "bans", "call_logs", "daily_summaries", "reports"];

    for (const table of requiredTables) {
      assert.ok(
        POSTGRES_SCHEMA_SQL.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
        `Schema must define table '${table}'`
      );
      assert.ok(
        POSTGRES_SCHEMA_SQL.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`),
        `Table '${table}' must have Row Level Security enabled`
      );
    }
  });

  await t.test("4. Schema Privacy audit: call_logs strictly omits session_id, accounts, and IPs", () => {
    // Extract call_logs DDL block
    const callLogsMatch = POSTGRES_SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS call_logs\s*\(([\s\S]*?)\);/);
    assert.ok(callLogsMatch, "call_logs DDL must exist");
    const callLogsDdl = callLogsMatch[1];

    assert.ok(!callLogsDdl.includes("session_id"), "call_logs must NOT have session_id column");
    assert.ok(!callLogsDdl.includes("ip_address"), "call_logs must NOT have IP address column");
    assert.ok(!callLogsDdl.includes("account_id"), "call_logs must NOT have account_id column");
    assert.ok(callLogsDdl.includes("connection_type TEXT NOT NULL CHECK(connection_type IN ('direct', 'relay', 'unknown'))"));
  });

  await t.test("5. Schema Constraints audit: reports note CHECK constraint and bans uniqueness", () => {
    assert.ok(POSTGRES_SCHEMA_SQL.includes("note TEXT CHECK(note IS NULL OR length(note) <= 500)"));
    assert.ok(POSTGRES_SCHEMA_SQL.includes("identity_hash TEXT UNIQUE NOT NULL"));
    assert.ok(POSTGRES_SCHEMA_SQL.includes("google_sub_hash TEXT UNIQUE"));
  });

  await t.test("6. Mocked PostgreSQL operations: batchInsert, account ops, and transactions use parameterized queries", async () => {
    const executedQueries = [];

    const mockClient = {
      query: async (sql, params) => {
        executedQueries.push({ sql: sql.trim(), params });
        if (sql.startsWith("SELECT id, google_sub_hash")) {
          return { rows: [{ id: "test-acc-1", google_sub_hash: "hash-1" }] };
        }
        if (sql.startsWith("SELECT 1 FROM bans")) {
          return { rows: [] };
        }
        if (sql.startsWith("SELECT 1 FROM reports")) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => {}
    };

    const mockPool = {
      connect: async () => mockClient,
      query: async (sql, params) => mockClient.query(sql, params),
      on: () => {},
      end: async () => {}
    };

    const pgDb = createPostgresDatabase("postgres://user:pass@localhost:5432/testdb", { pool: mockPool });

    // 1. Batch insert call log & report
    await pgDb.batchInsert([
      {
        type: "call_log",
        data: {
          id: "call-1",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationSeconds: 45,
          connectionType: "direct"
        }
      },
      {
        type: "report",
        data: {
          reportId: "rep-1",
          createdAt: new Date().toISOString(),
          sessionId: "sess-1",
          category: "harassment_hate",
          note: "test note"
        }
      }
    ]);

    // Verify transaction and parameterized insert queries
    assert.equal(executedQueries[0].sql, "BEGIN;");
    assert.match(executedQueries[1].sql, /INSERT INTO call_logs/);
    assert.deepEqual(executedQueries[1].params[0], "call-1");
    assert.equal(executedQueries[1].params[3], 45);
    assert.equal(executedQueries[1].params[4], "direct");

    assert.match(executedQueries[2].sql, /INSERT INTO reports/);
    assert.deepEqual(executedQueries[2].params[0], "rep-1");
    assert.equal(executedQueries[2].params[3], "harassment_hate");
    assert.equal(executedQueries[executedQueries.length - 1].sql, "COMMIT;");

    // 2. Ban Identity
    executedQueries.length = 0;
    await pgDb.banIdentity({ identityHash: "test-hash-xyz", reason: "safety_violation" });
    assert.match(executedQueries[0].sql, /INSERT INTO bans/);
    assert.equal(executedQueries[0].params[1], "test-hash-xyz");

    // 3. Delete Account (clean user nulls reported_account_id)
    executedQueries.length = 0;
    const deleted = await pgDb.deleteAccount("test-acc-1");
    assert.equal(deleted, true);
    assert.equal(executedQueries[0].sql, "BEGIN;");
    assert.match(executedQueries[1].sql, /SELECT id, google_sub_hash FROM accounts/);
    assert.match(executedQueries[2].sql, /UPDATE reports SET reporter_account_id = NULL/);
    assert.match(executedQueries[executedQueries.length - 2].sql, /DELETE FROM accounts WHERE id = \$1/);
    assert.equal(executedQueries[executedQueries.length - 1].sql, "COMMIT;");
  });

  await t.test("7. Storage Adapter Factory: defaults to SQLite in dev, selects PostgreSQL with pool", async () => {
    // Development default (no url, no NODE_ENV)
    const devStorage = createStorageAdapter({ backend: "sqlite", dbPath: ":memory:" });
    assert.equal(devStorage.isPostgres, false);
    assert.equal(devStorage.backend, "sqlite");
    await devStorage.close();

    // Explicit PostgreSQL selection
    const mockPool = {
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      query: async () => ({ rows: [] }),
      on: () => {},
      end: async () => {}
    };

    const pgStorage = createStorageAdapter({
      backend: "postgres",
      pool: mockPool
    });
    assert.equal(pgStorage.isPostgres, true);
    assert.equal(pgStorage.backend, "postgres");
    await pgStorage.close();
  });

  await t.test("8. Interface Parity: PostgreSQL adapter exposes every method found in the SQLite adapter", async () => {
    const sqliteStorage = createStorageAdapter({ backend: "sqlite", dbPath: ":memory:" });
    const mockPool = {
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      query: async () => ({ rows: [] }),
      on: () => {},
      end: async () => {}
    };
    const pgStorage = createStorageAdapter({ backend: "postgres", pool: mockPool });

    const expectedMethods = [
      "logCall",
      "saveReport",
      "getReports",
      "getReportById",
      "updateReportStatus",
      "createAccount",
      "getAccountById",
      "getAccountByGoogleSubHash",
      "getAccountByEmail",
      "deleteAccount",
      "banIdentity",
      "isIdentityBanned",
      "unbanIdentity",
      "getDashboardStats",
      "pruneOldData",
      "getQueueStats",
      "flushQueue",
      "close"
    ];

    for (const method of expectedMethods) {
      assert.equal(typeof sqliteStorage[method], "function", `SQLite adapter missing ${method}`);
      assert.equal(typeof pgStorage[method], "function", `PostgreSQL adapter missing ${method}`);
    }

    await sqliteStorage.close();
    await pgStorage.close();
  });

  await t.test("9. Asynchronous write queues: preserves reports during database errors and shutdown", async () => {
    let failBatchInsert = true;
    const writtenBatches = [];

    const mockPool = {
      connect: async () => ({
        query: async (sql, params) => {
          if (sql === "BEGIN;" && failBatchInsert) {
            throw new Error("Supabase connection timeout / network error");
          }
          if (sql.startsWith("INSERT INTO reports")) {
            writtenBatches.push(params);
          }
          return { rows: [] };
        },
        release: () => {}
      }),
      query: async () => ({ rows: [] }),
      on: () => {},
      end: async () => {}
    };

    const pgStorage = createStorageAdapter({
      backend: "postgres",
      pool: mockPool,
      flushIntervalMs: 10
    });

    // Enqueue report during database error
    pgStorage.saveReport({
      sessionId: "sess-error-test",
      category: "harassment_hate",
      note: "network failure test"
    });

    // Attempt flush while DB is throwing
    await pgStorage.flushQueue();

    // Verify queue stats: writeErrors incremented, report still pending (NEVER dropped)
    const statsDuringError = pgStorage.getQueueStats();
    assert.equal(statsDuringError.writeErrors, 1);
    assert.equal(statsDuringError.pendingReports, 1);

    // Database recovers
    failBatchInsert = false;
    await pgStorage.flushQueue();

    const statsAfterRecovery = pgStorage.getQueueStats();
    assert.equal(statsAfterRecovery.pendingReports, 0);
    assert.equal(statsAfterRecovery.totalFlushed, 1);

    await pgStorage.close({ timeoutMs: 1000 });
  });
});

