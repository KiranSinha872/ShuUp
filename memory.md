# Shuup - Progress Memory & State Log

## Current Status
- **Current Phase:** Phase 3 complete; planning Phase 4 (Preference-Aware Matchmaking)
- **Active Step:** Awaiting user approval of Phase 4 plan
- **Next Step:** Phase 4 implementation (isCompatible pure function, validation, longest-waiter-first queue matching, node:test suite, frontend preference UI)

---

## Phase 3 Completed
- **Commit:** `Phase 3: in-memory queue and private session rooms`
- **Matchmaking Separation:** Created dedicated `matchmaker.js` for in-memory FIFO queue and atomic pairing without awaits.
- **Signaling Separation:** Created dedicated `signaling.js` routing offer, answer, and ICE candidates strictly via stored partner lookup, with payload limits (64 KB SDP, 8 KB candidate) and attached `sessionId`.
- **Concurrency & Robustness:** Verified 4-tab concurrent pairing (two separate simultaneous calls), duplicate click protection, disconnect cleanup while waiting, and survivor recovery on partner reload.

---

## Phase 2 Completed
- **Commit:** `b62324a` ("Phase 2: WebRTC call between two tabs via bare signaling")

---

## Phase 1 Completed
- **Commit:** `7dccd36` ("Phase 1: project setup, docs and connection baseline")

---

## Files in Progress / Created
- `backend/src/matchmaker.js` (created in Phase 3)
- `backend/src/signaling.js` (created in Phase 3)
- `backend/src/server.js` (modified in Phase 3)
- `frontend/src/App.jsx` (modified in Phase 3)
- `memory.md` (updated)
