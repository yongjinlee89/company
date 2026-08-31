'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const { Room, MIN_PLAYERS, MAX_PLAYERS } = require('./src/room');
const { diff } = require('./src/diff');

const PORT = process.env.PORT || Number(process.argv[2]) || 7861;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  // 끊김을 빨리 알아채도록 짧게
  pingInterval: 10000,
  pingTimeout: 10000,
  cors: { origin: '*' },
  // 트래픽 절감 — 상태 JSON 은 키가 반복돼 압축이 아주 잘 된다 (보통 5~10배)
  perMessageDeflate: { threshold: 256 },
  httpCompression: { threshold: 256 },
});

// 정적 파일(HTML/JS/CSS)을 gzip 으로 눌러 보낸다 — 첫 접속 용량이 1/4 수준이 된다
app.use(compression());
// 배포한 뒤에도 브라우저에 옛 화면이 남지 않도록 매번 최신인지 확인하게 한다.
// no-cache 는 "캐시하지 마라"가 아니라 "쓰기 전에 서버에 물어봐라" 라서,
// 바뀐 게 없으면 304 만 오가므로 트래픽 부담은 거의 없다.
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/** @type {Map<string, Room>} */
const rooms = new Map();
/** socket.id -> {roomId, playerId} */
const sessions = new Map();

/**
 * 방 전체에 "바뀐 부분만" 보낸다 — 트래픽 절감의 핵심.
 *
 * 매번 상태 전체를 직렬화해 보내는 대신, 직전에 보낸 스냅샷과 비교해
 * diff(패치)만 브로드캐스트한다. 맵·상수·설정처럼 안 바뀌는 부분은
 * 자동으로 빠지므로 "전체/부분" 을 따로 구분할 필요가 없다.
 *
 * 메시지 형식:
 *   { v, f }          — 전체 상태 (입장·재동기화 때만)
 *   { v, base, p }    — base 버전에서 v 버전으로 가는 패치
 * 클라이언트는 자기 버전이 base 와 다르면 'resync' 를 요청한다.
 */
function snapshotOf(room) {
  // 상태는 살아 있는 게임 객체를 참조하므로, 다음 비교를 위해 깊은 사본을 뜬다
  return JSON.parse(JSON.stringify(room.state()));
}

function broadcast(room) {
  const snap = snapshotOf(room);
  if (!room._snap) {
    room._snap = snap;
    room._seq = 1;
    io.to(room.id).emit('state', { v: 1, f: snap });
    return;
  }
  const patch = diff(room._snap, snap);
  if (patch === undefined) return; // 바뀐 게 없으면 아예 안 보낸다
  const base = room._seq;
  room._seq = base + 1;
  room._snap = snap;
  io.to(room.id).emit('state', { v: room._seq, base, p: patch });
}

/** 한 소켓에만 전체 상태를 보낸다 (입장 직후 / 재동기화). 방 전체에는 뿌리지 않는다. */
function sendFull(socket, room) {
  if (!room._snap) {
    room._snap = snapshotOf(room);
    room._seq = 1;
  }
  socket.emit('state', { v: room._seq, f: room._snap });
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId, (r) => broadcast(r));
    rooms.set(roomId, room);
  }
  return room;
}

function normalizeRoomId(raw) {
  const id = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9가-힣_-]/g, '').slice(0, 24);
  return id || 'lobby';
}

