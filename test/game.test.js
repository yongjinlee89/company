'use strict';

/* 게임 핵심 로직 테스트: node test/game.test.js */

const assert = require('assert');
const {
  Game, MATERIALS, PRODUCTS, TILE_TYPES, BUILDINGS,
  TOTAL_SHARES, FOUNDER_SHARES, TAKEOVER_SHARES, DIVIDEND_RATE,
  transportQuote, generateMap, MAP_W, MAP_H,
} = require('../src/game');

function newGame(startCash = 1000, duration = 600) {
  return new Game([{ id: 'a', name: '갑' }, { id: 'b', name: '을' }], { startCash, duration });
}

/** dt 초 만큼 250ms 단위로 시뮬레이션한다 (서버와 같은 간격) */
function run(game, seconds) {
  const step = 0.25;
  for (let t = 0; t < seconds; t += step) game.tick(step);
}

/* ---------------- 맵 생성 ---------------- */
{
  const map = generateMap();
  assert.strictEqual(map.tiles.length, MAP_W * MAP_H);
  assert.strictEqual(map.cities.length, 4);
  for (const c of map.cities) {
    assert.strictEqual(map.tiles[c.y * MAP_W + c.x].t, 'city');
  }
  const counts = {};
  for (const t of map.tiles) counts[t.t] = (counts[t.t] || 0) + 1;
  assert.ok(counts.iron >= 8 && counts.oil >= 6 && counts.farm >= 10, '자원 타일이 충분해야 한다');
  console.log('✓ 맵 생성');
}

/* ---------------- 운송 수단 선택 ---------------- */
{
  // 소량·근거리는 트럭, 원거리는 기차, 대량 원거리는 항공이 싸야 한다
  assert.strictEqual(transportQuote(2, 0.2).method, 'truck');
  assert.strictEqual(transportQuote(10, 0.2).method, 'train');
  assert.strictEqual(transportQuote(10, 2.0).method, 'air');

  // 항상 세 수단 중 최솟값을 고른다
  for (const [d, r] of [[1, 0.1], [5, 0.5], [11, 3]]) {
    const q = transportQuote(d, r);
    const all = [2.0 * d * r, 0.9 + 0.55 * d * r, 2.2 + 0.18 * d * r];
    assert.ok(Math.abs(q.cost - Math.min(...all)) < 0.02, '가장 싼 수단을 골라야 한다');
  }
  // 거리가 멀수록 비싸고, 개당 단가는 물동량이 클수록 싸다 (규모의 경제)
  assert.ok(transportQuote(10, 0.2).cost > transportQuote(2, 0.2).cost);
  const perUnitSmall = transportQuote(8, 0.2).cost / 0.2;
  const perUnitBig = transportQuote(8, 2.0).cost / 2.0;
  assert.ok(perUnitBig < perUnitSmall, '대량으로 보내면 개당 운송비가 싸진다');
  console.log('✓ 운송 수단 선택 (트럭/기차/항공)');
}

/* ---------------- 땅 구매 / 건설 ---------------- */
{
  const g = newGame();
  const idx = g.map.tiles.findIndex((t) => t.t === 'iron');
  const a = g.player('a');

  assert.ok(g.buyTile('a', idx).ok);
  assert.strictEqual(g.map.tiles[idx].owner, 'a');
  assert.strictEqual(a.cash, 1000 - TILE_TYPES.iron.price);

  assert.ok(!g.buyTile('b', idx).ok, '남의 땅은 못 산다');
  const mIdx = g.map.tiles.findIndex((t) => t.t === 'mountain');
  assert.ok(!g.buyTile('a', mIdx).ok, '산은 못 산다');

  assert.ok(!g.build('a', idx, 'farm').ok, '철광 지대에 농장은 불가');
  assert.ok(g.build('a', idx, 'mine').ok);
  assert.ok(!g.build('a', idx, 'mine').ok, '중복 건설 불가');
  console.log('✓ 땅 구매/건설');
}

/* ---------------- 실시간 생산 ---------------- */
{
  const g = newGame();
  const a = g.player('a');
  const idx = g.map.tiles.findIndex((t) => t.t === 'iron');
  g.buyTile('a', idx);
  g.build('a', idx, 'mine');

  run(g, 10);
  const expected = BUILDINGS.mine.out.iron * 10;
  assert.ok(Math.abs(a.inv.iron - expected) < 0.01, `10초에 ${expected}개 (실제 ${a.inv.iron})`);

  // 시간에 비례한다
  run(g, 10);
  assert.ok(Math.abs(a.inv.iron - expected * 2) < 0.01, '생산량은 시간에 비례한다');
  console.log(`✓ 실시간 생산 (광산 ${BUILDINGS.mine.out.iron}/초)`);
}

