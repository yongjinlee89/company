'use strict';

/* 게임 핵심 로직 테스트: node test/game.test.js */

const assert = require('assert');
const {
  Game, MATERIALS, PRODUCTS, HITECH, TILE_TYPES, BUILDINGS,
  TOTAL_SHARES, FOUNDER_SHARES, INITIAL_FLOAT, TAKEOVER_SHARES, DIVIDEND_YIELD,
  transportQuote, generateMap, resourceCounts, RESEARCH, RESEARCH_MAX, MAP_W, MAP_H,
} = require('../src/game');

function newGame(startCash = 1000, duration = 600) {
  return new Game([{ id: 'a', name: '갑' }, { id: 'b', name: '을' }], { startCash, duration });
}

const fmt = (n) => Math.round(n * 100) / 100;

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
  assert.ok(g.upgradeBuilding('a', idx).ok);
  assert.strictEqual(tile.level, 2);
  assert.strictEqual(a.cash, cash0 - BUILDINGS.factory.upgradeCost);
  assert.ok(Math.abs(g.factoryRate(tile) - PRODUCTS.machine.rate * 2) < 1e-9, '생산량이 레벨에 비례한다');

  // 남의 공장은 증설 불가
  assert.ok(!g.upgradeBuilding('b', idx).ok);

  // 최대 단계까지만. 위로 갈수록 증설비가 비싸진다.
  assert.strictEqual(g.upgradeCost(tile), BUILDINGS.factory.upgradeCost * 2, '단계가 오를수록 비싸다');
  a.cash = 999999;
  while (g.upgradeCost(tile) !== null) assert.ok(g.upgradeBuilding('a', idx).ok);
  const max = BUILDINGS.factory.maxLevel;
  assert.strictEqual(tile.level, max);
  assert.ok(max >= 5, `충분히 여러 번 증설할 수 있다 (최대 ${max}단계)`);
  assert.ok(!g.upgradeBuilding('a', idx).ok, '최대 단계를 넘을 수 없다');

  // 실제 생산량도 단계에 비례한다
  a.inv.iron = 100000;
  a.inv.oil = 100000;
  g.setRoute('a', idx, null);
  const m0 = a.inv.machine;
  run(g, 10);
  assert.ok(
    Math.abs(a.inv.machine - m0 - PRODUCTS.machine.rate * max * 10) < 0.05,
    `${max}단계는 ${max}배로 생산`
  );

  // 증설해서 물동량이 커지면 개당 운송비가 싸져 순이익률이 올라간다
  const g2 = newGame(5000);
  const i2 = g2.map.tiles.findIndex((t) => t.t === 'plain');
  g2.buyTile('a', i2);
  g2.build('a', i2, 'factory');
  const far = g2.cities
    .map((_, ci) => ({ ci, d: g2.distToCity(i2, ci) }))
    .sort((x, y) => y.d - x.d)[0].ci;
  const q1 = g2.quoteRoute(i2, far, 'machine');
  g2.upgradeBuilding('a', i2);
  g2.upgradeBuilding('a', i2);
  const q3 = g2.quoteRoute(i2, far, 'machine');
  assert.ok(q3.net > q1.net * 3, `증설하면 순이익이 3배보다 더 는다 (${q1.net} → ${q3.net})`);
  console.log(`✓ 공장 증설 (${far}번 도시 ${q1.transport.name} ${q1.net}/초 → ${q3.transport.name} ${q3.net}/초)`);
}

/* ---------------- 자원 건물 증설 ---------------- */
{
  const g = newGame(5000);
  const a = g.player('a');

  for (const [kind, terrain] of [['mine', 'iron'], ['rig', 'oil'], ['farm', 'farm']]) {
    const spec = BUILDINGS[kind];
    assert.ok(spec.maxLevel >= 2 && spec.upgradeCost > 0, `${spec.name}도 증설할 수 있어야 한다`);

    const idx = g.map.tiles.findIndex((t) => t.t === terrain && !t.owner);
    g.buyTile('a', idx);
    g.build('a', idx, kind);
    const tile = g.map.tiles[idx];
    assert.strictEqual(tile.level, 1, '지으면 1단계');

    const mat = Object.keys(spec.out)[0];
    const base = spec.out[mat];
    assert.ok(Math.abs(g.buildingOutput(tile)[mat] - base) < 1e-9);

    // 증설하면 생산량이 배로 는다
    const cash0 = a.cash;
    assert.strictEqual(g.upgradeCost(tile), spec.upgradeCost);
    assert.ok(g.upgradeBuilding('a', idx).ok);
    assert.strictEqual(tile.level, 2);
    assert.strictEqual(a.cash, cash0 - spec.upgradeCost);
    assert.ok(Math.abs(g.buildingOutput(tile)[mat] - base * 2) < 1e-9, `${spec.name} 생산량이 2배`);

    // 남의 건물은 증설 불가
    assert.ok(!g.upgradeBuilding('b', idx).ok);

    // 최대 단계까지만 (돈이 모자라 멈추지 않도록 넉넉히 쥐여 준다)
    a.cash = 999999;
    while (g.upgradeCost(tile) !== null) assert.ok(g.upgradeBuilding('a', idx).ok);
    assert.strictEqual(tile.level, spec.maxLevel);
    assert.ok(!g.upgradeBuilding('a', idx).ok, '최대 단계를 넘을 수 없다');

    // 실제로 그만큼 더 캔다
    const before = a.inv[mat];
    run(g, 10);
    const made = a.inv[mat] - before;
    assert.ok(Math.abs(made - base * spec.maxLevel * 10) < 0.05, `${spec.name} ${spec.maxLevel}단계는 ${spec.maxLevel}배로 캔다`);

    // 증설비도 매각가에 반영된다
    assert.ok(g.tileValue(idx) > TILE_TYPES[terrain].price + spec.cost * 0.7, '증설한 만큼 값이 오른다');
  }
  console.log(`✓ 자원 건물 증설 (광산·시추소·농장 모두 ${BUILDINGS.mine.maxLevel}단계)`);
}

