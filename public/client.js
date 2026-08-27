'use strict';

/* ================================================================== 기본 설정 */

const socket = io({ transports: ['websocket', 'polling'] });

// 새로고침해도 같은 사람으로 인식되도록 브라우저에 id 를 저장한다
function myId() {
  let id = localStorage.getItem('company:playerId');
  if (!id) {
    id = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('company:playerId', id);
  }
  return id;
}

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fmt = (n) => Math.round(n).toLocaleString('ko-KR');

let S = null; // 서버가 보내주는 전체 상태
let selectedTile = null; // 선택한 타일 index
let activeTab = 'market';
let joined = false;

/* ================================================================== 입장 */

$('#join-name').value = localStorage.getItem('company:name') || '';
$('#join-room').value = localStorage.getItem('company:room') || '';

function join() {
  const name = $('#join-name').value.trim();
  const roomId = $('#join-room').value.trim();
  if (!name) return showJoinError('이름을 입력해 주세요.');
  if (!roomId) return showJoinError('방 코드를 입력해 주세요.');
  localStorage.setItem('company:name', name);
  localStorage.setItem('company:room', roomId);
  socket.emit('joinRoom', { roomId, name, playerId: myId() }, (res) => {
    if (!res || !res.ok) return showJoinError(res ? res.error : '접속에 실패했습니다.');
    joined = true;
    showJoinError('');
  });
}

function showJoinError(msg) {
  $('#join-error').textContent = msg || '';
}

$('#join-btn').addEventListener('click', join);
$('#join-room').addEventListener('keydown', (e) => e.key === 'Enter' && join());
$('#join-name').addEventListener('keydown', (e) => e.key === 'Enter' && join());

// 재접속(서버 재시작·네트워크 복구) 시 자동으로 다시 방에 들어간다
socket.on('connect', () => {
  if (joined) {
    socket.emit('joinRoom', {
      roomId: localStorage.getItem('company:room'),
      name: localStorage.getItem('company:name'),
      playerId: myId(),
    }, () => {});
  }
});

Voice.init(socket, myId());
Voice.onChange = () => {
  renderVoice();
  if (S) renderLobby();
};

/* ================================================================== 상태 수신 */

socket.on('state', (state) => {
  S = state;
  render();
});

function emit(event, payload, cb) {
  socket.emit(event, payload || {}, (res) => {
    if (res && !res.ok && res.error) toast(res.error);
    if (cb) cb(res);
  });
}

/* ------------------------------------------------------------------ 토스트 */

