'use strict';

/**
 * 컴퓨터 플레이어(AI) — 실시간판.
 *
 * 사람과 똑같이 Game 의 공개 메서드만 호출한다. (규칙 검증을 그대로 통과해야 하므로
 * 봇이 반칙을 할 수 없고, 게임 규칙이 바뀌어도 봇이 따로 깨지지 않는다)
 *
 * Room 이 몇 초에 한 번씩 think() 를 불러 주고, 한 번 부를 때마다 이렇게 판단한다:
 *   배송 노선 점검 → 잉여 자재 매도 → 건물 하나 짓기 → 부족한 재료 매수 → 주식
 */

const {
  MATERIALS,
  PRODUCTS,
  HITECH,
  MAKEABLE,
  BUILDINGS,
  RESEARCH,
  TILE_TYPES,
  TOTAL_SHARES,
  TAKEOVER_SHARES,
  MAX_SHORT,
  INCOME_MULTIPLE,
  chebyshev,
} = require('./game');

// 주력 제품별로 필요한 원자재 생산 건물
const FOCUS_SOURCES = {
  machine: ['mine', 'rig'],
  food: ['farm'],
};

const INPUT_BUFFER_SEC = 30; // 재료를 몇 초치까지 채워 둘지
const SURPLUS_SEC = 90; // 몇 초치를 넘는 재고는 내다 판다

/* ------------------------------------------------------------------ 도우미 */

function nearestCityDist(game, idx) {
  const x = idx % game.map.w;
  const y = Math.floor(idx / game.map.w);
  let best = Infinity;
  for (const c of game.cities) best = Math.min(best, chebyshev(x, y, c.x, c.y));
  return best;
}

function myTiles(game, id) {
  const out = [];
  for (let i = 0; i < game.map.tiles.length; i++) {
    if (game.map.tiles[i].owner === id) out.push({ idx: i, tile: game.map.tiles[i] });
  }
  return out;
}

/** 내 공장들이 초당 소비하는 재료 양 (증설 레벨 반영) */
function inputNeed(game, me) {
  const need = {};
  for (const { tile } of myTiles(game, me.id)) {
    if (tile.b !== 'factory') continue;
    const rate = game.factoryRate(tile);
    const eff = game.researchMult(me, 'efficiency'); // 공정 효율만큼 덜 쓴다
    for (const [k, n] of Object.entries(MAKEABLE[tile.mode || 'machine'].recipe)) {
      need[k] = (need[k] || 0) + n * eff * rate;
    }
  }
  return need;
}

function pickFocus(game) {
  // 식품 쪽이 초기 비용이 싸다(농장 하나면 됨). 시작 자금이 빠듯하면 식품부터.
  if (game.settings.startCash <= 500) return 'food';
  return Math.random() < 0.5 ? 'machine' : 'food';
}

/* ------------------------------------------------------------------ 행동 */

/**
 * 공장마다 초당 순이익이 가장 큰 도시로 노선을 잡는다.
 * 수요는 계속 변하므로 매번 다시 계산해 더 나은 곳이 있으면 갈아탄다.
 */
function checkRoutes(game, me) {
  let changed = false;
  for (const { idx, tile } of myTiles(game, me.id)) {
    if (tile.b !== 'factory') continue;
    const mode = tile.mode || 'machine';
    const best = game.bestRoute(idx, mode);
    if (!best) continue;
    if (tile.route === best.city) continue;
    // 지금 노선보다 확실히 나을 때만 옮긴다 (수요가 출렁일 때마다 흔들리지 않게)
    const now = tile.route === null ? null : game.quoteRoute(idx, tile.route, mode);
    if (!now || best.net > now.net * 1.1) {
      if (game.setRoute(me.id, idx, best.city).ok) changed = true;
    }
  }
  return changed;
}

/**
 * 공장이 쓰고 남을 자재는 시세가 괜찮을 때 팔아 현금화한다.
 * 하이테크 제품은 도시로 안 가고 시장에서만 팔리므로 쌓이는 대로 내다 판다.
 */
function sellSurplus(game, me) {
  const need = inputNeed(game, me);
  for (const key of Object.keys(game.market)) {
    const keep = (need[key] || 0) * SURPLUS_SEC;
    const extra = Math.floor((me.inv[key] || 0) - keep);
    if (extra < 1) continue;
    const m = game.market[key];
    // 원자재는 제값 받을 때만, 하이테크는 만든 게 곧 매출이니 바로 판다
    if (HITECH[key] || m.price >= m.base * 0.95) {
      game.trade(me.id, { mat: key, qty: Math.min(extra, 500), side: 'sell' });
    }
  }
}