/* ---------------- 임대업 (공급이 늘면 임대료가 내려간다) ---------------- */
{
  const g = newGame(20000);
  const a = g.player('a');
  const b = g.player('b');
  const plain = () => g.map.tiles.findIndex((t) => t.t === 'plain' && !t.owner);

  const i1 = plain();
  g.buyTile('a', i1);
  g.build('a', i1, 'rental');
  const t1 = g.map.tiles[i1];
  assert.strictEqual(g.rentalSupply(), 1);

  // 재료도 배송도 없이 임대료가 바로 들어온다
  const rent1 = g.rentPerSec(t1);
  assert.ok(rent1 > 0, '임대료가 들어온다');
  const cash0 = a.cash;
  run(g, 10);
  assert.ok(a.cash > cash0, '가만히 둬도 현금이 는다');

  // 남이 임대 건물을 더 지으면 내 임대료가 내려간다
  const i2 = plain();
  g.buyTile('b', i2);
  g.build('b', i2, 'rental');
  assert.strictEqual(g.rentalSupply(), 2);
  const rent2 = g.rentPerSec(t1);
  assert.ok(rent2 < rent1, `공급이 늘면 임대료가 내려간다 (${fmt(rent1)} → ${fmt(rent2)})`);

  // 증설하면 그 건물 수입은 늘지만, 공급도 함께 늘어 전체 단가는 더 내려간다
  const perLevelBefore = g.rentPerSec(t1) / (t1.level || 1);
  g.upgradeBuilding('a', i1);
  assert.strictEqual(t1.level, 2);
  assert.ok(g.rentPerSec(t1) > rent2, '증설하면 그 건물 수입은 는다');
  assert.ok(g.rentPerSec(t1) / t1.level < perLevelBefore, '레벨당 임대료는 오히려 내려간다');

  // 많이 깔릴수록 1채당 수입이 계속 줄어든다
  const before = g.rentPerSec(t1);
  b.cash = 999999;
  for (let k = 0; k < 12; k++) {
    const idx = plain();
    g.buyTile('b', idx);
    g.build('b', idx, 'rental');
  }
  const after = g.rentPerSec(t1);
  assert.ok(after < before * 0.85, `공급 과잉이면 임대료가 떨어진다 (${fmt(before)} → ${fmt(after)})`);

  // 판 전체 임대 수입은 채수에 비례해 늘지 않는다 (많이 깔수록 남는 게 적다)
  const supplyNow = g.rentalSupply();
  let totalRent = 0;
  for (const t of g.map.tiles) if (t.b === 'rental') totalRent += g.rentPerSec(t);
  assert.ok(
    totalRent < BUILDINGS.rental.rent * supplyNow * 0.7,
    '전체 임대 수입이 채수에 비례하지 않는다 (공급 과잉)'
  );

  // 임대 건물은 도시 배송도, 생산 품목도 없다
  assert.ok(!g.setRoute('a', i1, 0).ok);
  assert.ok(!g.setFactoryMode('a', i1, 'machine').ok);
  console.log(`✓ 임대업 (1채 ${fmt(rent1)}/초 → 여러 채 깔리면 ${fmt(g.rentPerSec(t1) / t1.level)}/초)`);
}

