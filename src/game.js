'use strict';

/**
 * 컴퍼니 — 실시간 회사 경영 게임의 핵심 로직.
 *
 * 턴이 없다. 서버가 일정 간격으로 tick(dt) 를 돌리고 모든 수치는 "초당" 으로 정의된다.
 *   생산 → 배송(자동 판매) → 배당/경영권 분배 → 시장·수요·주가 회복
 *
 * 플레이어는 언제든 땅을 사고, 건물을 짓고, 배송 도시를 바꾸고, 거래할 수 있다.
 * 제한 시간이 끝나면 순자산이 가장 많은 회사가 이긴다.
 */

const MAP_W = 12;
const MAP_H = 12;
const TOTAL_SHARES = 100; // 회사당 발행 주식 수
const FOUNDER_SHARES = 40; // 창업자 보유분 (나머지 60주는 시장 유통)
const TAKEOVER_SHARES = 51; // 이만큼 모으면 경영권 인수
const DIVIDEND_RATE = 0.15; // 매출 중 배당으로 나가는 비율
const TAKEOVER_CUT = 0.25; // 경영권 보유자가 가져가는 비율

const MATERIALS = {
  iron: { name: '철광석', base: 10 },
  oil: { name: '원유', base: 14 },
  grain: { name: '곡물', base: 6 },
};

// rate = 공장 하나가 초당 만들어내는 개수
const PRODUCTS = {
  machine: { name: '기계', base: 60, recipe: { iron: 2, oil: 1 }, rate: 0.18 },
  food: { name: '식품', base: 30, recipe: { grain: 2 }, rate: 0.22 },
};

const ITEM_NAMES = {};
for (const [k, v] of Object.entries(MATERIALS)) ITEM_NAMES[k] = v.name;
for (const [k, v] of Object.entries(PRODUCTS)) ITEM_NAMES[k] = v.name;

// 타일 종류. price 가 없으면 구매 불가.
const TILE_TYPES = {
  plain: { name: '평지', price: 40 },
  iron: { name: '철광 지대', price: 80 },
  oil: { name: '유전 지대', price: 100 },
  farm: { name: '농지', price: 60 },
  mountain: { name: '산' },
  city: { name: '도시' },
};

// out = 초당 생산량. 공장은 PRODUCTS 의 rate × 레벨을 따른다.
const BUILDINGS = {
  mine: { name: '광산', cost: 100, on: 'iron', out: { iron: 0.4 } },
  rig: { name: '시추소', cost: 120, on: 'oil', out: { oil: 0.3 } },
  farm: { name: '농장', cost: 80, on: 'farm', out: { grain: 0.5 } },
  // 증설하면 물동량이 늘어 기차·항공 같은 대량 운송이 유리해진다
  factory: { name: '공장', cost: 150, on: 'plain', maxLevel: 3, upgradeCost: 180 },
};

const CITY_NAMES = ['서울', '부산', '광주', '대전'];

const PLAYER_COLORS = ['#e5484d', '#3b82f6', '#22a06b', '#f59e0b', '#8b5cf6', '#0ea5b7'];

/* ------------------------------------------------------------------ 운송 */

/**
 * 운송 수단별 비용 구조 (초당 기준).
 * 트럭은 고정비가 없어 소량·근거리에 유리하고,
 * 기차·항공은 고정비가 있는 대신 거리당 단가가 싸서 대량·원거리에 유리하다.
 */
const TRANSPORT = [
  { method: 'truck', name: '트럭', fixed: 0, perUnit: 2.0 },
  { method: 'train', name: '기차', fixed: 0.9, perUnit: 0.55 },
  { method: 'air', name: '항공', fixed: 2.2, perUnit: 0.18 },
];

/**
 * 거리와 초당 물동량에 맞는 가장 싼 운송 수단을 고른다.
 * @param {number} dist 타일 거리
 * @param {number} ratePerSec 초당 운반 개수
 * @returns {{method:string, name:string, cost:number}} cost 는 초당 운송비
 */
