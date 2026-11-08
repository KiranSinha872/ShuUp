import React, { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { createPeerConnection } from "./webrtc.js";
import InviteGate from "./components/InviteGate.jsx";
import ConsentGate from "./components/ConsentGate.jsx";
import ReportModal from "./components/ReportModal.jsx";
import BlockConfirmModal from "./components/BlockConfirmModal.jsx";
import PreviousPartnerNotice from "./components/PreviousPartnerNotice.jsx";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

const IDENTITIES = ["Man", "Woman", "Non-binary", "Prefer not to say"];
const PREFERENCES = ["Men", "Women", "Non-binary people", "Anyone"];

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
  const [status, setStatus] = useState("Waiting for invite verification...");
  const [errorMessage, setErrorMessage] = useState("");
  const [sessionInfo, setSessionInfo] = useState(null);

  // Invite & Consent gate states (Phase 7b: in-memory only, never saved to storage)
  const [inviteInput, setInviteInput] = useState("");
  const [isInviteAccepted, setIsInviteAccepted] = useState(false);
  const [hasConsented, setHasConsented] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [isMediaReady, setIsMediaReady] = useState(false);

  // Safety UI states: Report, Block & 120s Grace Period
  const [previousSessionGrace, setPreviousSessionGrace] = useState(null); // { sessionId, expiresAt }
  const [reportModal, setReportModal] = useState({ isOpen: false, targetSessionId: null, label: "partner" });
  const [isBlockModalOpen, setIsBlockModalOpen] = useState(false);
  const [isBlocking, setIsBlocking] = useState(false);

  // User matching attributes (defaults per brief)
  const [identity, setIdentity] = useState("Prefer not to say");
  const [preferences, setPreferences] = useState(["Anyone"]);

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

  // Request camera and microphone access after invite is accepted
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
      setStatus("Camera preview ready. Choose your preferences and press Start.");
    } catch (err) {
      setIsMediaReady(false);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setErrorMessage("Camera or microphone permission was denied. Allow access in your browser settings, then reload the page.");
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
        setStatus("Ready. Choose your preferences and press Start.");
      }
    });

    socket.on("connect_error", (err) => {
      setIsConnected(false);
      let msg = "Cannot reach the server. Please check your connection.";
      if (err.message === "INVALID_INVITE_CODE") {
        msg = "Invalid invite code. Access denied.";
        setIsInviteAccepted(false);
        setInviteError(msg);
      } else if (err.message === "INVITE_LOCKED_OUT") {
        msg = "Too many failed attempts. Temporary lockout for 15 minutes.";
        setIsInviteAccepted(false);
        setInviteError(msg);
      } else if (err.message === "BANNED") {
        msg = "Access denied: Account permanently blocked.";
        setIsInviteAccepted(false);
        setInviteError(msg);
      }
      setErrorMessage(msg);
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
        setStatus(data.message || "Waiting for a compatible partner...");
      } else if (data.status === "rejected") {
        setUiState("idle");
        uiStateRef.current = "idle";
        setErrorMessage(data.message || "Queue request rejected.");
        setStatus("Ready. Please check your preferences and press Start.");
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
      setStatus(`Matched! Role: ${isCaller ? "Caller" : "Callee"}. Connecting video...`);

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
          setStatus("Ready. Choose your preferences and press Start.");
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
          setStatus("Processing offer. Sending answer...");
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
          setStatus("Offer sent. Waiting for answer...");
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
        setStatus("Offer received. Sending answer...");
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

      // Clear previous-partner notice if active, since socket ID changes on reconnect and old grace records are cleared
      setPreviousSessionGrace((prev) => {
        if (prev) {
          setErrorMessage("Connection was lost; the report window for your previous call is no longer available.");
        }
        return null;
      });
    });
  }

  function connectSocketWithAuth(code) {
    setIsAuthenticating(true);
    setInviteError("");

    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    const token = getOrCreateClientToken();
    const socket = io(BACKEND_URL, {
      auth: {
        inviteCode: code,
        clientToken: token
      }
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setIsAuthenticating(false);
      setIsConnected(true);
      setIsInviteAccepted(true);
      setInviteError("");
      wireSocketEvents(socket);
    });

    socket.on("connect_error", (err) => {
      setIsAuthenticating(false);
      setIsConnected(false);
      socket.disconnect();
      socketRef.current = null;

      let msg = "Cannot reach server. Please check your connection.";
      if (err.message === "INVALID_INVITE_CODE") {
        msg = "Invalid invite code. Please check your code and try again.";
      } else if (err.message === "INVITE_LOCKED_OUT") {
        msg = "Too many failed attempts. You are temporarily locked out for 15 minutes.";
      } else if (err.message === "BANNED") {
        msg = "Access denied: Account permanently blocked.";
      } else if (err.message === "MAX_ADDRESS_CONNECTIONS_REACHED") {
        msg = "Too many connections from this network address. Try again later.";
      } else if (err.message) {
        msg = `Connection error: ${err.message}`;
      }
      setInviteError(msg);
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

  function handleInviteSubmit(e) {
    if (e) e.preventDefault();
    const code = inviteInput.trim();
    if (!code) return;
    connectSocketWithAuth(code);
  }

  function handlePreferenceChange(option) {
    if (uiState !== "idle" || isSubmitting) return;

    if (option === "Anyone") {
      setPreferences(["Anyone"]);
      return;
    }

    const withoutAnyone = preferences.filter((p) => p !== "Anyone");
    if (withoutAnyone.includes(option)) {
      const remaining = withoutAnyone.filter((p) => p !== option);
      setPreferences(remaining.length === 0 ? ["Anyone"] : remaining);
    } else {
      setPreferences([...withoutAnyone, option]);
    }
  }

  function handleStart() {
    if (uiStateRef.current !== "idle" || !socketRef.current || !isConnected || isSubmittingRef.current || !isMediaReady) {
      return;
    }

    setShowBroadenBanner(false);
    setIsSubmitting(true);
    isSubmittingRef.current = true;
    setErrorMessage("");
    setStatus("Connecting to matchmaking queue...");

    socketRef.current.emit("join-queue", {
      identity,
      preferences
    });

    queueTimeoutRef.current = setTimeout(() => {
      if (isSubmittingRef.current) {
        setIsSubmitting(false);
        isSubmittingRef.current = false;
        if (socketRef.current) {
          socketRef.current.emit("leave-session", {});
        }
        setErrorMessage("Server request timed out after 5 seconds.");
        setStatus("Ready. Choose your preferences and press Start.");
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
    setStatus("Ready. Choose your preferences and press Start.");
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
      setStatus("Partner blocked. You will not be matched with them again in this session.");
    });
  }

  function handleBroadenAccept() {
    setShowBroadenBanner(false);
    if (socketRef.current && uiStateRef.current === "waiting") {
      socketRef.current.emit("broaden-accept", {});
      setStatus("Broadened preferences to Anyone. Searching for a partner...");
    }
  }

  function handleBroadenDismiss() {
    setShowBroadenBanner(false);
  }

  // Gate 1: Invite verification
  if (!isInviteAccepted) {
    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem" }}>
        <InviteGate
          inviteInput={inviteInput}
          setInviteInput={setInviteInput}
          isAuthenticating={isAuthenticating}
          inviteError={inviteError}
          onSubmit={handleInviteSubmit}
        />
      </main>
    );
  }

  // Gate 2: Consent and tester rules (in-memory per page load)
  if (!hasConsented) {
    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem" }}>
        <ConsentGate onConsentGranted={handleConsentGranted} />
      </main>
    );
  }

  // Start is disabled until media is ready, socket is connected, and state is idle
  const isStartDisabled = !isConnected || isSubmitting || uiState !== "idle" || !isMediaReady;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", maxWidth: "900px", margin: "0 auto" }}>
      <h2>Shuup (Phase 7b: Trust & Safety)</h2>

      {errorMessage && (
        <div style={{ padding: "0.75rem 1rem", backgroundColor: "#fee2e2", color: "#991b1b", borderRadius: "6px", marginBottom: "1rem" }}>
          <strong>Notice:</strong> {errorMessage}
        </div>
      )}

      {/* 120-Second Post-Call Grace Reporting Banner */}
      {previousSessionGrace && (
        <PreviousPartnerNotice
          graceExpiresAt={previousSessionGrace.expiresAt}
          onOpenReport={() => handleOpenReport(previousSessionGrace.sessionId, "previous partner")}
          onExpire={() => setPreviousSessionGrace(null)}
        />
      )}

      {/* Broaden Prompt Banner */}
      {showBroadenBanner && uiState === "waiting" && (
        <div style={{ padding: "0.75rem 1rem", backgroundColor: "#fef3c7", border: "1px solid #fde68a", color: "#92400e", borderRadius: "6px", marginBottom: "1rem" }}>
          <p style={{ margin: "0 0 0.5rem 0", fontWeight: "500" }}>
            No matches yet. Widen your search? You may be matched with people outside your selected preferences, if they're open to meeting you.
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              onClick={handleBroadenAccept}
              style={{ padding: "0.4rem 0.9rem", fontSize: "0.9rem", cursor: "pointer", backgroundColor: "#d97706", color: "#ffffff", border: "none", borderRadius: "4px", fontWeight: "600" }}
            >
              Widen search
            </button>
            <button
              onClick={handleBroadenDismiss}
              style={{ padding: "0.4rem 0.9rem", fontSize: "0.9rem", cursor: "pointer", backgroundColor: "#fef3c7", color: "#78350f", border: "1px solid #d97706", borderRadius: "4px" }}
            >
              Keep waiting
            </button>
          </div>
        </div>
      )}

      {/* Preferences Section */}
      <section style={{ backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
        <h4 style={{ margin: "0 0 0.5rem 0" }}>Matching Preferences</h4>
        
        <div style={{ marginBottom: "0.75rem" }}>
          <strong>Your Identity: </strong>
          {IDENTITIES.map((id) => (
            <label key={id} style={{ marginRight: "1rem", cursor: uiState === "idle" ? "pointer" : "default" }}>
              <input
                type="radio"
                name="identity"
                value={id}
                checked={identity === id}
                onChange={() => uiState === "idle" && !isSubmitting && setIdentity(id)}
                disabled={uiState !== "idle" || isSubmitting}
              />{" "}
              {id}
            </label>
          ))}
        </div>

        <div>
          <strong>Looking to meet: </strong>
          {PREFERENCES.map((pref) => (
            <label key={pref} style={{ marginRight: "1rem", cursor: uiState === "idle" ? "pointer" : "default" }}>
              <input
                type="checkbox"
                name="preference"
                value={pref}
                checked={preferences.includes(pref)}
                onChange={() => handlePreferenceChange(pref)}
                disabled={uiState !== "idle" || isSubmitting}
              />{" "}
              {pref}
            </label>
          ))}
        </div>
        <p style={{ margin: "0.5rem 0 0 0", fontSize: "0.8rem", color: "#64748b", fontStyle: "italic" }}>
          Matching depends on who is online and is not guaranteed. When few users are online, waits may be longer.
        </p>
      </section>

      {/* Connection & Match State */}
      <section style={{ backgroundColor: "#f1f5f9", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
        <p style={{ margin: "0 0 0.25rem 0" }}>
          <strong>Server:</strong>{" "}
          <span style={{ color: isConnected ? "green" : "red", fontWeight: "bold" }}>
            {isConnected ? "Connected" : "Disconnected"}
          </span>
        </p>
        <p style={{ margin: "0 0 0.25rem 0" }}>
          <strong>State:</strong> <span style={{ fontWeight: "bold" }}>{uiState.toUpperCase()}</span>
          {sessionInfo && ` (${sessionInfo.role} in session ${sessionInfo.sessionId.slice(0, 8)}...)`}
        </p>
        <p style={{ margin: "0" }}>
          <strong>Status:</strong> {status}
        </p>
      </section>

      {/* Main Actions */}
      <section style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem" }}>
        {uiState === "idle" && (
          <button
            onClick={handleStart}
            disabled={isStartDisabled}
            style={{
              padding: "0.6rem 1.4rem",
              fontSize: "1rem",
              fontWeight: "600",
              cursor: isStartDisabled ? "not-allowed" : "pointer",
              backgroundColor: isStartDisabled ? "#94a3b8" : "#16a34a",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px"
            }}
          >
            Start
          </button>
        )}

        {uiState === "waiting" && (
          <button
            onClick={handleLeave}
            style={{
              padding: "0.6rem 1.4rem",
              fontSize: "1rem",
              fontWeight: "600",
              cursor: "pointer",
              backgroundColor: "#dc2626",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px"
            }}
          >
            Cancel Wait
          </button>
        )}

        {uiState === "matched" && (
          <>
            <button
              onClick={handleNext}
              disabled={isSubmitting}
              style={{
                padding: "0.6rem 1.4rem",
                fontSize: "1rem",
                fontWeight: "600",
                cursor: isSubmitting ? "not-allowed" : "pointer",
                backgroundColor: isSubmitting ? "#94a3b8" : "#2563eb",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px"
              }}
            >
              Next
            </button>
            <button
              onClick={handleLeave}
              style={{
                padding: "0.6rem 1.4rem",
                fontSize: "1rem",
                fontWeight: "600",
                cursor: "pointer",
                backgroundColor: "#dc2626",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px"
              }}
            >
              Leave
            </button>
          </>
        )}
      </section>

      {/* Video Streams Section */}
      <section style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 300px" }}>
          <h4>Local Video (Self Preview)</h4>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{ width: "100%", maxHeight: "350px", backgroundColor: "#0f172a", borderRadius: "8px", transform: "scaleX(-1)" }}
          />
        </div>
        <div style={{ flex: "1 1 300px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <h4 style={{ margin: 0 }}>Remote Video (Partner Stream)</h4>
            {uiState === "matched" && (
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => handleOpenReport(currentSessionIdRef.current, "current partner")}
                  style={{
                    padding: "0.25rem 0.6rem",
                    fontSize: "0.8rem",
                    backgroundColor: "#f1f5f9",
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontWeight: "500",
                    color: "#334155"
                  }}
                >
                  ⚑ Report
                </button>
                <button
                  type="button"
                  onClick={handleOpenBlockModal}
                  style={{
                    padding: "0.25rem 0.6rem",
                    fontSize: "0.8rem",
                    backgroundColor: "#fee2e2",
                    border: "1px solid #fecaca",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontWeight: "500",
                    color: "#991b1b"
                  }}
                >
                  ✕ Block
                </button>
              </div>
            )}
          </div>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{ width: "100%", maxHeight: "350px", backgroundColor: "#0f172a", borderRadius: "8px" }}
          />
        </div>
      </section>

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
    </main>
  );
}