/* ---------------- 하이테크는 많이 팔면 값이 빠르게 무너진다 ---------------- */
{
  const g = newGame(200000);
  const a = g.player('a');
  a.inv.semi = 5000;

  // 원자재보다 체결 충격이 크다 — 같은 수량을 팔아도 훨씬 많이 밀린다
  const semi0 = g.market.semi.price;
  g.trade('a', { mat: 'semi', qty: 20, side: 'sell' });
  const semiDrop = 1 - g.market.semi.price / semi0;

  const g2 = newGame(200000);
  g2.player('a').inv.iron = 5000;
  const iron0 = g2.market.iron.price;
  g2.trade('a', { mat: 'iron', qty: 20, side: 'sell' });
  const ironDrop = 1 - g2.market.iron.price / iron0;
  assert.ok(semiDrop > ironDrop * 3, `하이테크가 훨씬 크게 밀린다 (${fmt(semiDrop * 100)}% vs ${fmt(ironDrop * 100)}%)`);

  // 계속 쏟아부으면 값이 회복되지 못하고 눌린 채로 간다
  for (let k = 0; k < 10; k++) {
    g.trade('a', { mat: 'semi', qty: 20, side: 'sell' });
    run(g, 5);
  }
  assert.ok(
    g.market.semi.price < semi0 * 0.5,
    `공급 과잉이면 반토막 아래로 떨어진다 (${fmt(g.market.semi.price)} / ${semi0})`
  );

  // 원자재보다 회복이 느리다
  const low = g.market.semi.price;
  run(g, 30);
  const recovered = (g.market.semi.price - low) / Math.max(0.01, g.market.semi.base - low);
  assert.ok(recovered < 0.5, '한 번 눌린 하이테크 시세는 천천히 돌아온다');

  // 마진이 도시 제품과 비슷한 수준이어야 한다 (하이테크만 압도적이면 안 된다)
  const semiInput = Object.entries(HITECH.semi.recipe).reduce(
    (s, [k, n]) => s + MATERIALS[k].base * n,
    0
  );
  const machineInput = Object.entries(PRODUCTS.machine.recipe).reduce(
    (s, [k, n]) => s + MATERIALS[k].base * n,
    0
  );
  const semiMarkup = HITECH.semi.base / semiInput;
  const machineMarkup = PRODUCTS.machine.base / machineInput;
  assert.ok(
    semiMarkup < machineMarkup * 1.5,
    `하이테크 마진율이 도시 제품과 비슷해야 한다 (${fmt(semiMarkup)}배 vs ${fmt(machineMarkup)}배)`
  );
  console.log(
    `✓ 하이테크 시세 붕괴 (20개 매도에 ${fmt(semiDrop * 100)}% 하락, 마진율 ${fmt(semiMarkup)}배)`
  );
}

/* ---------------- 운송업 (오가는 화물이 수요) ---------------- */
{
  const g = newGame(50000);
  const a = g.player('a');
  const b = g.player('b');
  const plain = () => g.map.tiles.findIndex((t) => t.t === 'plain' && !t.owner);

  // 아무도 배송하지 않으면 화물이 없다
  assert.strictEqual(g.freightDemand(), 0, '오가는 화물이 없으면 수요도 0');

  const d1 = plain();
  g.buyTile('a', d1);
  g.build('a', d1, 'depot');
  const depot = g.map.tiles[d1];
  assert.strictEqual(g.depotSupply(), 1);
  assert.strictEqual(g.freightPerSec(depot), 0, '화물이 없으면 운임도 없다');

  const cash0 = a.cash;
  run(g, 10);
  assert.ok(a.cash < cash0, '화물이 없으면 유지비만 나간다');

  // b 가 공장을 돌려 도시로 실어 나르면 화물이 생긴다.
  // 물동량이 적으면 유지비도 못 내므로, 실제로 붐비는 상황을 만든다.
  const f1 = plain();
  g.buyTile('b', f1);
  g.build('b', f1, 'factory'); // 건설 시 노선이 자동으로 잡힌다
  b.cash = 999999;
  while (g.upgradeCost(g.map.tiles[f1]) !== null) g.upgradeBuilding('b', f1);
  b.inv.iron = 50000;
  b.inv.oil = 50000;

  const freight = g.freightDemand();
  assert.ok(freight > 0, '남이 배송하면 화물 수요가 생긴다');
  assert.ok(g.freightPerSec(depot) > 0, '그 화물로 운임을 번다');

  const cash1 = a.cash;
  run(g, 10);
  assert.ok(a.cash > cash1, '남이 실어 나르는 만큼 내가 번다');

  // 하이테크는 도시로 안 가므로 화물에 안 잡힌다
  g.setFactoryMode('b', f1, 'semi');
  assert.strictEqual(g.freightDemand(), 0, '하이테크는 도시 배송이 아니라 화물이 아니다');
  g.setFactoryMode('b', f1, 'machine');

  // 물류 센터가 늘면 1채당 운임이 줄어든다
  const before = g.freightPerSec(depot);
  for (let k = 0; k < 5; k++) {
    const idx = plain();
    g.buyTile('b', idx);
    g.build('b', idx, 'depot');
  }
  assert.ok(g.freightPerSec(depot) < before, `물류가 늘면 나눠 갖는다 (${fmt(before)} → ${fmt(g.freightPerSec(depot))})`);

  // 증설하면 그 센터 몫이 커진다
  const mine0 = g.freightPerSec(depot);
  g.upgradeBuilding('a', d1);
  assert.ok(g.freightPerSec(depot) > mine0, '증설하면 더 많이 받는다');

  // 물류 센터는 생산도 배송도 하지 않는다
  assert.ok(!g.setRoute('a', d1, 0).ok);
  assert.ok(!g.setFactoryMode('a', d1, 'machine').ok);
  console.log(`✓ 운송업 (화물 ${fmt(freight)}/초 → 운임 ${fmt(before)}/초, 물류가 늘면 분산)`);
}

