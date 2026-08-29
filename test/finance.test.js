'use strict';

/* 자산 매각 · 부동산 · 대출 · 공매도 · 사건 테스트: node test/finance.test.js */

const assert = require('assert');
const {
  Game, TILE_TYPES, BUILDINGS, MAX_SHORT, LOAN_INTEREST, LOAN_MIN_LIMIT, RESALE_RATE,
  TAKEOVER_SHARES, AUTO_BUY_RATE, AUTO_BUY_RESERVE,
  TOTAL_SHARES, FOUNDER_SHARES, INITIAL_FLOAT,
  BOND_INTEREST, MARKET_CRASH_MULT, MARKET_RALLY_MULT, COMPANY_SLUMP_MULT, COMPANY_BOOM_MULT,
  BLUE_CHIP_SHARES,
} = require('../src/game');

function newGame(startCash = 5000, duration = 600) {
  return new Game([{ id: 'a', name: '갑' }, { id: 'b', name: '을' }], { startCash, duration });
}
function run(game, seconds) {
  for (let t = 0; t < seconds; t += 0.25) game.tick(0.25);
}
/** 금리를 기준값에 고정한 채 돌린다 — 이자 계산 자체를 볼 때 쓴다 */
function runFixedRate(game, seconds) {
  for (let t = 0; t < seconds; t += 0.25) {
    game.tick(0.25);
    game.rateMult = 1;
  }
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
  g2.upgradeBuilding('a', f);
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

  assert.ok(g.borrow('a', 300).ok);
  assert.strictEqual(a.cash, 1300);
  assert.strictEqual(a.debt, 300);

  // 빌린 돈은 순자산을 늘리지 않는다 (현금 +300, 빚 -300)
  const g2 = newGame(1000);
  const worthBefore = g2.netWorth(g2.player('a'));
  g2.borrow('a', 300);
  assert.strictEqual(g2.netWorth(g2.player('a')), worthBefore, '대출은 순자산을 부풀리지 않는다');

  // 이자가 초당 빠져나간다 (금리 변동은 따로 보므로 여기선 기준값에 고정한다)
  const cashBefore = a.cash;
  runFixedRate(g, 10);
  const paid = cashBefore - a.cash;
  const expected = 300 * LOAN_INTEREST * 10;
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
  g3.borrow('a', 300);
  c.cash = 0;
  const d0 = c.debt;
  run(g3, 20);
  assert.ok(c.debt > d0, '못 갚은 이자는 빚으로 불어난다');
  assert.strictEqual(c.cash, 0, '없는 현금에서 더 빼가지 않는다');
  console.log(`✓ 대출 (이자 ${LOAN_INTEREST * 100}%/초, 미납분은 복리)`);
}

/* ---------------- 채권 ---------------- */
{
  const g = newGame(1000);
  const a = g.player('a');

  assert.ok(!g.buyBond('a', 2000).ok, '현금보다 많이는 못 산다');
  assert.ok(g.buyBond('a', 500).ok);
  assert.strictEqual(a.cash, 500);
  assert.strictEqual(a.bonds, 500);

  // 채권을 사도 순자산은 그대로다 (현금 -500, 채권 +500)
  const g2 = newGame(1000);
  const worthBefore = g2.netWorth(g2.player('a'));
  g2.buyBond('a', 500);
  assert.strictEqual(g2.netWorth(g2.player('a')), worthBefore, '채권은 순자산을 부풀리지 않는다');

  // 이자가 초당 원금에 붙는다 (복리). 금리 변동은 따로 보므로 기준값에 고정한다.
  const bondsBefore = a.bonds;
  runFixedRate(g, 10);
  const gained = a.bonds - bondsBefore;
  const expected = bondsBefore * BOND_INTEREST * 10;
  assert.ok(
    Math.abs(gained - expected) < expected * 0.05 + 0.01,
    `10초치 이자 ≈ ${expected.toFixed(2)} (실제 ${gained.toFixed(2)})`
  );
  assert.ok(BOND_INTEREST < LOAN_INTEREST, '채권 이율은 대출 이자보다 낮아야 빌려서 넣는 차익이 없다');

  // 현금화
  const cashBefore = a.cash;
  assert.ok(g.redeemBond('a', 200).ok);
  assert.strictEqual(a.cash, cashBefore + 200);
  assert.ok(g.redeemBond('a', 99999).ok, '가진 만큼만 현금화한다');
  assert.strictEqual(a.bonds, 0);
  assert.ok(!g.redeemBond('a', 100).ok, '채권이 없으면 거부');
  console.log(`✓ 채권 (이자 ${BOND_INTEREST * 100}%/초 복리, 대출보다 낮은 이율)`);
}

