const STUN_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

export function createPeerConnection({ onIceCandidate, onTrack }) {
  const pc = new RTCPeerConnection(STUN_CONFIG);
  const candidateQueue = [];
  let isRemoteDescriptionSet = false;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      onIceCandidate(event.candidate);
    }
  };

  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      onTrack(event.streams[0]);
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