/**
 * 땅을 사고 건물을 짓는다. 이미 가진 빈 땅이 있으면 그곳을 먼저 쓴다.
 * 공장은 운송비가 싸도록 도시에 가까운 자리를 고른다.
 */
function tryAcquire(game, me, kind) {
  const spec = BUILDINGS[kind];
  const terrain = spec.on;

  // 설비가 어느 정도 깔린 뒤에는 여유 자금을 남긴다.
  // 안 그러면 매번 현금을 0 까지 써 버려서 빚도 못 갚고 연구도 못 한다.
  const reserve = me._reserve || 0;

  const own = myTiles(game, me.id).find((t) => t.tile.t === terrain && !t.tile.b);
  if (own) {
    if (me.cash < spec.cost + reserve) return false;
    const built = game.build(me.id, own.idx, kind).ok;
    if (built && kind === 'factory') applyFocus(game, me, own.idx);
    return built;
  }

  const tilePrice = TILE_TYPES[terrain].price;
  if (me.cash < tilePrice + spec.cost + reserve) return false;

  let best = null;
  for (let i = 0; i < game.map.tiles.length; i++) {
    const t = game.map.tiles[i];
    if (t.t !== terrain || t.owner) continue;
    const d = nearestCityDist(game, i);
    if (!best || d < best.d) best = { idx: i, d };
  }
  if (!best) return false;
  if (!game.buyTile(me.id, best.idx).ok) return false;
  const built = game.build(me.id, best.idx, kind).ok;
  if (built && kind === 'factory') applyFocus(game, me, best.idx);
  return built;
}

/**
 * 회사가 어느 정도 자리를 잡으면 공장 하나를 하이테크(반도체)로 돌린다.
 * 반도체는 철·원유를 쓰므로 기계 노선과 재료가 같아, 기계 쪽 봇만 넘어간다.
 * @returns {boolean} 맵이 바뀌었는지
 */
function goHitech(game, me) {
  if (me._focus !== 'machine') return false;
  const factories = myTiles(game, me.id).filter((t) => t.tile.b === 'factory');
  if (factories.length < 3 || me.cash < 2000) return false;
  if (factories.some((t) => HITECH[t.tile.mode])) return false; // 이미 있다

  // 도시에서 먼 공장을 하이테크로 돌린다 (가까운 쪽은 배송에 남겨 둔다)
  const far = factories
    .filter((t) => (t.tile.mode || 'machine') === 'machine')
    .sort((a, b) => nearestCityDist(game, b.idx) - nearestCityDist(game, a.idx))[0];
  if (!far) return false;
  return game.setFactoryMode(me.id, far.idx, 'semi').ok;
}

/**
 * 건물 증설. 땅을 새로 사는 것보다 싸고, 공장은 물동량이 커져 운송 단가도 내려간다.
 * @param {string} [only] 이 종류만 증설한다 (없으면 아무거나)
 */
function tryUpgrade(game, me, only) {
  let best = null;
  for (const { idx, tile } of myTiles(game, me.id)) {
    if (!tile.b) continue;
    if (only && tile.b !== only) continue;
    const cost = game.upgradeCost(tile);
    if (cost === null || me.cash < cost + (me._reserve || 0)) continue;
    const level = tile.level || 1;
    const d = nearestCityDist(game, idx);
    // 낮은 단계부터, 같은 단계면 도시에 가까운(운송비 싼) 쪽부터
    if (!best || level < best.level || (level === best.level && d < best.d)) best = { idx, level, d };
  }
  if (!best) return false;
  return game.upgradeBuilding(me.id, best.idx).ok;
}

/** 새로 지은 공장을 주력 제품으로 맞추고 노선을 다시 잡는다 */
function applyFocus(game, me, idx) {
  game.setFactoryMode(me.id, idx, me._focus);
  const best = game.bestRoute(idx, me._focus);
  if (best) game.setRoute(me.id, idx, best.city);
}