function sanitizeName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 16);
  return name || '이름없음';
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (payload = {}, ack) => {
    const roomId = normalizeRoomId(payload.roomId);
    const playerId = String(payload.playerId || '').slice(0, 64);
    const name = sanitizeName(payload.name);
    if (!playerId) {
      if (ack) ack({ ok: false, error: '잘못된 접속 정보입니다.' });
      return;
    }
    const prev = sessions.get(socket.id);
    if (prev && prev.roomId !== roomId) {
      const prevRoom = rooms.get(prev.roomId);
      if (prevRoom) prevRoom.disconnect(socket.id);
      socket.leave(prev.roomId);
    }

    const room = getRoom(roomId);
    const result = room.join(playerId, name, socket.id);
    if (!result.ok) {
      if (ack) ack(result);
      return;
    }
    sessions.set(socket.id, { roomId, playerId });
    socket.join(roomId);
    if (ack) ack({ ok: true, roomId });
    // 새로 들어온 사람에게만 전체 상태를 주고, 방 전체에는 바뀐 부분(입장 소식)만 보낸다.
    // 순서가 중요하다: 직전 스냅샷을 먼저 주고, 그 위에 얹을 패치를 뿌린다.
    sendFull(socket, room);
    broadcast(room);
  });

  // 패치 순서가 어긋난 클라이언트가 전체 상태를 다시 요청한다
  socket.on('resync', () => {
    const s = sessions.get(socket.id);
    if (!s) return;
    const room = rooms.get(s.roomId);
    if (room) sendFull(socket, room);
  });

  function withRoom(handler) {
    return (payload, ack) => {
      const s = sessions.get(socket.id);
      if (!s) {
        if (ack) ack({ ok: false, error: '방에 접속해 있지 않습니다.' });
        return;
      }
      const room = rooms.get(s.roomId);
      if (!room) {
        if (ack) ack({ ok: false, error: '방을 찾을 수 없습니다.' });
        return;
      }
      const result = handler(room, s.playerId, payload || {}) || { ok: true };
      if (ack) ack(result);
      // 거부된 요청은 상태가 바뀌지 않았으므로 브로드캐스트하지 않는다.
      if (result.ok) broadcast(room);
    };
  }

  /* ------------------------------------------------------------ 로비 */

  socket.on('updateSettings', withRoom((room, playerId, payload) => room.updateSettings(playerId, payload)));
  socket.on('addBot', withRoom((room, playerId) => room.addBot(playerId)));
  socket.on('removeBot', withRoom((room, playerId) => room.removeBot(playerId)));
  socket.on('startGame', withRoom((room, playerId) => room.start(playerId)));
  socket.on('restart', withRoom((room, playerId) => room.restart(playerId)));

  /* ------------------------------------------------------------ 게임 행동 */

  socket.on('buyTile', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.buyTile(pid, p.idx))));
  socket.on('build', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.build(pid, p.idx, p.kind))));
  socket.on('setFactoryMode', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setFactoryMode(pid, p.idx, p.mode))));
  socket.on('setRoute', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setRoute(pid, p.idx, p.city))));
  socket.on('upgrade', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.upgradeBuilding(pid, p.idx))));
  socket.on('research', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.research(pid, p.kind))));
  socket.on('trade', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.trade(pid, p))));
  socket.on('setAutoBuy', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setAutoBuy(pid, p.mat, p.target))));
  socket.on('stockTrade', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.stockTrade(pid, p))));
  socket.on('blueChipTrade', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.blueChipTrade(pid, p))));

  // 자산 매각 / 부동산
  socket.on('sellTile', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.sellTile(pid, p.idx))));
  socket.on('listTile', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.listTile(pid, p.idx, p.price))));
  socket.on('unlistTile', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.unlistTile(pid, p.idx))));
  socket.on('buyListedTile', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.buyListedTile(pid, p.idx))));

  // 대출 / 채권 / 공매도
  socket.on('borrow', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.borrow(pid, p.amount))));
  socket.on('repay', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.repay(pid, p.amount))));
  socket.on('buyBond', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.buyBond(pid, p.amount))));
  socket.on('redeemBond', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.redeemBond(pid, p.amount))));
  socket.on('shortSell', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.shortSell(pid, p.company, p.qty))));
  socket.on('coverShort', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.coverShort(pid, p.company, p.qty))));

  /* ------------------------------------------------------------ 음성 채팅 */
  // 서버는 신호(SDP/ICE)만 중계한다. 음성 자체는 브라우저끼리 P2P 로 오간다.

  socket.on('voice:join', withRoom((room, playerId) => {
    const p = room.player(playerId);
    if (!p) return { ok: false, error: '플레이어를 찾을 수 없습니다.' };
    if (p.voice) return { ok: true };
    p.voice = true;
    p.muted = false;
    const peers = room.players
      .filter((x) => x.voice && x.id !== playerId && x.socketId)
      .map((x) => ({ id: x.id, name: x.name }));
    socket.emit('voice:peers', { peers });
    room.pushLog(p.name + ' 님이 음성 채팅에 참여했습니다.');
    room.touch();
    return { ok: true };
  }));

  socket.on('voice:leave', withRoom((room, playerId) => {
    const p = room.player(playerId);
    if (!p || !p.voice) return { ok: true };
    p.voice = false;
    p.muted = false;
    for (const other of room.players) {
      if (other.socketId && other.id !== playerId) {
        io.to(other.socketId).emit('voice:peer-left', { id: playerId });
      }
    }
    room.pushLog(p.name + ' 님이 음성 채팅에서 나갔습니다.');
    room.touch();
    return { ok: true };
  }));

  socket.on('voice:mute', withRoom((room, playerId, payload) => {
    const p = room.player(playerId);
    if (!p) return { ok: true };
    p.muted = !!payload.muted;
    room.touch();
    return { ok: true };
  }));

  // SDP offer/answer 와 ICE 후보를 상대에게 그대로 전달
  socket.on('voice:signal', (payload = {}) => {
    const s = sessions.get(socket.id);
    if (!s) return;
    const room = rooms.get(s.roomId);
    if (!room) return;
    const target = room.player(String(payload.to || ''));
    if (!target || !target.socketId) return;
    io.to(target.socketId).emit('voice:signal', {
      from: s.playerId,
      kind: payload.kind,
      data: payload.data,
    });
  });

  /* ------------------------------------------------------------ 기타 */

  socket.on('leaveRoom', withRoom((room, playerId) => {
    room.leave(playerId);
    socket.leave(room.id);
    sessions.delete(socket.id);
    return { ok: true };
  }));

  socket.on(
    'chat',
    withRoom((room, playerId, payload) => {
      const text = String(payload.text || '').trim().slice(0, 200);
      if (!text) return { ok: true };
      const p = room.player(playerId);
      room.pushChat(p ? p.name : '?', text);
      return { ok: true };
    })
  );

  socket.on('disconnect', () => {
    const s = sessions.get(socket.id);
    if (!s) return;
    sessions.delete(socket.id);
    const room = rooms.get(s.roomId);
    if (!room) return;
    const p = room.player(s.playerId);
    if (p && p.voice) {
      p.voice = false;
      p.muted = false;
      for (const other of room.players) {
        if (other.socketId && other.id !== s.playerId) {
          io.to(other.socketId).emit('voice:peer-left', { id: s.playerId });
        }
      }
    }
    room.disconnect(socket.id);
    broadcast(room);
  });
});

// 사람이 아무도 없는 방 정리
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (!room.isEmpty()) continue;
    const idle = now - room.updatedAt;
    if (idle > 5 * 60 * 1000) {
      room.clearAutoTimer();
      rooms.delete(id);
    } else if (idle > 2 * 60 * 1000 && room.phase !== 'lobby') {
      room.resetToLobby();
    }
  }
}, 30 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`컴퍼니 서버 실행 중: http://0.0.0.0:${PORT} (${MIN_PLAYERS}~${MAX_PLAYERS}인)`);
});
