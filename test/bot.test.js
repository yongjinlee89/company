'use strict';

/* 컴퓨터 플레이어 테스트: node test/bot.test.js */

const assert = require('assert');
const { Game, BUILDINGS, TAKEOVER_SHARES } = require('../src/game');
const { playRound, inputNeed } = require('../src/bot');
const { Room, MAX_PLAYERS } = require('../src/room');

function newGame(startCash = 1000, rounds = 20, n = 2) {
  const infos = [];
  for (let i = 0; i < n; i++) infos.push({ id: 'p' + i, name: '회사' + i });
  return new Game(infos, { startCash, rounds, roundTime: 90 });
}

function countBuildings(game, id) {
  const counts = {};
  for (const t of game.map.tiles) {
    if (t.owner === id && t.b) counts[t.b] = (counts[t.b] || 0) + 1;
  }
  return counts;
}

/* ---------------- 봇이 스스로 생산 기반을 갖춘다 ---------------- */
{
  const g = newGame(1000, 30);
  // 첫 라운드에 반드시 뭔가를 짓는다
  playRound(g, 'p0');
  const first = countBuildings(g, 'p0');
  assert.ok(Object.keys(first).length >= 1, '첫 라운드에 건물을 하나는 지어야 한다');

  // 여러 라운드를 돌리면 공장까지 갖춘다
  for (let r = 0; r < 8; r++) {
    playRound(g, 'p0');
    g.resolveRound();
  }
  const counts = countBuildings(g, 'p0');
  assert.ok(counts.factory >= 1, '공장을 확보해야 한다: ' + JSON.stringify(counts));
  const producers = (counts.mine || 0) + (counts.rig || 0) + (counts.farm || 0);
  assert.ok(producers >= 1, '원자재 생산기지를 확보해야 한다');
  console.log('✓ 봇 생산 기반 구축');
}

/* ---------------- 봇이 돈을 번다 ---------------- */
{
  const g = newGame(1000, 30);
  const bot = g.player('p0');
  const idle = g.player('p1'); // 아무것도 안 하는 상대

  for (let r = 0; r < 15; r++) {
    playRound(g, 'p0');
    g.resolveRound();
  }
  assert.ok(g.netWorth(bot) > g.netWorth(idle), '봇은 가만히 있는 상대보다 잘해야 한다');
  assert.ok(g.netWorth(bot) > 1000, `순자산이 늘어야 한다 (현재 ${g.netWorth(bot)})`);
  console.log(`✓ 봇 수익 창출 (순자산 ${g.netWorth(bot)} vs 무행동 ${g.netWorth(idle)})`);
}

/* ---------------- 봇이 공장을 도시 가까이 짓는다 ---------------- */
{
  const g = newGame(3000, 30);
  for (let r = 0; r < 6; r++) {
    playRound(g, 'p0');
    g.resolveRound();
  }
  const factory = g.map.tiles.findIndex((t) => t.owner === 'p0' && t.b === 'factory');
  assert.ok(factory >= 0, '공장이 있어야 한다');
  const fx = factory % g.map.w;
  const fy = Math.floor(factory / g.map.w);
  const dist = Math.min(
    ...g.cities.map((c) => Math.max(Math.abs(fx - c.x), Math.abs(fy - c.y)))
  );
  assert.ok(dist <= 3, `공장은 도시 근처에 지어야 한다 (거리 ${dist})`);
  console.log(`✓ 봇 공장 입지 선정 (도시까지 ${dist}칸)`);
}

/* ---------------- 봇이 경영권을 방어한다 ---------------- */
{
  const g = newGame(5000, 30);
  const attacker = g.player('p1');
  // 공격자가 봇 회사 지분을 위협적인 수준까지 사들인다
  g.stockTrade('p1', { company: 'p0', qty: 40, side: 'buy' });
  assert.ok((attacker.shares.p0 || 0) >= TAKEOVER_SHARES - 15);

  const before = g.stocks.p0.float;
  playRound(g, 'p0');
  assert.ok(g.stocks.p0.float < before, '봇은 자기 주식을 되사서 방어해야 한다');
  console.log('✓ 봇 경영권 방어');
}

