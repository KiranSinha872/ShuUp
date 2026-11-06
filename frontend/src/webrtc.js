const DEFAULT_STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * Inspects WebRTC stats to determine if active candidate pair is direct or relay.
 * Returns "direct" | "relay" | "unknown".
 */
export async function inspectConnectionType(pc) {
  if (!pc || typeof pc.getStats !== "function") return "unknown";

  try {
    const stats = await pc.getStats();
    let selectedPair = null;

    for (const report of stats.values()) {
      if (report.type === "candidate-pair") {
        if (report.state === "succeeded" || report.nominated === true || report.selected === true) {
          selectedPair = report;
          break;
        }
      }
    }

    if (!selectedPair) return "unknown";

    const localCandidate = stats.get(selectedPair.localCandidateId);
    const remoteCandidate = stats.get(selectedPair.remoteCandidateId);

    const localType = localCandidate?.candidateType;
    const remoteType = remoteCandidate?.candidateType;

    if (localType === "relay" || remoteType === "relay") {
      return "relay";
    }

    const directTypes = ["host", "srflx", "prflx"];
    if (directTypes.includes(localType) || directTypes.includes(remoteType)) {
      return "direct";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

export function createPeerConnection({
  iceServers,
  iceTransportPolicy = "all",
  onIceCandidate,
  onTrack,
  onIceConnectionStateChange,
  onConnectionStats
}) {
  const pc = new RTCPeerConnection({
    iceServers: iceServers && iceServers.length > 0 ? iceServers : DEFAULT_STUN_SERVERS,
    iceTransportPolicy: iceTransportPolicy || "all"
  });

  const candidateQueue = [];
  let isRemoteDescriptionSet = false;
  let statsReported = false;

  pc.onicecandidate = (event) => {
    if (event.candidate && onIceCandidate) {
      onIceCandidate(event.candidate);
    }
  };

  pc.ontrack = (event) => {
    if (event.streams && event.streams[0] && onTrack) {
      onTrack(event.streams[0]);
    }
  };

  pc.oniceconnectionstatechange = async () => {
    const state = pc.iceConnectionState;
    if (onIceConnectionStateChange) {
      onIceConnectionStateChange(state);
    }

    if ((state === "connected" || state === "completed") && !statsReported) {
      statsReported = true;
      if (onConnectionStats) {
        const type = await inspectConnectionType(pc);
        onConnectionStats(type);
      }
    }
  };

  function addLocalStream(stream) {
    if (!stream) return;
    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });
  }

  async function createOffer() {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return pc.localDescription;
  }

  async function handleOffer(sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    isRemoteDescriptionSet = true;
    await flushCandidateQueue();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return pc.localDescription;
  }

  async function handleAnswer(sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    isRemoteDescriptionSet = true;
    await flushCandidateQueue();
  }

  async function addRemoteCandidate(candidate) {
    if (!candidate) return;
    if (isRemoteDescriptionSet) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      candidateQueue.push(candidate);
    }
  }

  async function flushCandidateQueue() {
    while (candidateQueue.length > 0) {
      const candidate = candidateQueue.shift();
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn("[WebRTC] Failed to add buffered ICE candidate:", err);
      }
    }
  }

  function cleanup() {
    candidateQueue.length = 0;
    isRemoteDescriptionSet = false;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.oniceconnectionstatechange = null;
    pc.close();
  }

  return {
    pc,
    addLocalStream,
    createOffer,
    handleOffer,
    handleAnswer,
    addRemoteCandidate,
    cleanup
  };
}
