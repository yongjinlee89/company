'use strict';

/**
 * 수동 테스트용 봇: 방에 들어가 간단한 행동을 하고 라운드마다 준비를 누른다.
 * 사용법: node test/bot.js <서버주소> <방코드> <이름>
 * 예:     node test/bot.js http://localhost:7861 test1 봇돌이
 */

const { io } = require('socket.io-client');

const url = process.argv[2] || 'http://localhost:7861';
const roomId = process.argv[3] || 'test1';
const name = process.argv[4] || '봇돌이';
const playerId = 'bot_' + name + '_' + Math.random().toString(36).slice(2, 8);

const socket = io(url, { transports: ['websocket', 'polling'] });
let acted = -1; // 마지막으로 행동한 라운드

socket.on('connect', () => {
  socket.emit('joinRoom', { roomId, name, playerId }, (res) => {
    console.log('[봇] 입장:', JSON.stringify(res));
  });
});

socket.on('state', (s) => {
  if (s.phase !== 'playing' || !s.game || s.game.ended) return;
  const g = s.game;
  const me = g.players.find((p) => p.id === playerId);
  if (!me || me.ready) return;
  if (acted === g.round) return;
  acted = g.round;

  // 첫 라운드: 아무 자원 땅이나 사서 건물을 짓는다
  const tryBuy = () => {
    const pairs = { iron: 'mine', oil: 'rig', farm: 'farm' };
    for (const [terrain, building] of Object.entries(pairs)) {
      const idx = g.map.tiles.findIndex((t) => t.t === terrain && !t.owner);
      if (idx >= 0) {
        socket.emit('buyTile', { idx }, (r1) => {
          console.log('[봇] 땅 구매', terrain, JSON.stringify(r1));
          if (r1 && r1.ok) {
            socket.emit('build', { idx, kind: building }, (r2) =>
              console.log('[봇] 건설', building, JSON.stringify(r2)));
          }
        });
        return;
      }
    }
  };
  if (g.round === 1) tryBuy();

  // 2라운드: 자재 시장에서 곡물을 조금 사 본다
  if (g.round === 2) {
    socket.emit('trade', { mat: 'grain', qty: 5, side: 'buy' }, (r) =>
      console.log('[봇] 곡물 매수', JSON.stringify(r)));
  }

  // 3라운드: 상대 주식을 사 본다
  if (g.round === 3) {
    const other = g.players.find((p) => p.id !== playerId);
    if (other) {
      socket.emit('stockTrade', { company: other.id, qty: 5, side: 'buy' }, (r) =>
        console.log('[봇] 주식 매수', other.name, JSON.stringify(r)));
    }
  }

  // 잠시 후 준비 완료
  setTimeout(() => {
    socket.emit('ready', { ready: true }, () => console.log(`[봇] ${g.round}라운드 준비 완료`));
  }, 1500);
});

socket.on('disconnect', () => console.log('[봇] 연결 끊김'));