/* ---------------- 금리 변동 ---------------- */
{
  const g = newGame(1000, 1200);
  assert.strictEqual(g.rateMult, 1, '처음엔 기준 금리');

  let lo = g.loanRate();
  let hi = g.loanRate();
  for (let i = 0; i < 400; i++) {
    run(g, 1);
    lo = Math.min(lo, g.loanRate());
    hi = Math.max(hi, g.loanRate());
    // 어느 국면에서든 채권이 대출보다 싸야 "빌려서 채권 사기" 차익이 안 생긴다
    assert.ok(g.bondRate() < g.loanRate(), '채권 이자는 언제나 대출 이자보다 낮다');
  }
  const swing = (hi - lo) / LOAN_INTEREST;
  assert.ok(swing > 0.3, `금리가 실제로 오르내린다 (변동폭 기준금리의 ${(swing * 100).toFixed(0)}%)`);
  console.log(`✓ 금리 변동 (대출 ${(lo * 100).toFixed(2)}~${(hi * 100).toFixed(2)}%/초, 채권은 항상 그보다 낮음)`);
}

/* ---------------- 우량주 ---------------- */
{
  const g = newGame(100000, 1200);
  const a = g.player('a');
  const ids = Object.keys(g.blueChips);
  assert.strictEqual(ids.length, 2, '우량주는 두 종목');
  assert.ok(g.blueChips.nvidia, '엔비디아가 있다');

  for (const id of ids) {
    const s = g.blueChips[id];
    assert.strictEqual(s.float, BLUE_CHIP_SHARES, '처음부터 전량 상장돼 있다');
    assert.ok(BLUE_CHIP_SHARES > TOTAL_SHARES, '개별 회사보다 주식수가 많다');
  }

  // 시가총액이 판 전체 자금을 훨씬 웃돌아야 "얼마든지 묻어 둘 수 있는 곳" 이 된다
  const cap = g.blueChips.nvidia.price * BLUE_CHIP_SHARES;
  assert.ok(cap > 100000 * 10, `시총이 시작 자금보다 훨씬 크다 (${cap})`);

  // 매수 → 순자산은 그대로(현금이 주식으로 바뀔 뿐), 보유분은 shares 에 쌓인다
  const QTY = 20;
  const worthBefore = g.netWorth(a);
  const r = g.blueChipTrade('a', { chip: 'nvidia', qty: QTY, side: 'buy' });
  assert.ok(r.ok, '우량주를 살 수 있다');
  assert.strictEqual(a.shares.nvidia, QTY);
  assert.ok(Math.abs(g.netWorth(a) - worthBefore) < worthBefore * 0.02, '산 직후 순자산이 크게 안 변한다');

  // 같은 수량을 사도 개별 회사 주식보다 시세가 훨씬 덜 밀린다 — 이게 우량주의 핵심
  const g2 = newGame(1000000, 1200);
  const bcBefore = g2.blueChips.nvidia.price;
  g2.blueChipTrade('a', { chip: 'nvidia', qty: 200, side: 'buy' });
  const bcJump = g2.blueChips.nvidia.price / bcBefore;
  const g3 = newGame(1000000, 1200);
  const stBefore = g3.stocks.b.price;
  g3.stockTrade('a', { company: 'b', qty: 200, side: 'buy' });
  const stJump = g3.stocks.b.price / stBefore;
  assert.ok(
    bcJump < stJump,
    `같은 수량이면 우량주가 훨씬 덜 밀린다 (우량주 ${bcJump.toFixed(3)}배 vs 개별 ${stJump.toFixed(3)}배)`
  );

  // 매도로 되판다
  assert.ok(g.blueChipTrade('a', { chip: 'nvidia', qty: QTY, side: 'sell' }).ok);
  assert.ok(!a.shares.nvidia, '다 팔면 보유분이 사라진다');
  assert.ok(!g.blueChipTrade('a', { chip: 'nvidia', qty: 1, side: 'sell' }).ok, '없으면 못 판다');
  assert.ok(!g.blueChipTrade('a', { chip: 'nope', qty: 1, side: 'buy' }).ok, '없는 종목은 거부');
  console.log(`✓ 우량주 (${ids.length}종목 × ${BLUE_CHIP_SHARES}주 전량 상장, 순자산에 시가로 반영)`);
}

