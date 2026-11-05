import React, { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { createPeerConnection } from "./webrtc.js";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

export default function App() {
  const [uiState, setUiState] = useState("idle"); // "idle" | "waiting" | "matched"
  const [status, setStatus] = useState("Initializing media...");
  const [errorMessage, setErrorMessage] = useState("");
  const [sessionInfo, setSessionInfo] = useState(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const rtcSessionRef = useRef(null);
  const socketRef = useRef(null);
  const currentSessionIdRef = useRef(null);
  const pendingOfferRef = useRef(null);

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

        setStatus("Camera preview ready. Press Start to join the matchmaking queue.");

        // Connect socket strictly after media is successfully granted
        const socket = io(BACKEND_URL);
        socketRef.current = socket;

        socket.on("connect", () => {
          // Connected and ready in idle state
        });

        socket.on("queue-status", (data) => {
          setStatus(data.message);
        });

        socket.on("matched", async ({ sessionId, isCaller }) => {
          currentSessionIdRef.current = sessionId;
          setSessionInfo({ sessionId, role: isCaller ? "Caller" : "Callee" });
          setUiState("matched");
          setStatus(`Matched! Role: ${isCaller ? "Caller" : "Callee"}. Connecting video...`);

          // Close any previous peer connection
          if (rtcSessionRef.current) {
            rtcSessionRef.current.cleanup();
            rtcSessionRef.current = null;
          }

          const rtc = createPeerConnection({
            onIceCandidate: (candidate) => {
              socket.emit("ice-candidate", { candidate });
            },
            onTrack: (remoteStream) => {
              if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = remoteStream;
              }
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
          // Drop message if not for the current session
          if (!currentSessionIdRef.current || sessionId !== currentSessionIdRef.current) {
            return;
          }

          if (!rtcSessionRef.current) {
            // Queue offer if peer connection is still initializing
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
          // Drop message if not for current session
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
          // Drop message if not for current session
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
          setStatus(`Partner left (${reason}). Ready to start again.`);
          setSessionInfo(null);
          currentSessionIdRef.current = null;
          pendingOfferRef.current = null;

          // Clear remote video
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
          }

          // Close active peer connection (keep local camera stream running)
          if (rtcSessionRef.current) {
            rtcSessionRef.current.cleanup();
            rtcSessionRef.current = null;
          }

          setUiState("idle");
        });

        socket.on("disconnect", (reason) => {
          setStatus(`Disconnected from server (${reason}).`);
          setUiState("idle");
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

  function handleStart() {
    if (uiState !== "idle" || !socketRef.current) return;
    setErrorMessage("");
    setUiState("waiting");
    setStatus("Joining queue. Waiting for a partner...");
    socketRef.current.emit("join-queue");
  }

  function handleLeave() {
    if (!socketRef.current) return;
    socketRef.current.emit("leave-session");

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
    setStatus("Ready. Press Start to join the queue.");
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", maxWidth: "900px", margin: "0 auto" }}>
      <h2>Shuup (Phase 3: In-Memory Queue & Private Rooms)</h2>

      {errorMessage && (
        <div style={{ padding: "0.75rem 1rem", backgroundColor: "#fee2e2", color: "#991b1b", borderRadius: "6px", marginBottom: "1rem" }}>
          <strong>Error:</strong> {errorMessage}
        </div>
      )}

      <div style={{ padding: "0.75rem 1rem", backgroundColor: "#f1f5f9", borderRadius: "6px", marginBottom: "1rem" }}>
        <p style={{ margin: 0 }}>
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

      <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem" }}>
        {uiState === "idle" && (
          <button
            onClick={handleStart}
            style={{ padding: "0.6rem 1.5rem", fontSize: "1rem", cursor: "pointer", backgroundColor: "#10b981", color: "#ffffff", border: "none", borderRadius: "6px" }}
          >
            Start
          </button>
        )}

        {(uiState === "waiting" || uiState === "matched") && (
          <button
            onClick={handleLeave}
            style={{ padding: "0.6rem 1.5rem", fontSize: "1rem", cursor: "pointer", backgroundColor: "#ef4444", color: "#ffffff", border: "none", borderRadius: "6px" }}
          >
            {uiState === "waiting" ? "Cancel Queue" : "Leave Call"}
          </button>
        )}
      </div>

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
