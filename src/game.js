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
// 주식 수를 넉넉히 두면 소량 거래로도 값이 튀지 않아 실제로 사고팔 만해진다.
// (주가 = 순자산 / 총주식수 이므로, 주식을 늘리면 그만큼 주당 가격은 내려간다)
const TOTAL_SHARES = 500; // 회사당 발행 주식 수
/*
 * 창업자는 지분을 거의 들고 시작하지 않는다. 자기 주식을 잔뜩 쥐고 있으면
 * 나중에 주가가 오를 때 그것만으로 승패가 갈려서, 회사를 잘 굴린 것보다
 * 주가 운이 더 중요해진다.
 *
 * 대신 나머지 주식은 처음부터 시장에 다 나와 있지 않고 시간이 지나며 조금씩
 * 상장된다. 그렇지 않으면 아무것도 안 하는 사람이 개장 직후 헐값에 남의 회사를
 * 통째로 사 두고 성장만 받아먹는다.
 */
const FOUNDER_SHARES = 50; // 창업자 초기 지분 (10%)
const INITIAL_FLOAT = 50; // 개장 시 시장에 나와 있는 물량
const LISTING_PORTION = 0.7; // 게임 시간의 이 비율에 걸쳐 나머지가 상장된다
// 외인·기관이 초당 굴리는 물량. 사람이 적어도 호가가 계속 움직이게 한다.
const NPC_ACTIVITY = 3;
const TAKEOVER_SHARES = 251; // 과반 — 이만큼 모으면 경영권 인수
// 1주 체결마다 움직이는 주가 비율. 지분을 크게 모을수록 평단가가 확 올라가서,
// 남의 회사를 싼값에 쓸어 담기 어렵게 만든다. (100주면 약 49%)
const STOCK_IMPACT = 0.004;
const STOCK_SPREAD = 0.005; // 매수는 비싸게, 매도는 싸게 체결되는 폭
// 배당은 주가에 비례해 초당 지급된다. 0.002 = 주가의 0.2%/초.
// 주가가 오를수록 배당도 커지고, 회사 현금에서 빠져나가므로 남에게 지분을
// 많이 내준 회사는 그만큼 성장이 느려진다. (되사면 그만큼 부담이 사라진다)
// 0.04%/초 = 10분에 약 24%. 이보다 높이면 지분을 많이 쥔 쪽이 배당만으로
// 본업 수익만큼 벌어들여서, 아무것도 안 하고 주식만 사 모으는 게 최선이 된다.
const DIVIDEND_YIELD = 0.0004;
const TAKEOVER_CUT = 0.25; // 경영권 보유자가 가져가는 매출 비율

const LOAN_INTEREST = 0.0008; // 대출 이자 (초당 0.08% — 10분이면 약 48%)
const LOAN_MIN_LIMIT = 600; // 자산이 없어도 이만큼은 빌릴 수 있다
const LOAN_RATIO = 0.5; // 총자산 대비 최대 대출 비율
const MAX_SHORT = 200; // 회사당 공매도 가능 주식 수
const SHORT_MARGIN = 0.5; // 공매도할 때 필요한 증거금 (거래대금 대비)
const RESALE_RATE = 0.7; // 건물을 은행에 되팔 때 돌려받는 비율
// 건물 유지비 — 초당 건축비의 0.25%. 지어만 두고 안 돌리면 돈이 샌다.
// 이게 있어야 무작정 확장하는 게 손해가 되고, 주가도 내려갈 이유가 생긴다.
const UPKEEP_RATE = 0.0025;
// 주가에 반영하는 수익력 — 초당 수익의 이 배수를 회사 가치로 쳐 준다.
// 매출이 꺾이면 자산이 그대로여도 주가가 떨어진다.
// 수익이 늘면 주가가 오르고 꺾이면 내려가야 하므로 넉넉히 잡는다.
const INCOME_MULTIPLE = 100;

// 자재 1개 체결마다 움직이는 시세 비율. 자동 매수가 초당 수십 개를 사기도 하므로
// 이 값이 크면 시세가 몇 초 만에 배로 튄다.
const MAT_IMPACT = 0.002;
const MAT_SPREAD = 0.005; // 매수는 비싸게, 매도는 싸게 (왕복 차익 방지)

const AUTO_BUY_RATE = 20; // 자동 매수로 1초에 채울 수 있는 최대 수량
const AUTO_BUY_RESERVE = 150; // 자동 매수가 남겨 두는 최소 운영자금

const MATERIALS = {
  iron: { name: '철광석', base: 10 },
  oil: { name: '원유', base: 14 },
  grain: { name: '곡물', base: 6 },
};

// 도시로 배송해서 파는 제품. rate = 공장 하나가 초당 만들어내는 개수
const PRODUCTS = {
  machine: { name: '기계', base: 60, recipe: { iron: 2, oil: 1 }, rate: 0.18 },
  food: { name: '식품', base: 30, recipe: { grain: 2 }, rate: 0.22 },
};

/**
 * 하이테크 제품. 도시로 보내지 않고 원자재처럼 재고로 쌓아 두었다가 시장에 판다.
 * 기계를 재료로 쓰므로, 기계 공장의 배송 노선을 꺼서 기계를 모아야 만들 수 있다.
 * 손이 많이 가는 대신 개당 마진이 크다.
 */
const HITECH = {
  semi: { name: '반도체', base: 200, recipe: { machine: 1, oil: 2 }, rate: 0.07 },
  car: { name: '자동차', base: 520, recipe: { machine: 2, semi: 1 }, rate: 0.035 },
};

/** 공장이 만들 수 있는 모든 것 */
const MAKEABLE = { ...PRODUCTS, ...HITECH };
/** 시장에서 사고팔 수 있는 모든 것 (원자재 + 하이테크) */
const TRADABLE = { ...MATERIALS, ...HITECH };

const ITEM_NAMES = {};
for (const [k, v] of Object.entries(MATERIALS)) ITEM_NAMES[k] = v.name;
for (const [k, v] of Object.entries(MAKEABLE)) ITEM_NAMES[k] = v.name;