/* ---------------- 임대 수요는 시간·산업과 함께 자란다 ---------------- */
{
  const g = newGame(50000, 600);
  const base = g.rentalDemand();
  assert.ok(Math.abs(base - 1) < 0.01, '시작할 땐 수요 배수가 1');

  // 시간이 지나면 수요가 는다
  run(g, 300);
  const timeGrown = g.rentalDemand();
  assert.ok(timeGrown > base, `시간이 지나면 수요가 는다 (${fmt(base)} → ${fmt(timeGrown)})`);

  // 공장·자원 건물이 늘어도 수요가 는다 (임대업은 안 늘려야 순수 효과가 보인다)
  const before = g.rentalDemand();
  for (const [terrain, kind] of [['iron', 'mine'], ['oil', 'rig'], ['plain', 'factory']]) {
    const idx = g.map.tiles.findIndex((t) => t.t === terrain && !t.owner);
    g.buyTile('a', idx);
    g.build('a', idx, kind);
  }
  const withIndustry = g.rentalDemand();
  assert.ok(withIndustry > before, `산업이 늘면 임대 수요도 는다 (${fmt(before)} → ${fmt(withIndustry)})`);

  // 임대 건물 자체는 수요를 늘리지 않는다 (공급만 늘린다)
  const d0 = g.rentalDemand();
  const ri = g.map.tiles.findIndex((t) => t.t === 'plain' && !t.owner);
  g.buyTile('a', ri);
  g.build('a', ri, 'rental');
  assert.ok(Math.abs(g.rentalDemand() - d0) < 1e-9, '임대 건물은 수요가 아니라 공급이다');

  // 후반에도 수요 배수가 터무니없이 커지지는 않는다
  assert.ok(g.rentalDemand() < 6, `수요 배수가 과하지 않다 (${fmt(g.rentalDemand())})`);
  console.log(`✓ 임대 수요 성장 (시작 1 → 시간 ${fmt(timeGrown)} → 산업까지 ${fmt(withIndustry)})`);
}

/* ---------------- 임대 수입도 경영권 몫의 대상이다 ---------------- */
{
  // 주가는 시장 심리에 따라 크게 흔들리므로, 과반을 사고도 남을 만큼 쥐여 준다
  const g = newGame(500000);
  const a = g.player('a');
  const b = g.player('b');

  const idx = g.map.tiles.findIndex((t) => t.t === 'plain' && !t.owner);
  g.buyTile('b', idx);
  g.build('b', idx, 'rental');

  // 경영권이 없을 때 b 가 버는 속도
  const bCash0 = b.cash;
  run(g, 10);
  const solo = b.cash - bCash0;
  assert.ok(solo > 0, '임대료가 들어온다');

  // a 가 b 를 인수하면 임대 수입의 일부가 a 에게 간다
  g.stocks.b.float += g.stocks.b.unissued;
  g.stocks.b.unissued = 0;
  g.stockTrade('a', { company: 'b', qty: TAKEOVER_SHARES, side: 'buy' });
  assert.strictEqual(g.controllerOf('b').id, 'a');

  const aCash0 = a.cash;
  const bCash1 = b.cash;
  run(g, 10);
  assert.ok(a.cash > aCash0, '인수자에게 임대 수입 몫이 들어온다');
  assert.ok(b.cash - bCash1 < solo, '인수당한 쪽은 그만큼 덜 남는다');
  console.log('✓ 임대 수입도 경영권 몫 대상');
}

