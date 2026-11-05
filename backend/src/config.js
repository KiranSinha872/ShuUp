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
