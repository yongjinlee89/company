'use strict';

/* 자산 매각 · 부동산 · 대출 · 공매도 · 사건 테스트: node test/finance.test.js */

const assert = require('assert');
const {
  Game, TILE_TYPES, BUILDINGS, MAX_SHORT, LOAN_INTEREST, LOAN_MIN_LIMIT, RESALE_RATE,
  TAKEOVER_SHARES, AUTO_BUY_RATE, AUTO_BUY_RESERVE,
} = require('../src/game');

function newGame(startCash = 5000, duration = 600) {
  return new Game([{ id: 'a', name: '갑' }, { id: 'b', name: '을' }], { startCash, duration });
}
function run(game, seconds) {
  for (let t = 0; t < seconds; t += 0.25) game.tick(0.25);
}
const findTile = (g, type) => g.map.tiles.findIndex((t) => t.t === type && !t.owner);

/* ---------------- 자산 매각 ---------------- */
{
  const g = newGame();
  const a = g.player('a');
  const idx = findTile(g, 'iron');

  g.buyTile('a', idx);
  g.build('a', idx, 'mine');
  const spent = TILE_TYPES.iron.price + BUILDINGS.mine.cost;
  const before = a.cash;

  const value = g.tileValue(idx);
  assert.strictEqual(value, Math.round(TILE_TYPES.iron.price + BUILDINGS.mine.cost * RESALE_RATE));
  assert.ok(value < spent, '건물값은 일부만 돌려받는다');

  assert.ok(g.sellTile('a', idx).ok);
  assert.strictEqual(a.cash, before + value);
  const tile = g.map.tiles[idx];
  assert.strictEqual(tile.owner, null, '판 땅은 주인이 없어진다');
  assert.strictEqual(tile.b, null, '건물도 함께 사라진다');
  assert.strictEqual(tile.t, 'iron', '지형은 그대로 남아 다시 살 수 있다');
  assert.ok(g.buyTile('b', idx).ok, '판 땅은 남이 살 수 있다');

  // 남의 땅은 못 판다
  assert.ok(!g.sellTile('a', idx).ok);

  // 증설한 공장도 증설비를 반영해 값이 오른다
  const g2 = newGame();
  const f = findTile(g2, 'plain');
  g2.buyTile('a', f);
  g2.build('a', f, 'factory');
  const v1 = g2.tileValue(f);
  g2.upgradeFactory('a', f);
  assert.ok(g2.tileValue(f) > v1, '증설하면 매각가도 오른다');
  console.log(`✓ 자산 매각 (광산 ${spent} 투자 → ${value} 회수)`);
}

/* ---------------- 부동산 (플레이어 간 거래) ---------------- */
{
  const g = newGame();
  const a = g.player('a');
  const b = g.player('b');
  const idx = findTile(g, 'oil');

  g.buyTile('a', idx);
  g.build('a', idx, 'rig');

  // 아직 매물이 아니면 못 산다
  assert.ok(!g.buyListedTile('b', idx).ok);

  assert.ok(g.listTile('a', idx, 400).ok);
  assert.strictEqual(g.map.tiles[idx].listPrice, 400);
  assert.ok(!g.listTile('b', idx, 100).ok, '남의 땅은 못 내놓는다');
  assert.ok(!g.buyListedTile('a', idx).ok, '내 매물은 내가 못 산다');

  const aCash = a.cash;
  const bCash = b.cash;
  assert.ok(g.buyListedTile('b', idx).ok);
  assert.strictEqual(g.map.tiles[idx].owner, 'b', '소유권이 넘어간다');
  assert.strictEqual(g.map.tiles[idx].b, 'rig', '건물째로 넘어간다');
  assert.strictEqual(g.map.tiles[idx].listPrice, null, '매물에서 내려간다');
  assert.strictEqual(a.cash, aCash + 400, '판 사람이 돈을 받는다');
  assert.strictEqual(b.cash, bCash - 400, '산 사람이 돈을 낸다');

  // 넘어간 시추소는 새 주인에게 생산해 준다
  const bIron = b.inv.oil;
  run(g, 10);
  assert.ok(b.inv.oil > bIron, '새 주인이 생산물을 받는다');

  // 매물 내리기
  g.listTile('b', idx, 900);
  assert.ok(g.unlistTile('b', idx).ok);
  assert.strictEqual(g.map.tiles[idx].listPrice, null);

  // 현금이 모자라면 못 산다
  const g2 = newGame();
  const i2 = findTile(g2, 'farm');
  g2.buyTile('a', i2);
  g2.listTile('a', i2, 99999);
  assert.ok(!g2.buyListedTile('b', i2).ok);
  console.log('✓ 부동산 (매물 등록 → 타 회사가 건물째 인수)');
}