/* ---------------- 연구개발 ---------------- */
{
  const g = newGame(100000);
  const a = g.player('a');

  assert.strictEqual(a.research.production, 0);
  assert.strictEqual(g.researchMult('a', 'production'), 1, '연구 전에는 보너스가 없다');

  // 생산 연구 — 자원 건물과 공장 모두 생산량이 는다
  const mineIdx = g.map.tiles.findIndex((t) => t.t === 'iron' && !t.owner);
  g.buyTile('a', mineIdx);
  g.build('a', mineIdx, 'mine');
  const facIdx = g.map.tiles.findIndex((t) => t.t === 'plain' && !t.owner);
  g.buyTile('a', facIdx);
  g.build('a', facIdx, 'factory');
  const out0 = g.buildingOutput(g.map.tiles[mineIdx]).iron;
  const rate0 = g.factoryRate(g.map.tiles[facIdx]);

  const cost1 = g.researchCost(a, 'production');
  assert.ok(cost1 > 0);
  const cash0 = a.cash;
  assert.ok(g.research('a', 'production').ok);
  assert.strictEqual(a.cash, cash0 - cost1);
  assert.strictEqual(a.research.production, 1);

  const step = RESEARCH.production.step;
  assert.ok(
    Math.abs(g.buildingOutput(g.map.tiles[mineIdx]).iron - out0 * (1 + step)) < 1e-9,
    `자원 생산량이 정확히 ${Math.round(step * 100)}% 는다`
  );
  assert.ok(Math.abs(g.factoryRate(g.map.tiles[facIdx]) - rate0 * (1 + step)) < 1e-9, '공장 생산량도 는다');

  // 단계가 오를수록 비싸진다
  assert.ok(g.researchCost(a, 'production') > cost1, '다음 단계가 더 비싸다');

  // 판매 연구 — 도시 판매가가 오른다
  const q0 = g.quoteRoute(facIdx, 0, 'machine').revenue;
  assert.ok(g.research('a', 'price').ok);
  const q1 = g.quoteRoute(facIdx, 0, 'machine').revenue;
  assert.ok(q1 > q0, `도시 판매가가 오른다 (${fmt(q0)} → ${fmt(q1)})`);

  // 최대 단계까지만
  let guard = 0;
  while (g.researchCost(a, 'production') !== null && guard++ < 20) {
    assert.ok(g.research('a', 'production').ok);
  }
  assert.strictEqual(a.research.production, RESEARCH_MAX);
  assert.ok(!g.research('a', 'production').ok, '최대 단계를 넘을 수 없다');
  assert.ok(
    Math.abs(g.researchMult('a', 'production') - (1 + RESEARCH_MAX * step)) < 1e-9,
    `최대 ${Math.round(RESEARCH_MAX * step * 100)}% 까지 오른다`
  );

  // 남의 회사 생산량은 그대로다
  const bIdx = g.map.tiles.findIndex((t) => t.t === 'iron' && !t.owner);
  g.buyTile('b', bIdx);
  g.build('b', bIdx, 'mine');
  assert.ok(
    g.buildingOutput(g.map.tiles[bIdx]).iron < g.buildingOutput(g.map.tiles[mineIdx]).iron,
    '연구 보너스는 그 회사에만 붙는다'
  );
  console.log(`✓ 연구개발 (생산 ${a.research.production}단계, 판매 ${a.research.price}단계)`);
}

/* ---------------- 깎아 주는 연구 (운송비·재료·유지비) ---------------- */
{
  // step 이 음수인 연구는 비용을 깎는다
  for (const kind of ['logistics', 'efficiency', 'upkeep']) {
    assert.ok(RESEARCH[kind], `${kind} 연구가 있어야 한다`);
    assert.ok(RESEARCH[kind].step < 0, `${kind} 는 깎아 주는 연구다`);
  }

  // 물류 — 운송비가 내려가 순이익이 오른다
  const g = newGame(100000);
  const a = g.player('a');
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain' && !t.owner);
  g.buyTile('a', idx);
  g.build('a', idx, 'factory');
  const far = g.cities.map((_, ci) => ({ ci, d: g.distToCity(idx, ci) })).sort((x, y) => y.d - x.d)[0].ci;
  const q0 = g.quoteRoute(idx, far, 'machine');
  assert.ok(g.research('a', 'logistics').ok);
  const q1 = g.quoteRoute(idx, far, 'machine');
  assert.ok(q1.transport.cost < q0.transport.cost, `운송비가 내려간다 (${q0.transport.cost} → ${q1.transport.cost})`);
  assert.ok(q1.net > q0.net, '그만큼 순이익이 오른다');

  // 공정 효율 — 같은 재료로 더 오래 돌아간다
  const g2 = newGame(100000);
  const p2 = g2.player('a');
  const i2 = g2.map.tiles.findIndex((t) => t.t === 'plain' && !t.owner);
  g2.buyTile('a', i2);
  g2.build('a', i2, 'factory');
  g2.setRoute('a', i2, null);
  p2.inv.iron = 100;
  p2.inv.oil = 100;
  run(g2, 20);
  const usedPlain = 100 - p2.inv.iron;

  const g3 = newGame(100000);
  const p3 = g3.player('a');
  const i3 = g3.map.tiles.findIndex((t) => t.t === 'plain' && !t.owner);
  g3.buyTile('a', i3);
  g3.build('a', i3, 'factory');
  g3.setRoute('a', i3, null);
  assert.ok(g3.research('a', 'efficiency').ok);
  p3.inv.iron = 100;
  p3.inv.oil = 100;
  run(g3, 20);
  const usedEff = 100 - p3.inv.iron;
  assert.ok(usedEff < usedPlain, `재료를 덜 쓴다 (${fmt(usedPlain)} → ${fmt(usedEff)})`);
  assert.ok(Math.abs(p3.inv.machine - p2.inv.machine) < 0.01, '만든 양은 같다');

  // 설비 관리 — 유지비가 줄어 현금이 덜 샌다
  const g4 = newGame(100000);
  const i4 = g4.map.tiles.findIndex((t) => t.t === 'iron' && !t.owner);
  g4.buyTile('a', i4);
  g4.build('a', i4, 'mine');
  const c4 = g4.player('a').cash;
  run(g4, 30);
  const feePlain = c4 - g4.player('a').cash;

  const g5 = newGame(100000);
  const i5 = g5.map.tiles.findIndex((t) => t.t === 'iron' && !t.owner);
  g5.buyTile('a', i5);
  g5.build('a', i5, 'mine');
  assert.ok(g5.research('a', 'upkeep').ok);
  const c5 = g5.player('a').cash;
  run(g5, 30);
  const feeCut = c5 - g5.player('a').cash;
  assert.ok(feeCut < feePlain, `유지비가 줄어든다 (${fmt(feePlain)} → ${fmt(feeCut)})`);
  console.log('✓ 깎아 주는 연구 (운송비·재료 소비·유지비)');
}

