'use strict';

/* 컴퓨터 플레이어 테스트: node test/bot.test.js */

const assert = require('assert');
const { Game, BUILDINGS, PRODUCTS, TAKEOVER_SHARES } = require('../src/game');
const { think, inputNeed } = require('../src/bot');

function newGame(startCash = 1000, duration = 600, n = 2) {
  const infos = [];
  for (let i = 0; i < n; i++) infos.push({ id: 'p' + i, name: '회사' + i });
  return new Game(infos, { startCash, duration });
}

/**
 * 실제 방과 같은 리듬으로 돌린다: 250ms 마다 tick, 1.5초마다 봇 판단.
 * @param {string[]} botIds 스스로 판단하는 회사들
 */
function simulate(game, seconds, botIds) {
  const step = 0.25;
  let sinceThink = 0;
  for (let t = 0; t < seconds; t += step) {
    game.tick(step);
    sinceThink += step;
    if (sinceThink >= 1.5) {
      sinceThink = 0;
      for (const id of botIds) think(game, id);
    }
  }
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
  const g = newGame(1000);
  think(g, 'p0');
  assert.ok(Object.keys(countBuildings(g, 'p0')).length >= 1, '첫 판단에 건물을 하나는 짓는다');

  simulate(g, 90, ['p0']);
  const counts = countBuildings(g, 'p0');
  assert.ok(counts.factory >= 1, '공장을 확보해야 한다: ' + JSON.stringify(counts));
  const producers = (counts.mine || 0) + (counts.rig || 0) + (counts.farm || 0);
  assert.ok(producers >= 1, '원자재 생산기지를 확보해야 한다');
  console.log('✓ 봇 생산 기반 구축 ' + JSON.stringify(counts));
}

/* ---------------- 봇이 배송 노선을 잡고 돈을 번다 ---------------- */
{
  // 순자산이 이제 "내가 들고 있는 주식의 시세"로 매겨져서(자사주 포함), 몇십 초
  // 단위로는 mood 잡음이 실제 성장분을 가릴 수 있다 — 실제 게임 최단 길이(5분)에
  // 맞춰 돌려야 신호가 잡음을 확실히 이긴다.
  const g = newGame(1000, 400);
  const bot = g.player('p0');
  const idle = g.player('p1'); // 아무것도 안 하는 상대

  simulate(g, 300, ['p0']);

  // 공장마다 노선이 잡혀 있어야 한다
  const factories = [];
  for (let i = 0; i < g.map.tiles.length; i++) {
    const t = g.map.tiles[i];
    if (t.owner === 'p0' && t.b === 'factory') factories.push({ i, t });
  }
  assert.ok(factories.length >= 1);
  assert.ok(factories.every((f) => f.t.route !== null), '모든 공장에 배송 노선이 지정된다');

  assert.ok(bot.incomePerSec > 0, `초당 수익이 나야 한다 (${bot.incomePerSec})`);
  assert.ok(g.netWorth(bot) > g.netWorth(idle), '가만히 있는 상대보다 잘해야 한다');
  console.log(
    `✓ 봇 수익 창출 (5분 후 순자산 ${g.netWorth(bot)}, ${bot.incomePerSec}/초 · 무행동 ${g.netWorth(idle)})`
  );
}

/* ---------------- 봇이 공장을 도시 가까이 짓는다 ---------------- */
{
  const g = newGame(3000);
  simulate(g, 60, ['p0']);
  const factory = g.map.tiles.findIndex((t) => t.owner === 'p0' && t.b === 'factory');
  assert.ok(factory >= 0, '공장이 있어야 한다');
  const dist = Math.min(...g.cities.map((_, ci) => g.distToCity(factory, ci)));
  assert.ok(dist <= 3, `공장은 도시 근처에 지어야 한다 (거리 ${dist})`);
  console.log(`✓ 봇 공장 입지 선정 (도시까지 ${dist}칸)`);
}