/** 한 번에 건물 하나씩. 부족한 쪽을 먼저 채운다. */
function buildUp(game, me) {
  const mine = myTiles(game, me.id);
  const counts = {};
  for (const { tile } of mine) {
    if (tile.b) counts[tile.b] = (counts[tile.b] || 0) + 1;
  }
  const sources = FOCUS_SOURCES[me._focus];

  // 1) 주력 제품에 필요한 원자재 생산기지부터 하나씩
  for (const kind of sources) {
    if (!counts[kind] && tryAcquire(game, me, kind)) return true;
  }
  // 2) 공장이 없으면 공장
  if (!counts.factory && tryAcquire(game, me, 'factory')) return true;

  // 3) 확장 — 자원별로 따져서 가장 모자란 쪽을 먼저 채운다.
  //    (기계는 철2 : 유1 로 쓰므로 뭉뚱그려 보면 한쪽만 잔뜩 짓게 된다)
  const need = inputNeed(game, me);
  // 증설한 건물은 그만큼 더 캐내므로 타일별 실제 생산량을 더한다
  const supply = {};
  for (const { tile } of mine) {
    if (!tile.b) continue;
    for (const [k, r] of Object.entries(game.buildingOutput(tile))) {
      supply[k] = (supply[k] || 0) + r;
    }
  }
  let worst = null;
  for (const kind of sources) {
    for (const k of Object.keys(BUILDINGS[kind].out)) {
      const demand = need[k] || 0;
      if (demand <= 0) continue;
      const ratio = (supply[k] || 0) / demand;
      if (!worst || ratio < worst.ratio) worst = { kind, ratio };
    }
  }
  // 재료가 달리면 그 자원부터 채운다. 증설이 땅값이 안 들어 더 싸므로 먼저 시도한다.
  // 필요한 것을 살 돈이 없으면 아무것도 안 하고 모은다 — 여기서 더 싼 걸 대신 사면
  // 쓰지도 않을 생산기지만 잔뜩 늘어난다.
  if (worst && worst.ratio < 1) {
    return tryUpgrade(game, me, worst.kind) || tryAcquire(game, me, worst.kind);
  }
  if (tryUpgrade(game, me)) return true;
  if (tryAcquire(game, me, 'factory')) return true;

  // 더 지을 게 없으면 임대업이나 운송업. 벌이가 유지비의 두 배도 안 되면 짓지 않는다.
  const worthIt = (spec, income) => income > spec.cost * 0.0025 * 2;

  const rentSpec = BUILDINGS.rental;
  const rent = (rentSpec.rent * game.rentalDemand()) / (1 + game.rentalSupply() * 0.06);

  const depotSpec = BUILDINGS.depot;
  const freight = (depotSpec.freight * game.freightDemand()) / (1 + game.depotSupply() * 0.08);

  // 더 잘 버는 쪽부터 시도한다
  const first = freight > rent ? 'depot' : 'rental';
  const second = first === 'depot' ? 'rental' : 'depot';
  const income = { rental: rent, depot: freight };
  for (const kind of [first, second]) {
    if (worthIt(BUILDINGS[kind], income[kind]) && tryAcquire(game, me, kind)) return true;
  }
  return false;
}

/** 공장을 놀리지 않도록 모자란 재료를 시장에서 사 온다 */
function buyInputs(game, me) {
  const need = inputNeed(game, me);
  const RESERVE = 120;
  for (const [mat, perSec] of Object.entries(need)) {
    const target = perSec * INPUT_BUFFER_SEC;
    const short = Math.floor(target - (me.inv[mat] || 0));
    if (short < 1) continue;
    const m = game.market[mat];
    if (!m) continue; // 기계처럼 시장에 없는 재료는 직접 만들어야 한다
    if (m.price > m.base * 1.6) continue; // 너무 비싸면 이번엔 건너뛴다
    const afford = Math.floor((me.cash - RESERVE) / (m.price * 1.02));
    const qty = Math.min(short, afford, 500);
    if (qty > 0) game.trade(me.id, { mat, qty, side: 'buy' });
  }
}

/**
 * 회사의 "제값" — 시장이 실제로 주가를 매길 때 쓰는 기준(본업 가치 + 수익력)과
 * 똑같은 공식이어야 한다. netWorth 는 남의 지분 보유분까지 섞인 순위용 값이라
 * 이 용도로 쓰면 수익력이 큰 회사를 전부 "고평가"로 잘못 읽어 공매도가
 * 걷잡을 수 없이 늘어난다.
 */
function fairPrice(game, p) {
  return Math.max(0.05, (game.operatingWorth(p) + p.incomePerSec * INCOME_MULTIPLE) / TOTAL_SHARES);
}

/** 공매도 포지션 전체를 지금 시세로 평가한 총 노출액 */
function totalShortExposure(game, me) {
  let v = 0;
  for (const [cid, pos] of Object.entries(me.shorts || {})) {
    const s = game.stocks[cid];
    if (s) v += s.price * pos.shares;
  }
  return v;
}

/**
 * 주식 — 경영권 방어가 최우선, 그다음은 공매도 청산/차익 실현, 그다음은
 * 심하게 고평가된 회사를 공매도로 노리는 것(실적 부진 사건 등을 노린다),
 * 마지막이 저평가된 회사를 사 모으는 것. 사람이 주식을 아예 안 만져도
 * 컴퓨터끼리 사고팔아 주가가 움직인다.
 */
