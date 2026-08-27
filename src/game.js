'use strict';

/**
 * 컴퍼니 — 회사 경영 보드게임의 핵심 로직.
 * 서버가 모든 상태를 관리하고(권위 서버), 클라이언트는 행동 요청만 보낸다.
 *
 * 한 라운드 동안 플레이어는 자유롭게 행동(땅 구매/건설/거래/배송)하고,
 * 전원이 준비를 누르거나 시간이 다 되면 라운드가 정산된다:
 *   생산 → 배당/경영권 이익 → 시장 가격 회귀 → 도시 수요 회복 → 주가 갱신
 */

const MAP_W = 12;
const MAP_H = 12;
const TOTAL_SHARES = 100; // 회사당 발행 주식 수
const FOUNDER_SHARES = 40; // 창업자 보유분 (나머지 60주는 시장 유통)
const TAKEOVER_SHARES = 51; // 이만큼 모으면 경영권 인수
const DIVIDEND_RATE = 0.15; // 라운드 이익 중 배당 비율
const TAKEOVER_CUT = 0.25; // 경영권 보유자가 가져가는 이익 비율

const MATERIALS = {
  iron: { name: '철광석', base: 10 },
  oil: { name: '원유', base: 14 },
  grain: { name: '곡물', base: 6 },
};

const PRODUCTS = {
  machine: { name: '기계', base: 60, recipe: { iron: 2, oil: 1 } },
  food: { name: '식품', base: 30, recipe: { grain: 2 } },
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

// 건물. on = 지을 수 있는 타일 종류, out = 라운드당 생산량
const BUILDINGS = {
  mine: { name: '광산', cost: 100, on: 'iron', out: { iron: 4 } },
  rig: { name: '시추소', cost: 120, on: 'oil', out: { oil: 3 } },
  farm: { name: '농장', cost: 80, on: 'farm', out: { grain: 5 } },
  factory: { name: '공장', cost: 150, on: 'plain', batches: 2 },
};

const CITY_NAMES = ['서울', '부산', '광주', '대전'];

const PLAYER_COLORS = ['#e5484d', '#3b82f6', '#22a06b', '#f59e0b', '#8b5cf6', '#0ea5b7'];

/* ------------------------------------------------------------------ 운송 */

/**
 * 거리와 수량에 따라 가장 싼 운송 수단을 고른다.
 * 트럭: 고정비 없음, 근거리 유리 / 기차: 중거리 / 항공: 원거리 대량
 */
function transportQuote(dist, qty) {
  const options = [
    { method: 'truck', name: '트럭', cost: 3 * dist * qty },
    { method: 'train', name: '기차', cost: 15 + 1.5 * dist * qty },
    { method: 'air', name: '항공', cost: 50 + 0.8 * dist * qty },
  ];
  options.sort((a, b) => a.cost - b.cost);
  const best = options[0];
  return { method: best.method, name: best.name, cost: Math.round(best.cost) };
}

function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/* ------------------------------------------------------------------ 맵 생성 */

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function generateMap() {
  const tiles = new Array(MAP_W * MAP_H).fill(null).map(() => ({ t: 'plain', owner: null, b: null, mode: null }));
  const cities = [];

  // 도시 4곳: 사분면마다 하나씩, 약간의 흔들림을 준다
  const quads = [
    [2, 2], [MAP_W - 3, 2], [2, MAP_H - 3], [MAP_W - 3, MAP_H - 3],
  ];
  quads.forEach(([qx, qy], i) => {
    const x = Math.min(MAP_W - 1, Math.max(0, qx + randInt(3) - 1));
    const y = Math.min(MAP_H - 1, Math.max(0, qy + randInt(3) - 1));
    tiles[y * MAP_W + x].t = 'city';
    cities.push({
      x, y,
      name: CITY_NAMES[i],
      // 도시별 가격 특색 (0.9 ~ 1.2)
      mod: {
        machine: Math.round((0.9 + Math.random() * 0.3) * 100) / 100,
        food: Math.round((0.9 + Math.random() * 0.3) * 100) / 100,
      },
      // 수요 배수. 팔면 내려가고 매 라운드 회복
      demand: { machine: 1, food: 1 },
    });
  });

  // 자원/산 배치
  const scatter = (type, count) => {
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < 2000) {
      const idx = randInt(tiles.length);
      if (tiles[idx].t === 'plain') {
        tiles[idx].t = type;
        placed++;
      }
    }
  };
  scatter('mountain', 12);
  scatter('iron', 10);
  scatter('oil', 8);
  scatter('farm', 12);

  return { w: MAP_W, h: MAP_H, tiles, cities };
}