let toastTimer = null;
function toast(msg) {
  let node = $('#toast');
  if (!node) {
    node = el('div', '');
    node.id = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

/* ================================================================== 렌더링 */

function me() {
  if (!S || !S.game) return null;
  return S.game.players.find((p) => p.id === S.you) || null;
}

function render() {
  if (!S) return;
  const phase = S.phase;
  $('#screen-join').classList.toggle('hidden', joined);
  $('#screen-lobby').classList.toggle('hidden', !joined || phase !== 'lobby');
  $('#screen-game').classList.toggle('hidden', !joined || phase === 'lobby');

  if (phase === 'lobby') {
    renderLobby();
  } else {
    renderGame();
  }
  renderChat();
  renderVoice();
}

/* ------------------------------------------------------------------ 대기실 */

function renderLobby() {
  if (!S || S.phase !== 'lobby') return;
  $('#lobby-room-code').textContent = '#' + S.roomId;

  const list = $('#lobby-players');
  list.innerHTML = '';
  for (const p of S.roomPlayers) {
    const li = el('li', p.connected ? '' : 'off');
    li.textContent = p.name + (p.id === S.hostId ? ' 👑' : '') + (p.voice ? ' 🎙️' : '');
    if (p.id === S.you) li.classList.add('me');
    list.appendChild(li);
  }
  for (let i = S.roomPlayers.length; i < S.maxPlayers; i++) {
    list.appendChild(el('li', 'empty', '빈 자리'));
  }

  const isHost = S.you === S.hostId;
  const wrap = $('#lobby-settings');
  wrap.innerHTML = '';
  const labels = { startCash: '시작 자금', rounds: '라운드 수', roundTime: '라운드 시간(초)' };
  for (const [key, choices] of Object.entries(S.settingChoices)) {
    const row = el('div', 'setting-row');
    row.appendChild(el('span', 'setting-label', labels[key]));
    const group = el('div', 'setting-choices');
    for (const c of choices) {
      const btn = el('button', 'chip' + (S.settings[key] === c ? ' on' : ''), String(c));
      btn.disabled = !isHost;
      btn.addEventListener('click', () => emit('updateSettings', { [key]: c }));
      group.appendChild(btn);
    }
    row.appendChild(group);
    wrap.appendChild(row);
  }

  $('#lobby-start').classList.toggle('hidden', !isHost);
  $('#lobby-hint').textContent = isHost
    ? `${S.minPlayers}~${S.maxPlayers}명이 모이면 시작할 수 있습니다.`
    : '방장이 시작하기를 기다리는 중...';
}

$('#lobby-start').addEventListener('click', () => emit('startGame'));
$('#lobby-leave').addEventListener('click', () => {
  emit('leaveRoom');
  joined = false;
  S = null;
  $('#screen-join').classList.remove('hidden');
  $('#screen-lobby').classList.add('hidden');
  $('#screen-game').classList.add('hidden');
});

/* ------------------------------------------------------------------ 게임 HUD */

function renderGame() {
  if (!S || !S.game) return;
  const g = S.game;
  const my = me();

  $('#hud-round').textContent = g.ended ? '게임 종료' : `${g.round} / ${g.totalRounds} 라운드`;
  $('#hud-cash').textContent = my ? `💵 ${fmt(my.cash)}` : '관전 중';

  const inv = $('#hud-inv');
  inv.innerHTML = '';
  if (my) {
    const names = { iron: '⛏️철', oil: '🛢️유', grain: '🌾곡', machine: '⚙️기계', food: '🍞식품' };
    for (const [k, label] of Object.entries(names)) {
      inv.appendChild(el('span', 'inv-item', `${label} ${my.inv[k] || 0}`));
    }
  }

  const readyBtn = $('#ready-btn');
  if (my) {
    readyBtn.classList.remove('hidden');
    readyBtn.textContent = my.ready ? '준비 취소' : '준비 완료';
    readyBtn.classList.toggle('on', my.ready);
  } else {
    readyBtn.classList.add('hidden');
  }

  drawMap();
  renderTilePanel();
  renderTabs();
  renderResult();
}

$('#ready-btn').addEventListener('click', () => {
  const my = me();
  if (my) emit('ready', { ready: !my.ready });
});

// 남은 시간 표시
setInterval(() => {
  if (!S || !S.roundEndsAt || (S.game && S.game.ended)) {
    $('#hud-timer').textContent = '';
    return;
  }
  const left = Math.max(0, Math.ceil((S.roundEndsAt - Date.now()) / 1000));
  $('#hud-timer').textContent = `⏱ ${left}초`;
  $('#hud-timer').classList.toggle('urgent', left <= 10);
}, 300);

/* ------------------------------------------------------------------ 맵 */

const TILE_COLORS = {
  plain: '#2d3a2e',
  iron: '#4a4a55',
  oil: '#3a3040',
  farm: '#3d4a26',
  mountain: '#26262b',
  city: '#5a4a2a',
};
const TILE_ICONS = { iron: '⛏️', oil: '🛢️', farm: '🌱', mountain: '⛰️', city: '🏙️' };
const BUILDING_ICONS = { mine: '⚒️', rig: '🏗️', farm: '🚜', factory: '🏭' };

function drawMap() {
  const g = S.game;
  const canvas = $('#map');
  const wrap = $('#map-wrap');
  const size = Math.min(wrap.clientWidth, wrap.clientHeight) || 480;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const ts = size / g.map.w;
  ctx.clearRect(0, 0, size, size);
  ctx.font = `${Math.floor(ts * 0.42)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < g.map.tiles.length; i++) {
    const tile = g.map.tiles[i];
    const x = (i % g.map.w) * ts;
    const y = Math.floor(i / g.map.w) * ts;

    ctx.fillStyle = TILE_COLORS[tile.t] || '#333';
    ctx.fillRect(x, y, ts, ts);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, ts - 1, ts - 1);

    // 소유자 테두리
    if (tile.owner) {
      const owner = g.players.find((p) => p.id === tile.owner);
      if (owner) {
        ctx.strokeStyle = owner.color;
        ctx.lineWidth = Math.max(2, ts * 0.09);
        ctx.strokeRect(x + 2, y + 2, ts - 4, ts - 4);
      }
    }

    // 아이콘: 건물 > 지형
    const icon = tile.b ? BUILDING_ICONS[tile.b] : TILE_ICONS[tile.t];
    if (icon) ctx.fillText(icon, x + ts / 2, y + ts / 2 + 1);

    // 선택 표시
    if (selectedTile === i) {
      ctx.strokeStyle = '#ffd866';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x + 1.5, y + 1.5, ts - 3, ts - 3);
    }
  }

  // 도시 이름
  ctx.font = `${Math.max(9, Math.floor(ts * 0.26))}px sans-serif`;
  ctx.fillStyle = '#ffd866';
  for (const c of g.cities) {
    ctx.fillText(c.name, c.x * ts + ts / 2, c.y * ts + ts * 0.86);
  }
}

$('#map').addEventListener('click', (e) => {
  if (!S || !S.game) return;
  const canvas = $('#map');
  const rect = canvas.getBoundingClientRect();
  const ts = rect.width / S.game.map.w;
  const x = Math.floor((e.clientX - rect.left) / ts);
  const y = Math.floor((e.clientY - rect.top) / ts);
  const idx = y * S.game.map.w + x;
  if (idx < 0 || idx >= S.game.map.tiles.length) return;
  selectedTile = selectedTile === idx ? null : idx;
  drawMap();
  renderTilePanel();
});

window.addEventListener('resize', () => S && S.game && drawMap());

/* ------------------------------------------------------------------ 타일 패널 */

// 재렌더링 사이에 입력 값을 유지하기 위한 저장소
const uiKeep = {};
function keepInput(input, key) {
  input.dataset.keep = key;
  if (uiKeep[key] !== undefined) input.value = uiKeep[key];
  input.addEventListener('input', () => (uiKeep[key] = input.value));
  return input;
}
function keptValue(key, fallback) {
  const v = Number(uiKeep[key]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function renderTilePanel() {
  const panel = $('#tile-panel');
  if (selectedTile === null || !S || !S.game) {
    panel.classList.add('hidden');
    return;
  }
  const g = S.game;
  const C = g.constants;
  const tile = g.map.tiles[selectedTile];
  const my = me();
  panel.classList.remove('hidden');
  panel.innerHTML = '';

  const type = C.tileTypes[tile.t];
  const head = el('div', 'tp-head');
  head.appendChild(el('b', '', type.name));
  const closeBtn = el('button', 'tp-close', '✕');
  closeBtn.addEventListener('click', () => {
    selectedTile = null;
    drawMap();
    renderTilePanel();
  });
  head.appendChild(closeBtn);
  panel.appendChild(head);

  // 소유 정보
  if (tile.owner) {
    const owner = g.players.find((p) => p.id === tile.owner);
    const row = el('div', 'tp-row');
    const dot = el('span', 'dot');
    dot.style.background = owner ? owner.color : '#888';
    row.appendChild(dot);
    row.appendChild(el('span', '', owner ? owner.name + ' 소유' : '소유'));
    panel.appendChild(row);
  }

  // 도시 정보
  if (tile.t === 'city') {
    const c = g.cities.find((c2) => c2.y * g.map.w + c2.x === selectedTile);
    if (c) {
      panel.appendChild(el('div', 'tp-row', `🏙️ ${c.name}`));
      for (const key of ['machine', 'food']) {
        const p = C.products[key];
        const unit = p.base * c.mod[key] * c.demand[key];
        panel.appendChild(el('div', 'tp-row small', `${p.name} 시세 ${fmt(unit)} (수요 ${Math.round(c.demand[key] * 100)}%)`));
      }
    }
  }

  if (!my || g.ended) return;

  // 땅 구매
  if (!tile.owner && type.price) {
    const btn = el('button', 'primary wide', `땅 구매 (${type.price})`);
    btn.disabled = my.cash < type.price;
    btn.addEventListener('click', () => emit('buyTile', { idx: selectedTile }));
    panel.appendChild(btn);
  }

  // 건설
  if (tile.owner === S.you && !tile.b) {
    for (const [kind, spec] of Object.entries(C.buildings)) {
      if (spec.on !== tile.t) continue;
      const desc = spec.out
        ? Object.entries(spec.out).map(([k, n]) => `+${n} ${nameOf(k)}/라운드`).join(', ')
        : '제품 생산 (기계/식품)';
      const btn = el('button', 'primary wide', `${spec.name} 건설 (${spec.cost}) — ${desc}`);
      btn.disabled = my.cash < spec.cost;
      btn.addEventListener('click', () => emit('build', { idx: selectedTile, kind }));
      panel.appendChild(btn);
    }
  }

  // 공장: 생산 품목 + 배송
  if (tile.owner === S.you && tile.b === 'factory') {
    panel.appendChild(el('div', 'tp-row', '🏭 생산 품목'));
    const modeRow = el('div', 'tp-choices');
    for (const [key, p] of Object.entries(C.products)) {
      const recipe = Object.entries(p.recipe).map(([k, n]) => `${nameOf(k)}×${n}`).join('+');
      const btn = el('button', 'chip' + (tile.mode === key ? ' on' : ''), `${p.name} (${recipe})`);
      btn.addEventListener('click', () => emit('setFactoryMode', { idx: selectedTile, mode: key }));
      modeRow.appendChild(btn);
    }
    panel.appendChild(modeRow);

    // 배송 UI
    panel.appendChild(el('div', 'tp-row', '🚚 도시로 배송 판매'));
    const shipRow = el('div', 'ship-form');

    const prodSel = el('select');
    for (const [key, p] of Object.entries(C.products)) {
      const opt = el('option', '', `${p.name} (보유 ${my.inv[key] || 0})`);
      opt.value = key;
      prodSel.appendChild(opt);
    }
    keepInput(prodSel, 'ship-prod');

    const citySel = el('select');
    g.cities.forEach((c, i) => {
      const opt = el('option', '', c.name);
      opt.value = String(i);
      citySel.appendChild(opt);
    });
    keepInput(citySel, 'ship-city');

    const qty = el('input');
    qty.type = 'number';
    qty.min = '1';
    qty.placeholder = '수량';
    keepInput(qty, 'ship-qty');

    const quote = el('div', 'tp-row small quote', '');
    const updateQuote = () => {
      const q = Math.floor(Number(qty.value) || 0);
      if (q < 1) {
        quote.textContent = '';
        return;
      }
      socket.emit('quoteShip', {
        from: selectedTile,
        city: Number(citySel.value || 0),
        product: prodSel.value,
        qty: q,
      }, (res) => {
        if (res && res.ok) {
          quote.textContent = `거리 ${res.dist}칸 · ${res.transport.name} 운송비 ${fmt(res.transport.cost)} · 예상 순수익 ${fmt(res.net)}`;
        }
      });
    };
    [prodSel, citySel, qty].forEach((n) => n.addEventListener('input', updateQuote));

    const sendBtn = el('button', 'primary', '배송');
    sendBtn.addEventListener('click', () => {
      const q = Math.floor(Number(qty.value) || 0);
      if (q < 1) return toast('수량을 입력해 주세요.');
      emit('ship', { from: selectedTile, city: Number(citySel.value || 0), product: prodSel.value, qty: q });
    });

    shipRow.appendChild(prodSel);
    shipRow.appendChild(citySel);
    shipRow.appendChild(qty);
    shipRow.appendChild(sendBtn);
    panel.appendChild(shipRow);
    panel.appendChild(quote);
    updateQuote();
  }
}

function nameOf(key) {
  const C = S.game.constants;
  return (C.materials[key] && C.materials[key].name) || (C.products[key] && C.products[key].name) || key;
}

/* ------------------------------------------------------------------ 탭 */

document.querySelectorAll('#tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
    renderTabs();
  });
});

function renderTabs() {
  for (const t of ['market', 'stocks', 'company', 'log']) {
    $('#tab-' + t).classList.toggle('hidden', activeTab !== t);
  }
  if (activeTab === 'market') renderMarket();
  if (activeTab === 'stocks') renderStocks();
  if (activeTab === 'company') renderCompany();
  if (activeTab === 'log') renderLog();
}

/* ---------- 자재 시장 ---------- */

function renderMarket() {
  const g = S.game;
  const my = me();
  const box = $('#tab-market');
  box.innerHTML = '';
  box.appendChild(el('p', 'tab-hint', '사면 오르고 팔면 내립니다. 매 라운드 기준가로 서서히 돌아갑니다.'));

  for (const [key, m] of Object.entries(g.market)) {
    const row = el('div', 'trade-row');
    const info = el('div', 'trade-info');
    const diff = m.price - m.base;
    info.appendChild(el('b', '', nameOf(key)));
    const priceSpan = el('span', diff > 0.01 ? 'up' : diff < -0.01 ? 'down' : '', ` ${fmt(m.price)} `);
    info.appendChild(priceSpan);
    info.appendChild(el('span', 'small', `(기준 ${m.base})`));
    if (my) info.appendChild(el('span', 'small', ` 보유 ${my.inv[key] || 0}`));
    row.appendChild(info);

    if (my && !g.ended) {
      const controls = el('div', 'trade-controls');
      const qty = el('input');
      qty.type = 'number';
      qty.min = '1';
      qty.placeholder = '수량';
      keepInput(qty, 'mkt-' + key);
      const buy = el('button', 'buy', '매수');
      const sell = el('button', 'sell', '매도');
      buy.addEventListener('click', () => emit('trade', { mat: key, qty: keptValue('mkt-' + key, 1), side: 'buy' }));
      sell.addEventListener('click', () => emit('trade', { mat: key, qty: keptValue('mkt-' + key, 1), side: 'sell' }));
      controls.appendChild(qty);
      controls.appendChild(buy);
      controls.appendChild(sell);
      row.appendChild(controls);
    }
    box.appendChild(row);
  }

  // 도시 시세 요약
  box.appendChild(el('p', 'tab-hint', '제품은 공장을 선택해 도시로 배송·판매합니다.'));
  for (const c of g.cities) {
    const row = el('div', 'city-row');
    row.appendChild(el('b', '', `🏙️ ${c.name}`));
    for (const key of ['machine', 'food']) {
      const p = g.constants.products[key];
      const unit = p.base * c.mod[key] * c.demand[key];
      row.appendChild(el('span', 'small', `${p.name} ${fmt(unit)}`));
    }
    box.appendChild(row);
  }
}

/* ---------- 주식 ---------- */

function renderStocks() {
  const g = S.game;
  const my = me();
  const box = $('#tab-stocks');
  box.innerHTML = '';
  box.appendChild(el('p', 'tab-hint', `회사당 ${g.constants.totalShares}주 · ${g.constants.takeoverShares}주를 모으면 경영권 인수`));

  for (const p of g.players) {
    const s = g.stocks[p.id];
    const row = el('div', 'stock-row');

    const head = el('div', 'trade-info');
    const dot = el('span', 'dot');
    dot.style.background = p.color;
    head.appendChild(dot);
    head.appendChild(el('b', '', p.name + (p.id === S.you ? ' (나)' : '')));
    head.appendChild(el('span', '', ` ${fmt(s.price)}/주`));
    head.appendChild(el('span', 'small', ` 유통 ${s.float}주`));
    row.appendChild(head);

    // 보유 현황
    const holders = el('div', 'small holders');
    const parts = [];
    for (const holder of g.players) {
      const n = holder.shares[p.id] || 0;
      if (n > 0) parts.push(`${holder.name} ${n}주`);
    }
    holders.textContent = parts.join(' · ') || '보유자 없음';
    row.appendChild(holders);

    if (p.controller) {
      const ctrl = g.players.find((x) => x.id === p.controller);
      row.appendChild(el('div', 'takeover', `⚡ ${ctrl ? ctrl.name : '?'} 님이 경영권 보유 중`));
    }

    if (my && !g.ended) {
      const controls = el('div', 'trade-controls');
      const qty = el('input');
      qty.type = 'number';
      qty.min = '1';
      qty.placeholder = '주';
      keepInput(qty, 'stk-' + p.id);
      const buy = el('button', 'buy', '매수');
      const sell = el('button', 'sell', '매도');
      buy.addEventListener('click', () => emit('stockTrade', { company: p.id, qty: keptValue('stk-' + p.id, 1), side: 'buy' }));
      sell.addEventListener('click', () => emit('stockTrade', { company: p.id, qty: keptValue('stk-' + p.id, 1), side: 'sell' }));
      controls.appendChild(qty);
      controls.appendChild(buy);
      controls.appendChild(sell);
      row.appendChild(controls);
    }
    box.appendChild(row);
  }
}

/* ---------- 회사 현황 ---------- */

function renderCompany() {
  const g = S.game;
  const box = $('#tab-company');
  box.innerHTML = '';

  for (const p of g.players) {
    const card = el('div', 'company-card');
    const head = el('div', 'trade-info');
    const dot = el('span', 'dot');
    dot.style.background = p.color;
    head.appendChild(dot);
    head.appendChild(el('b', '', p.name + (p.id === S.you ? ' (나)' : '')));
    if (p.ready) head.appendChild(el('span', 'small ready-mark', ' ✅준비'));
    card.appendChild(head);
    card.appendChild(el('div', 'small', `현금 ${fmt(p.cash)} · 순자산 ${fmt(p.netWorth)}`));

    const invParts = Object.entries(p.inv)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${nameOf(k)} ${n}`);
    card.appendChild(el('div', 'small', invParts.length ? '재고: ' + invParts.join(', ') : '재고 없음'));

    // 보유 건물 수
    const counts = {};
    for (const tile of g.map.tiles) {
      if (tile.owner === p.id && tile.b) counts[tile.b] = (counts[tile.b] || 0) + 1;
    }
    const bParts = Object.entries(counts).map(([k, n]) => `${g.constants.buildings[k].name} ${n}`);
    card.appendChild(el('div', 'small', bParts.length ? '건물: ' + bParts.join(', ') : '건물 없음'));
    box.appendChild(card);
  }
}