/* ---------------- 공장: 재료가 있는 만큼만 ---------------- */
{
  const g = newGame(5000);
  const a = g.player('a');
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain');
  g.buyTile('a', idx);
  g.build('a', idx, 'factory');
  g.setRoute('a', idx, null); // 배송은 끄고 재고만 본다
  assert.strictEqual(g.map.tiles[idx].mode, 'machine');

  // 재료가 없으면 멈춘다
  run(g, 5);
  assert.strictEqual(a.inv.machine, 0);
  assert.ok(g.map.tiles[idx].idle, '재료가 없으면 idle 로 표시된다');

  // 재료를 넣으면 rate 대로 만든다 (기계 = 철2 + 유1)
  a.inv.iron = 100;
  a.inv.oil = 100;
  run(g, 10);
  const made = PRODUCTS.machine.rate * 10;
  assert.ok(Math.abs(a.inv.machine - made) < 0.02, `10초에 ${made}개 (실제 ${a.inv.machine})`);
  assert.ok(Math.abs(a.inv.iron - (100 - made * 2)) < 0.05, '철을 개당 2개 소비');
  assert.ok(Math.abs(a.inv.oil - (100 - made * 1)) < 0.05, '원유를 개당 1개 소비');
  assert.ok(!g.map.tiles[idx].idle);

  // 재료가 부족하면 그만큼만 만든다
  a.inv.iron = 1;
  const before = a.inv.machine;
  run(g, 10);
  assert.ok(a.inv.machine - before < made, '재료가 모자라면 덜 만든다');
  assert.ok(a.inv.iron < 0.01, '남은 재료를 다 쓴다');
  console.log('✓ 공장 생산 (재료 제약)');
}

/* ---------------- 배송 노선 = 자동 판매 ---------------- */
{
  const g = newGame(5000);
  const a = g.player('a');
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain');
  g.buyTile('a', idx);
  g.build('a', idx, 'factory');
  a.inv.iron = 1000;
  a.inv.oil = 1000;

  // build() 가 가장 이득이 큰 노선을 자동으로 잡아 준다
  assert.ok(g.map.tiles[idx].route !== null, '건설 시 노선이 자동 지정된다');
  const best = g.bestRoute(idx, 'machine');
  assert.strictEqual(g.map.tiles[idx].route, best.city);

  const cash0 = a.cash;
  run(g, 10);
  assert.ok(a.cash > cash0, '노선이 있으면 돈이 계속 들어온다');
  assert.ok(a.inv.machine < 0.05, '만든 만큼 바로 팔려 재고가 쌓이지 않는다');

  // 초당 수익이 견적과 비슷해야 한다
  assert.ok(a.incomePerSec > 0, '초당 수익이 잡힌다');
  assert.ok(Math.abs(a.incomePerSec - best.net) < best.net * 0.5, '견적과 실제가 크게 다르지 않다');

  // 많이 팔면 그 도시 수요가 떨어진다
  assert.ok(g.cities[best.city].demand.machine < 1, '팔수록 수요가 떨어진다');

  // 노선을 끄면 재고가 쌓인다
  g.setRoute('a', idx, null);
  run(g, 5);
  assert.ok(a.inv.machine > 0.5, '노선을 끄면 재고가 쌓인다');
  console.log(`✓ 배송 노선 자동 판매 (${best.net}/초 견적)`);
}

/* ---------------- 거리가 멀수록 순이익이 준다 ---------------- */
{
  const g = newGame();
  // 도시에서 가장 가까운 평지와 가장 먼 평지를 비교
  let near = null;
  let far = null;
  for (let i = 0; i < g.map.tiles.length; i++) {
    if (g.map.tiles[i].t !== 'plain') continue;
    const d = Math.min(...g.cities.map((_, ci) => g.distToCity(i, ci)));
    if (!near || d < near.d) near = { i, d };
    if (!far || d > far.d) far = { i, d };
  }
  const qNear = g.bestRoute(near.i, 'machine');
  const qFar = g.bestRoute(far.i, 'machine');
  assert.ok(qNear.net > qFar.net, `가까운 쪽이 이득이 커야 한다 (${qNear.net} vs ${qFar.net})`);
  assert.ok(qNear.transport.cost < qFar.transport.cost, '가까우면 운송비가 싸다');
  console.log(`✓ 거리에 따른 운송비 차이 (${near.d}칸 ${qNear.net}/초 vs ${far.d}칸 ${qFar.net}/초)`);
}

