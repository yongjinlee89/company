'use strict';

/**
 * 음성 채팅 — WebRTC 메시(mesh).
 * 서버는 SDP/ICE 신호만 중계하고, 음성은 브라우저끼리 직접 주고받는다.
 *
 * 연결 방향 규칙: 나중에 들어온 쪽이 offer 를 건다. (양쪽이 동시에 걸어 충돌하는 것을 방지)
 *
 * 주의: 마이크는 HTTPS 또는 localhost 에서만 열린다.
 */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const Voice = {
  active: false,
  muted: false,
  localStream: null,
  /** peerId -> {pc, audio, analyser, data} */
  peers: new Map(),
  speaking: new Set(),
  _audioCtx: null,
  _levelTimer: null,
  _socket: null,
  _myId: null,
  onChange: () => {},
};

/* ------------------------------------------------------------------ 시작/종료 */

Voice.init = function (socket, myId) {
  this._socket = socket;
  this._myId = myId;

  socket.on('voice:peers', ({ peers }) => {
    // 내가 나중에 들어왔으므로 기존 참가자들에게 내가 offer 를 건다
    for (const peer of peers) this._connect(peer.id, true);
  });

  socket.on('voice:signal', async ({ from, kind, data }) => {
    if (!this.active) return;
    let entry = this.peers.get(from);
    if (!entry) entry = this._connect(from, false); // 상대가 걸어온 연결
    const pc = entry.pc;
    try {
      if (kind === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._send(from, 'answer', pc.localDescription);
      } else if (kind === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (kind === 'ice' && data) {
        await pc.addIceCandidate(new RTCIceCandidate(data));
      }
    } catch (err) {
      console.warn('[voice] 신호 처리 실패', kind, err);
    }
  });

  socket.on('voice:peer-left', ({ id }) => this._closePeer(id));
};

Voice.start = async function () {
  if (this.active) return { ok: true };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { ok: false, error: '이 브라우저에서는 음성 채팅을 쓸 수 없습니다.' };
  }
  if (!window.isSecureContext) {
    return { ok: false, error: '마이크는 HTTPS 주소에서만 열립니다. (localhost 는 예외)' };
  }
  try {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    const reason =
      err && err.name === 'NotAllowedError'
        ? '마이크 사용을 허용해 주세요.'
        : err && err.name === 'NotFoundError'
          ? '마이크를 찾을 수 없습니다.'
          : '마이크를 열지 못했습니다.';
    return { ok: false, error: reason };
  }

  this.active = true;
  this.muted = false;
  this._watchLevels();
  this._socket.emit('voice:join', {}, (res) => {
    if (res && !res.ok) console.warn('[voice] 참여 실패', res.error);
  });
  this.onChange();
  return { ok: true };
};

Voice.stop = function () {
  if (!this.active) return;
  this.active = false;
  this._socket.emit('voice:leave', {});
  for (const id of [...this.peers.keys()]) this._closePeer(id);
  if (this.localStream) {
    this.localStream.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }
  if (this._levelTimer) {
    clearInterval(this._levelTimer);
    this._levelTimer = null;
  }
  if (this._audioCtx) {
    this._audioCtx.close().catch(() => {});
    this._audioCtx = null;
  }
  this.speaking.clear();
  this.onChange();
};

Voice.toggleMute = function () {
  if (!this.active || !this.localStream) return;
  this.muted = !this.muted;
  this.localStream.getAudioTracks().forEach((t) => {
    t.enabled = !this.muted;
  });
  this._socket.emit('voice:mute', { muted: this.muted });
  this.onChange();
};

/* ------------------------------------------------------------------ 피어 연결 */

Voice._send = function (to, kind, data) {
  this._socket.emit('voice:signal', { to, kind, data });
};

Voice._connect = function (peerId, initiator) {
  const existing = this.peers.get(peerId);
  if (existing) return existing;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  document.body.appendChild(audio);

  const entry = { pc, audio, analyser: null, data: null };
  this.peers.set(peerId, entry);

  if (this.localStream) {
    for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) this._send(peerId, 'ice', e.candidate.toJSON());
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    audio.srcObject = stream;
    audio.play().catch(() => {
      /* 자동재생이 막히면 사용자가 화면을 한 번 누르면 풀린다 */
    });
    this._attachAnalyser(entry, stream);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      this._closePeer(peerId);
    }
  };

  if (initiator) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => this._send(peerId, 'offer', pc.localDescription))
      .catch((err) => console.warn('[voice] offer 실패', err));
  }
  return entry;
};

Voice._closePeer = function (peerId) {
  const entry = this.peers.get(peerId);
  if (!entry) return;
  try {
    entry.pc.close();
  } catch (_) {
    /* 이미 닫힌 경우 */
  }
  if (entry.audio) {
    entry.audio.srcObject = null;
    entry.audio.remove();
  }
  this.peers.delete(peerId);
  this.speaking.delete(peerId);
  this.onChange();
};

/* ------------------------------------------------------------------ 말하는 중 표시 */

Voice._ctx = function () {
  if (!this._audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    this._audioCtx = new Ctx();
  }
  if (this._audioCtx.state === 'suspended') this._audioCtx.resume().catch(() => {});
  return this._audioCtx;
};

Voice._attachAnalyser = function (entry, stream) {
  const ctx = this._ctx();
  if (!ctx) return;
  try {
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    entry.analyser = analyser;
    entry.data = new Uint8Array(analyser.frequencyBinCount);
  } catch (err) {
    console.warn('[voice] 레벨 측정 준비 실패', err);
  }
};

/** 마이크/상대 음량을 재서 "말하는 중" 표시를 갱신한다 */
Voice._watchLevels = function () {
  const ctx = this._ctx();
  if (ctx && this.localStream) {
    try {
      const src = ctx.createMediaStreamSource(this.localStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this._localAnalyser = analyser;
      this._localData = new Uint8Array(analyser.frequencyBinCount);
    } catch (err) {
      console.warn('[voice] 마이크 레벨 측정 실패', err);
    }
  }

  const level = (analyser, data) => {
    if (!analyser || !data) return 0;
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length;
  };

  const THRESHOLD = 12;
  this._levelTimer = setInterval(() => {
    const prev = new Set(this.speaking);
    this.speaking.clear();

    if (!this.muted && level(this._localAnalyser, this._localData) > THRESHOLD) {
      this.speaking.add(this._myId);
    }
    for (const [id, entry] of this.peers) {
      if (level(entry.analyser, entry.data) > THRESHOLD) this.speaking.add(id);
    }
    // 바뀐 게 있을 때만 화면 갱신
    let changed = prev.size !== this.speaking.size;
    if (!changed) {
      for (const id of this.speaking) {
        if (!prev.has(id)) {
          changed = true;
          break;
        }
      }
    }
    if (changed) this.onChange();
  }, 220);
};

window.Voice = Voice;
