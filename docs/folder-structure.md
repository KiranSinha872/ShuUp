# Shuup - Project Folder Structure

This document outlines the current project layout and planned structure. `frontend/` and `backend/` are strictly independent projects with their own dependencies, configuration, and scripts.

```text
Shuup/
├── .gitignore                      # Root ignore for OS files and local editor settings
├── AGENTS.md                       # Agent development guidelines (Ponytail mode)
├── memory.md                       # Project progress log and state tracker
├── SHUUP_PROJECT_BRIEF_FINAL.md   # Original customer specification
├── docs/                           # Central architectural and design documentation
│   ├── PRD.md                      # Product requirements and safety specification
│   ├── architecture.md             # System architecture, matching rules, and event contract
│   ├── folder-structure.md         # This folder layout documentation
│   ├── tech-stack-rules.md         # Implementation, technical, and security guidelines
│   ├── phases.md                   # 9-step development phases with acceptance criteria
│   ├── design.md                   # Visual system, layout, and component design specs
│   └── moderation-procedure.md     # [Planned Phase 7b] Operational moderation and incident response runbook
├── frontend/                       # Vite + React client application (Plain JavaScript)
│   ├── .env.example                # Example client variables (e.g., VITE_BACKEND_URL)
│   ├── .gitignore                  # Client ignore (node_modules, .env*, dist)
│   ├── package.json                # Frontend package dependencies and build scripts
│   ├── vite.config.js              # Vite dev server and build configuration (port 3000)
│   ├── index.html                  # Single-page application HTML entry mount
│   └── src/
│       ├── main.jsx                # React root bootstrap and DOM rendering
│       ├── App.jsx                 # Primary app state machine (invite gate, idle, waiting, matched call views)
│       ├── webrtc.js               # WebRTC peer connection manager (STUN, streams, ICE candidate buffering)
│       ├── App.css                 # [Planned Phase 6+] Split-screen and responsive design styling
│       ├── components/             # [Planned Phase 6+] Modular UI components (VideoGrid, Controls, Modals)
│       └── pages/                  # [Planned Phase 8] Protected /admin route
└── backend/                        # Plain Node.js HTTP + Socket.IO server (No Express)
    ├── .env.example                # Example server variables (PORT, CORS_ORIGIN, INVITE_CODES, SERVER_SALT)
    ├── .gitignore                  # Backend ignore (node_modules, .env*, data/)
    ├── package.json                # Backend dependencies, start scripts, and node --test script
    ├── data/                       # Git-ignored local directory (reports.jsonl with 0600 permissions)
    ├── src/
    │   ├── server.js               # Node HTTP server, /health endpoint, and Socket.IO initialization
    │   ├── config.js               # Server configuration and tunable numeric constants with environment fallbacks
    │   ├── matchmaker.js           # In-memory queue, atomic mutual compatibility matcher, session store
    │   ├── compatibility.js        # Pure mutual compatibility rules and join-queue payload validator
    │   ├── signaling.js            # WebRTC signaling router scoped strictly to paired partners
    │   ├── ice.js                  # ICE server manager, cached TURN credential provider, STUN fallback
    │   └── safety.js               # Handshake auth, token hashing, rate limiting, reports, blocks & cooldown
    └── test/
        ├── compatibility.test.js   # Unit tests for pure isCompatible rules and validateJoinPayload
        ├── matchmaker.test.js      # Unit tests for queue FIFO, 6-user scenario, and longest-waiter-first
        ├── lifecycle.test.js       # Unit tests for recent-partner memory, ghost cleanup, and broaden prompt flow
        ├── connectivity.test.js    # Unit tests for ICE management, fallback, matched payload, and stats validation
        └── safety.test.js          # Unit tests for invite validation, lockout, token hashing, blocks, and rate limiting
```
