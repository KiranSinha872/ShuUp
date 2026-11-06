import React, { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { createPeerConnection } from "./webrtc.js";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";


const IDENTITIES = ["Man", "Woman", "Non-binary", "Prefer not to say"];
const PREFERENCES = ["Men", "Women", "Non-binary people", "Anyone"];

export default function App() {
  const [uiState, setUiState] = useState("idle"); // "idle" | "waiting" | "matched"
  const [isConnected, setIsConnected] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showBroadenBanner, setShowBroadenBanner] = useState(false);
  const [status, setStatus] = useState("Initializing media...");
  const [errorMessage, setErrorMessage] = useState("");
  const [sessionInfo, setSessionInfo] = useState(null);

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

  useEffect(() => {
    let cancelled = false;

    function handleMediaError(err) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setErrorMessage("Camera or microphone permission was denied. Please allow access in browser settings.");
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        setErrorMessage("No camera or microphone found on this device.");
      } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
        setErrorMessage("Camera or microphone is already in use by another application or tab.");
      } else {
        setErrorMessage(`Media error: ${err.message || err.name}`);
      }
      setStatus("Media access failed.");
    }

    async function init() {
      try {
        setStatus("Requesting camera and microphone access...");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        setStatus("Camera preview ready. Choose your preferences and press Start.");

        const socket = io(BACKEND_URL);
        socketRef.current = socket;
        setIsConnected(socket.connected);

        socket.on("connect", () => {
          setIsConnected(true);
          setErrorMessage("");
          if (uiStateRef.current === "idle") {
            setStatus("Ready. Choose your preferences and press Start.");
          }
        });

        socket.on("connect_error", () => {
          setIsConnected(false);
          setErrorMessage("Cannot reach the server. Please check your connection.");
        });

        socket.on("queue-status", (data) => {
          // Late-reply guard: drop queue-status if client already timed out or left
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
          // Ignore late broaden-prompt unless currently in waiting state
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

          // Handle early offer if received before matched finished setup
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
          if (!currentSessionIdRef.current || sessionId !== currentSessionIdRef.current) {
            return;
          }

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
          if (!currentSessionIdRef.current || sessionId !== currentSessionIdRef.current) {
            return;
          }

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
          if (!currentSessionIdRef.current || sessionId !== currentSessionIdRef.current) {
            return;
          }

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
        });
      } catch (err) {
        if (!cancelled) {
          handleMediaError(err);
        }
      }
    }

    init();

    return () => {
      cancelled = true;

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

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
      }

      if (rtcSessionRef.current) {
        rtcSessionRef.current.cleanup();
        rtcSessionRef.current = null;
      }

      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, []);

  function handlePreferenceChange(option) {
    if (uiState !== "idle" || isSubmitting) return;

    if (option === "Anyone") {
      setPreferences(["Anyone"]);
      return;
    }

    let updated = preferences.filter((p) => p !== "Anyone");
    if (updated.includes(option)) {
      updated = updated.filter((p) => p !== option);
    } else {
      updated.push(option);
    }

    if (updated.length === 0) {
      updated = ["Anyone"];
    }

    setPreferences(updated);
  }

  function handleStart() {
    if (uiStateRef.current !== "idle" || !isConnected || isSubmittingRef.current || !socketRef.current) return;
    setErrorMessage("");
    setShowBroadenBanner(false);
    setIsSubmitting(true);
    isSubmittingRef.current = true;
    setStatus("Submitting queue request...");

    socketRef.current.emit("join-queue", {
      identity,
      preferences
    });

    queueTimeoutRef.current = setTimeout(() => {
      queueTimeoutRef.current = null;
      setIsSubmitting(false);
      isSubmittingRef.current = false;
      setUiState("idle");
      uiStateRef.current = "idle";
      setErrorMessage("Queue request timed out. The server did not respond.");
      setStatus("Ready. Choose your preferences and press Start.");
      if (socketRef.current) {
        socketRef.current.emit("leave-session", {});
      }
    }, 5000);
  }

  function handleNext() {
    if (uiStateRef.current !== "matched" || !socketRef.current || !isConnected || isSubmittingRef.current) return;
    if (iceDisconnectTimerRef.current) {
      clearTimeout(iceDisconnectTimerRef.current);
      iceDisconnectTimerRef.current = null;
    }
    setShowBroadenBanner(false);

    // 1. End current pairing
    socketRef.current.emit("leave-session", {});

    // 2. Tear down WebRTC for current pairing
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

    // 3. Immediately re-enter queue with existing preferences
    setUiState("idle");
    uiStateRef.current = "idle";
    setErrorMessage("");
    setIsSubmitting(true);
    isSubmittingRef.current = true;
    setStatus("Skipping partner. Re-entering queue...");

    socketRef.current.emit("join-queue", {
      identity,
      preferences
    });

    queueTimeoutRef.current = setTimeout(() => {
      queueTimeoutRef.current = null;
      setIsSubmitting(false);
      isSubmittingRef.current = false;
      setUiState("idle");
      uiStateRef.current = "idle";
      setErrorMessage("Queue request timed out. The server did not respond.");
      setStatus("Ready. Choose your preferences and press Start.");
      if (socketRef.current) {
        socketRef.current.emit("leave-session", {});
      }
    }, 5000);
  }

  function handleLeave() {
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

  const isStartDisabled = !isConnected || isSubmitting || uiState !== "idle";

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", maxWidth: "900px", margin: "0 auto" }}>
      <h2>Shuup (Phase 5: Session Lifecycle & Robustness)</h2>

      {errorMessage && (
        <div style={{ padding: "0.75rem 1rem", backgroundColor: "#fee2e2", color: "#991b1b", borderRadius: "6px", marginBottom: "1rem" }}>
          <strong>Notice:</strong> {errorMessage}
        </div>
      )}

      {/* Broaden Prompt Banner (Opt-in only) */}
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

      {/* Preferences Section (Visible & changeable while idle) */}
      <section style={{ backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
        <h4 style={{ margin: "0 0 0.5rem 0" }}>Matching Preferences</h4>
        
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ fontWeight: "600", marginRight: "1rem" }}>Your Identity:</label>
          {IDENTITIES.map((item) => (
            <label key={item} style={{ marginRight: "1rem", cursor: uiState === "idle" && !isSubmitting ? "pointer" : "default" }}>
              <input
                type="radio"
                name="identity"
                value={item}
                checked={identity === item}
                disabled={uiState !== "idle" || isSubmitting}
                onChange={(e) => setIdentity(e.target.value)}
              />{" "}
              {item}
            </label>
          ))}
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ fontWeight: "600", marginRight: "1rem" }}>Looking to meet:</label>
          {PREFERENCES.map((item) => (
            <label key={item} style={{ marginRight: "1rem", cursor: uiState === "idle" && !isSubmitting ? "pointer" : "default" }}>
              <input
                type="checkbox"
                name="preferences"
                value={item}
                checked={preferences.includes(item)}
                disabled={uiState !== "idle" || isSubmitting}
                onChange={() => handlePreferenceChange(item)}
              />{" "}
              {item}
            </label>
          ))}
        </div>

        <p style={{ margin: "0.5rem 0 0 0", fontSize: "0.85rem", color: "#64748b" }}>
          <em>Matching depends on who is online and is not guaranteed. When few users are online, waits may be longer.</em>
        </p>
      </section>

      {/* Status Bar */}
      <div style={{ padding: "0.75rem 1rem", backgroundColor: "#f1f5f9", borderRadius: "6px", marginBottom: "1rem" }}>
        <p style={{ margin: 0 }}>
          <strong>Server:</strong>{" "}
          <span style={{ color: isConnected ? "#10b981" : "#ef4444", fontWeight: "bold" }}>
            {isConnected ? "Connected" : "Disconnected"}
          </span>
        </p>
        <p style={{ margin: "0.25rem 0 0 0" }}>
          <strong>State:</strong> <span style={{ textTransform: "uppercase", fontWeight: "bold" }}>{uiState}</span>
        </p>
        <p style={{ margin: "0.25rem 0 0 0" }}>
          <strong>Status:</strong> {status}
        </p>
        {sessionInfo && (
          <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.9rem", color: "#475569" }}>
            Session ID: <code>{sessionInfo.sessionId}</code> | Role: <strong>{sessionInfo.role}</strong>
          </p>
        )}
      </div>

      {/* Control Buttons */}
      <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem" }}>
        {uiState === "idle" && (
          <button
            onClick={handleStart}
            disabled={isStartDisabled}
            style={{
              padding: "0.6rem 1.5rem",
              fontSize: "1rem",
              cursor: isStartDisabled ? "not-allowed" : "pointer",
              backgroundColor: isStartDisabled ? "#94a3b8" : "#10b981",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px"
            }}
          >
            {isSubmitting ? "Submitting..." : "Start"}
          </button>
        )}

        {uiState === "waiting" && (
          <button
            onClick={handleLeave}
            style={{ padding: "0.6rem 1.5rem", fontSize: "1rem", cursor: "pointer", backgroundColor: "#ef4444", color: "#ffffff", border: "none", borderRadius: "6px" }}
          >
            Cancel Queue
          </button>
        )}

        {uiState === "matched" && (
          <>
            <button
              onClick={handleNext}
              disabled={isSubmitting}
              style={{
                padding: "0.6rem 1.5rem",
                fontSize: "1rem",
                cursor: isSubmitting ? "not-allowed" : "pointer",
                backgroundColor: isSubmitting ? "#94a3b8" : "#3b82f6",
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
                padding: "0.6rem 1.5rem",
                fontSize: "1rem",
                cursor: "pointer",
                backgroundColor: "#ef4444",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px"
              }}
            >
              Leave
            </button>
          </>
        )}
      </div>

      {/* Video View */}
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <h4>Local Video (Self Preview)</h4>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{ width: "100%", maxHeight: "360px", backgroundColor: "#0f172a", borderRadius: "8px", transform: "scaleX(-1)" }}
          />
        </div>

        <div style={{ flex: "1 1 320px" }}>
          <h4>Remote Video (Partner Stream)</h4>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{ width: "100%", maxHeight: "360px", backgroundColor: "#0f172a", borderRadius: "8px" }}
          />
        </div>
      </div>
    </main>
  );
}