/* ---------------- 하이테크 제품 ---------------- */
{
  const g = newGame(20000);
  const a = g.player('a');
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain');
  g.buyTile('a', idx);
  g.build('a', idx, 'factory');
  const tile = g.map.tiles[idx];

  // 하이테크로 돌리면 배송 노선이 꺼진다 (도시로 안 간다)
  assert.ok(tile.route !== null, '기계 공장은 노선이 잡혀 있다');
  assert.ok(g.setFactoryMode('a', idx, 'semi').ok);
  assert.strictEqual(tile.route, null, '하이테크는 도시로 배송하지 않는다');
  assert.ok(!g.setRoute('a', idx, 0).ok, '하이테크 공장에는 노선을 걸 수 없다');
  assert.strictEqual(g.quoteRoute(idx, 0, 'semi'), null, '도시 견적도 없다');

  // 재료는 원자재를 바로 쓴다 — 기계를 모아 둘 필요가 없다
  assert.ok(!HITECH.semi.recipe.machine, '반도체는 기계를 쓰지 않는다');
  for (const k of Object.keys(HITECH.semi.recipe)) {
    assert.ok(MATERIALS[k], `반도체 재료 ${k} 는 원자재여야 한다`);
  }
  a.inv.iron = 200;
  a.inv.oil = 400;
  const cash0 = a.cash;
  run(g, 10);
  const made = HITECH.semi.rate * 10;
  assert.ok(Math.abs(a.inv.semi - made) < 0.05, `10초에 ${made}개 (실제 ${a.inv.semi})`);
  assert.ok(
    Math.abs(a.inv.iron - (200 - made * HITECH.semi.recipe.iron)) < 0.05,
    '철을 만든 만큼 소비한다'
  );
  // 도시로 안 팔리므로 매출이 없다 (유지비만 조금씩 빠져나간다)
  assert.ok(a.cash <= cash0, '하이테크는 만들어도 도시 매출이 생기지 않는다');

  // 시장에서 팔아야 돈이 된다
  assert.ok(g.market.semi, '반도체는 시장에서 거래된다');
  run(g, 60); // 팔 만큼 쌓일 때까지
  const stock = Math.floor(a.inv.semi);
  assert.ok(stock >= 2, `재고가 쌓인다 (${a.inv.semi.toFixed(1)}개)`);
  const sell = g.trade('a', { mat: 'semi', qty: stock, side: 'sell' });
  assert.ok(sell.ok && sell.total > 0, '시장에 팔면 현금이 들어온다');
  assert.ok(a.cash > cash0);
  assert.ok(sell.total / stock > PRODUCTS.machine.base, '반도체는 기계보다 개당 비싸다');

  assert.ok(HITECH.semi.base > PRODUCTS.machine.base, '하이테크가 도시 제품보다 비싸다');

  // 광산·시추소만 있으면 손대지 않아도 계속 돌아간다 (노선 조작이 필요 없다)
  const g2 = newGame(30000);
  const p2 = g2.player('a');
  const plain = () => g2.map.tiles.findIndex((t) => t.t === 'plain' && !t.owner);
  const semiIdx = plain();
  g2.buyTile('a', semiIdx);
  g2.build('a', semiIdx, 'factory');
  g2.setFactoryMode('a', semiIdx, 'semi');
  p2.inv.iron = 5000;
  p2.inv.oil = 5000;

  run(g2, 120);
  assert.ok(p2.inv.semi > 1, `반도체가 저절로 쌓인다 (${p2.inv.semi.toFixed(1)}개)`);
  assert.ok(!g2.map.tiles[semiIdx].idle, '원자재만 있으면 공장이 멈추지 않는다');
  console.log(`✓ 하이테크 (원자재로 직접 생산, 반도체 ${HITECH.semi.base})`);
}

/* ---------------- 반도체 시세는 스스로 출렁인다 ---------------- */
{
  const g = newGame(10000, 1200);

  // updateBaselines 만 반복 호출해 사건·거래 없이 순수한 변동만 관찰한다
  let lo = g.market.semi.baseline;
  let hi = g.market.semi.baseline;
  for (let t = 0; t < 300; t += 0.25) {
    g.updateBaselines(0.25);
    lo = Math.min(lo, g.market.semi.baseline);
    hi = Math.max(hi, g.market.semi.baseline);
  }
  const swing = (hi - lo) / HITECH.semi.base;
  assert.ok(swing > 0.15, `반도체 기준가가 크게 출렁인다 (변동폭 ${(swing * 100).toFixed(1)}%)`);

  // 아무도 캐거나 만들지 않는 원자재는 공급·수요가 0이라 기준가가 제자리를 지킨다
  assert.strictEqual(g.market.iron.baseline, MATERIALS.iron.base, '손대지 않은 원자재는 기준가가 그대로');
  console.log(`✓ 반도체 시세 자체 변동 (${(swing * 100).toFixed(1)}% 스윙, 손대지 않은 원자재는 제자리)`);
}