// 타일 종류. price 가 없으면 구매 불가.
const TILE_TYPES = {
  plain: { name: '평지', price: 40 },
  iron: { name: '철광 지대', price: 80 },
  oil: { name: '유전 지대', price: 100 },
  farm: { name: '농지', price: 60 },
  mountain: { name: '산' },
  city: { name: '도시' },
};

/**
 * out = 초당 생산량. 공장은 PRODUCTS/HITECH 의 rate 를 따른다.
 *
 * 모든 건물은 MAX_LEVEL 까지 증설할 수 있고 생산량이 레벨에 비례한다.
 * 증설비는 "신축비의 1.2배 × 현재 레벨" 이라 위로 갈수록 비싸진다.
 * 생산은 레벨에 비례(선형)하고 비용은 제곱으로 늘기 때문에, 무한정 올리는 것보다
 * 땅을 더 사는 게 나은 지점이 자연스럽게 생긴다.
 */
const MAX_LEVEL = 6;
const BUILDINGS = {
  mine: { name: '광산', cost: 100, on: 'iron', out: { iron: 0.4 }, maxLevel: MAX_LEVEL, upgradeCost: 120 },
  rig: { name: '시추소', cost: 120, on: 'oil', out: { oil: 0.3 }, maxLevel: MAX_LEVEL, upgradeCost: 145 },
  farm: { name: '농장', cost: 80, on: 'farm', out: { grain: 0.5 }, maxLevel: MAX_LEVEL, upgradeCost: 95 },
  // 공장은 증설하면 물동량이 늘어 기차·항공 같은 대량 운송도 유리해진다
  factory: { name: '공장', cost: 150, on: 'plain', maxLevel: MAX_LEVEL, upgradeCost: 180 },
  // 임대 상가 — 재료도 배송도 필요 없이 그냥 임대료가 들어온다.
  // 대신 판 전체에 임대 건물이 늘수록 임대료가 떨어진다 (공급 과잉).
  rental: {
    name: '임대 상가',
    cost: 200,
    on: 'plain',
    rent: 3.5, // 공급이 없을 때 레벨당 초당 임대료
    maxLevel: MAX_LEVEL,
    upgradeCost: 240,
  },
};

// 임대 공급이 1 늘 때마다 임대료가 이 비율만큼 희석된다
const RENT_SATURATION = 0.06;

const CITY_NAMES = ['서울', '부산', '광주', '대전'];

/**
 * 무작위 사건. 원자재 시세와 도시 수요를 흔들어서
 * 한 번 짜 놓은 공급망이 계속 최적이지 않도록 만든다.
 */