/* ---------------- 봇끼리 게임 한 판을 끝까지 돌린다 ---------------- */
{
  const g = newGame(1000, 20, 4);
  for (let r = 0; r < 20; r++) {
    for (const p of g.players) playRound(g, p.id);
    g.resolveRound();
  }
  assert.ok(g.ended, '게임이 끝나야 한다');
  assert.ok(g.ranking.length === 4);
  // 아무도 마이너스 현금으로 끝나지 않아야 한다 (규칙 검증이 제대로 걸린다는 뜻)
  for (const p of g.players) {
    assert.ok(p.cash >= 0, `${p.name} 현금이 음수: ${p.cash}`);
  }
  console.log('✓ 봇 4인 20라운드 완주 — 1위 순자산 ' + g.ranking[0].worth);
}

/* ---------------- 소비량 계산 ---------------- */
{
  const g = newGame(5000);
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain');
  g.buyTile('p0', idx);
  g.build('p0', idx, 'factory');
  const need = inputNeed(g, g.player('p0'));
  // 기계 = 철2 + 유1, 라운드당 2배치
  assert.strictEqual(need.iron, 2 * BUILDINGS.factory.batches);
  assert.strictEqual(need.oil, 1 * BUILDINGS.factory.batches);
  console.log('✓ 재료 소비량 계산');
}

/* ---------------- 방에서 봇 추가/제거 ---------------- */
{
  const room = new Room('t', () => {});
  room.join('a', '갑', 's1');

  // 방장만 추가할 수 있다
  room.join('b', '을', 's2');
  assert.ok(!room.addBot('b').ok, '방장이 아니면 추가 불가');
  assert.ok(room.addBot('a').ok);
  assert.strictEqual(room.players.filter((p) => p.isBot).length, 1);

  // 정원까지 채우고 나면 더 못 넣는다
  while (room.players.length < MAX_PLAYERS) assert.ok(room.addBot('a').ok);
  assert.ok(!room.addBot('a').ok, '정원 초과 시 거부');
  assert.strictEqual(room.players.length, MAX_PLAYERS);

  // 이름이 겹치지 않는다
  const names = room.players.map((p) => p.name);
  assert.strictEqual(new Set(names).size, names.length);

  // 제거
  const botCount = room.players.filter((p) => p.isBot).length;
  assert.ok(room.removeBot('a').ok);
  assert.strictEqual(room.players.filter((p) => p.isBot).length, botCount - 1);

  // 봇만 남은 방은 빈 방으로 본다
  const solo = new Room('t2', () => {});
  solo.join('a', '갑', 's1');
  solo.addBot('a');
  assert.ok(!solo.isEmpty(), '사람이 있으면 빈 방이 아니다');
  solo.disconnect('s1');
  assert.ok(solo.isEmpty(), '봇만 남으면 빈 방으로 정리 대상');
  console.log('✓ 방 봇 추가/제거');
}

/* ---------------- 봇과 함께 실제 라운드가 진행된다 ---------------- */
{
  const room = new Room('t3', () => {});
  room.join('a', '갑', 's1');
  room.addBot('a');
  room.updateSettings('a', { rounds: 10 });
  assert.ok(room.start('a').ok, '사람 1 + 봇 1 로 시작할 수 있어야 한다');
  assert.strictEqual(room.game.players.length, 2);

  const botId = room.players.find((p) => p.isBot).id;
  // 사람이 준비해도 봇이 아직이면 라운드가 넘어가지 않는다
  room.setReady('a', true);
  assert.strictEqual(room.game.round, 1);

  // 봇이 움직이고 준비를 누르면 정산된다 (예약 타이머가 도는 것을 기다린다)
  setTimeout(() => {
    assert.ok(room.game.round >= 2, `봇 차례 후 라운드가 진행되어야 한다 (현재 ${room.game.round})`);
    const built = room.game.map.tiles.some((t) => t.owner === botId && t.b);
    assert.ok(built, '봇이 실제로 건물을 지어야 한다');
    room.clearAutoTimer();
    console.log('✓ 봇 자동 진행 (방 통합)');
    console.log('\n봇 테스트 전부 통과!');
  }, 4000);
}
