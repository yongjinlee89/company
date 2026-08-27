'use strict';

/* 게임 핵심 로직 테스트: node test/game.test.js */

const assert = require('assert');
const {
  Game, MATERIALS, PRODUCTS, TILE_TYPES, BUILDINGS,
  TOTAL_SHARES, FOUNDER_SHARES, TAKEOVER_SHARES,
  transportQuote, generateMap, MAP_W, MAP_H,
} = require('../src/game');

function newGame(startCash = 1000, rounds = 20) {
  return new Game(
    [{ id: 'a', name: '갑' }, { id: 'b', name: '을' }],
    { startCash, rounds, roundTime: 90 }
  );
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
  assert.ok(counts.iron >= 8, '철광 타일이 충분해야 한다');
  assert.ok(counts.oil >= 6, '유전 타일이 충분해야 한다');
  assert.ok(counts.farm >= 10, '농지 타일이 충분해야 한다');
  console.log('✓ 맵 생성');
}

/* ---------------- 운송 견적 ---------------- */
{
  // 근거리는 트럭, 원거리 대량은 항공이 싸야 한다
  const near = transportQuote(1, 3);
  assert.strictEqual(near.method, 'truck');
  const far = transportQuote(11, 30);
  assert.strictEqual(far.method, 'air');
  // 견적은 항상 세 수단 중 최솟값
  for (const [d, q] of [[1, 1], [5, 10], [11, 50]]) {
    const quote = transportQuote(d, q);
    const all = [3 * d * q, 15 + 1.5 * d * q, 50 + 0.8 * d * q];
    assert.strictEqual(quote.cost, Math.round(Math.min(...all)));
  }
  console.log('✓ 운송 견적');
}

/* ---------------- 땅 구매 / 건설 ---------------- */
{
  const g = newGame();
  const idx = g.map.tiles.findIndex((t) => t.t === 'iron');
  const a = g.player('a');

  assert.ok(g.buyTile('a', idx).ok);
  assert.strictEqual(g.map.tiles[idx].owner, 'a');
  assert.strictEqual(a.cash, 1000 - TILE_TYPES.iron.price);

  // 남의 땅은 못 산다
  assert.ok(!g.buyTile('b', idx).ok);
  // 산/도시는 못 산다
  const mIdx = g.map.tiles.findIndex((t) => t.t === 'mountain');
  assert.ok(!g.buyTile('a', mIdx).ok);

  // 건설: 지형이 맞아야 한다
  assert.ok(!g.build('a', idx, 'farm').ok, '철광 지대에 농장은 불가');
  assert.ok(g.build('a', idx, 'mine').ok);
  assert.ok(!g.build('a', idx, 'mine').ok, '중복 건설 불가');

  // 생산 확인
  g.resolveRound();
  assert.strictEqual(a.inv.iron, BUILDINGS.mine.out.iron);
  console.log('✓ 땅 구매/건설/생산');
}

/* ---------------- 공장 생산 ---------------- */
{
  const g = newGame(5000);
  const a = g.player('a');
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain');
  g.buyTile('a', idx);
  g.build('a', idx, 'factory');
  assert.strictEqual(g.map.tiles[idx].mode, 'machine');

  // 재료 없으면 생산 못 함
  g.resolveRound();
  assert.strictEqual(a.inv.machine, 0);

  // 재료를 넣으면 최대 2배치 생산 (기계 = 철2 + 유1)
  a.inv.iron = 10;
  a.inv.oil = 10;
  g.resolveRound();
  assert.strictEqual(a.inv.machine, 2);
  assert.strictEqual(a.inv.iron, 10 - 4);
  assert.strictEqual(a.inv.oil, 10 - 2);

  // 식품 모드 전환
  assert.ok(g.setFactoryMode('a', idx, 'food').ok);
  a.inv.grain = 3;
  g.resolveRound();
  assert.strictEqual(a.inv.food, 1, '곡물 3개로는 1배치만 생산');
  console.log('✓ 공장 생산');
}