const EVENT_KINDS = [
  { kind: 'mat-up', weight: 3 },
  { kind: 'mat-down', weight: 3 },
  { kind: 'city-boom', weight: 2 },
  { kind: 'city-slump', weight: 2 },
];
const EVENT_FIRST = 35; // 첫 사건까지 (초)
const EVENT_GAP = [40, 75]; // 사건 사이 간격
const EVENT_LEN = [25, 45]; // 사건 지속 시간

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
    iron: 16 + 4 * extra, // 철광 지대
    oil: 11 + 3 * extra, // 유전 지대
    farm: 18 + 4 * extra, // 농지
    mountain: 8, // 산 (지을 수 없는 장애물)
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
      // 사건으로 붙는 일시적 가격 배수 (평소 1)
      boost: 1,
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

    // 자재 시장: 사면 오르고 팔면 내리고, 시간이 지나면 기준가로 회귀.
    // base 는 사건에 따라 흔들리는 "현재 기준가", baseline 은 원래 값.
    // 원자재와 하이테크 제품이 같은 시장에서 거래된다
    this.market = {};
    for (const [key, m] of Object.entries(TRADABLE)) {
      // baseline 은 수요·공급에 따라 흐르고, eventMult 는 사건이 곱하는 배수.
      // base(회귀 목표) = baseline × eventMult
      this.market[key] = { price: m.base, base: m.base, baseline: m.base, eventMult: 1 };
    }

    this.players = playerInfos.map((info, i) => ({
      id: info.id,
      name: info.name,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      cash: settings.startCash,
      inv: { iron: 0, oil: 0, grain: 0, machine: 0, food: 0, semi: 0, car: 0 },
      // shares[대상 회사 id] = 보유 주식 수
      shares: { [info.id]: FOUNDER_SHARES },
      debt: 0,
      // shorts[대상 회사 id] = { shares, proceeds } — 공매도 미결제 잔고
      shorts: {},
      // autoBuy[자재] = 유지할 수량. 공장이 재료 없이 멈추지 않게 자동으로 사 온다.
      autoBuy: { iron: 0, oil: 0, grain: 0, semi: 0, car: 0 },
      incomePerSec: 0,
      _incomeAccum: 0, // 1초 단위로 집계해 incomePerSec 로 옮긴다
    }));

    // 주식 시장: 회사(플레이어)마다 주가, 유통 물량, 외부 투자자 보유분
    this.stocks = {};
    for (const p of this.players) {
      this.stocks[p.id] = {
        price: Math.max(0.05, settings.startCash / TOTAL_SHARES),
        float: INITIAL_FLOAT, // 지금 시장에 나와 있는 물량
        unissued: TOTAL_SHARES - FOUNDER_SHARES - INITIAL_FLOAT, // 아직 상장 전
        npc: 0, // 외부 투자자가 들고 있는 물량 (사람도 이걸 사 올 수 있다)
        mood: 1, // 시장 심리
        turnover: 0, // 누적 거래량
        volume: 0, // 최근 1초 거래량 (화면 표시용)
        _pending: 0, // 상장 대기 소수점 누적
        _lots: 0, // 외인·기관 주문 소수점 누적
      };
    }

    this.event = null;
    this._nextEventAt = EVENT_FIRST;
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
    tile.level = 1;
    if (kind === 'factory') {
      tile.mode = 'machine';
      // 가장 이득이 큰 도시로 배송 노선을 자동 지정해 준다 (바로 돌아가도록)
      const best = this.bestRoute(idx, tile.mode);
      tile.route = best ? best.city : null;
    }
    this.pushLog(`${p.name} 님이 ${spec.name}을(를) 건설했습니다.`);
    return { ok: true };
  }

  /** 땅과 그 위 건물의 평가액 (순자산 계산과 은행 매각가에 함께 쓴다) */
  tileValue(idx) {
    const tile = this.tile(idx);
    if (!tile) return 0;
    let v = TILE_TYPES[tile.t].price || 0;
    if (tile.b) {
      const spec = BUILDINGS[tile.b];
      v += spec.cost * RESALE_RATE;
      // 증설에 들인 돈도 자산으로 쳐 준다
      for (let lv = 1; lv < (tile.level || 1); lv++) {
        v += spec.upgradeCost * lv * RESALE_RATE;
      }
    }
    return Math.round(v);
  }

  /** 땅·건물을 은행에 판다. 언제든 팔 수 있지만 건물값은 일부만 돌려받는다. */
  sellTile(pid, idx) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const tile = this.tile(idx);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid) return { ok: false, error: '내 땅이 아닙니다.' };
    const value = this.tileValue(idx);
    p.cash += value;
    const what = tile.b ? BUILDINGS[tile.b].name : TILE_TYPES[tile.t].name;
    tile.owner = null;
    tile.b = null;
    tile.mode = null;
    tile.route = null;
    tile.level = undefined;
    tile.idle = false;
    tile.listPrice = null;
    this.pushLog(`${p.name} 님이 ${what}을(를) ${value}에 매각했습니다.`);
    return { ok: true, value };
  }

  /** 내 땅을 부동산 매물로 내놓는다. 다른 회사가 그 값에 사 갈 수 있다. */
  listTile(pid, idx, price) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const tile = this.tile(idx);
    price = Math.floor(Number(price) || 0);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid) return { ok: false, error: '내 땅이 아닙니다.' };
    if (price < 1 || price > 999999) return { ok: false, error: '가격이 잘못되었습니다.' };
    tile.listPrice = price;
    this.pushLog(`${p.name} 님이 ${TILE_TYPES[tile.t].name}을(를) ${price}에 내놓았습니다.`);
    return { ok: true };
  }

  unlistTile(pid, idx) {
    const p = this.player(pid);
    const tile = this.tile(idx);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid) return { ok: false, error: '내 땅이 아닙니다.' };
    tile.listPrice = null;
    return { ok: true };
  }

  /** 남이 내놓은 매물을 산다. 건물이 있으면 건물째로 넘어온다. */
  buyListedTile(pid, idx) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const tile = this.tile(idx);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    if (!tile.listPrice) return { ok: false, error: '매물이 아닙니다.' };
    if (tile.owner === pid) return { ok: false, error: '내 땅입니다.' };
    const seller = this.player(tile.owner);
    if (!seller) return { ok: false, error: '판매자를 찾을 수 없습니다.' };
    const price = tile.listPrice;
    if (p.cash < price) return { ok: false, error: `현금이 부족합니다. (필요 ${price})` };
    p.cash -= price;
    seller.cash += price;
    tile.owner = pid;
    tile.listPrice = null;
    tile.route = null; // 노선은 새 주인이 다시 정한다
    const what = tile.b ? BUILDINGS[tile.b].name : TILE_TYPES[tile.t].name;
    this.pushLog(`🏠 ${p.name} 님이 ${seller.name} 님의 ${what}을(를) ${price}에 사들였습니다.`);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- 자동 매수 */

  /**
   * 자재를 이 수량만큼 유지한다. 모자라면 매 초 알아서 사 온다.
   * 공장이 재료가 떨어져 멈추는 걸 막는 용도. 0 이면 끈다.
   */
  setAutoBuy(pid, mat, target) {
    const p = this.player(pid);
    if (!p || !this.market[mat]) return { ok: false, error: '잘못된 요청입니다.' };
    target = Math.floor(Number(target) || 0);
    if (target < 0 || target > 9999) return { ok: false, error: '수량이 잘못되었습니다.' };
    p.autoBuy[mat] = target;
    return { ok: true };
  }

  /** 유지 수량에 못 미치는 자재를 사 온다. 현금이 되는 만큼만 산다. */
  runAutoBuy() {
    for (const p of this.players) {
      for (const [mat, target] of Object.entries(p.autoBuy || {})) {
        if (!target || !this.market[mat]) continue;
        const short = target - (p.inv[mat] || 0);
        if (short < 1) continue;
        const m = this.market[mat];
        // 살 수 있는 만큼만 사되, 아무것도 못 하게 되지 않도록 운영자금은 남긴다.
        // (한 번에 몰아사면 시세도 밀어올린다)
        const spendable = p.cash - AUTO_BUY_RESERVE;
        if (spendable <= 0) continue;
        const afford = Math.floor(spendable / (m.price * 1.02));
        const qty = Math.min(Math.ceil(short), AUTO_BUY_RATE, afford, 500);
        if (qty > 0) this.trade(p.id, { mat, qty, side: 'buy' });
      }
    }
  }

  /* ---------------------------------------------------------------- 대출 */

  /** 총자산 대비 한도 — 지금 더 빌릴 수 있는 금액 */
  creditLimit(p) {
    const gross = this.netWorth(p) + p.debt; // 부채를 되돌린 총자산
    const cap = Math.max(LOAN_MIN_LIMIT, gross * LOAN_RATIO);
    return Math.max(0, Math.round(cap - p.debt));
  }

  borrow(pid, amount) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    amount = Math.floor(Number(amount) || 0);
    if (!p) return { ok: false, error: '잘못된 요청입니다.' };
    if (amount < 1) return { ok: false, error: '금액을 입력해 주세요.' };
    const limit = this.creditLimit(p);
    if (amount > limit) return { ok: false, error: `한도를 넘었습니다. (가능 ${limit})` };
    p.cash += amount;
    p.debt += amount;
    this.pushLog(`${p.name} 님이 ${amount}을(를) 대출했습니다.`);
    return { ok: true };
  }

  repay(pid, amount) {
    const p = this.player(pid);
    amount = Math.floor(Number(amount) || 0);
    if (!p) return { ok: false, error: '잘못된 요청입니다.' };
    if (p.debt <= 0) return { ok: false, error: '갚을 빚이 없습니다.' };
    if (amount < 1) return { ok: false, error: '금액을 입력해 주세요.' };
    const pay = Math.min(amount, Math.floor(p.debt), Math.floor(p.cash));
    if (pay < 1) return { ok: false, error: '현금이 부족합니다.' };
    p.cash -= pay;
    p.debt -= pay;
    if (p.debt < 0.5) p.debt = 0;
    this.pushLog(`${p.name} 님이 대출 ${pay}을(를) 상환했습니다.`);
    return { ok: true, paid: pay };
  }

  /* ---------------------------------------------------------------- 공매도 */

  shortShares(p, companyId) {
    const s = p.shorts[companyId];
    return s ? s.shares : 0;
  }

  /** 빌린 주식을 미리 판다. 주가가 내려가면 싸게 되사서 차익을 남긴다. */
  shortSell(pid, company, qty) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const target = this.player(company);
    const s = this.stocks[company];
    qty = Math.floor(Number(qty) || 0);
    if (!p || !target || !s) return { ok: false, error: '잘못된 요청입니다.' };
    if (company === pid) return { ok: false, error: '자기 회사는 공매도할 수 없습니다.' };
    if (qty < 1) return { ok: false, error: '수량을 입력해 주세요.' };
    const held = this.shortShares(p, company);
    if (held + qty > MAX_SHORT) {
      return { ok: false, error: `회사당 ${MAX_SHORT}주까지만 공매도할 수 있습니다. (현재 ${held}주)` };
    }

    let price = s.price;
    let proceeds = 0;
    for (let i = 0; i < qty; i++) {
      price = Math.max(0.01, price * (1 - STOCK_IMPACT));
      proceeds += price * (1 - STOCK_SPREAD);
    }
    proceeds = Math.round(proceeds);
    // 증거금 — 되살 돈이 아예 없으면 못 건다
    if (p.cash < proceeds * SHORT_MARGIN) {
      return { ok: false, error: `증거금이 부족합니다. (현금 ${Math.round(proceeds * SHORT_MARGIN)} 필요)` };
    }
    p.cash += proceeds;
    if (!p.shorts[company]) p.shorts[company] = { shares: 0, proceeds: 0 };
    p.shorts[company].shares += qty;
    p.shorts[company].proceeds += proceeds;
    s.price = Math.round(price * 100) / 100;
    this.pushLog(`📉 ${p.name} 님이 ${target.name} 주식 ${qty}주를 공매도했습니다 (+${proceeds})`);
    return { ok: true, proceeds };
  }

  /** 공매도 환매 — 빌린 주식을 되사서 갚는다 */
  coverShort(pid, company, qty) {
    const p = this.player(pid);
    const target = this.player(company);
    const s = this.stocks[company];
    qty = Math.floor(Number(qty) || 0);
    if (!p || !target || !s) return { ok: false, error: '잘못된 요청입니다.' };
    const pos = p.shorts[company];
    if (!pos || pos.shares < 1) return { ok: false, error: '공매도 잔고가 없습니다.' };
    if (qty < 1) return { ok: false, error: '수량을 입력해 주세요.' };
    qty = Math.min(qty, pos.shares);

    let price = s.price;
    let cost = 0;
    for (let i = 0; i < qty; i++) {
      cost += price * (1 + STOCK_SPREAD);
      price = price * (1 + STOCK_IMPACT);
    }
    cost = Math.round(cost);
    if (p.cash < cost) return { ok: false, error: `현금이 부족합니다. (필요 ${cost})` };

    // 평균 매도가와 비교해 손익을 기록해 둔다
    const avgIn = pos.proceeds / pos.shares;
    const profit = Math.round(avgIn * qty - cost);
    p.cash -= cost;
    pos.proceeds -= avgIn * qty;
    pos.shares -= qty;
    if (pos.shares < 1) delete p.shorts[company];
    s.price = Math.round(price * 100) / 100;
    this.pushLog(
      `📈 ${p.name} 님이 ${target.name} 공매도 ${qty}주를 환매했습니다 (${profit >= 0 ? '+' : ''}${profit})`
    );
    return { ok: true, cost, profit };
  }

  /** 다음 단계 증설에 드는 돈. 더 못 올리면 null */
  upgradeCost(tile) {
    if (!tile || !tile.b) return null;
    const spec = BUILDINGS[tile.b];
    const level = tile.level || 1;
    if (!spec.maxLevel || level >= spec.maxLevel) return null;
    return spec.upgradeCost * level;
  }

  /** 건물 증설 — 생산량이 레벨에 비례해 늘어난다 (공장은 물동량도 커져 운송 단가가 싸진다) */
  upgradeBuilding(pid, idx) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const tile = this.tile(idx);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid || !tile.b) return { ok: false, error: '내 건물이 아닙니다.' };
    const spec = BUILDINGS[tile.b];
    const cost = this.upgradeCost(tile);
    if (cost === null) return { ok: false, error: `최대 ${spec.maxLevel}단계까지 증설할 수 있습니다.` };
    if (p.cash < cost) return { ok: false, error: `현금이 부족합니다. (필요 ${cost})` };
    p.cash -= cost;
    tile.level = (tile.level || 1) + 1;
    this.pushLog(`${p.name} 님이 ${spec.name}을(를) ${tile.level}단계로 증설했습니다.`);
    return { ok: true };
  }

  /** 공장의 초당 생산량 (레벨 반영) */
  factoryRate(tile) {
    const spec = MAKEABLE[tile.mode || 'machine'];
    return spec.rate * (tile.level || 1);
  }

  /** 지도 전체의 임대 공급량 (레벨 합) */
  rentalSupply() {
    let n = 0;
    for (const tile of this.map.tiles) {
      if (tile.b === 'rental' && tile.owner) n += tile.level || 1;
    }
    return n;
  }

  /**
   * 임대 건물 하나가 지금 벌어들이는 초당 임대료.
   * 판 전체에 임대 건물이 많을수록 1채당 임대료가 떨어진다.
   */
  rentPerSec(tile, supply) {
    if (!tile || tile.b !== 'rental') return 0;
    const total = supply === undefined ? this.rentalSupply() : supply;
    const level = tile.level || 1;
    return (BUILDINGS.rental.rent * level) / (1 + total * RENT_SATURATION);
  }

  /** 자원 건물의 초당 생산량 (레벨 반영) */
  buildingOutput(tile) {
    const spec = BUILDINGS[tile.b];
    if (!spec || !spec.out) return {};
    const level = tile.level || 1;
    const out = {};
    for (const [k, r] of Object.entries(spec.out)) out[k] = r * level;
    return out;
  }

  setFactoryMode(pid, idx, mode) {
    const p = this.player(pid);
    const tile = this.tile(idx);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid || tile.b !== 'factory') return { ok: false, error: '내 공장이 아닙니다.' };
    if (!MAKEABLE[mode]) return { ok: false, error: '알 수 없는 생산 품목입니다.' };
    tile.mode = mode;
    // 하이테크로 바꾸면 배송 노선은 의미가 없다 (시장에서 판다)
    if (HITECH[mode]) tile.route = null;
    else if (tile.route === null) {
      const best = this.bestRoute(idx, mode);
      if (best) tile.route = best.city;
    }
    return { ok: true };
  }

  /** 공장의 배송 도시를 지정한다. null 이면 배송을 멈추고 재고가 쌓인다. */
  setRoute(pid, idx, city) {
    const p = this.player(pid);
    const tile = this.tile(idx);
    if (!p || !tile) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid || tile.b !== 'factory') return { ok: false, error: '내 공장이 아닙니다.' };
    if (HITECH[tile.mode]) return { ok: false, error: '하이테크 제품은 시장에서 팝니다.' };
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
    const spec = PRODUCTS[useMode]; // 하이테크는 도시로 안 가므로 견적도 없다
    const dist = this.distToCity(idx, cityIndex);
    if (!spec || dist === null) return null;
    const c = this.cities[cityIndex];
    // 증설한 공장일수록 물동량이 커서 대량 운송 수단이 유리해진다
    const rate = spec.rate * ((tile && tile.level) || 1);
    const transport = transportQuote(dist, rate);
    const revenue = spec.base * c.mod[useMode] * c.demand[useMode] * (c.boost || 1) * rate;
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
        total += price * (1 + MAT_SPREAD);
        price = Math.min(hi, price * (1 + MAT_IMPACT));
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
        price = Math.max(lo, price * (1 - MAT_IMPACT));
        total += price * (1 - MAT_SPREAD);
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
      const avail = this.availableShares(company);
      if (avail < qty) return { ok: false, error: `살 수 있는 물량이 ${avail}주뿐입니다.` };
      for (let i = 0; i < qty; i++) {
        total += price * (1 + STOCK_SPREAD);
        price = price * (1 + STOCK_IMPACT);
      }
      total = Math.round(total);
      if (p.cash < total) return { ok: false, error: `현금이 부족합니다. (필요 ${total})` };
      p.cash -= total;
      // 시장에 남은 물량부터 가져오고, 모자라면 외부 투자자에게서 사 온다
      const fromFloat = Math.min(s.float, qty);
      s.float -= fromFloat;
      s.npc -= qty - fromFloat;
      p.shares[company] = (p.shares[company] || 0) + qty;
      s.price = Math.round(price * 100) / 100;
      this.pushLog(`${p.name} 님이 ${target.name} 주식 ${qty}주 매수 (-${total})`);
      this.checkTakeover(company);
      return { ok: true, total };
    }
    if (side === 'sell') {
      if ((p.shares[company] || 0) < qty) return { ok: false, error: '보유 주식이 부족합니다.' };
      for (let i = 0; i < qty; i++) {
        price = Math.max(0.01, price * (1 - STOCK_IMPACT));
        total += price * (1 - STOCK_SPREAD);
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
   * 매출에서 경영권 몫을 떼고 나머지를 회사가 가져간다.
   * (배당은 매출이 아니라 주가를 따르므로 payDividends 에서 따로 처리한다)
   */
  payIncome(company, net) {
    if (net > 0) {
      const controller = this.controllerOf(company.id);
      if (controller) {
        const cut = net * TAKEOVER_CUT;
        controller.cash += cut;
        controller._incomeAccum += cut;
        net -= cut;
      }
    }
    company.cash += net;
    company._incomeAccum += net;
  }

  /**
   * 배당 — 주가에 비례해 주주에게 초당 지급하고 회사 현금에서 뺀다.
   * 자기 주식에는 나가지 않으므로, 되사면 배당 부담이 그만큼 줄어든다.
   */
  payDividends(dt) {
    for (const company of this.players) {
      const price = this.stocks[company.id].price;
      const claims = [];
      let due = 0;
      for (const holder of this.players) {
        if (holder.id === company.id) continue;
        const n = holder.shares[company.id] || 0;
        if (n <= 0) continue;
        const amt = price * n * DIVIDEND_YIELD * dt;
        claims.push({ holder, amt });
        due += amt;
      }
      if (due <= 0) continue;
      // 현금이 모자라면 있는 만큼만 나눠 준다 (회사가 마이너스로 가지 않게)
      const payable = Math.min(due, Math.max(0, company.cash));
      if (payable <= 0) continue;
      const ratio = payable / due;
      for (const { holder, amt } of claims) {
        const paid = amt * ratio;
        holder.cash += paid;
        holder._incomeAccum += paid;
      }
      company.cash -= payable;
      company._incomeAccum -= payable;
    }
  }

  /* ---------------------------------------------------------------- 시세 흐름 */

  /**
   * 자재 기준가를 판 전체의 수요·공급에 맞춰 천천히 움직인다.
   *
   * 이게 없으면 자재값이 늘 제자리라 사고팔아 봐야 잔돈만 오가고, 결국 다들
   * 주식만 하게 된다. 공장이 늘수록 원자재가 귀해져 값이 오르므로
   * "쌀 때 사서 비쌀 때 판다" 가 실제로 통하게 된다.
   */
  updateBaselines(dt) {
    const supply = {};
    const demand = {};
    for (const tile of this.map.tiles) {
      if (!tile.b || !tile.owner) continue;
      const spec = BUILDINGS[tile.b];
      if (spec.out) {
        for (const [k, r] of Object.entries(this.buildingOutput(tile))) supply[k] = (supply[k] || 0) + r;
      } else if (tile.b === 'factory') {
        const rate = this.factoryRate(tile);
        for (const [k, n] of Object.entries(MAKEABLE[tile.mode || 'machine'].recipe)) {
          demand[k] = (demand[k] || 0) + n * rate;
        }
      }
    }

    for (const [key, m] of Object.entries(this.market)) {
      const origin = TRADABLE[key].base;
      if (MATERIALS[key]) {
        const s = supply[key] || 0;
        const d = demand[key] || 0;
        // -1(공급 과잉) ~ +1(품귀)
        const pressure = (d - s) / Math.max(0.4, s + d);
        // 수급 불균형에만 반응한다. 판이 커진다고 값이 계속 오르게 두면
        // 기준가가 한 방향으로만 흘러 생산하는 쪽 마진만 깎인다.
        const target = origin * Math.min(1.8, Math.max(0.6, 1 + pressure * 0.8));
        m.baseline += (target - m.baseline) * 0.05 * dt;
      }
      // 사건 배수는 따로 곱해 둔다 (기준가가 흐르는 중에도 사건이 겹칠 수 있다)
      m.base = Math.round(m.baseline * (m.eventMult || 1) * 100) / 100;
    }
  }

  /* ---------------------------------------------------------------- 사건 */

  /** 원자재 시세와 도시 수요를 흔드는 무작위 사건을 하나 일으킨다 */
  startEvent() {
    const total = EVENT_KINDS.reduce((s, e) => s + e.weight, 0);
    let roll = Math.random() * total;
    let pick = EVENT_KINDS[0];
    for (const e of EVENT_KINDS) {
      roll -= e.weight;
      if (roll <= 0) {
        pick = e;
        break;
      }
    }
    const len = EVENT_LEN[0] + Math.random() * (EVENT_LEN[1] - EVENT_LEN[0]);
    const until = this.elapsed + len;

    if (pick.kind === 'mat-up' || pick.kind === 'mat-down') {
      const keys = Object.keys(this.market);
      const mat = keys[randInt(keys.length)];
      const up = pick.kind === 'mat-up';
      // 사건은 흔들되 시세가 몇 배로 튀지는 않게 (±30~55% 선)
      const mult = up ? 1.3 + Math.random() * 0.25 : 0.6 + Math.random() * 0.15;
      const m = this.market[mat];
      m.eventMult = mult;
      m.base = Math.round(m.baseline * mult * 100) / 100; // 바로 반영
      const name = TRADABLE[mat].name; // 원자재뿐 아니라 하이테크에도 사건이 붙는다
      this.event = {
        kind: pick.kind,
        target: mat,
        mult: Math.round(mult * 100) / 100,
        until,
        icon: up ? '📈' : '📉',
        text: up
          ? `${name} 품귀 — 시세가 ${Math.round(mult * 100)}% 수준으로 치솟습니다`
          : `${name} 공급 과잉 — 시세가 ${Math.round(mult * 100)}% 수준으로 떨어집니다`,
      };
    } else {
      const ci = randInt(this.cities.length);
      const boom = pick.kind === 'city-boom';
      const mult = boom ? 1.35 + Math.random() * 0.25 : 0.6 + Math.random() * 0.15;
      this.cities[ci].boost = Math.round(mult * 100) / 100;
      const name = this.cities[ci].name;
      this.event = {
        kind: pick.kind,
        target: ci,
        mult: Math.round(mult * 100) / 100,
        until,
        icon: boom ? '🎉' : '🌧️',
        text: boom
          ? `${name} 호황 — 제품값이 ${Math.round(mult * 100)}% 수준으로 뜁니다`
          : `${name} 불황 — 제품값이 ${Math.round(mult * 100)}% 수준으로 주저앉습니다`,
      };
    }
    this.pushLog(`${this.event.icon} ${this.event.text}`);
  }

  endEvent() {
    if (!this.event) return;
    const e = this.event;
    if (e.kind === 'mat-up' || e.kind === 'mat-down') {
      const m = this.market[e.target];
      m.eventMult = 1;
      m.base = Math.round(m.baseline * 100) / 100;
    } else {
      this.cities[e.target].boost = 1;
    }
    this.pushLog(`${e.icon} 사건이 진정되었습니다.`);
    this.event = null;
    this._nextEventAt = this.elapsed + EVENT_GAP[0] + Math.random() * (EVENT_GAP[1] - EVENT_GAP[0]);
  }

  /* ---------------------------------------------------------------- 외부 투자자 */

  /**
   * 사람이 아무도 주식을 만지지 않아도 주가가 움직이도록 외부 투자자를 흉내낸다.
   * 적정가보다 싸면 사들이고(유통 물량이 줄고 주가가 오른다), 늘 잔물결이 있다.
   */
  tradeNpc(dt) {
    for (const p of this.players) {
      const s = this.stocks[p.id];

      // 시장 심리 — 제자리(1)로 돌아오려 하지만 계속 흔들린다.
      // 이게 없으면 주가가 순자산을 그대로 따라가서 오르기만 한다.
      // 회사가 커지는 속도보다 빠르게 흔들려야 실제로 하락 구간이 생긴다.
      s.mood += (1 - s.mood) * 0.08 * dt + (Math.random() - 0.5) * 0.28 * Math.sqrt(dt);
      s.mood = Math.min(1.7, Math.max(0.5, s.mood));

      // 본업 가치 + 수익력. 주식을 사 모은다고 자기 주가가 오르지는 않고,
      // 반대로 매출이 꺾이면 자산이 그대로여도 주가가 내려간다.
      const worth = this.operatingWorth(p) + p.incomePerSec * INCOME_MULTIPLE;
      const fair = Math.max(0.05, worth / TOTAL_SHARES);
      const target = fair * s.mood;
      const gap = (target - s.price) / s.price;

      /*
       * 외인·기관 매매. 사람이 몇 명 없어도 호가가 계속 움직이도록
       * 매 초 꾸준히 사고판다. 사람 거래와 똑같이 체결마다 주가를 밀기 때문에
       * 거래가 곧 시세 변동이 된다.
       * 저평가면 매수 쪽으로, 고평가면 매도 쪽으로 기울되 한쪽으로만 쏠리지는 않는다.
       */
      s._lots += NPC_ACTIVITY * dt * (0.4 + Math.random() * 1.2);
      const lots = Math.floor(s._lots);
      if (lots > 0) {
        s._lots -= lots;
        const buyBias = 0.5 + Math.max(-0.4, Math.min(0.4, gap * 2));
        if (Math.random() < buyBias) {
          const n = Math.min(lots, s.float);
          if (n > 0) {
            s.float -= n;
            s.npc += n;
            s.price *= Math.pow(1 + STOCK_IMPACT, n);
            s.turnover += n;
          }
        } else {
          const n = Math.min(lots, s.npc);
          if (n > 0) {
            s.npc -= n;
            s.float += n;
            s.price *= Math.pow(1 - STOCK_IMPACT, n);
            s.turnover += n;
          }
        }
      }

      // 거래가 없어도 적정가를 향해 완만히 돌아간다
      s.price = Math.round(Math.max(0.05, s.price + (target - s.price) * 0.08 * dt) * 100) / 100;
    }
  }

  /** 지금 살 수 있는 물량 (시장에 남은 것 + 외부 투자자가 내놓을 수 있는 것) */
  availableShares(companyId) {
    const s = this.stocks[companyId];
    return s ? s.float + s.npc : 0;
  }

  /**
   * 미발행 주식을 시간에 걸쳐 시장에 푼다.
   * 개장 직후에 물량이 적으므로, 회사가 크기 전에 헐값으로 지분을 쓸어 담을 수 없다.
   */
  releaseShares(dt) {
    const span = Math.max(1, this.settings.duration * LISTING_PORTION);
    const rate = (TOTAL_SHARES - FOUNDER_SHARES - INITIAL_FLOAT) / span;
    for (const s of Object.values(this.stocks)) {
      if (s.unissued <= 0) continue;
      s._pending += rate * dt;
      const n = Math.min(Math.floor(s._pending), s.unissued);
      if (n > 0) {
        s.unissued -= n;
        s.float += n;
        s._pending -= n;
      }
    }
  }

  /** 어떤 회사가 지금 초당 물고 있는 배당 총액 (UI 표시용) */
  dividendLoad(companyId) {
    const price = this.stocks[companyId].price;
    let n = 0;
    for (const holder of this.players) {
      if (holder.id === companyId) continue;
      n += holder.shares[companyId] || 0;
    }
    return Math.round(price * n * DIVIDEND_YIELD * 100) / 100;
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
        for (const [k, r] of Object.entries(this.buildingOutput(tile))) owner.inv[k] += r * dt;
        continue;
      }
      if (tile.b !== 'factory') continue; // 임대 상가는 아래 임대료에서 따로 처리한다
      const mode = tile.mode || 'machine';
      const prod = MAKEABLE[mode];
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
      // 하이테크 제품은 도시로 보내지 않는다 (시장에서 재고로 판다)
      if (HITECH[mode]) continue;
      const rate = this.factoryRate(tile);
      const dist = this.distToCity(idx, tile.route);
      let budget = rate * dt;

      // 품목을 바꿨을 때 남은 재고도 실려 나가도록 현재 품목부터 순서대로 처리한다
      const order = [mode, ...Object.keys(PRODUCTS).filter((k) => k !== mode)];
      for (const product of order) {
        if (budget <= 1e-9) break;
        const qty = Math.min(owner.inv[product] || 0, budget);
        if (qty <= 1e-9) continue;
        const unit =
          PRODUCTS[product].base * city.mod[product] * city.demand[product] * (city.boost || 1);
        const transport = transportQuote(dist, rate);
        // 운송비는 "초당" 기준이므로 실제로 보낸 양의 비율만큼만 물린다
        const cost = (transport.cost * qty) / rate;
        owner.inv[product] -= qty;
        this.payIncome(owner, unit * qty - cost);
        city.demand[product] = Math.max(0.35, city.demand[product] - qty * 0.06);
        budget -= qty;
      }
    }

    // 2-b) 임대료 — 재료도 배송도 필요 없지만, 임대 건물이 늘수록 1채당 수입이 준다
    const rentSupply = this.rentalSupply();
    if (rentSupply > 0) {
      for (const tile of this.map.tiles) {
        if (tile.b !== 'rental' || !tile.owner) continue;
        const owner = this.player(tile.owner);
        if (owner) this.payIncome(owner, this.rentPerSec(tile, rentSupply) * dt);
      }
    }

    // 3) 배당 — 주가에 비례해 주주에게 흘러간다
    this.payDividends(dt);

    // 4) 기준가는 수요·공급을 따라 흐르고, 시세는 그 기준가로 서서히 회귀한다
    this.updateBaselines(dt);
    // 거래로 밀린 시세는 기준가로 제법 빠르게 돌아온다 (한 번 튄 값이 오래 가지 않게)
    for (const m of Object.values(this.market)) {
      m.price = Math.round((m.price + (m.base - m.price) * 0.06 * dt) * 100) / 100;
    }
    for (const c of this.cities) {
      for (const k of Object.keys(c.demand)) {
        c.demand[k] = Math.min(1.25, c.demand[k] + (1 - c.demand[k]) * 0.05 * dt);
      }
    }

    // 4-b) 건물 유지비 — 돌아가든 놀든 매 초 나간다.
    //      놀리는 공장이 손해가 되고, 과잉 확장은 회사를 갉아먹는다.
    for (const tile of this.map.tiles) {
      if (!tile.b || !tile.owner) continue;
      const owner = this.player(tile.owner);
      if (!owner) continue;
      const spec = BUILDINGS[tile.b];
      const fee = spec.cost * (tile.level || 1) * UPKEEP_RATE * dt;
      owner.cash -= fee;
      owner._incomeAccum -= fee;
    }

    // 5) 대출 이자 — 현금이 모자라면 원금에 붙는다 (복리로 불어난다)
    for (const p of this.players) {
      if (p.debt <= 0) continue;
      const interest = p.debt * LOAN_INTEREST * dt;
      const fromCash = Math.min(interest, Math.max(0, p.cash));
      p.cash -= fromCash;
      p.debt += interest - fromCash;
      p._incomeAccum -= interest;
    }

    // 6) 주식 — 미발행 물량이 조금씩 상장되고, 외부 투자자가 거래하며 주가가 오르내린다
    this.releaseShares(dt);
    this.tradeNpc(dt);

    // 7) 사건 — 원자재 시세와 도시 수요를 흔든다
    if (this.event) {
      if (this.elapsed >= this.event.until) this.endEvent();
    } else if (this.elapsed >= this._nextEventAt) {
      this.startEvent();
    }

    // 8) 초당 수익 집계 + 자재 자동 매수 (1초마다)
    this._incomeTimer += dt;
    if (this._incomeTimer >= 1) {
      this.runAutoBuy();
      // 최근 1초 거래량을 갈무리해 화면에 보여준다
      for (const s of Object.values(this.stocks)) {
        s.volume = Math.round(s.turnover / this._incomeTimer);
        s.turnover = 0;
      }
      for (const p of this.players) {
        const measured = p._incomeAccum / this._incomeTimer;
        p.incomePerSec = Math.round((p.incomePerSec * 0.4 + measured * 0.6) * 100) / 100;
        p._incomeAccum = 0;
      }
      this._incomeTimer = 0;
    }

    // 9) 종료
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

  /** 아이템의 현재 평가액 (시장에서 거래되는 건 시장가, 도시 제품은 기준가) */
  itemValue(key) {
    if (this.market[key]) return this.market[key].price;
    if (PRODUCTS[key]) return PRODUCTS[key].base;
    return 0;
  }

  /**
   * 주가를 매길 때 쓰는 "본업 가치" — 현금·재고·땅·건물에서 빚을 뺀 값.
   *
   * 남의 주식 보유분은 일부러 뺀다. 넣으면 A 가 B 주식을 사는 순간 A 의 순자산이
   * 늘고, 그러면 A 의 주가도 올라 서로 사 주기만 해도 모두의 주가가 부풀어 오른다.
   * 그 고리를 끊어야 주가가 실제로 회사를 키운 만큼만 오른다.
   */
  operatingWorth(p) {
    let v = p.cash;
    for (const [k, n] of Object.entries(p.inv)) v += this.itemValue(k) * n;
    for (let i = 0; i < this.map.tiles.length; i++) {
      if (this.map.tiles[i].owner === p.id) v += this.tileValue(i);
    }
    v -= p.debt;
    for (const [cid, pos] of Object.entries(p.shorts)) {
      if (this.stocks[cid]) v -= this.stocks[cid].price * pos.shares;
    }
    return v;
  }

  /**
   * 최종 순위용 자산 = 내 회사 가치 − 남이 가진 내 지분 + 내가 가진 남의 지분.
   *
   * 자기 주식을 그냥 더하면 회사 자산을 두 번 세는 셈이라 점수가 부풀어 오른다.
   * 이렇게 두면 남이 내 회사를 사들일수록 내 몫이 줄고 그만큼 상대 몫이 늘어난다.
   * (외부 투자자 보유분은 사람 사이의 계산이 아니므로 건드리지 않는다)
   */
  netWorth(p) {
    let v = this.operatingWorth(p);
    for (const other of this.players) {
      if (other.id === p.id) continue;
      const mine = other.shares[p.id] || 0;
      if (mine) v -= this.stocks[p.id].price * mine;
      const theirs = p.shares[other.id] || 0;
      if (theirs) v += this.stocks[other.id].price * theirs;
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
      rentalSupply: this.rentalSupply(),
      duration: this.settings.duration,
      remaining: Math.max(0, Math.round((this.settings.duration - this.elapsed) * 10) / 10),
      ended: this.ended,
      ranking: this.ranking,
      cities: this.cities,
      market: this.market,
      stocks: this.stocks,
      event: this.event,
      players: this.players.map((p) => {
        const inv = {};
        for (const [k, n] of Object.entries(p.inv)) inv[k] = Game.round2(n);
        const shorts = {};
        for (const [cid, pos] of Object.entries(p.shorts)) {
          shorts[cid] = { shares: pos.shares, avg: Game.round2(pos.proceeds / pos.shares) };
        }
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          cash: Math.round(p.cash),
          inv,
          shares: p.shares,
          debt: Math.round(p.debt),
          credit: this.creditLimit(p),
          shorts,
          autoBuy: p.autoBuy,
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
        hitech: HITECH,
        tileTypes: TILE_TYPES,
        buildings: BUILDINGS,
        totalShares: TOTAL_SHARES,
        takeoverShares: TAKEOVER_SHARES,
        dividendYield: DIVIDEND_YIELD,
        takeoverCut: TAKEOVER_CUT,
        loanInterest: LOAN_INTEREST,
        maxShort: MAX_SHORT,
        resaleRate: RESALE_RATE,
        rentSaturation: RENT_SATURATION,
      };
    }
    return state;
  }
}

module.exports = {
  Game,
  MATERIALS,
  PRODUCTS,
  HITECH,
  MAKEABLE,
  TRADABLE,
  TILE_TYPES,
  BUILDINGS,
  TRANSPORT,
  TOTAL_SHARES,
  FOUNDER_SHARES,
  INITIAL_FLOAT,
  TAKEOVER_SHARES,
  STOCK_IMPACT,
  STOCK_SPREAD,
  DIVIDEND_YIELD,
  TAKEOVER_CUT,
  LOAN_INTEREST,
  LOAN_MIN_LIMIT,
  UPKEEP_RATE,
  INCOME_MULTIPLE,
  MAX_SHORT,
  RESALE_RATE,
  AUTO_BUY_RATE,
  AUTO_BUY_RESERVE,
  transportQuote,
  chebyshev,
  generateMap,
  resourceCounts,
  MAP_W,
  MAP_H,
};