/* ---------- 기록 ---------- */

function renderLog() {
  const list = $('#log-list');
  list.innerHTML = '';
  for (const item of S.log || []) {
    list.appendChild(el('div', 'log-item', item.text));
  }
  list.scrollTop = list.scrollHeight;
}

/* ------------------------------------------------------------------ 결과 */

let resultDismissed = false;
function renderResult() {
  const g = S.game;
  const overlay = $('#result-overlay');
  if (!g.ended || !g.ranking || resultDismissed) {
    overlay.classList.add('hidden');
    return;
  }
  overlay.classList.remove('hidden');
  const list = $('#result-list');
  list.innerHTML = '';
  g.ranking.forEach((r, i) => {
    const li = el('li', i === 0 ? 'winner' : '');
    const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}위`;
    li.textContent = `${medal} ${r.name} — 순자산 ${fmt(r.worth)}`;
    li.style.borderLeft = `4px solid ${r.color}`;
    list.appendChild(li);
  });
}
$('#result-close').addEventListener('click', () => {
  resultDismissed = true;
  $('#result-overlay').classList.add('hidden');
});

/* ------------------------------------------------------------------ 채팅 */

function renderChat() {
  if (!S) return;
  const list = $('#chat-list');
  const items = S.chat || [];
  list.innerHTML = '';
  for (const c of items.slice(-40)) {
    const row = el('div', 'chat-item');
    row.appendChild(el('b', '', c.name + ': '));
    row.appendChild(el('span', '', c.text));
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  emit('chat', { text });
  input.value = '';
});

/* ------------------------------------------------------------------ 음성 */

$('#voice-toggle').addEventListener('click', async () => {
  if (Voice.active) {
    Voice.stop();
  } else {
    const res = await Voice.start();
    if (!res.ok) toast(res.error);
  }
});

$('#voice-mute').addEventListener('click', () => Voice.toggleMute());

function renderVoice() {
  const toggle = $('#voice-toggle');
  const mute = $('#voice-mute');
  const status = $('#voice-status');
  toggle.textContent = Voice.active ? '🎙️ 음성 종료' : '🎙️ 음성 참여';
  mute.classList.toggle('hidden', !Voice.active);
  mute.textContent = Voice.muted ? '🔊 음소거 해제' : '🔇 음소거';

  if (Voice.active && S) {
    const speaking = [];
    for (const p of S.roomPlayers || []) {
      if (Voice.speaking.has(p.id)) speaking.push(p.name);
    }
    status.textContent = speaking.length ? '🗣 ' + speaking.join(', ') : '';
  } else {
    status.textContent = '';
  }
}
