import React, { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { createPeerConnection } from "./webrtc.js";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

export default function App() {
  const [status, setStatus] = useState("Initializing media...");
  const [errorMessage, setErrorMessage] = useState("");
  const [sessionInfo, setSessionInfo] = useState(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const rtcSessionRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    function handleMediaError(err) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setErrorMessage("Camera or microphone permission was denied. Please allow access in your browser settings.");
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

        // StrictMode unmount guard: discard late stream if effect was already cleaned up
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        setStatus("Media access granted. Connecting to signaling server...");

        // Connect socket strictly after media is successfully granted
        const socket = io(BACKEND_URL);
        socketRef.current = socket;

        socket.on("connect", () => {
          setStatus("Connected to server. Joining room...");
        });

        socket.on("queue-status", (data) => {
          setStatus(data.message);
        });

        socket.on("room-full", (data) => {
          setErrorMessage(data.message);
          setStatus("Disconnected: Room full.");
        });

        socket.on("matched", async ({ sessionId, isCaller }) => {
          setSessionInfo({ sessionId, role: isCaller ? "Caller" : "Callee" });
          setStatus(`Matched! Role: ${isCaller ? "Caller" : "Callee"}. Establishing video call...`);

          // Close any previous peer connection before starting a new one
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

          if (isCaller) {
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

        socket.on("offer", async (payload) => {
          if (!rtcSessionRef.current) return;
          try {
            setStatus("Offer received. Sending answer...");
            const answerDesc = await rtcSessionRef.current.handleOffer(payload.sdp);
            socket.emit("answer", { sdp: answerDesc });
            setStatus("Call connected with partner.");
          } catch (err) {
            console.error("[WebRTC] Error handling offer:", err);
            setErrorMessage("Failed to process partner's call offer.");
          }
        });

        socket.on("answer", async (payload) => {
          if (!rtcSessionRef.current) return;
          try {
            await rtcSessionRef.current.handleAnswer(payload.sdp);
            setStatus("Call connected with partner.");
          } catch (err) {
            console.error("[WebRTC] Error handling answer:", err);
            setErrorMessage("Failed to process partner's call answer.");
          }
        });

        socket.on("ice-candidate", async (payload) => {
          if (!rtcSessionRef.current) return;
          try {
            await rtcSessionRef.current.addRemoteCandidate(payload.candidate);
          } catch (err) {
            console.warn("[WebRTC] Error adding ICE candidate:", err);
          }
        });

        socket.on("partner-left", () => {
          setStatus("Partner left. Waiting for a new partner...");
          setSessionInfo(null);

          // Clear remote video
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
          }

          // Close active peer connection
          if (rtcSessionRef.current) {
            rtcSessionRef.current.cleanup();
            rtcSessionRef.current = null;
          }
        });

        socket.on("disconnect", (reason) => {
          setStatus(`Disconnected from server (${reason}).`);
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

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", maxWidth: "900px", margin: "0 auto" }}>
      <h2>Shuup (Phase 2: WebRTC Signaling Baseline)</h2>

      {errorMessage && (
        <div style={{ padding: "0.75rem 1rem", backgroundColor: "#fee2e2", color: "#991b1b", borderRadius: "6px", marginBottom: "1rem" }}>
          <strong>Error:</strong> {errorMessage}
        </div>
      )}

      <div style={{ padding: "0.75rem 1rem", backgroundColor: "#f1f5f9", borderRadius: "6px", marginBottom: "1rem" }}>
        <p style={{ margin: 0 }}>
          <strong>Status:</strong> {status}
        </p>
        {sessionInfo && (
          <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.9rem", color: "#475569" }}>
            Session ID: <code>{sessionInfo.sessionId}</code> | Assigned Role: <strong>{sessionInfo.role}</strong>
          </p>
        )}
      </div>

      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <h4>Local Video (Muted Self-Preview)</h4>
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
