'use strict';

/**
 * 컴퓨터 플레이어(AI).
 *
 * 사람과 똑같이 Game 의 공개 메서드만 호출한다. (규칙 검증을 그대로 통과해야 하므로
 * 봇이 반칙을 할 수 없고, 게임 규칙이 바뀌어도 봇이 따로 깨지지 않는다)
 *
 * 한 라운드 행동 순서:
 *   제품 판매 → 잉여 자재 매도 → 건설 → 생산 재료 매수 → 주식
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

/** 내 공장들이 한 라운드에 소비하는 원자재 양 */
function inputNeed(game, me) {
  const need = {};
  for (const { tile } of myTiles(game, me.id)) {
    if (tile.b !== 'factory') continue;
    const recipe = PRODUCTS[tile.mode || 'machine'].recipe;
    for (const [k, n] of Object.entries(recipe)) {
      need[k] = (need[k] || 0) + n * BUILDINGS.factory.batches;
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

/** 만들어 둔 제품을 가장 이득이 큰 도시로 배송한다 */
function sellProducts(game, me) {
  const factories = myTiles(game, me.id).filter((t) => t.tile.b === 'factory');
  if (!factories.length) return;

  for (const product of Object.keys(PRODUCTS)) {
    const stock = me.inv[product] || 0;
    if (stock < 1) continue;
    let best = null;
    for (const f of factories) {
      for (let ci = 0; ci < game.cities.length; ci++) {
        const q = game.quoteShip(me.id, { from: f.idx, city: ci, product, qty: stock });
        if (q.ok && (!best || q.net > best.net)) best = { net: q.net, from: f.idx, city: ci };
      }
    }
    if (best && best.net > 0) {
      game.ship(me.id, { from: best.from, city: best.city, product, qty: stock });
    }
  }
}

/** 공장이 쓰고 남을 원자재는 시세가 괜찮을 때 팔아 현금화한다 */
function sellSurplus(game, me) {
  const need = inputNeed(game, me);
  for (const mat of Object.keys(MATERIALS)) {
    const keep = (need[mat] || 0) * 2; // 두 라운드치는 남겨 둔다
    const extra = (me.inv[mat] || 0) - keep;
    const m = game.market[mat];
    if (extra > 0 && m.price >= m.base * 0.95) {
      game.trade(me.id, { mat, qty: extra, side: 'sell' });
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
    if (built && kind === 'factory') game.setFactoryMode(me.id, own.idx, me._focus);
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
  if (built && kind === 'factory') game.setFactoryMode(me.id, best.idx, me._focus);
  return built;
}

/** 라운드당 건물 하나씩. 부족한 쪽을 먼저 채운다. */
function buildUp(game, me) {
  const mine = myTiles(game, me.id);
  const counts = {};
  for (const { tile } of mine) {
    if (tile.b) counts[tile.b] = (counts[tile.b] || 0) + 1;
  }
  const sources = FOCUS_SOURCES[me._focus];

  // 1) 주력 제품에 필요한 원자재 생산기지부터 하나씩
  for (const kind of sources) {
    if (!counts[kind]) {
      if (tryAcquire(game, me, kind)) return;
    }
  }
  // 2) 공장이 없으면 공장
  if (!counts.factory) {
    if (tryAcquire(game, me, 'factory')) return;
  }
  // 3) 확장 — 공장 하나당 생산기지 둘을 목표로 번갈아 늘린다
  const producers = sources.reduce((sum, k) => sum + (counts[k] || 0), 0);
  const factories = counts.factory || 0;
  const wantProducer = producers < factories * sources.length * 2;
  const order = wantProducer ? [...sources, 'factory'] : ['factory', ...sources];
  for (const kind of order) {
    if (tryAcquire(game, me, kind)) return;
  }
}

/** 공장을 놀리지 않도록 모자란 재료를 시장에서 사 온다 */
function buyInputs(game, me) {
  const need = inputNeed(game, me);
  const RESERVE = 80;
  for (const [mat, n] of Object.entries(need)) {
    const short = n - (me.inv[mat] || 0);
    if (short <= 0) continue;
    const m = game.market[mat];
    if (m.price > m.base * 1.6) continue; // 너무 비싸면 이번 라운드는 건너뛴다
    const afford = Math.floor((me.cash - RESERVE) / (m.price * 1.02));
    const qty = Math.min(short, afford);
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
    const qty = Math.min(
      myStock.float,
      Math.floor((me.cash - 150) / (myStock.price * 1.05)),
      10
    );
    if (qty > 0) {
      game.stockTrade(me.id, { company: me.id, qty, side: 'buy' });
      return;
    }
  }

  // 공격은 자금에 여유가 있을 때만 (본업이 우선)
  if (me.cash < 600) return;
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
  const qty = Math.min(
    best.s.float,
    Math.floor((me.cash - 400) / (best.s.price * 1.1)),
    12
  );
  if (qty > 0) game.stockTrade(me.id, { company: best.id, qty, side: 'buy' });
}

/* ------------------------------------------------------------------ 진입점 */

/**
 * 봇 한 명의 라운드 행동을 모두 수행한다.
 * @param {import('./game').Game} game
 * @param {string} botId
 */
function playRound(game, botId) {
  const me = game.player(botId);
  if (!me || game.ended) return;
  if (!me._focus) me._focus = pickFocus(game);

  sellProducts(game, me);
  sellSurplus(game, me);
  buildUp(game, me);
  buyInputs(game, me);
  playStocks(game, me);
}

module.exports = { playRound, pickFocus, inputNeed, nearestCityDist };