function transportQuote(dist, ratePerSec) {
  let best = null;
  for (const t of TRANSPORT) {
    const cost = t.fixed + t.perUnit * dist * ratePerSec;
    if (!best || cost < best.cost) best = { method: t.method, name: t.name, cost };
  }
  return { method: best.method, name: best.name, cost: Math.round(best.cost * 100) / 100 };
}

function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/* ------------------------------------------------------------------ 맵 생성 */

function randInt(n) {
  return Math.floor(Math.random() * n);
}

/**
 * 인원수에 맞춘 자원 타일 개수.
 * 사람이 많을수록 늘려서, 2인 게임이 텅 비어 보이지도 않고
 * 6인 게임이 땅따먹기 싸움만 되지도 않게 한다.
 */
function resourceCounts(playerCount) {
  const extra = Math.max(0, playerCount - 2);
  return {
    iron: 12 + 3 * extra, // 철광 지대
    oil: 8 + 2 * extra, // 유전 지대
    farm: 14 + 3 * extra, // 농지
    mountain: 10, // 산 (지을 수 없는 장애물)
  };
}

/**
 * @param {number} playerCount 참가 인원 (자원 타일 개수를 정한다)
 */
function generateMap(playerCount = 2) {
  const tiles = new Array(MAP_W * MAP_H)
    .fill(null)
    .map(() => ({ t: 'plain', owner: null, b: null, mode: null, route: null }));
  const cities = [];

  // 도시 4곳: 사분면마다 하나씩, 약간의 흔들림을 준다
  const quads = [
    [2, 2],
    [MAP_W - 3, 2],
    [2, MAP_H - 3],
    [MAP_W - 3, MAP_H - 3],
  ];
  quads.forEach(([qx, qy], i) => {
    const x = Math.min(MAP_W - 1, Math.max(0, qx + randInt(3) - 1));
    const y = Math.min(MAP_H - 1, Math.max(0, qy + randInt(3) - 1));
    tiles[y * MAP_W + x].t = 'city';
    cities.push({
      x,
      y,
      name: CITY_NAMES[i],
      // 도시별 가격 특색 (0.9 ~ 1.2)
      mod: {
        machine: Math.round((0.9 + Math.random() * 0.3) * 100) / 100,
        food: Math.round((0.9 + Math.random() * 0.3) * 100) / 100,
      },
      // 수요 배수. 팔면 내려가고 시간이 지나면 회복된다
      demand: { machine: 1, food: 1 },
    });
  });

  // 자원/산 배치.
  // 남은 평지를 섞어서 앞에서부터 꺼내 쓴다 — 무작위로 찍어 보는 방식은
  // 자원이 많아질수록 빈 자리를 못 찾고 헛돌 수 있다.
  const pool = [];
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].t === 'plain') pool.push(i);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  let cursor = 0;
  const scatter = (type, count) => {
    for (let n = 0; n < count && cursor < pool.length; n++) {
      tiles[pool[cursor++]].t = type;
    }
  };
  const counts = resourceCounts(playerCount);
  scatter('mountain', counts.mountain);
  scatter('iron', counts.iron);
  scatter('oil', counts.oil);
  scatter('farm', counts.farm);

  return { w: MAP_W, h: MAP_H, tiles, cities };
}

/* ------------------------------------------------------------------ 게임 */

