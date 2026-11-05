# Shuup - Progress Memory & State Log

## Current Status
- **Current Phase:** Phase 2 complete; planning Phase 3 (In-Memory Queue & Private Rooms)
- **Active Step:** Awaiting user confirmation to commit Phase 2 and approve Phase 3 plan
- **Next Step:** Phase 3 implementation (matchmaker.js, private session rooms, Start button, multi-pair concurrency)

---

## Phase 2 Completed
- **WebRTC Signaling:** Direct P2P audio/video connection established between two tabs using bare Socket.IO signaling.
- **Media Handling:** `getUserMedia` invoked first with explicit error classification (`NotAllowedError`, `NotFoundError`, `NotReadableError`).
- **Connection Hygiene:** StrictMode unmount double-mounting guard (`cancelled` flag); candidate buffering queue to eliminate WebRTC SDP/ICE race conditions; local self-preview muted to prevent acoustic feedback.
- **Backend Guardrails:** Memory limits enforced (64 KB SDP, 8 KB ICE candidates); partner isolation for relayed signals; automatic room reset retaining surviving peer.

---

## Phase 1 Completed
- **Commit:** `7dccd36` ("Phase 1: project setup, docs and connection baseline")
- **Clean State:** Verified no `.env` or `node_modules` committed.

---

## Files in Progress / Created
- `backend/src/server.js` (ready to commit)
- `frontend/src/webrtc.js` (ready to commit)
- `frontend/src/App.jsx` (ready to commit)
- `memory.md` (updated)