/* ---------------- 공장 증설 ---------------- */
{
  const g = newGame(5000);
  const a = g.player('a');
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain');
  g.buyTile('a', idx);
  g.build('a', idx, 'factory');
  const tile = g.map.tiles[idx];
  assert.strictEqual(tile.level, 1);
  assert.ok(Math.abs(g.factoryRate(tile) - PRODUCTS.machine.rate) < 1e-9);

  const cash0 = a.cash;
  assert.ok(g.upgradeFactory('a', idx).ok);
  assert.strictEqual(tile.level, 2);
  assert.strictEqual(a.cash, cash0 - BUILDINGS.factory.upgradeCost);
  assert.ok(Math.abs(g.factoryRate(tile) - PRODUCTS.machine.rate * 2) < 1e-9, '생산량이 레벨에 비례한다');

  // 남의 공장은 증설 불가
  assert.ok(!g.upgradeFactory('b', idx).ok);

  // 최대 단계까지만
  assert.ok(g.upgradeFactory('a', idx).ok);
  assert.strictEqual(tile.level, BUILDINGS.factory.maxLevel);
  assert.ok(!g.upgradeFactory('a', idx).ok, '최대 단계를 넘을 수 없다');

  // 실제 생산량도 3배
  a.inv.iron = 1000;
  a.inv.oil = 1000;
  g.setRoute('a', idx, null);
  const m0 = a.inv.machine;
  run(g, 10);
  assert.ok(Math.abs(a.inv.machine - m0 - PRODUCTS.machine.rate * 3 * 10) < 0.05, '3단계는 3배로 생산');

  // 증설해서 물동량이 커지면 개당 운송비가 싸져 순이익률이 올라간다
  const g2 = newGame(5000);
  const i2 = g2.map.tiles.findIndex((t) => t.t === 'plain');
  g2.buyTile('a', i2);
  g2.build('a', i2, 'factory');
  const far = g2.cities
    .map((_, ci) => ({ ci, d: g2.distToCity(i2, ci) }))
    .sort((x, y) => y.d - x.d)[0].ci;
  const q1 = g2.quoteRoute(i2, far, 'machine');
  g2.upgradeFactory('a', i2);
  g2.upgradeFactory('a', i2);
  const q3 = g2.quoteRoute(i2, far, 'machine');
  assert.ok(q3.net > q1.net * 3, `증설하면 순이익이 3배보다 더 는다 (${q1.net} → ${q3.net})`);
  console.log(`✓ 공장 증설 (${far}번 도시 ${q1.transport.name} ${q1.net}/초 → ${q3.transport.name} ${q3.net}/초)`);
}

/* ---------------- 수요는 시간이 지나면 회복된다 ---------------- */
{
  const g = newGame();
  const c = g.cities[0];
  c.demand.machine = 0.4;
  run(g, 30);
  assert.ok(c.demand.machine > 0.5, '수요가 회복되어야 한다');
  assert.ok(c.demand.machine <= 1.001, '100% 를 넘지 않는다');
  console.log(`✓ 도시 수요 회복 (0.4 → ${Math.round(c.demand.machine * 100) / 100})`);
}

/* ---------------- 자재 시장 ---------------- */
{
  const g = newGame(100000);
  const a = g.player('a');

  const p0 = g.market.iron.price;
  const buy = g.trade('a', { mat: 'iron', qty: 50, side: 'buy' });
  assert.ok(buy.ok);
  assert.ok(g.market.iron.price > p0, '사면 가격이 오른다');
  assert.strictEqual(a.inv.iron, 50);

  const p1 = g.market.iron.price;
  const sell = g.trade('a', { mat: 'iron', qty: 50, side: 'sell' });
  assert.ok(sell.ok);
  assert.ok(g.market.iron.price < p1, '팔면 가격이 내린다');
  assert.ok(sell.total < buy.total, '왕복하면 손해 (스프레드)');

  for (let i = 0; i < 30; i++) g.trade('a', { mat: 'grain', qty: 500, side: 'buy' });
  assert.ok(g.market.grain.price <= MATERIALS.grain.base * 2.5 + 0.01, '상한을 넘지 않는다');

  const drift = g.market.grain.price;
  run(g, 20);
  assert.ok(g.market.grain.price < drift, '시간이 지나면 기준가로 회귀');
  console.log('✓ 자재 시장');
}