/* ---------------- 누진 법인세 ---------------- */
{
  const g = newGame(1000, 1200);
  const a = g.player('a');

  // 수익이 없으면 세금도 없다
  a.incomePerSec = 0;
  assert.strictEqual(g.taxRate(a), 0, '수익이 없으면 세금도 없다');

  // 많이 벌수록 세율이 오른다 (누진)
  let prev = 0;
  for (const inc of [10, 50, 100, 300, 1000]) {
    a.incomePerSec = inc;
    const rate = g.taxRate(a);
    assert.ok(rate > prev, `수익이 늘면 세율도 오른다 (${inc}/초 → ${(rate * 100).toFixed(0)}%)`);
    assert.ok(rate < 1, '세율이 100% 에 닿지 않아야 더 버는 게 손해가 안 된다');
    prev = rate;
  }

  // 실제로 매출에서 떼인다 — 세금은 누구에게도 안 가고 판에서 사라진다
  a.incomePerSec = 500; // 고세율 구간
  const rate = g.taxRate(a);
  assert.ok(rate > 0.4, `고수익이면 세율이 충분히 높다 (${(rate * 100).toFixed(0)}%)`);
  const cash0 = a.cash;
  g.payIncome(a, 1000);
  const got = a.cash - cash0;
  assert.ok(Math.abs(got - 1000 * (1 - rate)) < 1, `세후만 들어온다 (${got.toFixed(0)} / 세전 1000)`);

  // 적자는 세금을 매기지 않는다 (그대로 빠져나간다)
  const cash1 = a.cash;
  g.payIncome(a, -100);
  assert.ok(Math.abs(a.cash - cash1 + 100) < 0.01, '적자에는 세금을 매기지 않는다');

  // 잘 버는 쪽이 더 많이 낸다 — 격차가 무한정 벌어지지 않게 하는 게 목적
  const small = g.player('b');
  small.incomePerSec = 10;
  assert.ok(g.taxRate(small) < g.taxRate(a) / 3, '작은 회사는 거의 안 걷힌다');
  console.log(
    `✓ 누진 법인세 (10/초 → ${(g.taxRate(small) * 100).toFixed(0)}% · 500/초 → ${(rate * 100).toFixed(0)}%)`
  );
}

/* ---------------- 한국중공업 주가가 기계 판매가를 끌어올린다 ---------------- */
{
  const g = newGame(1000, 1200);
  const idx = g.map.tiles.findIndex((t) => t.t === 'plain' && !t.owner);
  g.buyTile('a', idx);
  g.build('a', idx, 'factory');

  const at = (mult) => {
    g.blueChips.heavy.price = g.blueChips.heavy.baseline * mult;
    return g.quoteRoute(idx, 0, 'machine').revenue;
  };
  const flat = at(1);
  const boom = at(2);
  const bust = at(0.5);
  assert.ok(boom > flat * 1.5, `한국중공업이 뛰면 기계 매출도 오른다 (${flat} → ${boom})`);
  assert.ok(bust < flat * 0.7, `가라앉으면 기계 매출도 준다 (${flat} → ${bust})`);

  // 배수는 상하한이 있어 판매가가 몇 배로 튀지는 않는다
  g.blueChips.heavy.price = g.blueChips.heavy.baseline * 100;
  assert.ok(g.demandMult('machine') <= 2.001, '전방 수요 배수에 상한이 있다');
  g.blueChips.heavy.price = g.blueChips.heavy.baseline * 0.01;
  assert.ok(g.demandMult('machine') >= 0.5, '하한도 있다');

  // 우량주가 대변하지 않는 품목은 영향을 안 받는다
  assert.strictEqual(g.demandMult('food'), 1, '식품은 연동 대상이 아니다');
  console.log(`✓ 한국중공업 → 기계 수요 연동 (폭락 ${bust} / 제자리 ${flat} / 폭등 ${boom})`);
}

