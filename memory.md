# Shuup - Progress Memory & State Log

## Current Status
- **Current Phase:** Phase 5 complete
- **Active Step:** Awaiting Phase 6 plan
- **Next Step:** Phase 6 (Split-screen video interface, responsive CSS, accessible layout)

---

## Running Locally
To run the prototype locally, start both dev servers in separate terminal tabs:
1. **Backend:** `cd backend && npm run dev` (starts on port 4000).
2. **Frontend:** `cd frontend && npm run dev` (starts on port 3000).
- The browser UI shows `Server: Connected` (green) only when the backend server is active. If the backend is stopped or unreachable, the UI indicates `Server: Disconnected` (red) and disables the Start button to prevent dead clicks.

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
