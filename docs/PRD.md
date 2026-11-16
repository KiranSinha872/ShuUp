# Shuup - Product Requirements Document (PRD)

## 1. Overview
Shuup is a browser-based, one-to-one random video chat web application offering transparent, preference-aware matching without paywalls. Users declare their identity, select who they want to meet, and join an in-memory queue. Once mutually compatible users are found, a peer-to-peer WebRTC video call is established directly between their browsers.

## 2. Target Audience & Scope
- **Prototype Phase:** Adult testing with confirmed adult testers (enforced via in-memory consent gate; sign-in to be added in Phase 7c).
- **Public Phase:** Adult users (18+) who agree to community safety guidelines. Stranger-to-stranger video is strictly prohibited for minors.
- **Platform:** Modern desktop and mobile web browsers with camera and microphone access.

## 3. Core Functional Requirements
1. **Consent & Rules Gate (In-Memory Per Page Load):**
   - Explicit confirmation of age (18+), direct P2P IP visibility, and agreement to Community Rules prior to requesting camera/microphone permissions.
   - Maintained in memory per page load (never stored in `localStorage`) so every page refresh prompts for re-verification.
2. **Preference-Aware Matchmaking:**
   - Single-select identity: `Man`, `Woman`, `Non-binary`, `Prefer not to say`.
   - Multi-select match preferences: `Men`, `Women`, `Non-binary people`, `Anyone`.
   - Mutual compatibility requirement (details in [architecture.md](file:///Users/kiransinha/Desktop/Shuup/docs/architecture.md)).
   - Longest-waiter-first queue ordering with zero paywalls.
3. **Queue Status & Broadening:**
   - Real-time status display (waiting, searching, matched).
   - Opt-in prompt to broaden preferences after 30 seconds of waiting without a match.
4. **Call Experience (Split-Screen):**
   - Two equal video panes: local stream and remote partner stream.
   - Live online user counter.
   - Core controls: `Start`, `Next` (skip to next compatible partner), `Leave/Stop`.
   - Explicitly excluded for prototype: mute/camera toggles, text chat, country filters.
5. **Admin Dashboard (`/admin`):**
   - Protected route displaying live platform health:
     - Users currently online.
     - Total completed calls.
     - Total call minutes.
     - Calls per day over the last 7 days.
   - Authentication via Supabase Auth with Multi-Factor Authentication (MFA).
   - Backend verification of the admin JWT on every administrative request.

## 4. Safety, Privacy & Trust (Single Source of Truth)
- **Strict Minor Protection:** Unrestricted stranger video is disabled for minors. Testing is limited to confirmed adults (18+).
- **Report & Block:**
   - Accessible during every call and for 120 seconds after call end via a grace period window.
   - Reporting supports 5 fixed categories including urgent classifications for minor safety and violent threats. Appended to `backend/data/reports.jsonl` with sanitized notes.
   - Blocking immediately dissolves the call and excludes partner tokens for 24 hours within the synchronous matching check.
   - Automated cooldown temporarily suspends users accumulating reports from $\ge 3$ distinct verified partners.
- **Anonymous Telemetry Only:**
   - Logged session data includes only: `session_id`, `started_at`, `ended_at`, `duration_seconds`, `connection_type` (direct P2P or TURN relay).
   - **Never collected or stored:** IP addresses, real names, video/audio recordings, or media frames.
- **No Identity Inference:** Gender or identity is never inferred from computer vision, audio, names, or metadata.
- **Zero Video on Server:** Video streams travel strictly peer-to-peer or via an encrypted TURN relay. The Node.js server never receives media frames.

## 5. Non-Functional Requirements
- **Zero Cost Prototype:** Runs entirely on free-tier services (Vercel/Cloudflare Pages for frontend, Render free tier for backend, Google public STUN, Supabase free tier).
- **Latency:** Real-time signaling delivery via WebSockets (<100ms); direct P2P video streaming.
- **Single-Threaded Safety:** In-memory queue matching must execute synchronously without async interruptions to prevent double-matching.

## 6. Open Items
- [OPEN] Production-grade adult age verification vendor (required before public rollout).
- [OPEN] Long-term TURN provider selection after verifying Metered.ca free quota under multi-user load.

