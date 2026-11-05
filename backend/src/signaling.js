const MAX_SDP_BYTES = 64 * 1024; // 64 KB
const MAX_CANDIDATE_BYTES = 8 * 1024; // 8 KB

function getPayloadSize(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj), "utf8");
  } catch {
    return Infinity;
  }
}

export function setupSignaling(io, socket, matchmaker) {
  socket.on("offer", (payload) => {
    const sessionInfo = matchmaker.getSessionInfo(socket.id);
    if (!sessionInfo) return;

    if (
      getPayloadSize(payload) > MAX_SDP_BYTES ||
      !payload?.sdp ||
      payload.sdp.type !== "offer" ||
      typeof payload.sdp.sdp !== "string"
    ) {
      console.warn(`[Signaling] Dropped malformed or oversized offer from ${socket.id}`);
      return;
    }

    // Forward strictly to stored partner, attaching verified sessionId
    io.to(sessionInfo.partnerId).emit("offer", {
      sessionId: sessionInfo.sessionId,
      sdp: payload.sdp
    });
  });

  socket.on("answer", (payload) => {
    const sessionInfo = matchmaker.getSessionInfo(socket.id);
    if (!sessionInfo) return;

    if (
      getPayloadSize(payload) > MAX_SDP_BYTES ||
      !payload?.sdp ||
      payload.sdp.type !== "answer" ||
      typeof payload.sdp.sdp !== "string"
    ) {
      console.warn(`[Signaling] Dropped malformed or oversized answer from ${socket.id}`);
      return;
    }

    io.to(sessionInfo.partnerId).emit("answer", {
      sessionId: sessionInfo.sessionId,
      sdp: payload.sdp
    });
  });

  socket.on("ice-candidate", (payload) => {
    const sessionInfo = matchmaker.getSessionInfo(socket.id);
    if (!sessionInfo) return;

    if (
      getPayloadSize(payload) > MAX_CANDIDATE_BYTES ||
      !payload?.candidate ||
      typeof payload.candidate !== "object"
    ) {
      console.warn(`[Signaling] Dropped malformed or oversized ICE candidate from ${socket.id}`);
      return;
    }

    io.to(sessionInfo.partnerId).emit("ice-candidate", {
      sessionId: sessionInfo.sessionId,
      candidate: payload.candidate
    });
  });
}