/* ---------------- 주가는 본업 가치만 따라간다 ---------------- */
{
  const g = newGame(10000);
  const a = g.player('a');
  const b = g.player('b');

  const priceA0 = g.stocks.a.price;
  const worthA0 = g.operatingWorth(a);

  // a 가 b 주식을 사도 a 의 본업 가치는 늘지 않아야 한다
  // (늘면 서로 사 주기만 해도 모두의 주가가 부풀어 오른다)
  g.stockTrade('a', { company: 'b', qty: 50, side: 'buy' });
  assert.ok(g.operatingWorth(a) < worthA0, '주식을 사면 현금이 나가 본업 가치는 오히려 준다');
  assert.ok(g.netWorth(a) > 0, '순위용 순자산에는 보유 주식이 포함된다');

  run(g, 20);
  assert.ok(g.stocks.a.price <= priceA0 * 1.3, '남의 주식을 샀다고 내 주가가 뛰지 않는다');

  // 반대로 실제로 회사를 키우면 주가가 오른다.
  // 시장 심리(mood)는 난수라 단기 주가를 크게 흔든다 — 여기서 보려는 건
  // "본업 가치가 주가를 끌어올린다" 이므로 심리를 1로 고정해 두고 본다.
  // (광산만 세우면 팔 곳이 없어 철값이 떨어지므로, 실제로 돈이 도는 공장으로 본다)
  const g2 = newGame(10000);
  const builder = g2.player('a');
  const idx = g2.map.tiles.findIndex((t) => t.t === 'plain');
  g2.buyTile('a', idx);
  g2.build('a', idx, 'factory'); // 건설 시 배송 노선이 자동으로 잡힌다
  builder.inv.iron = 2000;
  builder.inv.oil = 2000;
  const before = g2.stocks.a.price;
  const worth0 = g2.operatingWorth(builder);
  for (let t = 0; t < 60; t += 0.25) {
    g2.tick(0.25);
    g2.stocks.a.mood = 1;
    g2.marketMult = 1;
  }
  assert.ok(g2.operatingWorth(builder) > worth0, '공장이 돌면 회사 가치가 는다');
  assert.ok(g2.stocks.a.price > before, '그만큼 주가도 따라 오른다');
  console.log('✓ 주가 기준 = 본업 가치 (주식 상호매수로 부풀지 않음)');
}

/* ---------------- 순자산 = 현금·채권 − 빚 − 공매도 + 보유 주식 시가 (자사주도 예외 없음) ---------------- */
{
  const g = newGame(10000);
  const a = g.player('a');

  // 창업자가 자기 회사 지분을 전부 판다 — 그 회사에서 내 몫은 정확히 0이 된다
  assert.ok(g.stockTrade('a', { company: 'a', qty: FOUNDER_SHARES, side: 'sell' }).ok);
  assert.strictEqual(a.shares.a || 0, 0, '자사주가 하나도 안 남는다');
  assert.strictEqual(
    g.netWorth(a),
    Math.round(a.cash + a.bonds - a.debt),
    '자사주가 없으면 그 회사 몫은 순자산에 안 잡힌다'
  );

  // 시세가 아무리 뛰어도(mood·사건) 안 들고 있는 자사주는 내 순자산과 무관하다
  const worthNow = g.netWorth(a);
  g.stocks.a.price *= 5;
  assert.strictEqual(g.netWorth(a), worthNow, '안 들고 있는 자사주는 시세가 뛰어도 순자산에 영향이 없다');

  // 남의 회사 주식은 자사주와 똑같이 시세×수량으로 그대로 잡힌다
  assert.ok(g.stockTrade('a', { company: 'b', qty: 10, side: 'buy' }).ok);
  const held = a.shares.b;
  const fromB = g.stocks.b.price * held;
  const cashOnly = a.cash + a.bonds - a.debt;
  assert.ok(Math.abs(g.netWorth(a) - (cashOnly + fromB)) < 1, '보유 주식 시가가 그대로 더해진다');
  console.log('✓ 순자산 = 현금·채권-빚-공매도 + 보유 주식 시가 (자사주도 예외 없이 시세×수량)');
}