/* ---------------- 엔비디아 주가가 반도체 수요를 끌어올린다 ---------------- */
{
  const measure = (mult) => {
    const g = newGame(1000, 1200);
    for (let t = 0; t < 200; t += 0.25) {
      g.tick(0.25);
      g.blueChips.nvidia.price = g.blueChips.nvidia.baseline * mult; // 원하는 국면으로 고정
      g.market.semi.vol = 1; // 랜덤 변동은 끄고 수요 효과만 본다
    }
    return g.market.semi.baseline;
  };

  const boom = measure(2);
  const flat = measure(1);
  const bust = measure(0.5);
  assert.ok(boom > flat * 1.5, `엔비디아가 뛰면 반도체 기준가도 오른다 (${flat.toFixed(0)} → ${boom.toFixed(0)})`);
  assert.ok(bust < flat * 0.7, `엔비디아가 가라앉으면 반도체도 눌린다 (${flat.toFixed(0)} → ${bust.toFixed(0)})`);
  console.log(
    `✓ 엔비디아 → 반도체 수요 연동 (폭락 ${bust.toFixed(0)} / 제자리 ${flat.toFixed(0)} / 폭등 ${boom.toFixed(0)})`
  );
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
  // 미발행 물량이 상장되어 인수선을 넘길 만큼 나온 상황을 만든다
  g.stocks.b.float += g.stocks.b.unissued;
  g.stocks.b.unissued = 0;
  const total = g.availableShares('b');
  assert.ok(total >= TAKEOVER_SHARES, '상장이 끝나면 과반을 모을 물량이 나온다');

  // 외부 투자자가 물량을 대부분 사가도, 사람은 그들에게서 되사 올 수 있어야 한다
  g.stocks.b.npc = total - 5;
  g.stocks.b.float = 5;
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

/* ---------------- 즉시 전량 상장 + 외인·기관 거래 ---------------- */
{
  const g = newGame(1000, 600);
  const s = g.stocks.a;

  // 개장과 동시에 창업자 몫을 뺀 전량이 시장에 나와 있다
  assert.strictEqual(s.float, INITIAL_FLOAT);
  assert.strictEqual(s.unissued, 0, '미발행 물량 없이 처음부터 전량 상장');
  assert.strictEqual(s.float + FOUNDER_SHARES, TOTAL_SHARES, '주식 총수가 맞는다');
  assert.ok(g.availableShares('a') >= TAKEOVER_SHARES, '개장 즉시 과반을 모을 물량이 있다');

  // 외인·기관이 계속 사고판다.
  // 체결은 확률적이라 특정 1초가 비어 있을 수 있으므로 여러 초를 지켜본다.
  let peakVolume = 0;
  let peakNpc = 0;
  for (let i = 0; i < 60; i++) {
    run(g, 1);
    peakVolume = Math.max(peakVolume, s.volume);
    peakNpc = Math.max(peakNpc, s.npc);
  }
  assert.ok(peakVolume > 0, '외인·기관이 거래한다');
  assert.ok(peakNpc > 0, '물량이 시장에서 오간다 (외인·기관이 들고 있던 구간이 있다)');

  // 총수는 언제나 보존된다
  const total1 = s.float + s.npc + s.unissued + (g.player('a').shares.a || 0);
  assert.strictEqual(total1, TOTAL_SHARES, '거래가 오가도 주식 총수는 그대로');
  console.log(`✓ 즉시 전량 상장 + 외인·기관 거래 (최대 초당 ${peakVolume}주)`);
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
  } else if (fired.kind === 'market-crash' || fired.kind === 'market-rally') {
    assert.notStrictEqual(g.marketMult, 1, '사건 중에는 전체 주가 배수가 바뀐다');
  } else if (fired.kind === 'company-slump' || fired.kind === 'company-boom') {
    assert.notStrictEqual(g.stocks[fired.target].eventMult, 1, '사건 중에는 그 회사 주가 배수가 바뀐다');
  } else {
    assert.notStrictEqual(g.cities[fired.target].boost, 1, '사건 중에는 도시 가격 배수가 바뀐다');
  }

  // 사건이 끝나면 원래대로 돌아온다
  for (let t = 0; t < 200 && g.event; t += 0.25) g.tick(0.25);
  assert.strictEqual(g.event, null, '사건은 언젠가 끝난다');
  for (const m of Object.values(g.market)) {
    // 하이테크는 기준가 자체가 계속 출렁이므로(반올림 오차만큼) 근사 비교한다
    assert.ok(Math.abs(m.base - m.baseline) < 0.01, '기준가가 원래대로 돌아온다 (eventMult 해제)');
  }
  for (const c of g.cities) assert.strictEqual(c.boost, 1, '도시 배수도 원래대로');
  assert.strictEqual(g.marketMult, 1, '전체 주가 배수도 원래대로');
  for (const s of Object.values(g.stocks)) assert.strictEqual(s.eventMult, 1, '회사별 주가 배수도 원래대로');
  console.log(`✓ 사건 (${fired.icon} ${fired.text})`);
}