/* ---------------- 대출 ---------------- */
{
  const g = newGame(1000);
  const a = g.player('a');

  const limit = g.creditLimit(a);
  assert.ok(limit >= LOAN_MIN_LIMIT, `자산이 적어도 최소 ${LOAN_MIN_LIMIT} 은 빌릴 수 있다`);
  assert.ok(!g.borrow('a', limit + 1).ok, '한도를 넘으면 거부');

  assert.ok(g.borrow('a', 500).ok);
  assert.strictEqual(a.cash, 1500);
  assert.strictEqual(a.debt, 500);

  // 빌린 돈은 순자산을 늘리지 않는다 (현금 +500, 빚 -500)
  const g2 = newGame(1000);
  const worthBefore = g2.netWorth(g2.player('a'));
  g2.borrow('a', 500);
  assert.strictEqual(g2.netWorth(g2.player('a')), worthBefore, '대출은 순자산을 부풀리지 않는다');

  // 이자가 초당 빠져나간다
  const cashBefore = a.cash;
  run(g, 10);
  const paid = cashBefore - a.cash;
  const expected = 500 * LOAN_INTEREST * 10;
  assert.ok(Math.abs(paid - expected) < expected * 0.05, `10초치 이자 ≈ ${expected.toFixed(2)} (실제 ${paid.toFixed(2)})`);

  // 상환
  const debtBefore = a.debt;
  assert.ok(g.repay('a', 200).ok);
  assert.ok(a.debt < debtBefore - 199);
  assert.ok(g.repay('a', 99999).ok, '가진 만큼만 갚는다');
  assert.strictEqual(a.debt, 0);
  assert.ok(!g.repay('a', 100).ok, '빚이 없으면 거부');

  // 현금이 없으면 이자가 원금에 붙는다 (복리)
  const g3 = newGame(1000);
  const c = g3.player('a');
  g3.borrow('a', 600);
  c.cash = 0;
  const d0 = c.debt;
  run(g3, 20);
  assert.ok(c.debt > d0, '못 갚은 이자는 빚으로 불어난다');
  assert.strictEqual(c.cash, 0, '없는 현금에서 더 빼가지 않는다');
  console.log(`✓ 대출 (이자 ${LOAN_INTEREST * 100}%/초, 미납분은 복리)`);
}

/* ---------------- 공매도 ---------------- */
{
  const g = newGame(100000);
  const a = g.player('a');

  assert.ok(!g.shortSell('a', 'a', 10).ok, '자기 회사는 공매도 불가');
  assert.ok(!g.shortSell('a', 'b', MAX_SHORT + 1).ok, `회사당 ${MAX_SHORT}주까지`);

  const price0 = g.stocks.b.price;
  const cash0 = a.cash;
  const r = g.shortSell('a', 'b', 20);
  assert.ok(r.ok);
  assert.strictEqual(g.shortShares(a, 'b'), 20);
  assert.strictEqual(a.cash, cash0 + r.proceeds, '판 돈이 먼저 들어온다');
  assert.ok(g.stocks.b.price < price0, '공매도하면 주가가 내려간다');

  // 주가가 내려가면 이득
  const beforeDrop = g.netWorth(a);
  g.stocks.b.price = g.stocks.b.price * 0.5;
  assert.ok(g.netWorth(a) > beforeDrop, '주가가 내리면 순자산이 는다');

  // 주가가 오르면 손해
  g.stocks.b.price = g.stocks.b.price * 4;
  assert.ok(g.netWorth(a) < beforeDrop, '주가가 오르면 순자산이 준다');

  // 환매
  g.stocks.b.price = r.proceeds / 20 / 2; // 절반 값에 되산다
  const cover = g.coverShort('a', 'b', 20);
  assert.ok(cover.ok);
  assert.ok(cover.profit > 0, `싸게 되사면 이익 (${cover.profit})`);
  assert.strictEqual(g.shortShares(a, 'b'), 0, '잔고가 정리된다');
  assert.ok(!g.coverShort('a', 'b', 1).ok, '잔고가 없으면 거부');

  // 비싸게 되사면 손해
  const g2 = newGame(100000);
  const r2 = g2.shortSell('a', 'b', 10);
  g2.stocks.b.price = (r2.proceeds / 10) * 3;
  const bad = g2.coverShort('a', 'b', 10);
  assert.ok(bad.ok && bad.profit < 0, '비싸게 되사면 손해');

  // 증거금이 없으면 못 건다
  const g3 = newGame(100000);
  g3.player('a').cash = 1;
  assert.ok(!g3.shortSell('a', 'b', 20).ok, '증거금 부족 시 거부');
  console.log('✓ 공매도 (하락 시 이익 / 상승 시 손실, 순자산에 부채로 반영)');
}

