'use strict';

/*
 * 전략별 균형 점검: node test/balance.js [게임시간초] [반복]
 *
 * 같은 자금으로 각자 다른 전략만 파고들었을 때 얼마를 버는지 비교한다.
 * 자동 테스트가 아니라 수치를 눈으로 보고 조정하기 위한 도구다.
 */

const { Game, BUILDINGS, HITECH, PRODUCTS } = require('../src/game');

const DURATION = Number(process.argv[2]) || 600;
const RUNS = Number(process.argv[3]) || 5;
const START_CASH = 1000;

/** 전략마다 무엇을 어떤 순서로 지을지 */
const STRATEGIES = {
  기계: { sources: ['mine', 'rig'], mode: 'machine', sell: false },
  식품: { sources: ['farm'], mode: 'food', sell: false },
  반도체: { sources: ['mine', 'rig'], mode: 'semi', sell: true },
  임대: { sources: [], build: 'rental' },
  운송: { sources: [], build: 'depot' },
};

const emptyTile = (g, terrain) => g.map.tiles.findIndex((t) => t.t === terrain && !t.owner);

/** 돈이 되는 한 계속 짓는다. 재료가 모자라면 생산기지를, 남으면 공장을 세운다. */
function expand(g, id, plan) {
  const me = g.player(id);
  const mine = [];
  for (let i = 0; i < g.map.tiles.length; i++) {
    if (g.map.tiles[i].owner === id) mine.push({ idx: i, tile: g.map.tiles[i] });
  }

  // 임대·운송은 부지만 있으면 되므로 바로 짓는다
  if (plan.build) {
    const spec = BUILDINGS[plan.build];
    const idx = emptyTile(g, 'plain');
    if (idx >= 0 && me.cash >= 40 + spec.cost) {
      g.buyTile(id, idx);
      g.build(id, idx, plan.build);
      return true;
    }
    return false;
  }

  // 공장이 쓰는 재료와, 지금 캐는 양을 견줘 모자란 쪽부터 채운다
  const recipe = (HITECH[plan.mode] || PRODUCTS[plan.mode]).recipe;
  const need = {};
  const supply = {};
  for (const { tile } of mine) {
    if (tile.b === 'factory') {
      const rate = g.factoryRate(tile);
      for (const [k, n] of Object.entries(recipe)) need[k] = (need[k] || 0) + n * rate;
    } else if (tile.b && BUILDINGS[tile.b].out) {
      for (const [k, r] of Object.entries(g.buildingOutput(tile))) supply[k] = (supply[k] || 0) + r;
    }
  }

  let worst = null;
  for (const kind of plan.sources) {
    for (const k of Object.keys(BUILDINGS[kind].out)) {
      const d = need[k] || 0;
      if (d <= 0) continue;
      const ratio = (supply[k] || 0) / d;
      if (!worst || ratio < worst.ratio) worst = { kind, ratio };
    }
  }

  const tryBuild = (kind) => {
    const spec = BUILDINGS[kind];
    const idx = emptyTile(g, spec.on);
    if (idx < 0) return false;
    const price = { iron: 80, oil: 100, farm: 60, plain: 40 }[spec.on];
    if (me.cash < price + spec.cost) return false;
    g.buyTile(id, idx);
    g.build(id, idx, kind);
    if (kind === 'factory') g.setFactoryMode(id, idx, plan.mode);
    return true;
  };

  if (worst && worst.ratio < 1) return tryBuild(worst.kind);
  // 재료가 남아도는데도 공장 자리가 없으면 아무것도 안 짓는다.
  // (예전엔 여기서 생산기지를 더 지어서, 평지가 동난 뒤 쓰지도 않을 농장만
  //  30채씩 쌓였다 — 전략이 아니라 벤치마크가 만든 착시였다)
  return tryBuild('factory');
}

/** 도시를 골고루 나눠 배송해 한 도시 수요만 무너뜨리지 않게 한다 */
function spreadRoutes(g, id) {
  let k = 0;
  for (let i = 0; i < g.map.tiles.length; i++) {
    const t = g.map.tiles[i];
    if (t.owner !== id || t.b !== 'factory' || HITECH[t.mode]) continue;
    g.setRoute(id, i, k % g.cities.length);
    k++;
  }
}

