# Shuup - Progress Memory & State Log

## Current Status
- **Current Phase:** Phase 7 complete (7a and 7b); Phase 8 next (database and admin dashboard, free tier only, no payment card)
- **Active Step:** Phase 7b committed; ready to design and plan Phase 8
- **Next Step:** Phase 8 (database and admin dashboard, free tier only, no payment card)

---

## Running Locally
To run the prototype locally, start both dev servers in separate terminal tabs:
1. **Backend:** `cd backend && npm run dev` (starts on port 4000).
2. **Frontend:** `cd frontend && npm run dev` (starts on port 3000).
- The browser UI shows `Server: Connected` (green) only when the backend server is active and the client has authenticated with a valid invite code. If the backend is stopped or unreachable, the UI indicates `Server: Disconnected` (red) and disables the Start button to prevent dead clicks.

---

## Phase 7a Implemented (Awaiting Verification)
- **Handshake Invite Gate:** Server-side validation via `crypto.timingSafeEqual` over fixed-length SHA-256 digests against `INVITE_CODES`. Prevents timing leaks without early return.
- **Dual-Tier Lockout Defense:**
  - Strict per-token lockout: 5 failed attempts in 15 minutes locks out specific `${address}:${clientToken}` with `INVITE_LOCKED_OUT`.
  - Looser per-address lockout: `INVITE_ADDRESS_LOCKOUT_ATTEMPTS` (default 50 failed attempts in 15 min) rejects all handshakes from that IP with `INVITE_LOCKED_OUT` to stop token-rotation bypass. Only failed attempts count; valid codes never trip it. Shared networks (campus Wi-Fi, tunnels) can raise the limit.
- **Memory Growth & Map Bounds:**
  - All in-memory maps in `safety.js` (`lockouts`, `addressLockouts`, `userBlocks`, `sessionReports`, `verifiedPairings`, `userReportTallies`, `cooldowns`) enforce hard bounds (`MAX_TRACKED_LOCKOUTS`, default 10,000) using oldest-entry LRU eviction (`setWithCap`).
  - `sweepExpired()` actively purges all failed-attempt records older than 15 minutes, including partial attempts that never reached lockout thresholds.
- **Anonymous Client Token:** Generated via `crypto.randomUUID()` in `localStorage`, hashed server-side with `HMAC-SHA256` keyed by `SERVER_SALT`. Zero logging of raw tokens, codes, or notes.
- **Startup Config Guard:** `validateStartupConfig()` checks `SERVER_SALT` ($\ge 32$) and `INVITE_CODES` ($\ge 16$ per code) on startup, failing safely with a clear message (no secrets printed).
- **Multi-Tier Rate Limiting:** Token-bucket rate limits per event type: generous 30-capacity bucket (10/s refill) for `ice-candidate` bursts; strict buckets for `join-queue`, `offer`, `answer`, `leave-session`, `report-user`, and `block-user`. Global flood limiter drops excessive traffic and signals disconnect upon continuous flood.
- **Post-Call Grace Window:** Server retains last `sessionId` and partner's `hashedToken` in memory for 120s after call end to permit reporting or blocking a partner who left.
- **Block & Cooldown Abuse Controls:**
  - In-memory bidirectional block check evaluated in `isCompatible` in constant time without `await` (24h TTL, 100-entry LRU cap). Block ends active call immediately and returns both users to idle.
  - Automated 1h cooldown triggered when a token receives reports from $\ge 3$ distinct verified partner tokens. Rejects `join-queue` with informative status.
- **Reports File:** Appended to `backend/data/reports.jsonl` (mode `0600`, git-ignored, 10MB cap). Notes are stripped of control characters and capped at 200 characters. Urgent reports trigger a terminal alert without personal data.
- **Minimal Frontend:** Bare invite-code entry card preceding camera/mic access; Start button disabled until media is ready.
- **Test Suite:** 77 unit tests passing in `backend/test/` covering all Phase 7a requirements and lockout rotation defense.

---