/* ---------------- 주식 / 경영권 ---------------- */
{
  const g = newGame(100000);
  const a = g.player('a');
  const b = g.player('b');

  assert.strictEqual(a.shares.a, FOUNDER_SHARES);
  assert.strictEqual(g.stocks.a.float, TOTAL_SHARES - FOUNDER_SHARES);

  const p0 = g.stocks.b.price;
  assert.ok(g.stockTrade('a', { company: 'b', qty: 30, side: 'buy' }).ok);
  assert.strictEqual(a.shares.b, 30);
  assert.strictEqual(g.stocks.b.float, 30);
  assert.ok(g.stocks.b.price > p0, '매수하면 주가가 오른다');
  assert.strictEqual(g.controllerOf('b'), null, '30주로는 경영권 없음');

  assert.ok(g.stockTrade('a', { company: 'b', qty: 21, side: 'buy' }).ok);
  assert.strictEqual(a.shares.b, 51);
  assert.strictEqual(g.controllerOf('b').id, 'a');
  assert.ok(!g.stockTrade('b', { company: 'b', qty: 30, side: 'buy' }).ok, '유통 물량 초과 매수 불가');

  assert.ok(g.stockTrade('a', { company: 'b', qty: 10, side: 'sell' }).ok);
  assert.strictEqual(g.controllerOf('b'), null, '매도하면 경영권이 풀린다');

  const g3 = newGame(100000);
  const rb = g3.stockTrade('a', { company: 'b', qty: 40, side: 'buy' });
  const rs = g3.stockTrade('a', { company: 'b', qty: 40, side: 'sell' });
  assert.ok(rs.total < rb.total, '주식 왕복도 손해');
  console.log('✓ 주식/경영권');
}

/* ---------------- 실시간 배당과 경영권 이익 ---------------- */
{
  const g = newGame(5000);
  const a = g.player('a');
  const b = g.player('b');

  // b 가 공장을 돌려 매출을 낸다 (20초를 돌리기에 넉넉한 만큼만 재료를 준다)
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain');
  g.buyTile('b', idx);
  g.build('b', idx, 'factory');
  b.inv.iron = 40;
  b.inv.oil = 20;

  // a 가 b 지분을 20주 사서 배당만 받는 상태
  // (주가는 회사 순자산을 따라 오르므로 지분을 넉넉히 살 현금을 쥐여 준다)
  a.cash = 100000;
  g.stockTrade('a', { company: 'b', qty: 20, side: 'buy' });
  const aCash0 = a.cash;
  run(g, 10);
  const dividend = a.cash - aCash0;
  assert.ok(dividend > 0, '지분이 있으면 배당이 실시간으로 들어온다');
  assert.strictEqual(g.controllerOf('b'), null);

  // 51주까지 늘려 경영권을 가져오면 몫이 확 커진다
  g.stockTrade('a', { company: 'b', qty: 31, side: 'buy' });
  assert.strictEqual(g.controllerOf('b').id, 'a');
  const aCash1 = a.cash;
  run(g, 10);
  const withControl = a.cash - aCash1;
  assert.ok(withControl > dividend * 2, `경영권을 쥐면 훨씬 많이 가져간다 (${dividend} → ${withControl})`);
  console.log(`✓ 실시간 배당/경영권 이익 (10초당 ${Math.round(dividend)} → ${Math.round(withControl)})`);
}

/* ---------------- 게임 종료 / 순자산 ---------------- */
{
  const g = newGame(1000, 20); // 20초짜리
  run(g, 19);
  assert.ok(!g.ended, '아직 안 끝났다');
  run(g, 2);
  assert.ok(g.ended, '제한 시간이 지나면 끝난다');
  assert.ok(Array.isArray(g.ranking) && g.ranking.length === 2);
  assert.ok(g.ranking[0].worth >= g.ranking[1].worth, '순자산 순으로 정렬');

  // 끝난 뒤에는 아무 행동도 받지 않는다
  assert.ok(!g.buyTile('a', 0).ok);
  assert.ok(!g.trade('a', { mat: 'iron', qty: 1, side: 'buy' }).ok);
  const worth = g.netWorth(g.player('a'));
  run(g, 5);
  assert.strictEqual(g.netWorth(g.player('a')), worth, '끝난 뒤에는 시간이 흘러도 변하지 않는다');
  console.log('✓ 게임 종료/순자산');
}

/* ---------------- 상태 직렬화 ---------------- */
{
  const g = newGame();
  const full = g.publicState(true);
  assert.ok(full.map && full.constants, '전체 상태에는 맵과 상수가 들어간다');
  const light = g.publicState(false);
  assert.ok(!light.map && !light.constants, '주기 갱신에는 맵을 빼서 트래픽을 아낀다');
  assert.ok(light.players && light.market && light.stocks && light.cities);
  assert.ok(typeof light.remaining === 'number');
  // 비밀 필드가 새어 나가지 않는다
  assert.ok(!('_incomeAccum' in light.players[0]), '내부 집계값은 보내지 않는다');
  assert.ok(JSON.stringify(light).length < JSON.stringify(full).length, '가벼운 상태가 더 작다');
  console.log('✓ 상태 직렬화');
}

console.log('\n게임 로직 테스트 전부 통과!');
