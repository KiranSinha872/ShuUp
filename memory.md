# Shuup - Progress Memory & State Log

## Current Status
- **Current Phase:** Phase 4 complete
- **Active Step:** Awaiting Phase 5 plan
- **Next Step:** Phase 5 (Session Lifecycle & Robustness: Next/skip, recent-partner memory, 30s broaden prompt, ghost cleanup)

---

## Running Locally
To run the prototype locally, start both dev servers in separate terminal tabs:
1. **Backend:** `cd backend && npm run dev` (starts on port 4000).
2. **Frontend:** `cd frontend && npm run dev` (starts on port 3000).
- The browser UI shows `Server: Connected` (green) only when the backend server is active. If the backend is stopped or unreachable, the UI indicates `Server: Disconnected` (red) and disables the Start button to prevent dead clicks.

---

## Phase 4 Completed
- **Commit:** `Phase 4: preference-aware matching, validation, connection-state UI and tests`
- **Pure Compatibility (`compatibility.js`):** Mutual compatibility checking; enforces the rule that `"Anyone"` is the only preference that accepts `"Prefer not to say"`.
- **Server Validation (`compatibility.js`):** `validateJoinPayload` strictly verifies identity, deduplicates preferences, rejects unknown items or extra fields, and collapses `"Anyone"`.
- **Matchmaker Updates (`matchmaker.js`):** Longest-waiter-first queue ordering, synchronous atomic matching (zero awaits), disconnected socket pruning, and `MATCH_WITH_ANYONE` flag support.
- **Privacy & Telemetry:** Matched event carries only `sessionId` and caller role. Zero logging of identities or preferences.
- **Connection-Resilient UI (`App.jsx`):** Live server connection status indicator, disabled Start button when offline/submitting, 5-second request timeout with auto-leave, and graceful reconnect state management.
- **Test Suite (`test/`):** 18 unit tests using Node's native `node --test` runner covering the Section 6.4 6-user scenario, payload edge cases, and longest waiter matching.

---

## Notes for Phase 5
- **Queue Timeout Edge Case:** After the frontend's 5-second queue timeout triggers (which returns the UI to `idle` and emits `leave-session`), a severely delayed `queue-status: "waiting"` from the server could theoretically arrive late and shift the UI back into `WAITING` while the server has already removed the user. Phase 5 should ensure late incoming `queue-status` packets are ignored if the UI has already returned to `idle` or if `isSubmitting` is false.

---

## Phase 3 Completed
- **Commit:** `a3f407c` ("Phase 3: in-memory queue and private session rooms")

---

## Phase 2 Completed
- **Commit:** `b62324a` ("Phase 2: WebRTC call between two tabs via bare signaling")

---

## Phase 1 Completed
- **Commit:** `7dccd36` ("Phase 1: project setup, docs and connection baseline")
