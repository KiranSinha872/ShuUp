# Shuup - Project Folder Structure

This document outlines the directory structure and file layout. `frontend/` and `backend/` are strictly independent projects with their own dependencies, configuration, and scripts.

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
│   └── design.md                   # Visual system, layout, and component design specs
├── frontend/                       # Vite + React client application (Plain JavaScript)
│   ├── .env.example                # Example client variables (e.g., VITE_BACKEND_URL)
│   ├── .gitignore                  # Client ignore (node_modules, .env*, dist)
│   ├── package.json                # Frontend package dependencies and build scripts
│   ├── vite.config.js              # Vite dev server and build configuration
│   ├── index.html                  # Single-page application HTML entry mount
│   └── src/
│       ├── main.jsx                # React root bootstrap and DOM rendering
│       ├── App.jsx                 # Primary app state machine (onboarding, waiting, active call)
│       ├── App.css                 # Core split-screen and responsive layout styles
│       ├── socket.js               # Socket.IO client instance and event handler dispatch
│       ├── webrtc.js               # WebRTC peer connection manager (streams, offer/answer, ICE)
│       ├── components/
│       │   ├── ConsentModal.jsx    # First-visit 18+ verification and community rules modal
│       │   ├── Preferences.jsx     # Identity selection and match preferences controls
│       │   ├── VideoGrid.jsx       # Side-by-side local and remote video display
│       │   ├── Controls.jsx        # Call action buttons: Start, Next, Leave/Stop
│       │   ├── StatusPanel.jsx     # Queue status indicator and live online user counter
│       │   └── SafetyModal.jsx     # In-call report and block submission dialog
│       └── pages/
│           └── AdminDashboard.jsx  # Protected /admin route displaying aggregate metrics (Phase 8)
└── backend/                        # Plain Node.js HTTP + Socket.IO server (No Express)
    ├── .env.example                # Example server variables (PORT, CORS_ORIGIN, INVITE_CODES)
    ├── .gitignore                  # Backend ignore (node_modules, .env*)
    ├── package.json                # Backend package dependencies and start scripts
    └── src/
        ├── server.js               # Node HTTP server, /health endpoint, and Socket.IO initialization
        ├── config.js               # Environment configuration and default settings loader
        ├── matchmaker.js           # In-memory queue, atomic mutual compatibility matcher
        ├── signaling.js            # WebRTC signaling router scoped strictly to paired partners
        ├── moderation.js           # In-memory rate limiting, reporting, and session blocking (Phase 7)
        └── telemetry.js            # Anonymous session metrics and Supabase client integration (Phase 8)
```