/* ---------------- 배송 판매 ---------------- */
{
  const g = newGame(5000);
  const a = g.player('a');
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain');
  g.buyTile('a', idx);
  g.build('a', idx, 'factory');
  a.inv.machine = 10;

  const before = a.cash;
  const quote = g.quoteShip('a', { from: idx, city: 0, product: 'machine', qty: 5 });
  assert.ok(quote.ok);
  const res = g.ship('a', { from: idx, city: 0, product: 'machine', qty: 5 });
  assert.ok(res.ok);
  assert.strictEqual(a.inv.machine, 5);
  assert.strictEqual(a.cash, before + quote.net, '견적과 실제 정산이 같아야 한다');

  // 팔면 도시 수요가 떨어진다
  const c = g.cities[0];
  assert.ok(c.demand.machine < 1);

  // 공장 아닌 곳에서 배송 불가
  assert.ok(!g.ship('a', { from: 0, city: 0, product: 'machine', qty: 1 }).ok || g.map.tiles[0].b === 'factory');
  console.log('✓ 배송 판매');
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
  assert.ok(sell.total < buy.total, '왕복하면 손해 (호가 충격)');

  // 가격 상하한
  for (let i = 0; i < 30; i++) g.trade('a', { mat: 'grain', qty: 500, side: 'buy' });
  assert.ok(g.market.grain.price <= MATERIALS.grain.base * 2.5 + 0.01);

  // 라운드 정산 시 기준가로 회귀
  const drift = g.market.grain.price;
  g.resolveRound();
  assert.ok(g.market.grain.price < drift, '기준가로 회귀');
  console.log('✓ 자재 시장');
}

/* ---------------- 주식 / 경영권 ---------------- */
{
  const g = newGame(100000);
  const a = g.player('a');
  const b = g.player('b');

  // 시작 지분: 창업자 40주 + 유통 60주
  assert.strictEqual(a.shares.a, FOUNDER_SHARES);
  assert.strictEqual(g.stocks.a.float, TOTAL_SHARES - FOUNDER_SHARES);

  const p0 = g.stocks.b.price;
  const buy = g.stockTrade('a', { company: 'b', qty: 30, side: 'buy' });
  assert.ok(buy.ok);
  assert.strictEqual(a.shares.b, 30);
  assert.strictEqual(g.stocks.b.float, 30);
  assert.ok(g.stocks.b.price > p0, '매수하면 주가가 오른다');
  assert.strictEqual(g.controllerOf('b'), null, '30주로는 경영권 없음');

  // 51주 확보 → 경영권 인수
  assert.ok(g.stockTrade('a', { company: 'b', qty: 21, side: 'buy' }).ok);
  assert.strictEqual(a.shares.b, 51);
  assert.strictEqual(g.controllerOf('b').id, 'a');

  // 유통 물량보다 많이는 못 산다
  assert.ok(!g.stockTrade('b', { company: 'b', qty: 30, side: 'buy' }).ok);

  // 경영권 이익: b 가 이익을 내면 a 가 25% 수취
  b.roundProfit = 1000;
  const aCash = a.cash;
  const bCash = b.cash;
  g.resolveRound();
  assert.ok(a.cash > aCash, '배당+경영권 이익 수취');
  assert.ok(b.cash < bCash, '피인수 회사는 이익을 나눠준다');

  // 매도하면 경영권이 풀린다
  assert.ok(g.stockTrade('a', { company: 'b', qty: 10, side: 'sell' }).ok);
  assert.strictEqual(g.controllerOf('b'), null);

  // 주식도 사고팔기를 반복하면 손해여야 한다 (무한 펌핑 방지)
  const g3 = newGame(100000);
  const rb = g3.stockTrade('a', { company: 'b', qty: 40, side: 'buy' });
  const rs = g3.stockTrade('a', { company: 'b', qty: 40, side: 'sell' });
  assert.ok(rs.total < rb.total, '주식 왕복 손해');
  console.log('✓ 주식/경영권');
}

/* ---------------- 게임 종료 / 순자산 ---------------- */
{
  const g = newGame(1000, 2);
  g.resolveRound();
  assert.strictEqual(g.round, 2);
  assert.ok(!g.ended);
  g.resolveRound();
  assert.ok(g.ended);
  assert.ok(Array.isArray(g.ranking) && g.ranking.length === 2);
  assert.ok(g.ranking[0].worth >= g.ranking[1].worth);

  // 순자산 = 현금 + 재고 + 토지/건물 + 주식
  const g2 = newGame(1000);
  const a = g2.player('a');
  const own = g2.netWorth(a);
  assert.ok(own >= 1000, '시작 순자산은 현금 + 자기 주식 가치 이상');
  console.log('✓ 게임 종료/순자산');
}

console.log('\n게임 로직 테스트 전부 통과!');