function playStocks(game, me) {
  // 총주식수가 바뀌어도 따라가도록 비율로 잡는다
  const DEFEND_FROM = Math.round(TAKEOVER_SHARES * 0.8); // 인수까지 20% 남으면 방어 시작
  const LOT = Math.max(1, Math.round(TOTAL_SHARES / 10)); // 한 번에 거래하는 단위
  const myStock = game.stocks[me.id];

  const threat = game.players.some((p) => p.id !== me.id && (p.shares[me.id] || 0) >= DEFEND_FROM);
  const avail = game.availableShares(me.id); // 외부 투자자 보유분도 되사 올 수 있다
  if (threat && avail > 0 && me.cash > 200) {
    const qty = Math.min(avail, Math.floor((me.cash - 150) / (myStock.price * 1.05)), LOT);
    if (qty > 0) {
      game.stockTrade(me.id, { company: me.id, qty, side: 'buy' });
      return;
    }
  }

  /*
   * 방어에 필요한 만큼만 남기고 자사주를 내놓는다.
   *
   * 자사주는 배당이 안 나오는데 보유세는 그대로 나가는 순수 비용이고, 물량을
   * 시장에 풀어야 남들이 사고팔 수 있다. 예전엔 방어로 사기만 하고 파는 길이
   * 없어서, 봇들이 자사주를 1000주 넘게 끌어안고 유통 물량이 0 까지 말랐다.
   * 위협이 없을 때, 방어선보다 넉넉히 들고 있는 몫만 조금씩 되판다.
   */
  const ownShares = me.shares[me.id] || 0;
  const keep = DEFEND_FROM; // 이만큼은 방어용으로 남긴다
  if (!threat && ownShares > keep + LOT) {
    const qty = Math.min(ownShares - keep, LOT);
    if (qty > 0 && game.stockTrade(me.id, { company: me.id, qty, side: 'sell' }).ok) return;
  }

  // 공매도해 둔 게 고평가가 풀려 제값 근처로 돌아왔으면 청산해 이익을 실현한다
  for (const [cid, pos] of Object.entries(me.shorts || {})) {
    if (!pos.shares) continue;
    const target = game.player(cid);
    const s = game.stocks[cid];
    if (!target || !s) continue;
    const fair = fairPrice(game, target);
    if (s.price <= fair * 1.05) {
      game.coverShort(me.id, cid, pos.shares);
      return;
    }
  }

  /*
   * 들고 있는 남의 주식을 판다 — 주가가 내려가는 힘이자, 유통 물량을 시장에
   * 되돌려 놓는 유일한 통로다.
   *
   * 매도 문턱(1.12)이 매수 문턱(1.02)에 너무 가까우면 같은 자리에서 사고팔며
   * 스프레드만 까먹고, 너무 멀면(예전 1.25) 아무도 안 팔아서 물량이 말라붙는다.
   * 현금이 급하면 제값이어도 내다 파는 길도 열어 둔다 — 실제로 돈이 필요하면
   * 투자부터 정리하는 게 자연스럽고, 그래야 시장에 물량이 돈다.
   */
  const needCash = me.cash < 300;
  for (const [cid, n] of Object.entries(me.shares)) {
    if (cid === me.id || n < 1) continue;
    const target = game.player(cid);
    const s = game.stocks[cid];
    if (!target || !s) continue;
    const fair = fairPrice(game, target);
    // 경영권을 쥐고 있으면 팔지 않는다 (그 자체로 돈이 들어온다)
    if (game.controllerOf(cid) && game.controllerOf(cid).id === me.id) continue;
    if (s.price > fair * 1.12 || needCash) {
      game.stockTrade(me.id, { company: cid, qty: Math.min(n, LOT), side: 'sell' });
      return;
    }
  }

  // 심하게 고평가됐는데 들고 있는 게 없으면 공매도로 노린다
  // (실적 부진·금융위기 사건이 오면 그 낙폭을 그대로 이익으로 챙긴다).
  // 총 노출액은 본업 가치의 60% 로 묶어 둔다 — 안 그러면 다들 서로를 한도까지
  // 공매도해 버려서, 그중 하나만 값이 뛰어도 회사가 통째로 휘청인다.
  if (me.cash > 400 && totalShortExposure(game, me) < game.operatingWorth(me) * 0.6) {
    let worst = null;
    for (const p of game.players) {
      if (p.id === me.id) continue;
      if ((me.shares[p.id] || 0) > 0) continue; // 들고 있으면 위에서 이미 처리한다
      const held = game.shortShares(me, p.id);
      if (held >= MAX_SHORT) continue;
      const s = game.stocks[p.id];
      const fair = fairPrice(game, p);
      const overvalue = s.price / fair; // 1보다 크면 고평가
      if (overvalue > 1.3 && (!worst || overvalue > worst.overvalue)) worst = { id: p.id, overvalue, held };
    }
    if (worst) {
      const qty = Math.min(MAX_SHORT - worst.held, LOT);
      if (qty > 0 && game.shortSell(me.id, worst.id, qty).ok) return;
    }
  }

  // 본업에 쓸 돈은 남겨 두고, 저평가된 회사를 사 모은다.
  // 물량은 시장에 남은 것뿐 아니라 외부 투자자가 들고 있는 것도 사 올 수 있다.
  if (me.cash < 600) return;
  let best = null;
  for (const p of game.players) {
    if (p.id === me.id) continue;
    const avail2 = game.availableShares(p.id);
    if (avail2 < 1) continue;
    const s = game.stocks[p.id];
    const fair = fairPrice(game, p);
    const value = fair / s.price; // 1보다 크면 저평가
    if (value > 1.02 && (!best || value > best.value)) best = { id: p.id, value, s, avail: avail2 };
  }
  if (!best) return;
  const qty = Math.min(best.avail, Math.floor((me.cash - 350) / (best.s.price * 1.1)), LOT);
  if (qty > 0) game.stockTrade(me.id, { company: best.id, qty, side: 'buy' });
}

