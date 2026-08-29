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
  if (tryBuild('factory')) return true;
  for (const kind of plan.sources) if (tryBuild(kind)) return true;
  return false;
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
