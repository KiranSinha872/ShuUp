import React, { useState, useEffect } from "react";
import { io } from "socket.io-client";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [socketId, setSocketId] = useState("");
  const [replyMessage, setReplyMessage] = useState("");
  const [replyTimestamp, setReplyTimestamp] = useState(null);

  useEffect(() => {
    const socket = io(BACKEND_URL);

    socket.on("connect", () => {
      setIsConnected(true);
      setSocketId(socket.id);
      socket.emit("hello", { clientTime: Date.now() });
    });

    socket.on("hello-reply", (data) => {
      setReplyMessage(data.message);
      setReplyTimestamp(data.timestamp);
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "600px" }}>
      <h1>Shuup (Phase 1 Baseline)</h1>
      <p>
        <strong>Backend URL:</strong> {BACKEND_URL}
      </p>
      <p>
        <strong>Connection Status:</strong>{" "}
        <span style={{ color: isConnected ? "green" : "red", fontWeight: "bold" }}>
          {isConnected ? "Connected" : "Disconnected"}
        </span>
      </p>
      {isConnected && (
        <p>
          <strong>Socket ID:</strong> {socketId}
        </p>
      )}
      <p>
        <strong>Server Reply:</strong>{" "}
        {replyMessage ? `${replyMessage} (at ${new Date(replyTimestamp).toLocaleTimeString()})` : "Waiting for reply..."}
      </p>
    </main>
  );
}

