'use strict';

/* 게임 핵심 로직 테스트: node test/game.test.js */

const assert = require('assert');
const {
  Game, MATERIALS, PRODUCTS, TILE_TYPES, BUILDINGS,
  TOTAL_SHARES, FOUNDER_SHARES, TAKEOVER_SHARES, DIVIDEND_YIELD,
  transportQuote, generateMap, resourceCounts, MAP_W, MAP_H,
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
  const tally = (map) => {
    const counts = {};
    for (const t of map.tiles) counts[t.t] = (counts[t.t] || 0) + 1;
    return counts;
  };

  const map = generateMap(2);
  assert.strictEqual(map.tiles.length, MAP_W * MAP_H);
  assert.strictEqual(map.cities.length, 4);
  for (const c of map.cities) {
    assert.strictEqual(map.tiles[c.y * MAP_W + c.x].t, 'city');
  }

  // 요청한 개수가 정확히 깔려야 한다 (빈 자리를 못 찾고 헛돌면 안 된다)
  for (const n of [2, 4, 6]) {
    const m = generateMap(n);
    const counts = tally(m);
    const want = resourceCounts(n);
    for (const [type, expected] of Object.entries(want)) {
      assert.strictEqual(counts[type], expected, `${n}인 맵의 ${type} 타일이 ${expected}개여야 한다`);
    }
    assert.ok(counts.plain > 40, `공장 지을 평지가 넉넉해야 한다 (${counts.plain}칸)`);
  }

  // 인원이 늘면 자원도 늘어난다
  const c2 = resourceCounts(2);
  const c6 = resourceCounts(6);
  for (const type of ['iron', 'oil', 'farm']) {
    assert.ok(c6[type] > c2[type], `${type} 타일은 인원이 많을수록 늘어야 한다`);
  }
  // 기계 생산(철2:유1)에 맞게 광산 자리가 유전보다 넉넉하다
  assert.ok(c2.iron > c2.oil && c6.iron > c6.oil);
  console.log(`✓ 맵 생성 (2인 철${c2.iron}/유${c2.oil}/농${c2.farm} → 6인 철${c6.iron}/유${c6.oil}/농${c6.farm})`);
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
  // 도시마다 가격 계수가 달라서, 거리 효과만 보려면 "같은 도시" 기준으로 비교해야 한다
  const ci = 0;
  let near = null;
  let far = null;
  for (let i = 0; i < g.map.tiles.length; i++) {
    if (g.map.tiles[i].t !== 'plain') continue;
    const d = g.distToCity(i, ci);
    if (!near || d < near.d) near = { i, d };
    if (!far || d > far.d) far = { i, d };
  }
  const qNear = g.quoteRoute(near.i, ci, 'machine');
  const qFar = g.quoteRoute(far.i, ci, 'machine');
  assert.ok(qNear.net > qFar.net, `가까운 쪽이 이득이 커야 한다 (${qNear.net} vs ${qFar.net})`);
  assert.ok(qNear.transport.cost < qFar.transport.cost, '가까우면 운송비가 싸다');
  assert.strictEqual(qNear.revenue, qFar.revenue, '같은 도시면 매출은 같고 운송비만 다르다');
  console.log(
    `✓ 거리에 따른 운송비 차이 (${g.cities[ci].name}행: ${near.d}칸 ${qNear.net}/초 vs ${far.d}칸 ${qFar.net}/초)`
  );
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

/* ---------------- 시장은 모두가 공유한다 ---------------- */
{
  const g = newGame(100000);
  const a = g.player('a');
  const b = g.player('b');

  // 자재: 한 사람이 사면 모두에게 값이 오른다
  const start = g.market.iron.price;
  const bFirst = g.trade('b', { mat: 'iron', qty: 10, side: 'buy' }).total;
  const afterA = (() => {
    g.trade('a', { mat: 'iron', qty: 60, side: 'buy' }); // a 가 대량 매수
    return g.market.iron.price;
  })();
  assert.ok(afterA > start, '남이 사면 시세가 오른다');
  const bLater = g.trade('b', { mat: 'iron', qty: 10, side: 'buy' }).total;
  assert.ok(bLater > bFirst, `a 가 사들인 뒤 b 는 더 비싸게 산다 (${bFirst} → ${bLater})`);

  // 반대로 남이 팔면 모두에게 값이 내린다
  const beforeSell = g.market.iron.price;
  g.trade('a', { mat: 'iron', qty: 60, side: 'sell' });
  assert.ok(g.market.iron.price < beforeSell, '남이 팔면 시세가 내린다');

  // 주식도 같은 하나의 호가를 공유한다
  const s0 = g.stocks.b.price;
  g.stockTrade('a', { company: 'b', qty: 20, side: 'buy' });
  assert.ok(g.stocks.b.price > s0, '남이 사면 주가가 오른다');

  // 도시 수요도 공유 — 남이 쏟아부으면 내 노선 수익도 같이 떨어진다
  const idxA = g.map.tiles.findIndex((t) => t.t === 'plain');
  const idxB = g.map.tiles.findIndex((t, i) => t.t === 'plain' && i !== idxA);
  g.buyTile('a', idxA);
  g.build('a', idxA, 'factory');
  g.buyTile('b', idxB);
  g.build('b', idxB, 'factory');
  const city = g.map.tiles[idxA].route;
  const myNetBefore = g.quoteRoute(idxA, city, 'machine').net;
  b.inv.machine = 20;
  g.setRoute('b', idxB, city); // b 도 같은 도시로 쏟아붓는다
  run(g, 15);
  const myNetAfter = g.quoteRoute(idxA, city, 'machine').net;
  assert.ok(myNetAfter < myNetBefore, `남이 같은 도시에 팔면 내 수익도 떨어진다 (${myNetBefore} → ${myNetAfter})`);
  console.log('✓ 시장 공유 (자재/주식/도시 수요 모두 한 판)');
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

/* ---------------- 배당은 주가를 따른다 ---------------- */
{
  const g = newGame(5000);
  const a = g.player('a');
  const b = g.player('b');
  a.cash = 100000;

  // a 가 b 지분 20주를 산다
  g.stockTrade('a', { company: 'b', qty: 20, side: 'buy' });
  assert.strictEqual(g.controllerOf('b'), null);

  // 주가를 고정해 두고 10초간 받은 배당을 잰다
  const price1 = 50;
  g.stocks.b.price = price1;
  const aCash0 = a.cash;
  const bCash0 = b.cash;
  g.payDividends(10);
  const got1 = a.cash - aCash0;
  const expected1 = price1 * 20 * DIVIDEND_YIELD * 10;
  assert.ok(Math.abs(got1 - expected1) < 1e-6, `배당 = 주가 × 주식수 × ${DIVIDEND_YIELD}/초`);
  assert.ok(Math.abs(bCash0 - b.cash - got1) < 1e-6, '배당은 회사 현금에서 나간다');

  // 주가가 2배면 배당도 2배
  g.stocks.b.price = price1 * 2;
  const aCash1 = a.cash;
  g.payDividends(10);
  const got2 = a.cash - aCash1;
  assert.ok(Math.abs(got2 - got1 * 2) < 1e-6, `주가가 오르면 배당도 비례해 오른다 (${got1} → ${got2})`);

  // 주식이 많을수록 많이 받는다
  g.stockTrade('a', { company: 'b', qty: 20, side: 'buy' });
  g.stocks.b.price = price1;
  const aCash2 = a.cash;
  g.payDividends(10);
  assert.ok(a.cash - aCash2 > got1 * 1.9, '40주는 20주의 두 배쯤 받는다');

  // 자기 주식에는 배당이 나가지 않는다
  const g2 = newGame(5000);
  const solo = g2.player('a');
  const cash0 = solo.cash;
  g2.payDividends(10);
  assert.strictEqual(solo.cash, cash0, '창업자 지분에는 배당이 나가지 않는다');

  // 회사에 현금이 없으면 있는 만큼만 나간다 (마이너스로 가지 않는다)
  const g3 = newGame(5000);
  g3.player('a').cash = 100000;
  g3.stockTrade('a', { company: 'b', qty: 30, side: 'buy' });
  g3.player('b').cash = 5;
  g3.stocks.b.price = 500;
  g3.payDividends(10);
  assert.ok(g3.player('b').cash >= 0, '회사 현금이 음수가 되지 않는다');
  console.log(`✓ 주가 연동 배당 (주가 ${price1}×20주 10초 → ${Math.round(got1)})`);
}

/* ---------------- 경영권 인수는 매출에서 뗀다 ---------------- */
{
  const g = newGame(5000);
  const a = g.player('a');
  const b = g.player('b');
  a.cash = 100000;

  // b 가 공장을 돌려 매출을 낸다
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain');
  g.buyTile('b', idx);
  g.build('b', idx, 'factory');
  b.inv.iron = 60;
  b.inv.oil = 30;

  // 20주만 있을 때 (경영권 없음) 10초간 벌이
  g.stockTrade('a', { company: 'b', qty: 20, side: 'buy' });
  const aCash0 = a.cash;
  run(g, 10);
  const noControl = a.cash - aCash0;

  // 51주로 경영권을 쥐면 매출의 25%가 추가로 들어온다
  g.stockTrade('a', { company: 'b', qty: 31, side: 'buy' });
  assert.strictEqual(g.controllerOf('b').id, 'a');
  const aCash1 = a.cash;
  run(g, 10);
  const withControl = a.cash - aCash1;
  assert.ok(withControl > noControl * 2, `경영권을 쥐면 훨씬 많이 가져간다 (${noControl} → ${withControl})`);
  console.log(
    `✓ 경영권 인수 이익 (10초당 ${Math.round(noControl)} → ${Math.round(withControl)})`
  );
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