/* ---------------- 주식 물량 (외부 투자자가 있어도 인수 가능) ---------------- */
{
  const g = newGame(1000000);
  // 외부 투자자가 물량을 대부분 사가도, 사람은 그들에게서 되사 올 수 있어야 한다
  const total = g.stocks.b.float;
  g.stocks.b.float = 5;
  g.stocks.b.npc = total - 5;
  assert.strictEqual(g.availableShares('b'), total);

  assert.ok(
    g.stockTrade('a', { company: 'b', qty: TAKEOVER_SHARES, side: 'buy' }).ok,
    '외부 투자자에게서도 살 수 있다'
  );
  assert.strictEqual(g.player('a').shares.b, TAKEOVER_SHARES);
  assert.ok(g.controllerOf('b'), '경영권 인수가 여전히 가능하다');
  assert.strictEqual(g.controllerOf('b').id, 'a');
  assert.strictEqual(g.stocks.b.float + g.stocks.b.npc, total - TAKEOVER_SHARES, '물량 회계가 맞는다');
  assert.ok(g.stocks.b.npc >= 0 && g.stocks.b.float >= 0, '물량이 음수가 되지 않는다');
  console.log('✓ 주식 물량 회계 (외부 투자자 보유분도 매수 가능)');
}

/* ---------------- 자재 수량 유지 (자동 매수) ---------------- */
{
  const g = newGame(50000);
  const a = g.player('a');

  assert.ok(!g.setAutoBuy('a', 'nope', 10).ok, '없는 자재는 거부');
  assert.ok(!g.setAutoBuy('a', 'iron', -1).ok, '음수는 거부');
  assert.ok(g.setAutoBuy('a', 'iron', 60).ok);
  assert.strictEqual(a.autoBuy.iron, 60);

  // 1초마다 조금씩 채워 넣는다 (한 번에 몰아사서 시세를 밀어올리지 않게)
  run(g, 1.1);
  assert.ok(a.inv.iron > 0, '모자라면 알아서 사 온다');
  assert.ok(a.inv.iron <= AUTO_BUY_RATE + 0.01, `1초에 ${AUTO_BUY_RATE}개까지만 산다 (실제 ${a.inv.iron})`);

  // 목표치까지 채우면 멈춘다
  run(g, 10);
  assert.ok(Math.abs(a.inv.iron - 60) < 1.01, `목표 60 근처에서 멈춘다 (실제 ${a.inv.iron})`);
  const settled = a.inv.iron;
  const cash = a.cash;
  run(g, 5);
  assert.ok(Math.abs(a.inv.iron - settled) < 0.01, '목표에 도달하면 더 사지 않는다');
  assert.strictEqual(a.cash, cash, '돈도 더 쓰지 않는다');

  // 공장이 재료를 쓰면 다시 채워 준다 — 이게 이 기능의 목적
  const idx = findTile(g, 'plain');
  g.buyTile('a', idx);
  g.build('a', idx, 'factory');
  g.setAutoBuy('a', 'oil', 40);
  run(g, 30);
  const tile = g.map.tiles[idx];
  assert.ok(!tile.idle, '공장이 재료 부족으로 멈추지 않는다');
  assert.ok(a.inv.iron > 30 && a.inv.oil > 20, '소비되는 재료가 계속 채워진다');

  // 끄면 더 이상 사지 않는다
  assert.ok(g.setAutoBuy('a', 'iron', 0).ok);
  a.inv.iron = 0;
  run(g, 3);
  assert.ok(a.inv.iron < 1, '0으로 두면 자동 매수가 꺼진다');

  // 현금이 말라도 운영자금은 남긴다 (자동 매수가 회사를 빈털터리로 만들지 않게)
  const g2 = newGame(50000);
  const b2 = g2.player('a');
  g2.setAutoBuy('a', 'grain', 5000);
  b2.cash = 2000;
  run(g2, 40);
  assert.ok(b2.cash >= AUTO_BUY_RESERVE - 40, `운영자금을 남긴다 (남은 현금 ${Math.round(b2.cash)})`);
  assert.ok(b2.inv.grain > 50, '그래도 살 수 있는 만큼은 사 온다');
  console.log(`✓ 자재 수량 유지 (초당 ${AUTO_BUY_RATE}개까지 자동 매수)`);
}

