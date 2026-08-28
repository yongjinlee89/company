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
  TILE_TYPES,
  TOTAL_SHARES,
  TAKEOVER_SHARES,
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
    for (const [k, n] of Object.entries(MAKEABLE[tile.mode || 'machine'].recipe)) {
      need[k] = (need[k] || 0) + n * rate;
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
    // 하이테크 공장에 재료를 대 주려고 일부러 노선을 끈 공장은 건드리지 않는다
    if (idx === me._feeder) continue;
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

  const own = myTiles(game, me.id).find((t) => t.tile.t === terrain && !t.tile.b);
  if (own) {
    if (me.cash < spec.cost) return false;
    const built = game.build(me.id, own.idx, kind).ok;
    if (built && kind === 'factory') applyFocus(game, me, own.idx);
    return built;
  }

  const tilePrice = TILE_TYPES[terrain].price;
  if (me.cash < tilePrice + spec.cost) return false;

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
 * 회사가 어느 정도 자리를 잡으면 하이테크(반도체)로 넘어간다.
 * 기계 공장 하나의 노선을 꺼서 기계를 모으고, 그걸 반도체 공장에 먹인다.
 * @returns {boolean} 맵이 바뀌었는지
 */
function goHitech(game, me) {
  const factories = myTiles(game, me.id).filter((t) => t.tile.b === 'factory');
  if (factories.length < 3 || me.cash < 2000) return false;

  const machines = factories.filter((t) => (t.tile.mode || 'machine') === 'machine');
  if (machines.length < 2) return false; // 기계를 대 줄 공장이 남아 있어야 한다

  if (!factories.some((t) => HITECH[t.tile.mode])) {
    // 도시에서 먼 공장을 하이테크로 돌린다 (가까운 쪽은 배송에 남겨 둔다)
    const far = machines
      .slice()
      .sort((a, b) => nearestCityDist(game, b.idx) - nearestCityDist(game, a.idx))[0];
    return game.setFactoryMode(me.id, far.idx, 'semi').ok;
  }

  // 반도체 공장이 생겼으면 기계 공장 하나는 노선을 꺼서 재료를 쌓는다
  if (me._feeder === undefined) {
    const feeder = machines.find((t) => t.tile.route !== null);
    if (feeder && game.setRoute(me.id, feeder.idx, null).ok) {
      me._feeder = feeder.idx;
      return true;
    }
  }
  return false;
}

/**
 * 공장 증설. 땅+공장을 새로 짓는 것보다 싸고, 물동량이 커져 운송 단가도 내려간다.
 * 운송비가 싼(도시에 가까운) 공장부터 키운다.
 */
function tryUpgrade(game, me) {
  const spec = BUILDINGS.factory;
  let best = null;
  for (const { idx, tile } of myTiles(game, me.id)) {
    if (tile.b !== 'factory') continue;
    const level = tile.level || 1;
    if (level >= spec.maxLevel) continue;
    if (me.cash < spec.upgradeCost * level) continue;
    const d = nearestCityDist(game, idx);
    if (!best || level < best.level || (level === best.level && d < best.d)) best = { idx, level, d };
  }
  if (!best) return false;
  return game.upgradeFactory(me.id, best.idx).ok;
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
  const supply = {};
  for (const kind of sources) {
    for (const [k, r] of Object.entries(BUILDINGS[kind].out)) {
      supply[k] = (supply[k] || 0) + r * (counts[kind] || 0);
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
  // 재료가 달리면 그 자원부터, 넉넉하면 생산 능력을 늘린다.
  // 필요한 것을 살 돈이 없으면 아무것도 안 하고 모은다 — 여기서 더 싼 걸 대신 사면
  // 쓰지도 않을 생산기지만 잔뜩 늘어난다.
  if (worst && worst.ratio < 1) return tryAcquire(game, me, worst.kind);
  if (tryUpgrade(game, me)) return true;
  return tryAcquire(game, me, 'factory');
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
 * 주식 — 경영권 방어가 최우선이고, 그다음은 싸게 사서 비싸게 파는 것.
 * 사람이 주식을 아예 안 만져도 컴퓨터끼리 사고팔아 주가가 움직인다.
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

  // 들고 있는 남의 주식이 비싸졌으면 판다 (차익 실현 — 주가가 내려가는 힘이 된다)
  for (const [cid, n] of Object.entries(me.shares)) {
    if (cid === me.id || n < 1) continue;
    const target = game.player(cid);
    const s = game.stocks[cid];
    if (!target || !s) continue;
    const fair = game.netWorth(target) / TOTAL_SHARES;
    // 경영권을 쥐고 있으면 팔지 않는다 (그 자체로 돈이 들어온다)
    if (game.controllerOf(cid) && game.controllerOf(cid).id === me.id) continue;
    if (s.price > fair * 1.25) {
      game.stockTrade(me.id, { company: cid, qty: Math.min(n, LOT), side: 'sell' });
      return;
    }
  }

  // 본업에 쓸 돈은 남겨 두고, 저평가된 회사를 사 모은다.
  // 물량은 시장에 남은 것뿐 아니라 외부 투자자가 들고 있는 것도 사 올 수 있다.
  if (me.cash < 800) return;
  let best = null;
  for (const p of game.players) {
    if (p.id === me.id) continue;
    const avail = game.availableShares(p.id);
    if (avail < 1) continue;
    const s = game.stocks[p.id];
    const fair = game.netWorth(p) / TOTAL_SHARES;
    const value = fair / s.price; // 1보다 크면 저평가
    if (value > 1.05 && (!best || value > best.value)) best = { id: p.id, value, s, avail };
  }
  if (!best) return;
  const qty = Math.min(best.avail, Math.floor((me.cash - 500) / (best.s.price * 1.1)), LOT);
  if (qty > 0) game.stockTrade(me.id, { company: best.id, qty, side: 'buy' });
}

/**
 * 대출 — 초반에 설비를 깔 돈이 없을 때만 쓴다.
 * 이자가 계속 나가므로 여유가 생기면 갚는다.
 */
function manageLoan(game, me) {
  // 돈이 남으면 먼저 빚부터 정리
  if (me.debt > 0 && me.cash > me.debt + 600) {
    game.repay(me.id, Math.floor(me.debt));
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

  let mapChanged = checkRoutes(game, me);
  sellSurplus(game, me);
  manageLoan(game, me);
  if (goHitech(game, me)) mapChanged = true;
  if (buildUp(game, me)) mapChanged = true;
  buyInputs(game, me);
  playStocks(game, me);
  return mapChanged;
}

module.exports = { think, pickFocus, inputNeed, nearestCityDist };
