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

/** 내 공장들이 초당 소비하는 원자재 양 (증설 레벨 반영) */
function inputNeed(game, me) {
  const need = {};
  for (const { tile } of myTiles(game, me.id)) {
    if (tile.b !== 'factory') continue;
    const rate = game.factoryRate(tile);
    for (const [k, n] of Object.entries(PRODUCTS[tile.mode || 'machine'].recipe)) {
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

/** 공장이 쓰고 남을 원자재는 시세가 괜찮을 때 팔아 현금화한다 */
function sellSurplus(game, me) {
  const need = inputNeed(game, me);
  for (const mat of Object.keys(MATERIALS)) {
    const keep = (need[mat] || 0) * SURPLUS_SEC;
    const extra = Math.floor((me.inv[mat] || 0) - keep);
    const m = game.market[mat];
    if (extra >= 1 && m.price >= m.base * 0.95) {
      game.trade(me.id, { mat, qty: Math.min(extra, 500), side: 'sell' });
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
    if (m.price > m.base * 1.6) continue; // 너무 비싸면 이번엔 건너뛴다
    const afford = Math.floor((me.cash - RESERVE) / (m.price * 1.02));
    const qty = Math.min(short, afford, 500);
    if (qty > 0) game.trade(me.id, { mat, qty, side: 'buy' });
  }
}

/** 경영권 방어를 최우선으로 하고, 여유가 있으면 저평가된 라이벌 지분을 모은다 */
function playStocks(game, me) {
  const DEFEND_FROM = TAKEOVER_SHARES - 15; // 36주부터 위협으로 본다
  const myStock = game.stocks[me.id];

  const threat = game.players.some(
    (p) => p.id !== me.id && (p.shares[me.id] || 0) >= DEFEND_FROM
  );
  if (threat && myStock.float > 0 && me.cash > 200) {
    const qty = Math.min(myStock.float, Math.floor((me.cash - 150) / (myStock.price * 1.05)), 10);
    if (qty > 0) {
      game.stockTrade(me.id, { company: me.id, qty, side: 'buy' });
      return;
    }
  }

  // 공격은 자금에 여유가 있을 때만 (본업이 우선)
  if (me.cash < 800) return;
  let best = null;
  for (const p of game.players) {
    if (p.id === me.id) continue;
    const s = game.stocks[p.id];
    if (s.float < 1) continue;
    const fair = game.netWorth(p) / TOTAL_SHARES;
    const value = fair / s.price; // 1보다 크면 저평가
    if (value > 1.05 && (!best || value > best.value)) best = { id: p.id, value, s };
  }
  if (!best) return;
  const qty = Math.min(best.s.float, Math.floor((me.cash - 500) / (best.s.price * 1.1)), 12);
  if (qty > 0) game.stockTrade(me.id, { company: best.id, qty, side: 'buy' });
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
  if (buildUp(game, me)) mapChanged = true;
  buyInputs(game, me);
  playStocks(game, me);
  return mapChanged;
}

module.exports = { think, pickFocus, inputNeed, nearestCityDist };
