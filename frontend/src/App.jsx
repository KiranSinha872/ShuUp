import React, { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { createPeerConnection } from "./webrtc.js";
import ConsentGate from "./components/ConsentGate.jsx";
import ReportModal from "./components/ReportModal.jsx";
import BlockConfirmModal from "./components/BlockConfirmModal.jsx";
import PreviousPartnerNotice from "./components/PreviousPartnerNotice.jsx";
import "./App.css";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

const IDENTITIES = [
  { label: "Man", icon: "👦" },
  { label: "Woman", icon: "👧" },
  { label: "Non-binary", icon: "🧑" },
  { label: "Prefer not to say", icon: "👤" }
];

function getOrCreateClientToken() {
  let token = localStorage.getItem("shuup_client_token");
  if (!token || typeof token !== "string" || token.length < 8) {
    token = crypto.randomUUID();
    localStorage.setItem("shuup_client_token", token);
  }
  return token;
}

export default function App() {
  const [uiState, setUiState] = useState("idle"); // "idle" | "waiting" | "matched"
  const [isConnected, setIsConnected] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showBroadenBanner, setShowBroadenBanner] = useState(false);
  const [status, setStatus] = useState("Waiting for consent...");
  const [errorMessage, setErrorMessage] = useState("");
  const [sessionInfo, setSessionInfo] = useState(null);

  // Consent gate state
  const [hasConsented, setHasConsented] = useState(false);
  const [isMediaReady, setIsMediaReady] = useState(false);

  // Safety UI states: Report, Block & 120s Grace Period
  const [previousSessionGrace, setPreviousSessionGrace] = useState(null);
  const [reportModal, setReportModal] = useState({ isOpen: false, targetSessionId: null, label: "partner" });
  const [isBlockModalOpen, setIsBlockModalOpen] = useState(false);
  const [isBlocking, setIsBlocking] = useState(false);

  // User matching attributes
  const [identity, setIdentity] = useState("Prefer not to say");
  const [preferences, setPreferences] = useState(["Anyone"]);

  // Popover state for the "I Am" button
  const [isIdentityMenuOpen, setIsIdentityMenuOpen] = useState(false);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const rtcSessionRef = useRef(null);
  const socketRef = useRef(null);
  const currentSessionIdRef = useRef(null);
  const pendingOfferRef = useRef(null);
  const queueTimeoutRef = useRef(null);
  const iceDisconnectTimerRef = useRef(null);

  const uiStateRef = useRef("idle");
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    uiStateRef.current = uiState;
  }, [uiState]);

  useEffect(() => {
    isSubmittingRef.current = isSubmitting;
  }, [isSubmitting]);

  // Close identity menu on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (!e.target.closest(".shuup-btn-iam") && !e.target.closest(".shuup-iam-popover")) {
        setIsIdentityMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Request camera and microphone access after consent is granted
  async function startMedia() {
    try {
      setStatus("Requesting camera and microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      setIsMediaReady(true);
      setStatus("Camera preview ready. Press Start to meet someone.");
    } catch (err) {
      setIsMediaReady(false);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setErrorMessage("Camera or microphone permission was denied. Allow access in your browser settings, then reload.");
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        setErrorMessage("No camera or microphone found on this device.");
      } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
        setErrorMessage("Camera or microphone is already in use by another application or tab.");
      } else {
        setErrorMessage(`Media error: ${err.message || err.name}`);
      }
      setStatus("Media access failed.");
    }
  }

  function wireSocketEvents(socket) {
    socket.on("connect", () => {
      setIsConnected(true);
      setErrorMessage("");
      if (uiStateRef.current === "idle") {
        setStatus("Ready. Press Start to meet someone.");
      }
    });

    socket.on("connect_error", (err) => {
      setIsConnected(false);
      let msg = "Cannot reach the server. Please check your connection.";
      if (err.message === "SERVER_FULL") {
        msg = "The server is currently full. Please try again in a few moments.";
      } else if (err.message === "MAX_ADDRESS_CONNECTIONS_REACHED") {
        msg = "Too many connections from this network address. Try again later.";
      } else if (err.message === "BANNED") {
        msg = "Access denied: Account permanently blocked.";
      }
      setErrorMessage(msg);
    });

    socket.on("server-full", () => {
      setIsConnected(false);
      setErrorMessage("The server is currently full. Please try again in a few moments.");
    });

    socket.on("queue-status", (data) => {
      if (!isSubmittingRef.current || uiStateRef.current !== "idle") {
        return;
      }

      if (queueTimeoutRef.current) {
        clearTimeout(queueTimeoutRef.current);
        queueTimeoutRef.current = null;
      }
      setIsSubmitting(false);
      isSubmittingRef.current = false;

      if (data.status === "waiting") {
        setUiState("waiting");
        uiStateRef.current = "waiting";
        setStatus(data.message || "Waiting for a partner...");
      } else if (data.status === "rejected") {
        setUiState("idle");
        uiStateRef.current = "idle";
        setErrorMessage(data.message || "Queue request rejected.");
        setStatus("Ready. Press Start to try again.");
      }
    });

    socket.on("broaden-prompt", () => {
      if (uiStateRef.current !== "waiting") return;
      setShowBroadenBanner(true);
    });

    socket.on("matched", async ({ sessionId, isCaller, iceServers, iceTransportPolicy }) => {
      if (queueTimeoutRef.current) {
        clearTimeout(queueTimeoutRef.current);
        queueTimeoutRef.current = null;
      }
      if (iceDisconnectTimerRef.current) {
        clearTimeout(iceDisconnectTimerRef.current);
        iceDisconnectTimerRef.current = null;
      }
      setIsSubmitting(false);
      isSubmittingRef.current = false;
      setShowBroadenBanner(false);

      currentSessionIdRef.current = sessionId;
      setSessionInfo({ sessionId, role: isCaller ? "Caller" : "Callee" });
      setUiState("matched");
      uiStateRef.current = "matched";
      setStatus(`Matched with partner.`);

      if (rtcSessionRef.current) {
        rtcSessionRef.current.cleanup();
        rtcSessionRef.current = null;
      }

      function triggerIceNetworkFailure() {
        if (iceDisconnectTimerRef.current) {
          clearTimeout(iceDisconnectTimerRef.current);
          iceDisconnectTimerRef.current = null;
        }
        if (uiStateRef.current === "matched") {
          if (currentSessionIdRef.current) {
            setPreviousSessionGrace({
              sessionId: currentSessionIdRef.current,
              expiresAt: Date.now() + 120_000
            });
          }
          if (socketRef.current) {
            socketRef.current.emit("leave-session", {});
          }
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
          }
          if (rtcSessionRef.current) {
            rtcSessionRef.current.cleanup();
            rtcSessionRef.current = null;
          }
          setSessionInfo(null);
          currentSessionIdRef.current = null;
          pendingOfferRef.current = null;
          setUiState("idle");
          uiStateRef.current = "idle";
          setErrorMessage("Call disconnected due to network issues.");
          setStatus("Ready. Press Start to connect.");
        }
      }

      const rtc = createPeerConnection({
        iceServers,
        iceTransportPolicy,
        onIceCandidate: (candidate) => {
          socket.emit("ice-candidate", { candidate });
        },
        onTrack: (remoteStream) => {
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream;
          }
        },
        onIceConnectionStateChange: (state) => {
          if (state === "failed") {
            triggerIceNetworkFailure();
          } else if (state === "disconnected") {
            if (iceDisconnectTimerRef.current) {
              clearTimeout(iceDisconnectTimerRef.current);
            }
            iceDisconnectTimerRef.current = setTimeout(() => {
              iceDisconnectTimerRef.current = null;
              triggerIceNetworkFailure();
            }, 5000);
          } else if (state === "connected" || state === "completed") {
            if (iceDisconnectTimerRef.current) {
              clearTimeout(iceDisconnectTimerRef.current);
              iceDisconnectTimerRef.current = null;
            }
            setStatus("Call connected with partner.");
          }
        },
        onConnectionStats: (connectionType) => {
          socket.emit("connection-stats", { sessionId, connectionType });
        }
      });

      rtcSessionRef.current = rtc;
      rtc.addLocalStream(localStreamRef.current);

      if (pendingOfferRef.current && pendingOfferRef.current.sessionId === sessionId) {
        const earlyOffer = pendingOfferRef.current.sdp;
        pendingOfferRef.current = null;
        try {
          setStatus("Processing offer. Connecting...");
          const answerDesc = await rtc.handleOffer(earlyOffer);
          socket.emit("answer", { sdp: answerDesc });
          setStatus("Call connected with partner.");
        } catch (err) {
          console.error("[WebRTC] Error handling early offer:", err);
        }
      } else if (isCaller) {
        try {
          const offerDesc = await rtc.createOffer();
          socket.emit("offer", { sdp: offerDesc });
          setStatus("Connecting to partner...");
        } catch (err) {
          console.error("[WebRTC] Error creating offer:", err);
          setErrorMessage("Failed to initiate call offer.");
        }
      }
    });

    socket.on("offer", async ({ sessionId, sdp }) => {
      if (!currentSessionIdRef.current || sessionId !== currentSessionIdRef.current) return;
      if (!rtcSessionRef.current) {
        pendingOfferRef.current = { sessionId, sdp };
        return;
      }

      try {
        setStatus("Offer received. Connecting...");
        const answerDesc = await rtcSessionRef.current.handleOffer(sdp);
        socket.emit("answer", { sdp: answerDesc });
        setStatus("Call connected with partner.");
      } catch (err) {
        console.error("[WebRTC] Error handling offer:", err);
        setErrorMessage("Failed to process partner's call offer.");
      }
    });

    socket.on("answer", async ({ sessionId, sdp }) => {
      if (!currentSessionIdRef.current || sessionId !== currentSessionIdRef.current) return;
      if (!rtcSessionRef.current) return;

      try {
        await rtcSessionRef.current.handleAnswer(sdp);
        setStatus("Call connected with partner.");
      } catch (err) {
        console.error("[WebRTC] Error handling answer:", err);
        setErrorMessage("Failed to process partner's call answer.");
      }
    });

    socket.on("ice-candidate", async ({ sessionId, candidate }) => {
      if (!currentSessionIdRef.current || sessionId !== currentSessionIdRef.current) return;
      if (!rtcSessionRef.current) return;

      try {
        await rtcSessionRef.current.addRemoteCandidate(candidate);
      } catch (err) {
        console.warn("[WebRTC] Error adding ICE candidate:", err);
      }
    });

    socket.on("partner-left", ({ reason }) => {
      if (queueTimeoutRef.current) {
        clearTimeout(queueTimeoutRef.current);
        queueTimeoutRef.current = null;
      }
      if (iceDisconnectTimerRef.current) {
        clearTimeout(iceDisconnectTimerRef.current);
        iceDisconnectTimerRef.current = null;
      }
      setIsSubmitting(false);
      isSubmittingRef.current = false;
      setShowBroadenBanner(false);

      if (currentSessionIdRef.current) {
        setPreviousSessionGrace({
          sessionId: currentSessionIdRef.current,
          expiresAt: Date.now() + 120_000
        });
      }

      setStatus(`Partner left (${reason}). Ready to start again.`);
      setSessionInfo(null);
      currentSessionIdRef.current = null;
      pendingOfferRef.current = null;

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }

      if (rtcSessionRef.current) {
        rtcSessionRef.current.cleanup();
        rtcSessionRef.current = null;
      }

      setUiState("idle");
      uiStateRef.current = "idle";
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
      if (queueTimeoutRef.current) {
        clearTimeout(queueTimeoutRef.current);
        queueTimeoutRef.current = null;
      }
      if (iceDisconnectTimerRef.current) {
        clearTimeout(iceDisconnectTimerRef.current);
        iceDisconnectTimerRef.current = null;
      }
      setIsSubmitting(false);
      isSubmittingRef.current = false;
      setShowBroadenBanner(false);

      setSessionInfo(null);
      currentSessionIdRef.current = null;
      pendingOfferRef.current = null;

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }
      if (rtcSessionRef.current) {
        rtcSessionRef.current.cleanup();
        rtcSessionRef.current = null;
      }

      setUiState("idle");
      uiStateRef.current = "idle";
      setStatus("Connection lost. Reconnecting...");

      setPreviousSessionGrace((prev) => {
        if (prev) {
          setErrorMessage("Connection was lost; the report window for your previous call is no longer available.");
        }
        return null;
      });
    });
  }

  function connectSocket() {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    const token = getOrCreateClientToken();
    const socket = io(BACKEND_URL, {
      auth: {
        clientToken: token
      }
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setIsConnected(true);
      setErrorMessage("");
      wireSocketEvents(socket);
    });

    socket.on("connect_error", (err) => {
      setIsConnected(false);
      socket.disconnect();
      socketRef.current = null;

      let msg = "Cannot reach server. Please check your connection.";
      if (err.message === "SERVER_FULL") {
        msg = "The server is currently full. Please try again in a few moments.";
      } else if (err.message === "MAX_ADDRESS_CONNECTIONS_REACHED") {
        msg = "Too many connections from this network address. Try again later.";
      } else if (err.message === "BANNED") {
        msg = "Access denied: Account permanently blocked.";
      } else if (err.message) {
        msg = `Connection error: ${err.message}`;
      }
      setErrorMessage(msg);
    });
  }

  // Teardown resources on component unmount
  useEffect(() => {
    return () => {
      if (queueTimeoutRef.current) clearTimeout(queueTimeoutRef.current);
      if (iceDisconnectTimerRef.current) clearTimeout(iceDisconnectTimerRef.current);
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (rtcSessionRef.current) rtcSessionRef.current.cleanup();
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  function handleStart() {
    if (uiStateRef.current !== "idle" || !socketRef.current || !isConnected || isSubmittingRef.current || !isMediaReady) {
      return;
    }

    setIsIdentityMenuOpen(false);
    setShowBroadenBanner(false);
    setIsSubmitting(true);
    isSubmittingRef.current = true;
    setErrorMessage("");
    setStatus("Connecting to matchmaking queue...");

    socketRef.current.emit("join-queue", {
      identity,
      preferences: ["Anyone"]
    });

    queueTimeoutRef.current = setTimeout(() => {
      if (isSubmittingRef.current) {
        setIsSubmitting(false);
        isSubmittingRef.current = false;
        if (socketRef.current) {
          socketRef.current.emit("leave-session", {});
        }
        setErrorMessage("Server request timed out after 5 seconds.");
        setStatus("Ready. Press Start to connect.");
      }
    }, 5000);
  }

  function handleLeave() {
    if (uiStateRef.current === "idle") return;
    setShowBroadenBanner(false);

    if (queueTimeoutRef.current) {
      clearTimeout(queueTimeoutRef.current);
      queueTimeoutRef.current = null;
    }
    if (iceDisconnectTimerRef.current) {
      clearTimeout(iceDisconnectTimerRef.current);
      iceDisconnectTimerRef.current = null;
    }
    setIsSubmitting(false);
    isSubmittingRef.current = false;

    if (currentSessionIdRef.current) {
      setPreviousSessionGrace({
        sessionId: currentSessionIdRef.current,
        expiresAt: Date.now() + 120_000
      });
    }

    if (socketRef.current) {
      socketRef.current.emit("leave-session", {});
    }

    setSessionInfo(null);
    currentSessionIdRef.current = null;
    pendingOfferRef.current = null;

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    if (rtcSessionRef.current) {
      rtcSessionRef.current.cleanup();
      rtcSessionRef.current = null;
    }

    setUiState("idle");
    uiStateRef.current = "idle";
    setStatus("Ready. Press Start to connect.");
  }

  function handleNext() {
    if (uiStateRef.current !== "matched" || !socketRef.current || !isConnected || isSubmittingRef.current) return;
    if (iceDisconnectTimerRef.current) {
      clearTimeout(iceDisconnectTimerRef.current);
      iceDisconnectTimerRef.current = null;
    }
    setShowBroadenBanner(false);

    if (currentSessionIdRef.current) {
      setPreviousSessionGrace({
        sessionId: currentSessionIdRef.current,
        expiresAt: Date.now() + 120_000
      });
    }

    socketRef.current.emit("leave-session", {});

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    if (rtcSessionRef.current) {
      rtcSessionRef.current.cleanup();
      rtcSessionRef.current = null;
    }

    setSessionInfo(null);
    currentSessionIdRef.current = null;
    pendingOfferRef.current = null;

    setUiState("idle");
    uiStateRef.current = "idle";
    handleStart();
  }

  function handleConsentGranted() {
    setHasConsented(true);
    startMedia();
    connectSocket();
  }

  function handleOpenReport(targetSessionId, label = "partner") {
    setReportModal({
      isOpen: true,
      targetSessionId,
      label
    });
  }

  function handleSubmitReport(payload, callback) {
    if (!socketRef.current || !isConnected) {
      if (typeof callback === "function") callback({ ok: false, error: "NOT_CONNECTED" });
      return;
    }
    socketRef.current.emit("report-user", payload, (response) => {
      if (response && response.ok) {
        if (previousSessionGrace && previousSessionGrace.sessionId === payload.sessionId) {
          setPreviousSessionGrace(null);
        }
      }
      if (typeof callback === "function") callback(response);
    });
  }

  function handleOpenBlockModal() {
    setIsBlockModalOpen(true);
  }

  function handleBlockConfirm() {
    const activeSessionId = currentSessionIdRef.current;
    if (!activeSessionId || !socketRef.current) {
      setIsBlockModalOpen(false);
      return;
    }
    setIsBlocking(true);
    socketRef.current.emit("block-user", { sessionId: activeSessionId }, () => {
      setIsBlocking(false);
      setIsBlockModalOpen(false);
      setPreviousSessionGrace({
        sessionId: activeSessionId,
        expiresAt: Date.now() + 120_000
      });
      handleLeave();
      setStatus("Partner blocked.");
    });
  }

  const currentIdentityObj = IDENTITIES.find((i) => i.label === identity) || IDENTITIES[3];
  const isStartDisabled = !isConnected || isSubmitting || uiState === "waiting" || !isMediaReady;

  // Gate: Consent and tester rules
  if (!hasConsented) {
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#111317" }}>
        <ConsentGate onConsentGranted={handleConsentGranted} />
      </main>
    );
  }

  return (
    <div className="shuup-stage">
      {/* ======================================================== */}
      {/* UPPER SECTION: TWO SIDE-BY-SIDE VIDEO PANELS            */}
      {/* ======================================================== */}
      <section className="shuup-video-row">
        {/* LEFT PANEL: Remote Partner Video */}
        <div className="shuup-video-panel shuup-remote-panel">
          {/* Small ShuUp Logo in Top-Left Corner */}
          <div className="shuup-watermark">
            <svg width="24" height="20" viewBox="0 0 200 160" fill="none">
              <line x1="82" y1="36" x2="60" y2="10" stroke="#f25c3b" strokeWidth="8" strokeLinecap="round" />
              <line x1="118" y1="36" x2="140" y2="10" stroke="#f25c3b" strokeWidth="8" strokeLinecap="round" />
              <rect x="20" y="32" width="160" height="110" rx="24" fill="#f25c3b" />
              <rect x="32" y="44" width="108" height="86" rx="16" fill="#ffffff" />
              <circle cx="156" cy="62" r="6" fill="#ffffff" />
              <circle cx="156" cy="80" r="6" fill="#ffffff" />
            </svg>
            <span className="shuup-watermark-text">ShuUp</span>
            <span className="shuup-watermark-badge">LIVE</span>
          </div>

          {/* Remote Video Stream */}
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="shuup-video-element shuup-remote-video"
          />

          {/* Placeholder When Not Matched */}
          {uiState !== "matched" && (
            <div className="shuup-placeholder-layer">
              {uiState === "waiting" ? (
                <>
                  <div className="shuup-radar-spinner" />
                  <div className="shuup-placeholder-headline">Looking for a partner...</div>
                  <div className="shuup-placeholder-desc">
                    Searching for someone online. Please keep your face in frame.
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: "36px", marginBottom: "8px" }}>👋</div>
                  <div className="shuup-placeholder-headline">Ready to Chat</div>
                  <div className="shuup-placeholder-desc">
                    {status || "Press Start to begin video matching."}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Top-Right Safety Actions Overlay (When in call) */}
          {uiState === "matched" && (
            <div className="shuup-safety-pills">
              <button
                type="button"
                className="shuup-pill-btn shuup-pill-report"
                onClick={() => handleOpenReport(currentSessionIdRef.current, "current partner")}
              >
                ⚑ Report
              </button>
              <button
                type="button"
                className="shuup-pill-btn shuup-pill-block"
                onClick={handleOpenBlockModal}
              >
                ✕ Block
              </button>
            </div>
          )}
        </div>

        {/* RIGHT PANEL: My Local Camera Video */}
        <div className="shuup-video-panel shuup-local-panel">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="shuup-video-element shuup-local-video"
          />
        </div>
      </section>

      {/* ======================================================== */}
      {/* LOWER SECTION: BOTTOM CONTROLS (LEFT ONLY) & CLEAN RIGHT */}
      {/* ======================================================== */}
      <footer className="shuup-bottom-bar">
        {/* Left Bottom Panel: Exactly THREE Large Buttons */}
        <div className="shuup-bottom-left">
          {/* 1. Next / Start (Green) */}
          {uiState === "matched" ? (
            <button
              type="button"
              className="shuup-action-btn shuup-btn-next"
              onClick={handleNext}
              disabled={isSubmitting}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              className="shuup-action-btn shuup-btn-next"
              onClick={handleStart}
              disabled={isStartDisabled}
            >
              {isSubmitting ? "Queueing..." : "Next"}
            </button>
          )}

          {/* 2. Stop (Coral-Red) */}
          <button
            type="button"
            className={`shuup-action-btn shuup-btn-stop ${uiState !== "idle" ? "active" : ""}`}
            onClick={handleLeave}
            disabled={uiState === "idle"}
          >
            Stop
          </button>

          {/* 3. I Am (White/Light-Grey with Icon) */}
          <div style={{ position: "relative", width: "100%", height: "100%" }}>
            <button
              type="button"
              className={`shuup-action-btn shuup-btn-iam ${isIdentityMenuOpen ? "open" : ""}`}
              style={{ width: "100%" }}
              onClick={() => setIsIdentityMenuOpen(!isIdentityMenuOpen)}
              disabled={uiState !== "idle" || isSubmitting}
            >
              <span>I am</span>
              <span>{currentIdentityObj.icon}</span>
            </button>

            {/* Gender Selection Popover */}
            {isIdentityMenuOpen && (
              <div className="shuup-iam-popover">
                <div className="shuup-iam-title">Select Gender</div>
                {IDENTITIES.map((item) => (
                  <label
                    key={item.label}
                    className="shuup-iam-option"
                    onClick={() => {
                      setIdentity(item.label);
                      setIsIdentityMenuOpen(false);
                    }}
                  >
                    <input
                      type="radio"
                      name="identity"
                      checked={identity === item.label}
                      onChange={() => {}}
                    />
                    <span>{item.icon} {item.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Bottom Panel: Kept completely minimal & clean */}
        <div className="shuup-bottom-right">
          {errorMessage && (
            <div className="shuup-notice-alert">
              {errorMessage}
            </div>
          )}

          {previousSessionGrace && (
            <PreviousPartnerNotice
              graceExpiresAt={previousSessionGrace.expiresAt}
              onOpenReport={() => handleOpenReport(previousSessionGrace.sessionId, "previous partner")}
              onExpire={() => setPreviousSessionGrace(null)}
            />
          )}
        </div>
      </footer>

      {/* Safety Modals: Report & Block Confirmation */}
      <ReportModal
        isOpen={reportModal.isOpen}
        targetSessionId={reportModal.targetSessionId}
        partnerLabel={reportModal.label}
        onSubmitReport={handleSubmitReport}
        onClose={() => setReportModal({ isOpen: false, targetSessionId: null, label: "partner" })}
      />
      <BlockConfirmModal
        isOpen={isBlockModalOpen}
        onConfirm={handleBlockConfirm}
        onCancel={() => setIsBlockModalOpen(false)}
        isSubmitting={isBlocking}
      />
    </div>
  );
}