/* ---------------- 봇이 여유가 생기면 증설한다 ---------------- */
{
  const g = newGame(3000);
  simulate(g, 180, ['p0']);
  const levels = [];
  for (const t of g.map.tiles) {
    if (t.owner === 'p0' && t.b === 'factory') levels.push(t.level || 1);
  }
  assert.ok(levels.length >= 1);
  assert.ok(Math.max(...levels) >= 2, `공장을 증설해야 한다 (레벨 ${levels.join(',')})`);
  console.log(`✓ 봇 공장 증설 (레벨 ${levels.join(', ')})`);
}

/* ---------------- 봇이 경영권을 방어한다 ---------------- */
{
  const g = newGame(200000);
  const attacker = g.player('p1');
  // 인수까지 얼마 안 남은 수준까지 사들여 위협한다.
  // 후반이라 미발행 물량이 다 상장된 상황을 가정한다.
  g.stocks.p0.float += g.stocks.p0.unissued;
  g.stocks.p0.unissued = 0;
  const threat = Math.round(TAKEOVER_SHARES * 0.85);
  assert.ok(g.availableShares('p0') > threat, '되살 물량도 남아 있어야 방어가 가능하다');
  assert.ok(g.stockTrade('p1', { company: 'p0', qty: threat, side: 'buy' }).ok);
  assert.ok(g.availableShares('p0') > 0, '되살 물량이 남아 있어야 방어가 가능하다');
  assert.ok((attacker.shares.p0 || 0) >= TAKEOVER_SHARES * 0.8);

  const before = g.player('p0').shares.p0;
  think(g, 'p0');
  assert.ok(g.player('p0').shares.p0 > before, '자기 주식을 되사서 방어해야 한다');
  console.log(`✓ 봇 경영권 방어 (상대 ${threat}주 매집 → 되사기)`);
}

/* ---------------- 봇끼리 한 판을 끝까지 돌린다 ---------------- */
{
  const g = newGame(1000, 300, 4);
  const ids = g.players.map((p) => p.id);
  simulate(g, 305, ids);

  assert.ok(g.ended, '제한 시간이 지나면 끝난다');
  assert.strictEqual(g.ranking.length, 4);
  for (const p of g.players) {
    assert.ok(p.cash >= 0, `${p.name} 현금이 음수: ${p.cash}`);
    assert.ok(Number.isFinite(g.netWorth(p)), '순자산이 정상 범위여야 한다');
  }
  // 순자산이 이제 보유 주식 시세로 매겨지다 보니, 게임 막판에 금융위기 같은
  // 사건이 겹치면 다 같이 시작 자금보다 낮게 끝날 수도 있다 — 의도한 변동성이라
  // 절대 하한 대신 "가만히만 있지 않았다"는 실질적 차이만 확인한다.
  const spread = Math.max(...g.ranking.map((r) => r.worth)) - Math.min(...g.ranking.map((r) => r.worth));
  assert.ok(spread > 10, `경쟁 결과가 서로 갈려야 한다 (편차 ${spread})`);
  console.log(
    `✓ 봇 4인 5분 완주 (순자산 ${g.ranking.map((r) => r.worth).join(' / ')})`
  );
}

/* ---------------- 재료 소비량 계산 (증설 반영) ---------------- */
{
  const g = newGame(5000);
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain');
  g.buyTile('p0', idx);
  g.build('p0', idx, 'factory');
  const me = g.player('p0');

  let need = inputNeed(g, me);
  assert.ok(Math.abs(need.iron - 2 * PRODUCTS.machine.rate) < 1e-9, '기계는 철을 개당 2개 쓴다');
  assert.ok(Math.abs(need.oil - 1 * PRODUCTS.machine.rate) < 1e-9);

  g.upgradeBuilding('p0', idx);
  need = inputNeed(g, me);
  assert.ok(Math.abs(need.iron - 2 * PRODUCTS.machine.rate * 2) < 1e-9, '증설하면 소비도 늘어난다');
  console.log('✓ 재료 소비량 계산');
}

console.log('\n봇 테스트 전부 통과!');