/* ---------------- 주가가 오르내린다 ---------------- */
{
  const g = newGame(1000);
  const a = g.player('a');
  // 회사를 계속 키우면서 주가를 지켜본다
  const idx = findTile(g, 'plain');
  g.buyTile('a', idx);
  g.build('a', idx, 'factory');
  a.inv.iron = 100000;
  a.inv.oil = 100000;

  let peak = g.stocks.a.price;
  let maxDrop = 0;
  let downTicks = 0;
  let prev = peak;
  for (let t = 0; t < 240; t += 0.25) {
    g.tick(0.25);
    const p = g.stocks.a.price;
    if (p < prev) downTicks++;
    peak = Math.max(peak, p);
    maxDrop = Math.max(maxDrop, (peak - p) / peak);
    prev = p;
  }
  assert.ok(downTicks > 100, '주가가 내려가는 구간이 충분히 있어야 한다');
  assert.ok(maxDrop > 0.1, `고점 대비 10% 넘는 조정이 있어야 한다 (실제 ${(maxDrop * 100).toFixed(1)}%)`);
  console.log(`✓ 주가 변동 (최대 낙폭 ${(maxDrop * 100).toFixed(1)}%)`);
}

/* ---------------- 사건 ---------------- */
{
  const g = newGame(1000, 1200);
  assert.strictEqual(g.event, null, '처음엔 사건이 없다');

  // 사건이 일어날 때까지 돌린다
  let fired = null;
  for (let t = 0; t < 400 && !fired; t += 0.25) {
    g.tick(0.25);
    if (g.event) fired = g.event;
  }
  assert.ok(fired, '시간이 지나면 사건이 일어난다');
  assert.ok(fired.text && fired.icon, '사건에 설명이 붙는다');

  if (fired.kind === 'mat-up' || fired.kind === 'mat-down') {
    const m = g.market[fired.target];
    assert.notStrictEqual(m.base, m.baseline, '사건 중에는 기준가가 바뀐다');
    if (fired.kind === 'mat-up') assert.ok(m.base > m.baseline);
    else assert.ok(m.base < m.baseline);
    // 가격이 실제로 새 기준가를 따라간다
    const before = m.price;
    run(g, 15);
    assert.ok(fired.kind === 'mat-up' ? m.price > before : m.price < before, '시세가 사건을 따라 움직인다');
  } else {
    assert.notStrictEqual(g.cities[fired.target].boost, 1, '사건 중에는 도시 가격 배수가 바뀐다');
  }

  // 사건이 끝나면 원래대로 돌아온다
  for (let t = 0; t < 200 && g.event; t += 0.25) g.tick(0.25);
  assert.strictEqual(g.event, null, '사건은 언젠가 끝난다');
  for (const m of Object.values(g.market)) {
    assert.strictEqual(m.base, m.baseline, '기준가가 원래대로 돌아온다');
  }
  for (const c of g.cities) assert.strictEqual(c.boost, 1, '도시 배수도 원래대로');
  console.log(`✓ 사건 (${fired.icon} ${fired.text})`);
}

console.log('\n금융/부동산 테스트 전부 통과!');
