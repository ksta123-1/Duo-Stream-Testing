(function() {
  if (!window.location.hostname.includes('ome.tv')) {
    return;
  }

  let SERVER_URL = localStorage.getItem('duostream_server') || 'http://localhost:3000';
  let ROOM_ID = localStorage.getItem('duostream_room') || 'room-' + Math.random().toString(36).substring(2, 7);

  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const OriginalRTCPeerConnection = window.RTCPeerConnection;

  const hostVideo = document.createElement('video');
  const peerVideo = document.createElement('video');
  const strangerVideo = document.createElement('video');
  [hostVideo, peerVideo, strangerVideo].forEach(v => {
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
  });

  // High-Definition Canvases with High-Quality Bicubic Smoothing
  const omeCanvas = document.createElement('canvas');
  omeCanvas.width = 1280;
  omeCanvas.height = 720;
  const omeCtx = omeCanvas.getContext('2d', { alpha: false });
  omeCtx.imageSmoothingEnabled = true;
  omeCtx.imageSmoothingQuality = 'high';

  const friendCanvas = document.createElement('canvas');
  friendCanvas.width = 1280;
  friendCanvas.height = 720;
  const friendCtx = friendCanvas.getContext('2d', { alpha: false });
  friendCtx.imageSmoothingEnabled = true;
  friendCtx.imageSmoothingQuality = 'high';

  let friendPC = null;
  let socket = null;
  let omeAudioMixer = null;
  let friendAudioMixer = null;
  let peerGainNode = null;
  let compositeStream = null;
  let friendViewStream = null;
  let uiStatusEl = null;

  const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  };

  // Force WebRTC Senders to transmit at 2.5 Mbps HD with zero resolution downscaling
  async function boostBitrate(pc) {
    if (!pc || !pc.getSenders) return;
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track.kind === 'video') {
        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = 2500000;
          params.encodings[0].scaleResolutionDownBy = 1.0;
          await sender.setParameters(params);
        } catch (e) {}
      }
    }
  }

  function drawCover(ctx, video, x, y, w, h) {
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) {
        ctx.drawImage(video, x, y, w, h);
        return;
      }
      const videoRatio = vw / vh;
      const targetRatio = w / h;
      let sx, sy, sw, sh;
      if (videoRatio > targetRatio) {
        sh = vh;
        sw = vh * targetRatio;
        sx = (vw - sw) / 2;
        sy = 0;
      } else {
        sw = vw;
        sh = vw / targetRatio;
        sx = 0;
        sy = (vh - sh) / 2;
      }
      ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
    } catch (e) {}
  }

  function updateStatus(text, color = '#ffb74d') {
    if (uiStatusEl) {
      uiStatusEl.textContent = text;
      uiStatusEl.style.color = color;
    }
  }

  // ============================================================================
  // 1. FLOATING SHADOW-DOM CONTROL PANEL
  // ============================================================================
  function mountFloatingUI() {
    if (document.getElementById('duostream-root')) return;

    const hostEl = document.createElement('div');
    hostEl.id = 'duostream-root';
    document.documentElement.appendChild(hostEl);

    const shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .panel {
          position: fixed;
          top: 16px;
          right: 16px;
          width: 250px;
          background: rgba(18, 18, 22, 0.94);
          border: 1px solid #383842;
          border-radius: 12px;
          padding: 12px 14px;
          color: #fff;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 13px;
          z-index: 2147483647;
          box-shadow: 0 8px 24px rgba(0,0,0,0.5);
          backdrop-filter: blur(6px);
        }
        .title-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: 700;
          margin-bottom: 6px;
          font-size: 14px;
        }
        .min-btn {
          background: transparent;
          border: none;
          color: #aaa;
          cursor: pointer;
          font-size: 16px;
          width: auto;
          padding: 0 4px;
          margin: 0;
        }
        .status { font-size: 12px; font-weight: 600; color: #ffb74d; margin-bottom: 10px; display: block; }
        .row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
        label { font-size: 11px; color: #aaa; }
        input[type="text"] {
          background: #121216; border: 1px solid #444; color: #fff;
          padding: 5px 8px; border-radius: 6px; font-size: 12px;
        }
        button.action {
          background: #3b82f6; color: #fff; border: none; padding: 7px 10px;
          border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 12px;
          width: 100%; margin-bottom: 6px;
        }
        button.action:hover { background: #2563eb; }
        input[type="range"] { width: 100%; cursor: pointer; }
      </style>
      <div class="panel">
        <div class="title-bar">
          <span>DuoStream Bridge (HD)</span>
          <button class="min-btn" id="ds-min" title="Minimize">-</button>
        </div>
        <div id="ds-body">
          <span class="status" id="ds-status">Waiting for camera start...</span>
          <div class="row">
            <label>Server URL (Local or Tunnel)</label>
            <input type="text" id="ds-server" value="${SERVER_URL}" />
          </div>
          <div class="row">
            <label>Room Code</label>
            <input type="text" id="ds-room" value="${ROOM_ID}" />
          </div>
          <button class="action" id="ds-connect-btn">Save & Reconnect</button>
          <button class="action" id="ds-copy-btn" style="background:#10b981;">Copy Friend Join Link</button>
          <div class="row" style="margin-top:6px;margin-bottom:0;">
            <label>Friend Mic Volume</label>
            <input type="range" id="ds-vol" min="0" max="2" step="0.05" value="1" />
          </div>
        </div>
      </div>
    `;

    uiStatusEl = shadow.getElementById('ds-status');
    const bodyEl = shadow.getElementById('ds-body');
    const minBtn = shadow.getElementById('ds-min');

    minBtn.addEventListener('click', () => {
      const isHidden = bodyEl.style.display === 'none';
      bodyEl.style.display = isHidden ? 'block' : 'none';
      minBtn.textContent = isHidden ? '-' : '+';
    });

    shadow.getElementById('ds-connect-btn').addEventListener('click', () => {
      SERVER_URL = shadow.getElementById('ds-server').value.trim().replace(/\/$/, '');
      ROOM_ID = shadow.getElementById('ds-room').value.trim();
      localStorage.setItem('duostream_server', SERVER_URL);
      localStorage.setItem('duostream_room', ROOM_ID);
      initSignaling();
    });

    shadow.getElementById('ds-copy-btn').addEventListener('click', (e) => {
      const link = `${SERVER_URL}/?room=${encodeURIComponent(ROOM_ID)}`;
      navigator.clipboard.writeText(link);
      e.target.textContent = 'Copied to Clipboard!';
      setTimeout(() => (e.target.textContent = 'Copy Friend Join Link'), 1800);
    });

    shadow.getElementById('ds-vol').addEventListener('input', (e) => {
      if (peerGainNode) peerGainNode.gain.value = parseFloat(e.target.value);
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', mountFloatingUI);
  } else {
    mountFloatingUI();
  }

  // ============================================================================
  // 2. SIGNALING & FRIEND P2P WEBRTC CONNECTION
  // ============================================================================
  function initSignaling() {
    if (typeof io === 'undefined') {
      updateStatus('Error: Socket.io missing', '#ef5350');
      return;
    }
    if (socket) socket.disconnect();
    updateStatus('Connecting to server...', '#ffb74d');
    socket = io(SERVER_URL);

    socket.on('connect', () => {
      updateStatus(`Waiting for friend (${ROOM_ID})`, '#29b6f6');
      socket.emit('join-room', ROOM_ID);
      setupFriendPeerConnection();
    });

    socket.on('connect_error', () => {
      updateStatus('Server offline (Run start-duostream.bat)', '#ef5350');
    });

    socket.on('peer-joined', async () => {
      updateStatus('Friend joined! Linking HD video...', '#ffb74d');
      if (!friendPC) setupFriendPeerConnection();
      const offer = await friendPC.createOffer();
      await friendPC.setLocalDescription(offer);
      socket.emit('signal', { signal: { sdp: friendPC.localDescription } });
    });

    socket.on('signal', async ({ signal }) => {
      if (!friendPC) setupFriendPeerConnection();
      if (signal.sdp) {
        await friendPC.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await friendPC.createAnswer();
          await friendPC.setLocalDescription(answer);
          socket.emit('signal', { signal: { sdp: friendPC.localDescription } });
        }
        boostBitrate(friendPC);
      } else if (signal.candidate) {
        await friendPC.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    });

    socket.on('peer-disconnected', () => {
      updateStatus('Friend disconnected', '#ffb74d');
      peerVideo.srcObject = null;
    });
  }

  function setupFriendPeerConnection() {
    if (friendPC) friendPC.close();
    friendPC = new OriginalRTCPeerConnection(rtcConfig);

    if (friendViewStream) {
      friendViewStream.getTracks().forEach(track => {
        if (track.kind === 'video') track.contentHint = 'motion';
        friendPC.addTrack(track, friendViewStream);
      });
    }

    friendPC.ontrack = (event) => {
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      if (event.track.kind === 'video') {
        peerVideo.srcObject = remoteStream;
        peerVideo.play().catch(() => {});
        updateStatus('Friend Connected (HD Split-Screen)', '#66bb6a');
        boostBitrate(friendPC);
      }
      if (event.track.kind === 'audio' && omeAudioMixer) {
        const peerAudioSource = omeAudioMixer.ctx.createMediaStreamSource(remoteStream);
        peerGainNode = omeAudioMixer.ctx.createGain();
        peerGainNode.gain.value = 1.0;
        peerAudioSource.connect(peerGainNode);
        peerGainNode.connect(omeAudioMixer.dest);
      }
    };

    friendPC.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', { signal: { candidate: event.candidate } });
      }
    };
  }

  // ============================================================================
  // 3. CAPTURE OMETV STRANGER VIDEO & BOOST OMETV BITRATE
  // ============================================================================
  const CustomRTCPeerConnection = function(...args) {
    const pc = new OriginalRTCPeerConnection(...args);
    pc.addEventListener('track', (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      if (event.track.kind === 'video') {
        strangerVideo.srcObject = stream;
        strangerVideo.play().catch(() => {});
      }
      if (event.track.kind === 'audio' && friendAudioMixer) {
        try {
          const strangerAudio = friendAudioMixer.ctx.createMediaStreamSource(stream);
          strangerAudio.connect(friendAudioMixer.dest);
        } catch (e) {}
      }
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') {
        boostBitrate(pc); // Force OmeTV connection to send crisp HD video too!
      }
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        strangerVideo.srcObject = null;
      }
    });
    return pc;
  };
  CustomRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  window.RTCPeerConnection = CustomRTCPeerConnection;

  function findRemoteDomVideo() {
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      if (v !== hostVideo && v !== peerVideo && v !== strangerVideo && v.readyState >= 2) {
        if (v.srcObject !== compositeStream && v.videoWidth > 0 && !v.paused) {
          return v;
        }
      }
    }
    return null;
  }

  // ============================================================================
  // 4. DUAL CANVAS RENDER ENGINE (HD)
  // ============================================================================
  async function createCompositeStream() {
    if (compositeStream) return compositeStream;

    let realStream;
    try {
      realStream = await originalGetUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
    } catch (err) {
      updateStatus('Cam error: Close other camera apps/tabs!', '#ef5350');
      throw err;
    }

    hostVideo.srcObject = realStream;
    await hostVideo.play().catch(() => {});

    setInterval(() => {
      // CANVAS 1: OMETV SPLIT-SCREEN
      omeCtx.fillStyle = '#111';
      omeCtx.fillRect(0, 0, 1280, 720);

      if (hostVideo.readyState >= 2) {
        drawCover(omeCtx, hostVideo, 0, 0, 640, 720);
      }

      if (peerVideo.readyState >= 2 && peerVideo.srcObject) {
        drawCover(omeCtx, peerVideo, 640, 0, 640, 720);
      } else {
        omeCtx.fillStyle = '#1a1a22';
        omeCtx.fillRect(640, 0, 640, 720);
        omeCtx.fillStyle = '#777';
        omeCtx.font = '600 22px system-ui, sans-serif';
        omeCtx.textAlign = 'center';
        omeCtx.fillText('Waiting for Friend to Join...', 960, 360);
      }

      omeCtx.fillStyle = '#000000';
      omeCtx.fillRect(638, 0, 4, 720);

      // CANVAS 2: FRIEND'S THEATER SCREEN
      friendCtx.fillStyle = '#0d0d11';
      friendCtx.fillRect(0, 0, 1280, 720);

      const activeStranger = (strangerVideo.readyState >= 2 && strangerVideo.srcObject)
        ? strangerVideo
        : findRemoteDomVideo();

      if (activeStranger) {
        drawCover(friendCtx, activeStranger, 0, 0, 1280, 720);

        if (hostVideo.readyState >= 2) {
          const pipX = 20, pipY = 500, pipW = 310, pipH = 200;
          friendCtx.fillStyle = '#3b82f6';
          friendCtx.fillRect(pipX - 2, pipY - 2, pipW + 4, pipH + 4);
          drawCover(friendCtx, hostVideo, pipX, pipY, pipW, pipH);

          friendCtx.fillStyle = 'rgba(0,0,0,0.75)';
          friendCtx.fillRect(pipX + 8, pipY + pipH - 28, 76, 20);
          friendCtx.fillStyle = '#60a5fa';
          friendCtx.font = 'bold 12px system-ui, sans-serif';
          friendCtx.textAlign = 'left';
          friendCtx.fillText('Host', pipX + 16, pipY + pipH - 14);
        }
      } else {
        if (hostVideo.readyState >= 2) {
          drawCover(friendCtx, hostVideo, 0, 0, 1280, 720);
        }
      }
    }, 1000 / 30);

    compositeStream = omeCanvas.captureStream(30);
    friendViewStream = friendCanvas.captureStream(30);

    // Hint to Chrome's encoder to prioritize smooth motion & crispness
    compositeStream.getVideoTracks().forEach(t => (t.contentHint = 'motion'));
    friendViewStream.getVideoTracks().forEach(t => (t.contentHint = 'motion'));

    const audioCtx = new AudioContext();
    const omeDest = audioCtx.createMediaStreamDestination();
    omeAudioMixer = { ctx: audioCtx, dest: omeDest };

    const friendDest = audioCtx.createMediaStreamDestination();
    friendAudioMixer = { ctx: audioCtx, dest: friendDest };

    if (realStream.getAudioTracks().length > 0) {
      const hostAudio = audioCtx.createMediaStreamSource(realStream);
      hostAudio.connect(omeDest);
      hostAudio.connect(friendDest);
    }

    if (omeDest.stream.getAudioTracks()[0]) {
      compositeStream.addTrack(omeDest.stream.getAudioTracks()[0]);
    }
    if (friendDest.stream.getAudioTracks()[0]) {
      friendViewStream.addTrack(friendDest.stream.getAudioTracks()[0]);
    }

    const videoTrack = compositeStream.getVideoTracks()[0];
    const realSettings = realStream.getVideoTracks()[0].getSettings();
    videoTrack.getSettings = () => ({
      ...realSettings,
      width: 1280,
      height: 720,
      aspectRatio: 1280 / 720,
      frameRate: 30
    });

    initSignaling();
    return compositeStream;
  }

  const customGetUserMedia = async function(constraints) {
    if (constraints && constraints.video) {
      return await createCompositeStream();
    }
    return originalGetUserMedia(constraints);
  };

  customGetUserMedia.toString = () => 'function getUserMedia() { [native code] }';

  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
    get() { return customGetUserMedia; },
    set(newVal) {},
    configurable: true,
    enumerable: true
  });
})();