class Game {
  /**
   * @param {Array<{id:string,name:string}>} playerInfos
   * @param {{startCash:number, duration:number}} settings duration 은 초 단위
   */
  constructor(playerInfos, settings) {
    this.settings = settings;
    this.elapsed = 0;
    this.ended = false;
    this.ranking = null;

    const map = generateMap(playerInfos.length);
    this.map = { w: map.w, h: map.h, tiles: map.tiles };
    this.cities = map.cities;

    // 자재 시장: 사면 오르고 팔면 내리고, 시간이 지나면 기준가로 회귀
    this.market = {};
    for (const [key, m] of Object.entries(MATERIALS)) {
      this.market[key] = { price: m.base, base: m.base };
    }

    this.players = playerInfos.map((info, i) => ({
      id: info.id,
      name: info.name,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      cash: settings.startCash,
      inv: { iron: 0, oil: 0, grain: 0, machine: 0, food: 0 },
      // shares[대상 회사 id] = 보유 주식 수
      shares: { [info.id]: FOUNDER_SHARES },
      incomePerSec: 0,
      _incomeAccum: 0, // 1초 단위로 집계해 incomePerSec 로 옮긴다
    }));

    // 주식 시장: 회사(플레이어)마다 주가와 유통 물량
    this.stocks = {};
    for (const p of this.players) {
      this.stocks[p.id] = {
        price: Math.max(1, settings.startCash / TOTAL_SHARES),
        float: TOTAL_SHARES - FOUNDER_SHARES,
      };
    }

    this._incomeTimer = 0;
    this._controllers = {};
    this.log = [];
  }

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  pushLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 120) this.log.shift();
  }

  tile(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.map.tiles.length) return null;
    return this.map.tiles[idx];
  }

  distToCity(idx, cityIndex) {
    const c = this.cities[cityIndex];
    if (!c) return null;
    const x = idx % this.map.w;
    const y = Math.floor(idx / this.map.w);
    return Math.max(1, chebyshev(x, y, c.x, c.y));
  }

  /* ---------------------------------------------------------------- 행동 */

  buyTile(pid, idx) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const tile = this.tile(idx);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    const type = TILE_TYPES[tile.t];
    if (!type.price) return { ok: false, error: '살 수 없는 땅입니다.' };
    if (tile.owner) return { ok: false, error: '이미 주인이 있는 땅입니다.' };
    if (p.cash < type.price) return { ok: false, error: '현금이 부족합니다.' };
    p.cash -= type.price;
    tile.owner = pid;
    this.pushLog(`${p.name} 님이 ${type.name}을(를) ${type.price}에 구입했습니다.`);
    return { ok: true };
  }

  build(pid, idx, kind) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const tile = this.tile(idx);
    const spec = BUILDINGS[kind];
    if (!p || !tile || !spec) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid) return { ok: false, error: '내 땅에만 지을 수 있습니다.' };
    if (tile.b) return { ok: false, error: '이미 건물이 있습니다.' };
    if (tile.t !== spec.on) {
      return { ok: false, error: `${spec.name}은(는) ${TILE_TYPES[spec.on].name}에만 지을 수 있습니다.` };
    }
    if (p.cash < spec.cost) return { ok: false, error: '현금이 부족합니다.' };
    p.cash -= spec.cost;
    tile.b = kind;
    if (kind === 'factory') {
      tile.mode = 'machine';
      tile.level = 1;
      // 가장 이득이 큰 도시로 배송 노선을 자동 지정해 준다 (바로 돌아가도록)
      const best = this.bestRoute(idx, tile.mode);
      tile.route = best ? best.city : null;
    }
    this.pushLog(`${p.name} 님이 ${spec.name}을(를) 건설했습니다.`);
    return { ok: true };
  }

  /** 공장 증설 — 생산량이 레벨에 비례해 늘고, 물동량이 커져 운송 단가가 싸진다 */
  upgradeFactory(pid, idx) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const tile = this.tile(idx);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid || tile.b !== 'factory') return { ok: false, error: '내 공장이 아닙니다.' };
    const spec = BUILDINGS.factory;
    const level = tile.level || 1;
    if (level >= spec.maxLevel) return { ok: false, error: `최대 ${spec.maxLevel}단계까지 증설할 수 있습니다.` };
    const cost = spec.upgradeCost * level;
    if (p.cash < cost) return { ok: false, error: `현금이 부족합니다. (필요 ${cost})` };
    p.cash -= cost;
    tile.level = level + 1;
    this.pushLog(`${p.name} 님이 공장을 ${tile.level}단계로 증설했습니다.`);
    return { ok: true };
  }

  /** 공장의 초당 생산량 (레벨 반영) */
  factoryRate(tile) {
    const mode = tile.mode || 'machine';
    return PRODUCTS[mode].rate * (tile.level || 1);
  }

  setFactoryMode(pid, idx, mode) {
    const p = this.player(pid);
    const tile = this.tile(idx);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid || tile.b !== 'factory') return { ok: false, error: '내 공장이 아닙니다.' };
    if (!PRODUCTS[mode]) return { ok: false, error: '알 수 없는 생산 품목입니다.' };
    tile.mode = mode;
    return { ok: true };
  }

  /** 공장의 배송 도시를 지정한다. null 이면 배송을 멈추고 재고가 쌓인다. */
  setRoute(pid, idx, city) {
    const p = this.player(pid);
    const tile = this.tile(idx);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid || tile.b !== 'factory') return { ok: false, error: '내 공장이 아닙니다.' };
    if (city === null || city === undefined || city === '') {
      tile.route = null;
      return { ok: true };
    }
    const ci = Number(city);
    if (!Number.isInteger(ci) || !this.cities[ci]) return { ok: false, error: '알 수 없는 도시입니다.' };
    tile.route = ci;
    return { ok: true };
  }

  /**
   * 특정 공장에서 특정 도시로 보낼 때의 초당 손익을 계산한다. (UI 미리보기 겸 AI 판단용)
   */
  quoteRoute(idx, cityIndex, mode) {
    const tile = this.tile(idx);
    const useMode = mode || (tile && tile.mode) || 'machine';
    const spec = PRODUCTS[useMode];
    const dist = this.distToCity(idx, cityIndex);
    if (!spec || dist === null) return null;
    const c = this.cities[cityIndex];
    // 증설한 공장일수록 물동량이 커서 대량 운송 수단이 유리해진다
    const rate = spec.rate * ((tile && tile.level) || 1);
    const transport = transportQuote(dist, rate);
    const revenue = spec.base * c.mod[useMode] * c.demand[useMode] * rate;
    return {
      city: cityIndex,
      dist,
      rate,
      transport,
      revenue: Math.round(revenue * 100) / 100,
      net: Math.round((revenue - transport.cost) * 100) / 100,
    };
  }

  /** 초당 순이익이 가장 큰 도시를 고른다 */
  bestRoute(idx, mode) {
    let best = null;
    for (let ci = 0; ci < this.cities.length; ci++) {
      const q = this.quoteRoute(idx, ci, mode);
      if (q && (!best || q.net > best.net)) best = q;
    }
    return best;
  }

  /**
   * 자재 시장 거래. 한 개 살 때마다 가격이 조금씩 오르고(0.8%), 팔면 내린다.
   * 매수는 0.5% 비싸게, 매도는 0.5% 싸게 체결된다(스프레드) — 없으면 왕복만으로 돈이 불어난다.
   */
  trade(pid, { mat, qty, side }) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const m = this.market[mat];
    qty = Math.floor(Number(qty) || 0);
    if (!p || !m) return { ok: false, error: '잘못된 요청입니다.' };
    if (qty < 1 || qty > 500) return { ok: false, error: '수량은 1~500 사이여야 합니다.' };

    const lo = m.base * 0.4;
    const hi = m.base * 2.5;
    let price = m.price;
    let total = 0;

    if (side === 'buy') {
      for (let i = 0; i < qty; i++) {
        total += price * 1.005;
        price = Math.min(hi, price * 1.008);
      }
      total = Math.round(total);
      if (p.cash < total) return { ok: false, error: `현금이 부족합니다. (필요 ${total})` };
      p.cash -= total;
      p.inv[mat] += qty;
      m.price = Math.round(price * 100) / 100;
      return { ok: true, total };
    }
    if (side === 'sell') {
      if ((p.inv[mat] || 0) < qty) return { ok: false, error: '재고가 부족합니다.' };
      for (let i = 0; i < qty; i++) {
        price = Math.max(lo, price * 0.992);
        total += price * 0.995;
      }
      total = Math.round(total);
      p.cash += total;
      p.inv[mat] -= qty;
      m.price = Math.round(price * 100) / 100;
      return { ok: true, total };
    }
    return { ok: false, error: '잘못된 요청입니다.' };
  }

  /**
   * 주식 거래. 시장 유통 물량(float)에서 사고, 팔면 유통 물량으로 돌아간다.
   * 체결마다 주가가 1%씩 움직이고, 자재와 같은 이유로 0.5% 스프레드가 붙는다.
   */
  stockTrade(pid, { company, qty, side }) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const target = this.player(company);
    const s = this.stocks[company];
    qty = Math.floor(Number(qty) || 0);
    if (!p || !target || !s) return { ok: false, error: '잘못된 요청입니다.' };
    if (qty < 1 || qty > TOTAL_SHARES) return { ok: false, error: '수량이 잘못되었습니다.' };

    let price = s.price;
    let total = 0;

    if (side === 'buy') {
      if (s.float < qty) return { ok: false, error: `시장에 나온 물량이 ${s.float}주뿐입니다.` };
      for (let i = 0; i < qty; i++) {
        total += price * 1.005;
        price = price * 1.01;
      }
      total = Math.round(total);
      if (p.cash < total) return { ok: false, error: `현금이 부족합니다. (필요 ${total})` };
      p.cash -= total;
      s.float -= qty;
      p.shares[company] = (p.shares[company] || 0) + qty;
      s.price = Math.round(price * 100) / 100;
      this.pushLog(`${p.name} 님이 ${target.name} 주식 ${qty}주 매수 (-${total})`);
      this.checkTakeover(company);
      return { ok: true, total };
    }
    if (side === 'sell') {
      if ((p.shares[company] || 0) < qty) return { ok: false, error: '보유 주식이 부족합니다.' };
      for (let i = 0; i < qty; i++) {
        price = Math.max(1, price * 0.99);
        total += price * 0.995;
      }
      total = Math.round(total);
      p.cash += total;
      p.shares[company] -= qty;
      if (p.shares[company] === 0) delete p.shares[company];
      s.float += qty;
      s.price = Math.round(price * 100) / 100;
      this.pushLog(`${p.name} 님이 ${target.name} 주식 ${qty}주 매도 (+${total})`);
      this.checkTakeover(company);
      return { ok: true, total };
    }
    return { ok: false, error: '잘못된 요청입니다.' };
  }

  /** 과반(51주 이상)을 모은 다른 플레이어가 있으면 경영권이 넘어간다. */
  controllerOf(companyId) {
    for (const p of this.players) {
      if (p.id !== companyId && (p.shares[companyId] || 0) >= TAKEOVER_SHARES) return p;
    }
    return null;
  }

  checkTakeover(companyId) {
    const target = this.player(companyId);
    const controller = this.controllerOf(companyId);
    const prev = this._controllers[companyId] || null;
    const now = controller ? controller.id : null;
    if (now !== prev) {
      this._controllers[companyId] = now;
      if (controller) {
        this.pushLog(
          `⚡ ${controller.name} 님이 ${target.name} 회사의 경영권을 인수했습니다! (${controller.shares[companyId]}주)`
        );
      } else if (prev) {
        this.pushLog(`${target.name} 회사의 경영권이 되돌아왔습니다.`);
      }
    }
  }

  /* ---------------------------------------------------------------- 정산 */

  /**
   * 매출을 배당·경영권 몫으로 나누고 나머지를 회사가 가져간다.
   * 실시간이라 매 tick 조금씩 흘러 들어간다.
   */
  payIncome(company, net) {
    if (net <= 0) {
      company.cash += net;
      company._incomeAccum += net;
      return;
    }
    let remain = net;
    for (const holder of this.players) {
      if (holder.id === company.id) continue;
      const n = holder.shares[company.id] || 0;
      if (n <= 0) continue;
      const amt = net * DIVIDEND_RATE * (n / TOTAL_SHARES);
      holder.cash += amt;
      holder._incomeAccum += amt;
      remain -= amt;
    }
    const controller = this.controllerOf(company.id);
    if (controller) {
      const cut = net * TAKEOVER_CUT;
      controller.cash += cut;
      controller._incomeAccum += cut;
      remain -= cut;
    }
    company.cash += remain;
    company._incomeAccum += remain;
  }

  /**
   * 실시간 진행. 서버가 일정 간격으로 호출한다.
   * @param {number} dt 경과 시간(초)
   */
  tick(dt) {
    if (this.ended || !(dt > 0)) return;
    this.elapsed += dt;

    // 1) 생산 — 자원 건물은 그냥 뽑고, 공장은 재료가 있는 만큼만 만든다
    for (const tile of this.map.tiles) {
      if (!tile.b || !tile.owner) continue;
      const owner = this.player(tile.owner);
      if (!owner) continue;
      const spec = BUILDINGS[tile.b];
      if (spec.out) {
        for (const [k, r] of Object.entries(spec.out)) owner.inv[k] += r * dt;
        continue;
      }
      const mode = tile.mode || 'machine';
      const prod = PRODUCTS[mode];
      let make = this.factoryRate(tile) * dt;
      for (const [k, n] of Object.entries(prod.recipe)) {
        make = Math.min(make, (owner.inv[k] || 0) / n);
      }
      tile.idle = make <= 1e-9;
      if (tile.idle) continue;
      for (const [k, n] of Object.entries(prod.recipe)) owner.inv[k] -= n * make;
      owner.inv[mode] += make;
    }

    // 2) 배송 — 노선이 지정된 공장은 생산 속도만큼 계속 도시로 흘려보낸다
    for (let idx = 0; idx < this.map.tiles.length; idx++) {
      const tile = this.map.tiles[idx];
      if (tile.b !== 'factory' || tile.route === null || !tile.owner) continue;
      const owner = this.player(tile.owner);
      const city = this.cities[tile.route];
      if (!owner || !city) continue;

      const mode = tile.mode || 'machine';
      const rate = this.factoryRate(tile);
      const dist = this.distToCity(idx, tile.route);
      let budget = rate * dt;

      // 품목을 바꿨을 때 남은 재고도 실려 나가도록 현재 품목부터 순서대로 처리한다
      const order = [mode, ...Object.keys(PRODUCTS).filter((k) => k !== mode)];
      for (const product of order) {
        if (budget <= 1e-9) break;
        const qty = Math.min(owner.inv[product] || 0, budget);
        if (qty <= 1e-9) continue;
        const unit = PRODUCTS[product].base * city.mod[product] * city.demand[product];
        const transport = transportQuote(dist, rate);
        // 운송비는 "초당" 기준이므로 실제로 보낸 양의 비율만큼만 물린다
        const cost = (transport.cost * qty) / rate;
        owner.inv[product] -= qty;
        this.payIncome(owner, unit * qty - cost);
        city.demand[product] = Math.max(0.35, city.demand[product] - qty * 0.06);
        budget -= qty;
      }
    }

    // 3) 자재 시세는 기준가로, 도시 수요는 100% 로 서서히 회복
    for (const m of Object.values(this.market)) {
      m.price = Math.round((m.price + (m.base - m.price) * 0.02 * dt) * 100) / 100;
    }
    for (const c of this.cities) {
      for (const k of Object.keys(c.demand)) {
        c.demand[k] = Math.min(1.25, c.demand[k] + (1 - c.demand[k]) * 0.05 * dt);
      }
    }

    // 4) 주가는 회사 순자산 기준 적정가를 따라간다
    for (const p of this.players) {
      const s = this.stocks[p.id];
      const fair = Math.max(1, this.netWorth(p) / TOTAL_SHARES);
      s.price = Math.round(Math.max(1, s.price + (fair - s.price) * 0.05 * dt) * 100) / 100;
    }

    // 5) 초당 수익 집계 (1초마다 갱신, 살짝 평활화해서 숫자가 튀지 않게)
    this._incomeTimer += dt;
    if (this._incomeTimer >= 1) {
      for (const p of this.players) {
        const measured = p._incomeAccum / this._incomeTimer;
        p.incomePerSec = Math.round((p.incomePerSec * 0.4 + measured * 0.6) * 100) / 100;
        p._incomeAccum = 0;
      }
      this._incomeTimer = 0;
    }

    // 6) 종료
    if (this.elapsed >= this.settings.duration) {
      this.finish();
    }
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    this.ranking = this.players
      .map((p) => ({ id: p.id, name: p.name, color: p.color, worth: this.netWorth(p) }))
      .sort((a, b) => b.worth - a.worth);
    this.pushLog(`🏆 게임 종료! 우승: ${this.ranking[0].name} (순자산 ${this.ranking[0].worth})`);
  }

  /* ---------------------------------------------------------------- 상태 */

  /** 아이템의 현재 평가액 (원자재는 시장가, 제품은 기준가) */
  itemValue(key) {
    if (this.market[key]) return this.market[key].price;
    if (PRODUCTS[key]) return PRODUCTS[key].base;
    return 0;
  }

  netWorth(p) {
    let v = p.cash;
    for (const [k, n] of Object.entries(p.inv)) v += this.itemValue(k) * n;
    for (const tile of this.map.tiles) {
      if (tile.owner === p.id) {
        v += TILE_TYPES[tile.t].price || 0;
        if (tile.b) v += BUILDINGS[tile.b].cost * 0.7;
        // 증설에 들인 돈도 자산으로 쳐 준다
        for (let lv = 1; lv < (tile.level || 1); lv++) {
          v += BUILDINGS.factory.upgradeCost * lv * 0.7;
        }
      }
    }
    for (const [cid, n] of Object.entries(p.shares)) {
      if (this.stocks[cid]) v += this.stocks[cid].price * n;
    }
    return Math.round(v);
  }

  /** 소수점이 지저분하지 않게 다듬어 보낸다 */
  static round2(n) {
    return Math.round(n * 100) / 100;
  }

  publicState(includeMap = true) {
    const state = {
      elapsed: Math.round(this.elapsed * 10) / 10,
      duration: this.settings.duration,
      remaining: Math.max(0, Math.round((this.settings.duration - this.elapsed) * 10) / 10),
      ended: this.ended,
      ranking: this.ranking,
      cities: this.cities,
      market: this.market,
      stocks: this.stocks,
      players: this.players.map((p) => {
        const inv = {};
        for (const [k, n] of Object.entries(p.inv)) inv[k] = Game.round2(n);
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          cash: Math.round(p.cash),
          inv,
          shares: p.shares,
          incomePerSec: p.incomePerSec,
          netWorth: this.netWorth(p),
          controller: (() => {
            const c = this.controllerOf(p.id);
            return c ? c.id : null;
          })(),
        };
      }),
    };
    // 맵은 땅을 사거나 건물을 지을 때만 바뀌므로 주기 갱신에서는 빼서 트래픽을 아낀다
    if (includeMap) {
      state.map = this.map;
      state.constants = {
        materials: MATERIALS,
        products: PRODUCTS,
        tileTypes: TILE_TYPES,
        buildings: BUILDINGS,
        totalShares: TOTAL_SHARES,
        takeoverShares: TAKEOVER_SHARES,
      };
    }
    return state;
  }
}

module.exports = {
  Game,
  MATERIALS,
  PRODUCTS,
  TILE_TYPES,
  BUILDINGS,
  TRANSPORT,
  TOTAL_SHARES,
  FOUNDER_SHARES,
  TAKEOVER_SHARES,
  DIVIDEND_RATE,
  TAKEOVER_CUT,
  transportQuote,
  chebyshev,
  generateMap,
  resourceCounts,
  MAP_W,
  MAP_H,
};