/* ---------------- 재고는 액면가가 아니라 팔았을 때 값으로 잡힌다 ---------------- */
{
  const QTY = 200;
  const g = newGame(10000);
  const a = g.player('a');

  const naiveIron = g.market.iron.price * QTY;
  const realIron = g.liquidationValue('iron', QTY);
  assert.ok(realIron < naiveIron, '많이 쌓아 둔 재고는 액면가보다 싸게 매겨진다');

  a.inv.iron = QTY;
  assert.ok(
    Math.abs(g.operatingWorth(a) - (10000 + realIron)) < 0.5,
    '순자산 계산도 liquidationValue 를 그대로 쓴다'
  );

  // 실제로 팔아 보면 예측과 비슷해야 한다 (진짜 회수 가능액이라는 검증)
  const sold = g.trade('a', { mat: 'iron', qty: QTY, side: 'sell' });
  assert.ok(sold.ok);
  assert.ok(
    Math.abs(sold.total - realIron) < realIron * 0.02,
    `예측(${realIron.toFixed(0)})과 실제 체결(${sold.total})이 비슷하다`
  );

  // 하이테크는 체결 충격이 훨씬 커서(HITECH_IMPACT), 같은 수량이면 할인폭도 더 크다
  const naiveSemi = g.market.semi.price * QTY;
  const realSemi = g.liquidationValue('semi', QTY);
  const matDiscount = 1 - realIron / naiveIron;
  const hitechDiscount = 1 - realSemi / naiveSemi;
  assert.ok(hitechDiscount > matDiscount, '하이테크가 원자재보다 재고 할인폭이 크다');
  console.log(
    `✓ 재고는 팔았을 때 값으로 평가 (${QTY}개 기준 원자재 ${(matDiscount * 100).toFixed(1)}% 할인, ` +
      `반도체 ${(hitechDiscount * 100).toFixed(1)}% 할인)`
  );
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

/* ---------------- 자재 시세는 기준선 근처에서 논다 ---------------- */
{
  const g = newGame(200000);
  const a = g.player('a');

  // 한 번에 많이 사도 시세가 몇 배로 튀지 않는다
  const p0 = g.market.iron.price;
  g.trade('a', { mat: 'iron', qty: 100, side: 'buy' });
  const jump = g.market.iron.price / p0;
  assert.ok(jump > 1, '사면 오르긴 한다');
  assert.ok(jump < 1.4, `100개를 사도 40% 안쪽으로만 오른다 (실제 ${Math.round((jump - 1) * 100)}%)`);

  // 튄 값은 기준가로 제법 빠르게 돌아온다
  run(g, 30);
  assert.ok(g.market.iron.price < p0 * jump, '시간이 지나면 되돌아온다');

  // 기준가는 수급에 따라 오르내릴 뿐 한 방향으로 흐르지 않는다.
  // 아무도 아무것도 안 지으면 원래 값 그대로여야 한다.
  const g2 = newGame(1000);
  run(g2, 300);
  for (const [key, m] of Object.entries(g2.market)) {
    if (!MATERIALS[key]) continue;
    assert.ok(
      Math.abs(m.baseline - MATERIALS[key].base) < MATERIALS[key].base * 0.15,
      `${MATERIALS[key].name} 기준가가 제자리를 지킨다 (${m.baseline.toFixed(1)} vs ${MATERIALS[key].base})`
    );
  }
  console.log(`✓ 자재 시세 안정 (100개 매수 시 +${Math.round((jump - 1) * 100)}%, 기준가는 제자리)`);
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

  // 창업자는 지분을 거의 안 들고 시작한다 (자기 주식이 승패를 좌우하지 않게)
  assert.strictEqual(a.shares.a, FOUNDER_SHARES);
  assert.ok(FOUNDER_SHARES <= TOTAL_SHARES * 0.2, '창업자 초기 지분은 소액');
  assert.strictEqual(g.availableShares('a'), INITIAL_FLOAT, '창업자 몫을 뺀 전량이 개장 즉시 나와 있다');
  assert.strictEqual(g.stocks.a.unissued, 0, '미발행 물량 없이 처음부터 전량 상장');

  // 조금 사면 주가가 오르고, 과반에 못 미치면 경영권은 안 넘어온다
  const p0 = g.stocks.b.price;
  assert.ok(g.stockTrade('a', { company: 'b', qty: 100, side: 'buy' }).ok);
  assert.strictEqual(a.shares.b, 100);
  assert.ok(g.stocks.b.price > p0, '매수하면 주가가 오른다');
  assert.strictEqual(g.controllerOf('b'), null, '과반에 못 미치면 경영권은 그대로');

  const need = TAKEOVER_SHARES - (a.shares.b || 0);
  assert.ok(g.availableShares('b') >= need, '개장 즉시 과반을 모을 물량이 있다');
  assert.ok(g.stockTrade('a', { company: 'b', qty: need, side: 'buy' }).ok);
  assert.strictEqual(a.shares.b, TAKEOVER_SHARES);
  assert.strictEqual(g.controllerOf('b').id, 'a', '과반을 모으면 경영권을 가져온다');

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

  // 과반을 넘기려면 물량이 상장될 때까지 기다려야 한다
  const need = TAKEOVER_SHARES - (a.shares.b || 0);
  let guard = 0;
  while (g.availableShares('b') < need && guard++ < 4000) run(g, 1);
  assert.ok(g.stockTrade('a', { company: 'b', qty: need, side: 'buy' }).ok);
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