## Phase 6a Complete & Phase 6b Deferred
- **ICE Configuration & Management (`ice.js`):** Server delivers `iceServers` (Google STUN default) and `iceTransportPolicy` (`"all"` default, `"relay"` configurable) inside `matched`. TURN credentials cached with 1-hr TTL, 3s timeout, and concurrent request deduplication.
- **Relay-Without-TURN Refusal:** If `ICE_TRANSPORT_POLICY="relay"` and no TURN servers are available, the server terminates pairing and emits a clear rejection without falling back to STUN.
- **Telemetry (`connection-stats`):** Clients classify candidate pairs as `"direct"`, `"relay"`, or `"unknown"`. Server strictly validates payload and rate-limits to once per session per socket without logging IP addresses or raw candidate strings.
- **Failure Handling:** Client automatically tears down call cleanly if `iceConnectionState === "failed"` or if disconnected for > 5s, resetting to `idle` with camera running and displaying `"Call disconnected due to network issues."`.
- **Verified Fixes:**
  - `leaveSession` / abort paths: recent partners are not recorded on aborts (relay refusal or partner leaving during ICE lookup), allowing immediate re-match.
  - Stale abort guard: `handleMatchedSession` checks `hasActiveSession(sessionId)` before dissolving, preventing eviction of re-queued users or new sessions.
- **Phase 6b Deferred:** No free no-card TURN option chosen; prototype remains on STUN-only baseline for now. Revisit only if real users cannot connect. The TURN fetch logic in `ice.js` is dormant.
- **Privacy Notice:** Direct mode exposes users' public IP addresses to connected peers via WebRTC candidate exchange; private testers must be informed.
- **Zero-Payment Constraint:** Never use any third-party service requiring a payment method or credit card on file.
- **Test Suite:** 41 unit tests passing in `backend/test/` covering connectivity, lifecycle, payload validation, and secret sanitization.

---

## Phase 5 Completed
- **Commit:** `Phase 5: next, recent-partner memory, opt-in broaden, ghost cleanup and tests`
- **Next / Skip Flow:** Next button in active call emits `leave-session` (`{}`), tears down WebRTC and remote video, and immediately dispatches `join-queue` with user's saved preferences from the client.
- **Recent-Partner Exclusion:** In-memory tracking of recent partner socket pairs with configurable limit (`RECENT_PARTNER_LIMIT=5`) and TTL (`RECENT_PARTNER_TTL_MS=120000`). Applied bidirectionally on session end (Next, leave, partner-left). Socket entry cleaned on disconnect and expired entries purged in ghost sweep. Reloading tab resets socket ID without storing personal data.
- **Broaden Prompt Banner:** After 30s queue wait, server emits `broaden-prompt`. Frontend displays opt-in banner ("No matches yet. Widen your search? You may be matched with people outside your selected preferences, if they're open to meeting you.") with "Widen search" and "Keep waiting". Opting in widens preferences for that single queue entry only while respecting mutual partner preferences.
- **Ghost Socket & Session Sweep:** Background timer sweeps every 30s (`unref()`) to purge disconnected queue sockets, dissolve orphaned sessions, and notify surviving peers.
- **Heartbeat & Ping:** Socket.IO ping interval (15s) and timeout (10s) configured via `config.js`.
- **Late-Reply & Stale-Event Guards:** `uiStateRef` and `isSubmittingRef` ensure stale queue-status or late broaden-prompts are safely ignored.
- **Test Suite:** 29 backend unit tests passing in ~165ms covering lifecycle, compatibility, and matchmaking.

---

## Notes for Phase 6
- **Next Step:** Phase 6 plan approval before code implementation.
- **Split-Screen Layout:** Full-height responsive video view (local preview + remote video) with clean overlay controls.
- **Accessibility & Contrast:** High contrast buttons, labels, and status badges adhering to PRD requirements.

---

## Phase 4 Completed
- **Commit:** `Phase 4: preference-aware matching, validation, connection-state UI and tests`
- **Pure Compatibility (`compatibility.js`):** Mutual compatibility checking; enforces the rule that `"Anyone"` is the only preference that accepts `"Prefer not to say"`.
- **Server Validation (`compatibility.js`):** `validateJoinPayload` strictly verifies identity, deduplicates preferences, rejects unknown items or extra fields, and collapses `"Anyone"`.
- **Matchmaker Updates (`matchmaker.js`):** Longest-waiter-first queue ordering, synchronous atomic matching (zero awaits), disconnected socket pruning, and `MATCH_WITH_ANYONE` flag support.
- **Privacy & Telemetry:** Matched event carries only `sessionId` and caller role. Zero logging of identities or preferences.
- **Connection-Resilient UI (`App.jsx`):** Live server connection status indicator, disabled Start button when offline/submitting, 5-second request timeout with auto-leave, and graceful reconnect state management.

---

## Phase 3 Completed
- **Commit:** `a3f407c` ("Phase 3: in-memory queue and private session rooms")

---

## Phase 2 Completed
- **Commit:** `b62324a` ("Phase 2: WebRTC call between two tabs via bare signaling")

---

## Phase 1 Completed
- **Commit:** `7dccd36` ("Phase 1: project setup, docs and connection baseline")
