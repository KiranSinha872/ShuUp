export function parseNumber(val, defaultVal) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

export const PORT = parseNumber(process.env.PORT, 4000);
export const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
export const MATCH_WITH_ANYONE = process.env.MATCH_WITH_ANYONE === "true";

export const BROADEN_WAIT_SECONDS = parseNumber(process.env.BROADEN_WAIT_SECONDS, 30);
export const RECENT_PARTNER_LIMIT = parseNumber(process.env.RECENT_PARTNER_LIMIT, 5);
export const RECENT_PARTNER_TTL_MS = parseNumber(process.env.RECENT_PARTNER_TTL_MS, 120_000);
export const GHOST_SWEEP_INTERVAL_MS = parseNumber(process.env.GHOST_SWEEP_INTERVAL_MS, 30_000);
export const PING_INTERVAL = parseNumber(process.env.PING_INTERVAL, 15_000);
export const PING_TIMEOUT = parseNumber(process.env.PING_TIMEOUT, 10_000);

export const ICE_TRANSPORT_POLICY = process.env.ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all";
export const METERED_DOMAIN = (process.env.METERED_DOMAIN || "").trim();
export const METERED_API_KEY = (process.env.METERED_API_KEY || "").trim();

// Phase 7 Trust & Safety Config
export const SERVER_SALT = (process.env.SERVER_SALT || "").trim();
export const TRUST_PROXY = process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1";
export const MAX_SOCKETS_PER_ADDRESS = parseNumber(process.env.MAX_SOCKETS_PER_ADDRESS, 10);
export const MAX_CONNECTIONS = parseNumber(process.env.MAX_CONNECTIONS, 500);
export const BANNED_TOKENS = (process.env.BANNED_TOKENS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const MAX_TRACKED_LOCKOUTS = parseNumber(process.env.MAX_TRACKED_LOCKOUTS, 10_000);
export const GRACE_PERIOD_MS = parseNumber(process.env.GRACE_PERIOD_MS, 120_000);
export const BLOCK_TTL_MS = parseNumber(process.env.BLOCK_TTL_MS, 24 * 60 * 60 * 1000);
export const MAX_BLOCKS_PER_USER = parseNumber(process.env.MAX_BLOCKS_PER_USER, 100);
export const COOLDOWN_REPORT_THRESHOLD = parseNumber(process.env.COOLDOWN_REPORT_THRESHOLD, 3);
export const COOLDOWN_WINDOW_MS = parseNumber(process.env.COOLDOWN_WINDOW_MS, 60 * 60 * 1000);
export const COOLDOWN_DURATION_MS = parseNumber(process.env.COOLDOWN_DURATION_MS, 60 * 60 * 1000);
export const REPORTS_FILE_PATH = process.env.REPORTS_FILE_PATH || "backend/data/reports.jsonl";
export const MAX_REPORTS_FILE_SIZE_BYTES = parseNumber(process.env.MAX_REPORTS_FILE_SIZE_BYTES, 10 * 1024 * 1024);
export const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH || "backend/data/shuup.db";
export const SUPABASE_DB_URL = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "").trim();
export const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || (SUPABASE_DB_URL ? "postgres" : "sqlite")).toLowerCase();
export const NODE_ENV = (process.env.NODE_ENV || "development").toLowerCase();

export function validateStartupConfig(cfg = {}) {
  const serverSalt = cfg.SERVER_SALT ?? SERVER_SALT;
  if (!serverSalt || typeof serverSalt !== "string" || serverSalt.length < 32) {
    throw new Error(
      "Startup failed: SERVER_SALT is missing or shorter than 32 characters."
    );
  }

  const nodeEnv = cfg.NODE_ENV ?? NODE_ENV;
  const storageBackend = cfg.STORAGE_BACKEND ?? STORAGE_BACKEND;
  const supabaseDbUrl = cfg.SUPABASE_DB_URL ?? SUPABASE_DB_URL;

  if (nodeEnv === "production") {
    if (storageBackend === "sqlite") {
      throw new Error(
        "Startup failed: SQLite storage backend is not permitted in production."
      );
    }
    if (!supabaseDbUrl) {
      throw new Error(
        "Startup failed: SUPABASE_DB_URL is missing in production environment. SQLite fallback is not permitted in production."
      );
    }
  }
}

