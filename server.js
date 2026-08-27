'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room, MIN_PLAYERS, MAX_PLAYERS } = require('./src/room');

const PORT = process.env.PORT || 7861;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  // 끊김을 빨리 알아채도록 짧게
  pingInterval: 10000,
  pingTimeout: 10000,
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/** @type {Map<string, Room>} */
const rooms = new Map();
/** socket.id -> {roomId, playerId} */
const sessions = new Map();

function broadcast(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', room.stateFor(p.id));
  }
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
    broadcast(room);
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
      // 거부된 요청은 상태가 바뀌지 않았으므로 브로드캐스트하지 않는다
      if (result.ok) broadcast(room);
    };
  }

  /* ------------------------------------------------------------ 로비 */

  socket.on('updateSettings', withRoom((room, playerId, payload) => room.updateSettings(playerId, payload)));
  socket.on('addBot', withRoom((room, playerId) => room.addBot(playerId)));
  socket.on('removeBot', withRoom((room, playerId) => room.removeBot(playerId)));
  socket.on('startGame', withRoom((room, playerId) => room.start(playerId)));

  /* ------------------------------------------------------------ 게임 행동 */

  socket.on('buyTile', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.buyTile(pid, p.idx))));
  socket.on('build', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.build(pid, p.idx, p.kind))));
  socket.on('setFactoryMode', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.setFactoryMode(pid, p.idx, p.mode))));
  socket.on('ship', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.ship(pid, p))));
  socket.on('trade', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.trade(pid, p))));
  socket.on('stockTrade', withRoom((room, pid, p) => room.gameAction(pid, (g) => g.stockTrade(pid, p))));
  socket.on('ready', withRoom((room, pid, p) => room.setReady(pid, p.ready)));

  // 배송 견적은 상태를 바꾸지 않으므로 직접 응답만 한다
  socket.on('quoteShip', (payload = {}, ack) => {
    const s = sessions.get(socket.id);
    const room = s && rooms.get(s.roomId);
    if (!room || !room.game) {
      if (ack) ack({ ok: false, error: '게임 중이 아닙니다.' });
      return;
    }
    if (ack) ack(room.game.quoteShip(s.playerId, payload));
  });

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
      room.chat.push({ t: Date.now(), name: p ? p.name : '?', text });
      if (room.chat.length > 100) room.chat.shift();
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