/**
 * 연구개발 — 설비를 어느 정도 갖춘 뒤 남는 돈으로 올린다.
 * 회사 전체에 붙는 보너스라 설비가 많을수록 이득이 크다.
 */
function doResearch(game, me) {
  if (me.debt > 0) return;
  // 설비가 어느 정도 깔린 뒤라야 회사 전체 보너스가 값어치를 한다.
  // 이 시점부터는 건물 하나 더 짓는 것보다 연구를 먼저 친다.
  const buildings = myTiles(game, me.id).filter((t) => t.tile.b).length;
  if (buildings < 6) return;
  const options = Object.keys(RESEARCH)
    .map((kind) => ({ kind, cost: game.researchCost(me, kind) }))
    .filter((o) => o.cost !== null && o.cost + 300 <= me.cash)
    .sort((a, b) => a.cost - b.cost);
  if (options.length) game.research(me.id, options[0].kind);
}

/**
 * 대출 — 초반에 설비를 깔 돈이 없을 때만 쓴다.
 * 이자가 계속 나가므로 여유가 생기면 갚는다.
 */
function manageLoan(game, me) {
  // 돈이 남으면 먼저 빚부터 정리. 이자가 계속 나가므로 조금이라도 갚는다.
  if (me.debt > 0 && me.cash > 400) {
    game.repay(me.id, Math.min(Math.ceil(me.debt), Math.floor(me.cash - 250)));
    return;
  }
  // 아직 공장이 없고 현금이 말랐으면 빌려서라도 시작한다
  if (me.debt > 0 || me.cash > 250) return;
  const hasFactory = myTiles(game, me.id).some((t) => t.tile.b === 'factory');
  const limit = game.creditLimit(me);
  if (limit < 200) return;
  // 설비 하나를 더 놓을 만큼만 빌린다
  const want = hasFactory ? 300 : 500;
  game.borrow(me.id, Math.min(want, limit));
}

/* ------------------------------------------------------------------ 진입점 */

/**
 * 봇 한 명이 한 번 판단한다.
 * @param {import('./game').Game} game
 * @param {string} botId
 * @returns {boolean} 맵이 바뀌었는지 (땅 구매/건설/노선 변경)
 */
function think(game, botId) {
  const me = game.player(botId);
  if (!me || game.ended) return false;
  if (!me._focus) me._focus = pickFocus(game);

  // 설비가 갖춰지면 무작정 더 짓기보다 빚 정리와 연구에 쓸 돈을 남긴다
  const buildings = myTiles(game, me.id).filter((t) => t.tile.b).length;
  me._reserve = buildings >= 6 ? 800 : 0;

  let mapChanged = checkRoutes(game, me);
  sellSurplus(game, me);
  manageLoan(game, me);
  doResearch(game, me);
  if (goHitech(game, me)) mapChanged = true;
  if (buildUp(game, me)) mapChanged = true;
  buyInputs(game, me);
  playStocks(game, me);
  return mapChanged;
}

module.exports = { think, pickFocus, inputNeed, nearestCityDist };