/* ---------------- 금융위기 / 랠리 (주식시장 전체 사건) ---------------- */
{
  const g = newGame(5000, 1200);
  for (const s of Object.values(g.stocks)) s.mood = 1; // 개별 편차를 없애 비교를 쉽게 한다

  // 확률적으로 뽑히므로 원하는 종류가 나올 때까지 다시 뽑는다
  let fired = null;
  for (let i = 0; i < 300 && !fired; i++) {
    g.startEvent();
    if (g.event.kind === 'market-crash') fired = g.event;
    else g.endEvent();
  }
  assert.ok(fired, '금융위기 사건을 뽑을 수 있어야 한다');
  assert.ok(fired.mult >= MARKET_CRASH_MULT[0] && fired.mult <= MARKET_CRASH_MULT[1], '위기 배수가 정해진 범위 안');
  assert.ok(Math.abs(g.marketMult - fired.mult) < 0.01, '전체 배수에 즉시 반영된다 (표시값은 반올림)');

  // 예고 없이 전 종목이 동시에 눌린다
  const before = {};
  for (const [id, s] of Object.entries(g.stocks)) before[id] = s.price;
  run(g, 15);
  for (const [id, s] of Object.entries(g.stocks)) {
    assert.ok(s.price < before[id], `${id} 주가도 위기 중엔 함께 눌린다 (보유만 하고 있어도 안전하지 않다)`);
  }

  g.endEvent();
  assert.strictEqual(g.marketMult, 1, '위기가 끝나면 배수가 원래대로 돌아온다');

  // 랠리(상승)보다 위기(하락) 쪽 폭이 커야, 그냥 들고 버티는 게 유리해지지 않는다
  assert.ok(
    1 - MARKET_CRASH_MULT[0] > MARKET_RALLY_MULT[1] - 1,
    '하락 쪽 최대 낙폭이 상승 쪽 최대 상승폭보다 커야 한다'
  );
  console.log(`✓ 금융위기/랠리 (위기 시 전 종목 동시에 ${Math.round((1 - fired.mult) * 100)}% 급락)`);
}

/* ---------------- 실적 부진 / 호조 (회사 하나만 겨냥한 사건) ---------------- */
{
  const g = newGame(5000, 1200);
  for (const s of Object.values(g.stocks)) s.mood = 1; // 개별 편차를 없애 비교를 쉽게 한다

  let fired = null;
  for (let i = 0; i < 300 && !fired; i++) {
    g.startEvent();
    if (g.event.kind === 'company-slump') fired = g.event;
    else g.endEvent();
  }
  assert.ok(fired, '실적 부진 사건을 뽑을 수 있어야 한다');
  assert.ok(g.stocks[fired.target], '특정 회사를 겨냥한다');
  assert.ok(
    fired.mult >= COMPANY_SLUMP_MULT[0] && fired.mult <= COMPANY_SLUMP_MULT[1],
    '부진 배수가 정해진 범위 안'
  );
  assert.strictEqual(g.stocks[fired.target].eventMult, fired.mult, '그 회사에만 즉시 반영된다');

  // 겨냥한 회사만 눌리고, 나머지는 이 사건과 무관하다
  const before = {};
  for (const [id, s] of Object.entries(g.stocks)) before[id] = s.price;
  run(g, 15);
  assert.ok(g.stocks[fired.target].price < before[fired.target], '겨냥한 회사 주가는 떨어진다');
  for (const [id, s] of Object.entries(g.stocks)) {
    if (id === fired.target) continue;
    assert.strictEqual(s.eventMult, 1, `${id} 는 이 사건의 영향을 받지 않는다`);
  }

  g.endEvent();
  assert.strictEqual(g.stocks[fired.target].eventMult, 1, '사건이 끝나면 배수가 원래대로 돌아온다');

  // 호조(상승)보다 부진(하락) 쪽 폭이 커야, 공매도할 진짜 기회가 된다
  assert.ok(
    1 - COMPANY_SLUMP_MULT[0] > COMPANY_BOOM_MULT[1] - 1,
    '부진 쪽 최대 낙폭이 호조 쪽 최대 상승폭보다 커야 한다'
  );
  console.log(`✓ 실적 부진/호조 (겨냥한 회사만 ${Math.round((1 - fired.mult) * 100)}% 하락, 나머지는 무관)`);
}

console.log('\n금융/부동산 테스트 전부 통과!');