/* ------------------------------------------------------------------ 게임 */

class Game {
  /**
   * @param {Array<{id:string,name:string}>} playerInfos
   * @param {{startCash:number, rounds:number, roundTime:number}} settings
   */
  constructor(playerInfos, settings) {
    this.settings = settings;
    this.round = 1;
    this.ended = false;
    this.ranking = null;

    const map = generateMap();
    this.map = { w: map.w, h: map.h, tiles: map.tiles };
    this.cities = map.cities;

    // 자재 시장: 사면 오르고 팔면 내리고, 라운드마다 기준가로 회귀
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
      roundProfit: 0, // 이번 라운드 영업 손익 (배당 계산용)
      ready: false,
    }));

    // 주식 시장: 회사(플레이어)마다 주가와 유통 물량
    this.stocks = {};
    for (const p of this.players) {
      this.stocks[p.id] = {
        price: Math.max(1, settings.startCash / TOTAL_SHARES),
        float: TOTAL_SHARES - FOUNDER_SHARES,
      };
    }

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
    p.roundProfit -= type.price;
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
    if (tile.t !== spec.on) return { ok: false, error: `${spec.name}은(는) ${TILE_TYPES[spec.on].name}에만 지을 수 있습니다.` };
    if (p.cash < spec.cost) return { ok: false, error: '현금이 부족합니다.' };
    p.cash -= spec.cost;
    p.roundProfit -= spec.cost;
    tile.b = kind;
    if (kind === 'factory') tile.mode = 'machine';
    this.pushLog(`${p.name} 님이 ${spec.name}을(를) 건설했습니다.`);
    return { ok: true };
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

  /** 공장에서 도시로 제품을 배송해 판매한다. 운송비는 거리에 따라 자동 계산. */
  ship(pid, { from, city, product, qty }) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const tile = this.tile(from);
    const c = this.cities[city];
    const spec = PRODUCTS[product];
    qty = Math.floor(Number(qty) || 0);
    if (!p || !tile || !c || !spec) return { ok: false, error: '잘못된 요청입니다.' };
    if (tile.owner !== pid || tile.b !== 'factory') return { ok: false, error: '내 공장에서만 배송할 수 있습니다.' };
    if (qty < 1) return { ok: false, error: '수량을 입력해 주세요.' };
    if ((p.inv[product] || 0) < qty) return { ok: false, error: '재고가 부족합니다.' };

    const fx = from % this.map.w;
    const fy = Math.floor(from / this.map.w);
    const dist = Math.max(1, chebyshev(fx, fy, c.x, c.y));
    const quote = transportQuote(dist, qty);
    const unitPrice = spec.base * c.mod[product] * c.demand[product];
    const revenue = Math.round(unitPrice * qty);
    const net = revenue - quote.cost;

    p.inv[product] -= qty;
    p.cash += net;
    p.roundProfit += net;
    // 많이 팔수록 그 도시의 수요(가격)가 떨어진다
    c.demand[product] = Math.max(0.4, Math.round((c.demand[product] - 0.03 * qty) * 100) / 100);
    this.pushLog(
      `${p.name} 님이 ${spec.name} ${qty}개를 ${c.name}에 판매 (+${revenue}, ${quote.name} 운송비 -${quote.cost})`
    );
    return { ok: true, revenue, transport: quote };
  }

  /** 배송 전 견적 (수익/운송비 미리보기) */
  quoteShip(pid, { from, city, product, qty }) {
    const tile = this.tile(from);
    const c = this.cities[city];
    const spec = PRODUCTS[product];
    qty = Math.floor(Number(qty) || 0);
    if (!tile || !c || !spec || qty < 1) return { ok: false, error: '잘못된 요청입니다.' };
    const fx = from % this.map.w;
    const fy = Math.floor(from / this.map.w);
    const dist = Math.max(1, chebyshev(fx, fy, c.x, c.y));
    const quote = transportQuote(dist, qty);
    const revenue = Math.round(spec.base * c.mod[product] * c.demand[product] * qty);
    return { ok: true, dist, revenue, transport: quote, net: revenue - quote.cost };
  }

  /**
   * 자재 시장 거래. 한 개 살 때마다 가격이 조금씩 오르고(0.8%), 팔면 내린다.
   * 가격은 기준가의 0.4 ~ 2.5배 사이로 제한.
   */
  trade(pid, { mat, qty, side }) {
    if (this.ended) return { ok: false, error: '게임이 끝났습니다.' };
    const p = this.player(pid);
    const m = this.market[mat];
    qty = Math.floor(Number(qty) || 0);
    if (!p || !m) return { ok: false, error: '잘못된 요청입니다.' };
    if (qty < 1 || qty > 500) return { ok: false, error: '수량은 1~500 사이여야 합니다.' };

    const base = m.base;
    const lo = base * 0.4;
    const hi = base * 2.5;
    let price = m.price;
    let total = 0;

    // 매수는 호가보다 0.5% 비싸게, 매도는 0.5% 싸게 체결된다 (스프레드).
    // 이게 없으면 사고팔기를 반복해 돈을 무한히 불릴 수 있다.
    if (side === 'buy') {
      for (let i = 0; i < qty; i++) {
        total += price * 1.005;
        price = Math.min(hi, price * 1.008);
      }
      total = Math.round(total);
      if (p.cash < total) return { ok: false, error: `현금이 부족합니다. (필요 ${total})` };
      p.cash -= total;
      p.roundProfit -= total;
      p.inv[mat] += qty;
      m.price = Math.round(price * 100) / 100;
      this.pushLog(`${p.name} 님이 ${MATERIALS[mat].name} ${qty}개 매수 (-${total})`);
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
      p.roundProfit += total;
      p.inv[mat] -= qty;
      m.price = Math.round(price * 100) / 100;
      this.pushLog(`${p.name} 님이 ${MATERIALS[mat].name} ${qty}개 매도 (+${total})`);
      return { ok: true, total };
    }
    return { ok: false, error: '잘못된 요청입니다.' };
  }

  /**
   * 주식 거래. 시장 유통 물량(float)에서 사고, 팔면 유통 물량으로 돌아간다.
   * 체결마다 주가가 1%씩 움직인다.
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

    // 자재 시장과 같은 이유로 스프레드를 둔다 (매수 +0.5% / 매도 -0.5%)
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
    const prev = this._controllers ? this._controllers[companyId] : null;
    if (!this._controllers) this._controllers = {};
    const now = controller ? controller.id : null;
    if (now !== prev) {
      this._controllers[companyId] = now;
      if (controller) {
        this.pushLog(`⚡ ${controller.name} 님이 ${target.name} 회사의 경영권을 인수했습니다! (${controller.shares[companyId]}주)`);
      } else if (prev) {
        this.pushLog(`${target.name} 회사의 경영권이 되돌아왔습니다.`);
      }
    }
  }

  /* ---------------------------------------------------------------- 정산 */

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
      }
    }
    for (const [cid, n] of Object.entries(p.shares)) {
      if (this.stocks[cid]) v += this.stocks[cid].price * n;
    }
    return Math.round(v);
  }

  /** 라운드 종료 정산. Room 이 타이머/전원준비 시점에 호출한다. */
  resolveRound() {
    if (this.ended) return;

    // 1) 생산
    for (let idx = 0; idx < this.map.tiles.length; idx++) {
      const tile = this.map.tiles[idx];
      if (!tile.b || !tile.owner) continue;
      const owner = this.player(tile.owner);
      if (!owner) continue;
      const spec = BUILDINGS[tile.b];
      if (spec.out) {
        for (const [k, n] of Object.entries(spec.out)) owner.inv[k] += n;
      } else if (tile.b === 'factory') {
        const mode = tile.mode || 'machine';
        const recipe = PRODUCTS[mode].recipe;
        for (let b = 0; b < spec.batches; b++) {
          const can = Object.entries(recipe).every(([k, n]) => owner.inv[k] >= n);
          if (!can) break;
          for (const [k, n] of Object.entries(recipe)) owner.inv[k] -= n;
          owner.inv[mode] += 1;
        }
      }
    }

    // 2) 배당 + 경영권 이익 배분
    for (const company of this.players) {
      const profit = Math.max(0, company.roundProfit);
      if (profit > 0) {
        // 배당: 이익의 15% 를 100주 기준으로 나눠 보유자에게 지급
        const perShare = (profit * DIVIDEND_RATE) / TOTAL_SHARES;
        let paid = 0;
        for (const holder of this.players) {
          const n = holder.shares[company.id] || 0;
          if (n > 0 && holder.id !== company.id) {
            const amt = Math.round(perShare * n);
            const payable = Math.min(amt, Math.max(0, company.cash - paid));
            holder.cash += payable;
            paid += payable;
            if (payable > 0) this.pushLog(`💰 ${holder.name} 님이 ${company.name} 배당 +${payable} 수령`);
          }
        }
        company.cash -= paid;

        // 경영권 인수당한 회사는 이익의 25% 를 인수자에게 추가로 지급
        const controller = this.controllerOf(company.id);
        if (controller) {
          const cut = Math.min(Math.round(profit * TAKEOVER_CUT), Math.max(0, company.cash));
          if (cut > 0) {
            company.cash -= cut;
            controller.cash += cut;
            this.pushLog(`⚡ ${controller.name} 님이 ${company.name} 경영권 이익 +${cut} 수취`);
          }
        }
      }
      company.roundProfit = 0;
      company.ready = false;
    }

    // 3) 자재 가격은 기준가로 서서히 회귀
    for (const m of Object.values(this.market)) {
      m.price = Math.round((m.price + (m.base - m.price) * 0.08) * 100) / 100;
    }

    // 4) 도시 수요 회복
    for (const c of this.cities) {
      for (const k of Object.keys(c.demand)) {
        c.demand[k] = Math.min(1.25, Math.round((c.demand[k] + 0.08) * 100) / 100);
      }
    }

    // 5) 주가: 회사 순자산 기반 적정가로 30% 수렴
    for (const p of this.players) {
      const s = this.stocks[p.id];
      const fair = Math.max(1, this.netWorth(p) / TOTAL_SHARES);
      s.price = Math.round(Math.max(1, s.price + (fair - s.price) * 0.3) * 100) / 100;
    }

    // 6) 다음 라운드 또는 종료
    if (this.round >= this.settings.rounds) {
      this.ended = true;
      this.ranking = this.players
        .map((p) => ({ id: p.id, name: p.name, color: p.color, worth: this.netWorth(p) }))
        .sort((a, b) => b.worth - a.worth);
      this.pushLog(`🏆 게임 종료! 우승: ${this.ranking[0].name} (순자산 ${this.ranking[0].worth})`);
    } else {
      this.round += 1;
      this.pushLog(`── ${this.round} 라운드 시작 ──`);
    }
  }

  /* ---------------------------------------------------------------- 상태 */

  publicState() {
    return {
      round: this.round,
      totalRounds: this.settings.rounds,
      ended: this.ended,
      ranking: this.ranking,
      map: this.map,
      cities: this.cities,
      market: this.market,
      stocks: this.stocks,
      constants: {
        materials: MATERIALS,
        products: PRODUCTS,
        tileTypes: TILE_TYPES,
        buildings: BUILDINGS,
        totalShares: TOTAL_SHARES,
        takeoverShares: TAKEOVER_SHARES,
      },
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        cash: Math.round(p.cash),
        inv: p.inv,
        shares: p.shares,
        ready: p.ready,
        netWorth: this.netWorth(p),
        controller: (() => {
          const c = this.controllerOf(p.id);
          return c ? c.id : null;
        })(),
      })),
    };
  }
}

module.exports = {
  Game,
  MATERIALS,
  PRODUCTS,
  TILE_TYPES,
  BUILDINGS,
  TOTAL_SHARES,
  FOUNDER_SHARES,
  TAKEOVER_SHARES,
  transportQuote,
  chebyshev,
  generateMap,
  MAP_W,
  MAP_H,
};