function play() {
  const names = Object.keys(STRATEGIES);
  const g = new Game(
    names.map((n) => ({ id: n, name: n })),
    { startCash: START_CASH, duration: DURATION }
  );

  let sinceAct = 0;
  for (let t = 0; t < DURATION; t += 0.25) {
    g.tick(0.25);
    sinceAct += 0.25;
    if (sinceAct < 2.5) continue;
    sinceAct = 0;

    for (const name of names) {
      const plan = STRATEGIES[name];
      expand(g, name, plan);
      if (!plan.build) spreadRoutes(g, name);
      // 하이테크는 시장에 내다 팔아야 돈이 된다
      if (plan.sell) {
        const q = Math.floor(g.player(name).inv[plan.mode] || 0);
        if (q > 0) g.trade(name, { mat: plan.mode, qty: q, side: 'sell' });
      }
    }
  }
  return g;
}

const totals = {};
const stats = {};
let semiPrice = 0;
for (let r = 0; r < RUNS; r++) {
  const g = play();
  for (const name of Object.keys(STRATEGIES)) {
    const p = g.player(name);
    totals[name] = (totals[name] || 0) + g.netWorth(p);
    const s = stats[name] || (stats[name] = { buildings: 0, income: 0 });
    for (const t of g.map.tiles) if (t.owner === name && t.b) s.buildings += t.level || 1;
    s.income += p.incomePerSec;
  }
  semiPrice += g.market.semi.price;
}

const rows = Object.entries(totals)
  .map(([name, sum]) => ({
    name,
    worth: Math.round(sum / RUNS),
    lv: Math.round(stats[name].buildings / RUNS),
    inc: Math.round(stats[name].income / RUNS),
  }))
  .sort((a, b) => b.worth - a.worth);
const top = rows[0].worth;

console.log(`전략별 균형 (${DURATION}초 × ${RUNS}회 평균, 시작 자금 ${START_CASH})\n`);
console.log('  전략   순자산   비율  건물레벨  초당수익  레벨당수익');
for (const r of rows) {
  const per = r.lv ? (r.inc / r.lv).toFixed(2) : '-';
  console.log(
    `  ${r.name.padEnd(4)} ${String(r.worth).padStart(7)}  ${(r.worth / top).toFixed(2)}` +
      `   ${String(r.lv).padStart(6)}  ${String(r.inc).padStart(7)}  ${String(per).padStart(9)}`
  );
}
console.log(`\n  1위 대비 최하위 비율: ${(rows[rows.length - 1].worth / top).toFixed(2)}`);
console.log(`  반도체 종료 시세: ${Math.round(semiPrice / RUNS)} (기준 ${HITECH.semi.base})`);

/*
 * 왜 그런 결과가 나왔는지 보려면 마지막 한 판의 시장 상태를 들여다본다.
 * (수치가 이상할 때 "수요가 말라서" 인지 "시세가 무너져서" 인지 구분하는 용도)
 */
if (process.env.DETAIL) {
  const g = play();
  console.log('\n--- 마지막 판 시장 상태 ---');
  console.log('  도시 수요 (1.0 정상 / 0.35 바닥)');
  for (const c of g.cities) {
    console.log(`    ${c.name} 기계 ${c.demand.machine.toFixed(2)} · 식품 ${c.demand.food.toFixed(2)}`);
  }
  console.log(`  임대 수요배수 ${g.rentalDemand().toFixed(2)} · 공급 ${g.rentalSupply()}`);
  console.log(`  화물 수요 ${g.freightDemand().toFixed(2)} · 물류 공급 ${g.depotSupply()}`);
  console.log(`  반도체 시세 ${g.market.semi.price.toFixed(1)} / 기준 ${g.market.semi.base.toFixed(1)}`);
  const freePlain = g.map.tiles.filter((t) => t.t === 'plain' && !t.owner).length;
  console.log(`  남은 빈 평지 ${freePlain}칸 (공장·임대·운송이 모두 여기를 쓴다)`);
  console.log('  전략별 세부');
  for (const name of Object.keys(STRATEGIES)) {
    const p = g.player(name);
    const counts = {};
    for (const t of g.map.tiles) {
      if (t.owner === name && t.b) counts[t.b] = (counts[t.b] || 0) + (t.level || 1);
    }
    const comp = Object.entries(counts)
      .map(([k, n]) => `${BUILDINGS[k].name}${n}`)
      .join(' ');
    console.log(
      `    ${name.padEnd(4)} 순자산 ${String(g.netWorth(p)).padStart(7)} · 수익 ${p.incomePerSec
        .toFixed(1)
        .padStart(7)}/초 · 법인세 ${String((g.taxRate(p) * 100).toFixed(0)).padStart(2)}% · ${comp}`
    );
  }
}
