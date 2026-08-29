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

const ME = myId();

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fmt = (n) => Math.round(n).toLocaleString('ko-KR');
/** 재고처럼 잘게 쌓이는 값은 소수 한 자리까지 */
const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
/** 주가처럼 작은 값은 두 자리까지 (총주식수가 많아 주당 가격이 작다) */
const fmt2 = (n) =>
  (Math.round(n * 100) / 100).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

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
  socket.emit('joinRoom', { roomId, name, playerId: ME }, (res) => {
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
    socket.emit(
      'joinRoom',
      {
        roomId: localStorage.getItem('company:room'),
        name: localStorage.getItem('company:name'),
        playerId: ME,
      },
      () => {}
    );
  }
});

Voice.init(socket, ME);
Voice.onChange = () => {
  renderVoice();
  if (S && S.phase === 'lobby') renderLobby();
};

/* ================================================================== 상태 수신 */

socket.on('state', (st) => {
  // 실시간 갱신은 트래픽을 아끼려고 맵·상수·채팅·기록을 뺀 채로 온다.
  // 빠진 부분은 직전 상태에서 그대로 이어 쓴다.
  if (S) {
    if (st.game && S.game) {
      if (!st.game.map) st.game.map = S.game.map;
      if (!st.game.constants) st.game.constants = S.game.constants;
    }
    if (!st.chat) st.chat = S.chat;
    if (!st.log) st.log = S.log;
  }
  st.you = ME;
  const prevPhase = S ? S.phase : null;
  S = st;
  if (prevPhase !== st.phase) {
    // 새 게임이 시작되면 화면 조각과 주가 기록을 모두 새로 만든다
    resultDismissed = false;
    for (const k of Object.keys(panes)) delete panes[k];
    for (const k of Object.keys(priceHistory)) delete priceHistory[k];
  }
  samplePrices();
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
  return S.game.players.find((p) => p.id === ME) || null;
}

/** 게임 상태에는 봇 여부가 없으므로 방 참가자 목록에서 찾는다 */
function isBotId(id) {
  const rp = S && S.roomPlayers ? S.roomPlayers.find((p) => p.id === id) : null;
  return !!(rp && rp.isBot);
}

/** 목록에 보여줄 이름 (봇 표시 + 내 회사 표시) */
function labelOf(p) {
  return (isBotId(p.id) ? '🤖 ' : '') + p.name + (p.id === ME ? ' (나)' : '');
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
  renderVoice();
}

/* ------------------------------------------------------------------ 대기실 */

const SETTING_LABELS = { startCash: '시작 자금', duration: '게임 시간' };
const settingText = (key, v) => (key === 'duration' ? `${Math.round(v / 60)}분` : String(v));

function renderLobby() {
  if (!S || S.phase !== 'lobby') return;
  $('#lobby-room-code').textContent = '#' + S.roomId;

  const list = $('#lobby-players');
  list.innerHTML = '';
  for (const p of S.roomPlayers) {
    const li = el('li', p.connected ? '' : 'off');
    li.textContent =
      (p.isBot ? '🤖 ' : '') + p.name + (p.id === S.hostId ? ' 👑' : '') + (p.voice ? ' 🎙️' : '');
    if (p.id === ME) li.classList.add('me');
    list.appendChild(li);
  }
  for (let i = S.roomPlayers.length; i < S.maxPlayers; i++) {
    list.appendChild(el('li', 'empty', '빈 자리'));
  }

  const isHost = ME === S.hostId;
  const wrap = $('#lobby-settings');
  wrap.innerHTML = '';
  for (const [key, choices] of Object.entries(S.settingChoices)) {
    const row = el('div', 'setting-row');
    row.appendChild(el('span', 'setting-label', SETTING_LABELS[key] || key));
    const group = el('div', 'setting-choices');
    for (const c of choices) {
      const btn = el('button', 'chip' + (S.settings[key] === c ? ' on' : ''), settingText(key, c));
      btn.disabled = !isHost;
      btn.addEventListener('click', () => emit('updateSettings', { [key]: c }));
      group.appendChild(btn);
    }
    row.appendChild(group);
    wrap.appendChild(row);
  }

  const botCount = S.roomPlayers.filter((p) => p.isBot).length;
  $('#lobby-start').classList.toggle('hidden', !isHost);
  $('#lobby-bot-actions').classList.toggle('hidden', !isHost);
  $('#lobby-add-bot').disabled = S.roomPlayers.length >= S.maxPlayers;
  $('#lobby-remove-bot').disabled = botCount === 0;
  $('#lobby-hint').textContent = isHost
    ? `${S.minPlayers}~${S.maxPlayers}명이 모이면 시작할 수 있습니다. 혼자라면 컴퓨터를 추가하세요.`
    : '방장이 시작하기를 기다리는 중...';
}

$('#lobby-start').addEventListener('click', () => emit('startGame'));
$('#lobby-add-bot').addEventListener('click', () => emit('addBot'));
$('#lobby-remove-bot').addEventListener('click', () => emit('removeBot'));
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
  if (!S || !S.game || !S.game.map) return;
  const g = S.game;
  const my = me();

  $('#hud-cash').textContent = my ? `💵 ${fmt(my.cash)}` : '관전 중';

  const income = $('#hud-income');
  if (my) {
    const v = my.incomePerSec;
    income.textContent = `${v >= 0 ? '+' : ''}${fmt1(v)}/초`;
    income.className = v > 0.05 ? 'income up' : v < -0.05 ? 'income down' : 'income';
  } else {
    income.textContent = '';
  }

  renderInventory(my);

  renderClock();
  renderEvent();
  drawMap();
  renderTilePanel();
  renderTabs();
  renderResult();
}

/** 진행 중인 사건을 화면 위에 띄운다 */
function renderEvent() {
  const banner = $('#event-banner');
  const e = S.game.event;
  if (!e || S.game.ended) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  const left = Math.max(0, Math.round(e.until - S.game.elapsed));
  banner.textContent = `${e.icon} ${e.text} (${left}초 남음)`;
  banner.classList.toggle(
    'bad',
    e.kind === 'mat-up' || e.kind === 'city-slump' || e.kind === 'market-crash' || e.kind === 'company-slump'
  );
}

/**
 * 상단 보유 자원.
 *
 * 0.5초마다 값이 바뀌는데 그때마다 다시 그리면 숫자 자릿수가 달라질 때
 * 칸 너비가 변해 상단바가 밀리고, 휴대폰에서는 줄바꿈이 오가며 화면이 요동친다.
 * 그래서 칸은 한 번만 만들고 숫자만 갈아끼우며, 숫자 칸 너비는 CSS 로 고정한다.
 */
// 좁은 화면에서는 이름을 감추고 아이콘만 남겨 한 줄에 들어가게 한다
const INV_LABELS = {
  iron: ['⛏️', '철'],
  oil: ['🛢️', '유'],
  grain: ['🌾', '곡'],
  machine: ['⚙️', '기계'],
  food: ['🍞', '식품'],
  semi: ['💾', '반도체'],
};
// 하이테크는 손대기 전까지 상단바를 넓히지 않도록 필요할 때만 보여준다
const INV_OPTIONAL = ['semi'];
const invNums = {};
const invItems = {};

/** 자릿수가 들쭉날쭉하지 않도록 100 이상은 정수로만 보여준다 */
function fmtInv(n) {
  if (n >= 100) return Math.round(n).toLocaleString('ko-KR');
  return (Math.round(n * 10) / 10).toFixed(1);
}

function renderInventory(my) {
  const inv = $('#hud-inv');
  if (!inv.dataset.built) {
    inv.innerHTML = '';
    for (const [k, [icon, name]] of Object.entries(INV_LABELS)) {
      const item = el('span', 'inv-item');
      item.title = name;
      const label = el('span', 'inv-label');
      label.appendChild(el('span', 'inv-ico', icon));
      label.appendChild(el('span', 'inv-name', name));
      item.appendChild(label);
      const num = el('span', 'inv-num', '0.0');
      item.appendChild(num);
      inv.appendChild(item);
      invNums[k] = num;
      invItems[k] = item;
    }
    inv.dataset.built = '1';
  }
  inv.classList.toggle('hidden', !my);
  if (!my) return;

  // 하이테크 공장을 돌리고 있으면 재고가 0이어도 보여 준다
  const making = new Set();
  for (const t of S.game.map.tiles) {
    if (t.owner === ME && t.b === 'factory' && t.mode) making.add(t.mode);
  }

  for (const k of Object.keys(INV_LABELS)) {
    const n = my.inv[k] || 0;
    const text = fmtInv(n);
    if (invNums[k].textContent !== text) invNums[k].textContent = text;
    if (INV_OPTIONAL.includes(k)) {
      invItems[k].classList.toggle('hidden', n < 0.05 && !making.has(k));
    }
  }
}

function renderClock() {
  const g = S && S.game;
  if (!g) return;
  const left = g.ended ? 0 : g.remaining;
  $('#hud-timer').textContent = g.ended ? '게임 종료' : `⏱ ${mmss(left)}`;
  $('#hud-timer').classList.toggle('urgent', !g.ended && left <= 30);
  const pct = g.duration ? Math.max(0, Math.min(100, (left / g.duration) * 100)) : 0;
  $('#time-fill').style.width = pct + '%';
}

// 서버 갱신 사이(0.5초)에도 시계가 부드럽게 흐르도록 보간한다
setInterval(() => {
  if (!S || !S.game || S.game.ended) return;
  S.game.remaining = Math.max(0, S.game.remaining - 0.2);
  renderClock();
}, 200);

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
const BUILDING_ICONS = { mine: '⚒️', rig: '🏗️', farm: '🚜', factory: '🏭', rental: '🏬', depot: '🚛' };

/**
 * 맵이 화면을 다 먹지 않도록 남는 공간의 80% 만 쓴다 (나머지는 메뉴 몫).
 * 다만 가로로 돌린 휴대폰처럼 세로가 짧을 때는 줄일 여유가 없으므로 거의 다 쓴다.
 */
// 휴대폰(세로·가로 모두)에서는 CSS 가 맵 자리를 이미 좁게 잡아 주므로
// 여기서 또 줄이면 공백만 늘어난다. 넓은 화면에서만 80% 로 줄인다.
const COMPACT = '(max-width: 820px), (orientation: landscape) and (max-height: 560px)';
function mapScale() {
  return window.matchMedia && window.matchMedia(COMPACT).matches ? 0.98 : 0.8;
}

function drawMap() {
  const g = S.game;
  const canvas = $('#map');
  const wrap = $('#map-wrap');
  const size = (Math.min(wrap.clientWidth, wrap.clientHeight) || 480) * mapScale();
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

    // 소유 표시 — 내부를 주인 색으로 덮고 테두리를 두른다.
    // 내 땅은 더 진하고 테두리도 굵게 해서 한눈에 들어오게 한다.
    if (tile.owner) {
      const owner = g.players.find((p) => p.id === tile.owner);
      if (owner) {
        const isMine = tile.owner === ME;
        ctx.save();
        ctx.globalAlpha = isMine ? 0.5 : 0.28;
        ctx.fillStyle = owner.color;
        ctx.fillRect(x, y, ts, ts);
        ctx.restore();

        ctx.strokeStyle = owner.color;
        ctx.lineWidth = isMine ? Math.max(3, ts * 0.14) : Math.max(2, ts * 0.08);
        const inset = ctx.lineWidth / 2;
        ctx.strokeRect(x + inset, y + inset, ts - inset * 2, ts - inset * 2);
      }
    }

    // 아이콘: 건물 > 지형
    const icon = tile.b ? BUILDING_ICONS[tile.b] : TILE_ICONS[tile.t];
    if (icon) ctx.fillText(icon, x + ts / 2, y + ts / 2 + 1);

    if (tile.b === 'factory') {
      // 재료가 없어 멈춘 공장은 빨간 점으로 알려 준다
      if (tile.idle) {
        ctx.fillStyle = 'rgba(255, 80, 80, 0.9)';
        ctx.beginPath();
        ctx.arc(x + ts * 0.82, y + ts * 0.18, Math.max(2.5, ts * 0.09), 0, Math.PI * 2);
        ctx.fill();
      }
      // 증설한 공장은 단계를 표시
      if ((tile.level || 1) > 1) {
        ctx.font = `bold ${Math.max(8, Math.floor(ts * 0.3))}px sans-serif`;
        ctx.fillStyle = '#ffd866';
        ctx.fillText(String(tile.level), x + ts * 0.2, y + ts * 0.8);
        ctx.font = `${Math.floor(ts * 0.42)}px sans-serif`;
      }
    }

    // 부동산 매물은 점선 테두리로 표시
    if (tile.listPrice) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#ffd866';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 3, y + 3, ts - 6, ts - 6);
      ctx.restore();
    }

    if (selectedTile === i) {
      ctx.strokeStyle = '#ffd866';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x + 1.5, y + 1.5, ts - 3, ts - 3);
    }
  }

  // 배송 노선 — 공장에서 도시로 이어지는 선
  ctx.lineWidth = Math.max(1.5, ts * 0.05);
  for (let i = 0; i < g.map.tiles.length; i++) {
    const tile = g.map.tiles[i];
    if (tile.b !== 'factory' || tile.route === null || tile.route === undefined) continue;
    const city = g.cities[tile.route];
    if (!city) continue;
    const owner = g.players.find((p) => p.id === tile.owner);
    ctx.strokeStyle = owner ? owner.color : '#888';
    ctx.globalAlpha = tile.owner === ME ? 0.85 : 0.35;
    ctx.beginPath();
    ctx.moveTo((i % g.map.w) * ts + ts / 2, Math.floor(i / g.map.w) * ts + ts / 2);
    ctx.lineTo(city.x * ts + ts / 2, city.y * ts + ts / 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 도시 이름
  ctx.font = `${Math.max(9, Math.floor(ts * 0.26))}px sans-serif`;
  ctx.fillStyle = '#ffd866';
  for (const c of g.cities) {
    ctx.fillText(c.name, c.x * ts + ts / 2, c.y * ts + ts * 0.86);
  }
}

$('#map').addEventListener('click', (e) => {
  if (!S || !S.game || !S.game.map) return;
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

window.addEventListener('resize', () => S && S.game && S.game.map && drawMap());

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

/* ---------------------------------------------------------------- 부분 갱신
 *
 * 실시간이라 상태가 0.5초마다 들어온다. 그때마다 화면을 통째로 다시 만들면
 * 누르던 버튼과 입력칸이 사라져 클릭이 씹히고 타이핑이 튄다.
 * 그래서 "구조가 바뀔 때만" 다시 만들고, 숫자는 제자리에서 고친다.
 *
 * 각 렌더러는 sig(구조 서명)와 live(숫자 갱신 함수 목록)를 들고 있는다.
 */
const panes = {};

function pane(name) {
  if (!panes[name]) panes[name] = { sig: null, live: [] };
  return panes[name];
}

/**
 * @param {string} name 화면 조각 이름
 * @param {string} sig 구조 서명 — 이게 그대로면 다시 만들지 않는다
 * @param {(live: Array<Function>) => void} build 새로 만들 때 호출. live 에 갱신 함수를 넣는다.
 * @returns {boolean} 다시 만들었는지
 */
function renderPane(name, sig, build) {
  const p = pane(name);
  if (p.sig === sig) {
    for (const fn of p.live) fn();
    return false;
  }
  p.sig = sig;
  p.live = [];
  build(p.live);
  for (const fn of p.live) fn();
  return true;
}

function nameOf(key) {
  const C = S.game.constants;
  const spec = C.materials[key] || C.products[key] || (C.hitech && C.hitech[key]);
  return spec ? spec.name : key;
}

/** 연구 보너스 배수 (서버의 researchMult 와 같은 계산) */
function researchMult(kind) {
  const my = me();
  const spec = S.game.constants.research;
  if (!my || !my.research || !spec || !spec[kind]) return 1;
  return 1 + (my.research[kind] || 0) * spec[kind].step;
}

/** 공장이 만들 수 있는 모든 품목 (도시 배송 + 하이테크) */
function makeable() {
  const C = S.game.constants;
  return { ...C.products, ...(C.hitech || {}) };
}
const isHitech = (key) => {
  const C = S.game.constants;
  return !!(C.hitech && C.hitech[key]);
};

/** 거리·물동량에 따라 어떤 운송 수단이 가장 싼지 클라이언트에서도 똑같이 계산한다 */
const TRANSPORT = [
  { method: 'truck', name: '트럭', fixed: 0, perUnit: 2.0 },
  { method: 'train', name: '기차', fixed: 0.9, perUnit: 0.55 },
  { method: 'air', name: '항공', fixed: 2.2, perUnit: 0.18 },
];
function transportQuote(dist, ratePerSec) {
  let best = null;
  for (const t of TRANSPORT) {
    const cost = t.fixed + t.perUnit * dist * ratePerSec;
    if (!best || cost < best.cost) best = { name: t.name, cost };
  }
  return best;
}

/** 공장 idx 에서 도시 ci 로 보낼 때의 초당 손익 (서버와 같은 계산) */
function routeQuote(idx, ci, mode) {
  const g = S.game;
  const c = g.cities[ci];
  const spec = g.constants.products[mode];
  const tile = g.map.tiles[idx];
  if (!c || !spec || !tile) return null;
  const x = idx % g.map.w;
  const y = Math.floor(idx / g.map.w);
  const dist = Math.max(1, Math.max(Math.abs(x - c.x), Math.abs(y - c.y)));
  const rate = spec.rate * (tile.level || 1) * researchMult('production');
  const t = transportQuote(dist, rate);
  // 물류 연구가 운송비를, 판매 연구가 판매가를 바꾼다. 사건 배수도 함께 반영.
  const cost = t.cost * researchMult('logistics');
  const unit = spec.base * c.mod[mode] * c.demand[mode] * (c.boost || 1);
  const revenue = unit * rate * researchMult('price');
  return { dist, rate, transport: { name: t.name, cost }, revenue, net: revenue - cost };
}

function renderTilePanel() {
  const panel = $('#tile-panel');
  if (selectedTile === null || !S || !S.game || !S.game.map) {
    panel.classList.add('hidden');
    pane('tile').sig = null;
    return;
  }
  const g = S.game;
  const tile = g.map.tiles[selectedTile];
  panel.classList.remove('hidden');

  // 구조가 그대로면 숫자만 고친다 (다시 만들면 누르던 버튼이 사라진다)
  const sig = [
    selectedTile, tile.t, tile.owner, tile.b, tile.mode, tile.level, tile.route, tile.listPrice, g.ended,
  ].join('|');
  renderPane('tile', sig, (live) => buildTilePanel(panel, tile, live));
}

function buildTilePanel(panel, tile, live) {
  const g = S.game;
  const C = g.constants;
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

  if (tile.owner) {
    const owner = g.players.find((p) => p.id === tile.owner);
    const row = el('div', 'tp-row');
    const dot = el('span', 'dot');
    dot.style.background = owner ? owner.color : '#888';
    row.appendChild(dot);
    row.appendChild(el('span', '', owner ? owner.name + ' 소유' : '소유'));
    panel.appendChild(row);
  }

  // 남이 내놓은 매물이면 살 수 있다
  if (tile.owner && tile.owner !== ME && tile.listPrice && !g.ended) {
    const btn = el('button', 'primary wide', `🏠 매물 구입 (${fmt(tile.listPrice)})`);
    btn.addEventListener('click', () => emit('buyListedTile', { idx: selectedTile }));
    live.push(() => {
      const my = me();
      btn.disabled = !my || my.cash < tile.listPrice;
    });
    panel.appendChild(btn);
  }

  // 도시 정보 — 시세와 수요는 계속 변하므로 live 로 갱신한다
  if (tile.t === 'city') {
    const ci = g.cities.findIndex((c) => c.y * g.map.w + c.x === selectedTile);
    if (ci >= 0) {
      panel.appendChild(el('div', 'tp-row', `🏙️ ${g.cities[ci].name}`));
      for (const key of ['machine', 'food']) {
        const row = el('div', 'tp-row small');
        panel.appendChild(row);
        live.push(() => {
          const c = S.game.cities[ci];
          const p = S.game.constants.products[key];
          const unit = p.base * c.mod[key] * c.demand[key];
          row.textContent = `${p.name} 개당 ${fmt1(unit)} · 수요 ${Math.round(c.demand[key] * 100)}%`;
        });
      }
    }
  }

  if (!me() || g.ended) return;

  /** 현금이 모자라면 자동으로 비활성화되는 버튼 */
  const costButton = (label, cost, onClick) => {
    const btn = el('button', 'primary wide', label);
    btn.addEventListener('click', onClick);
    live.push(() => {
      const my = me();
      btn.disabled = !my || my.cash < cost;
    });
    panel.appendChild(btn);
  };

  // 땅 구매
  if (!tile.owner && type.price) {
    costButton(`땅 구매 (${type.price})`, type.price, () => emit('buyTile', { idx: selectedTile }));
  }

  // 건설
  if (tile.owner === ME && !tile.b) {
    for (const [kind, spec] of Object.entries(C.buildings)) {
      if (spec.on !== tile.t) continue;
      const desc = spec.out
        ? Object.entries(spec.out)
            .map(([k, r]) => `${nameOf(k)} +${r}/초`)
            .join(', ')
        : spec.rent
          ? '임대료 수입 (공급이 늘면 임대료는 내려감)'
          : spec.freight
            ? '운임 수입 (판에서 오가는 화물이 많을수록 벌이가 좋음)'
            : '제품 생산 (기계/식품/하이테크)';
      costButton(`${spec.name} 건설 (${spec.cost}) — ${desc}`, spec.cost, () =>
        emit('build', { idx: selectedTile, kind })
      );
    }
  }

  /** 증설 버튼 — 광산·시추소·농장·공장 모두 3단계까지 키울 수 있다 */
  const upgradeButton = () => {
    const spec = C.buildings[tile.b];
    const level = tile.level || 1;
    if (!spec.maxLevel || level >= spec.maxLevel) return;
    const cost = spec.upgradeCost * level;
    const what = spec.rent ? '임대료' : spec.freight ? '운임' : '생산';
    costButton(`⬆️ ${level + 1}단계 증설 (${cost}) · ${what} ${level + 1}배`, cost, () =>
      emit('upgrade', { idx: selectedTile })
    );
  };

  // 자원 건물 — 생산량을 보여주고 증설할 수 있다
  if (tile.owner === ME && tile.b && C.buildings[tile.b].out) {
    const spec = C.buildings[tile.b];
    const level = tile.level || 1;
    const row = el('div', 'tp-row');
    panel.appendChild(row);
    live.push(() => {
      const mult = level * researchMult('production');
      const out = Object.entries(spec.out)
        .map(([k, r]) => `${nameOf(k)} +${Math.round(r * mult * 100) / 100}/초`)
        .join(', ');
      row.textContent = `⛏️ ${spec.name} ${level}단계 · ${out}`;
    });
    upgradeButton();
  }

  // 임대 상가 — 지금 임대료와 전체 공급을 보여준다 (공급이 늘면 임대료가 내려간다)
  if (tile.owner === ME && tile.b === 'rental') {
    const spec = C.buildings.rental;
    const level = tile.level || 1;
    const row = el('div', 'tp-row');
    const note = el('div', 'tp-row small');
    panel.appendChild(row);
    panel.appendChild(note);
    live.push(() => {
      const supply = S.game.rentalSupply || 0;
      const demand = S.game.rentalDemand || 1;
      const rent = (spec.rent * level * demand) / (1 + supply * C.rentSaturation);
      row.textContent = `🏬 ${spec.name} ${level}단계 · 임대료 +${fmt1(rent)}/초`;
      note.textContent = `수요 ${fmt1(demand)}배 · 공급 ${supply} — 도시가 커지면 오르고, 상가가 늘면 내려갑니다`;
    });
    upgradeButton();
  }

  // 물류 센터 — 판에서 오가는 화물이 수요, 물류 센터 총량이 공급
  if (tile.owner === ME && tile.b === 'depot') {
    const spec = C.buildings.depot;
    const level = tile.level || 1;
    const row = el('div', 'tp-row');
    const note = el('div', 'tp-row small');
    panel.appendChild(row);
    panel.appendChild(note);
    live.push(() => {
      const supply = S.game.depotSupply || 0;
      const demand = S.game.freightDemand || 0;
      const pay = (spec.freight * level * demand) / (1 + supply * C.freightSaturation);
      row.textContent = `🚛 ${spec.name} ${level}단계 · 운임 +${fmt1(pay)}/초`;
      note.textContent = `화물 ${fmt1(demand)}/초 · 물류 공급 ${supply} — 남들이 많이 실어 나를수록 벌이가 좋습니다`;
    });
    upgradeButton();
  }

  // 공장: 생산 품목 + 배송 노선
  if (tile.owner === ME && tile.b === 'factory') {
    const mode = tile.mode || 'machine';
    const level = tile.level || 1;

    panel.appendChild(el('div', 'tp-row', `🏭 공장 ${level}단계`));

    // 도시로 보내는 제품과, 재고로 쌓아 시장에 파는 하이테크를 나눠서 보여준다
    const modeGroup = (label, hint, specs) => {
      if (!specs || !Object.keys(specs).length) return;
      const row = el('div', 'tp-choices');
      // 라벨을 칩과 같은 줄에 둬서 패널이 두꺼워지지 않게 한다
      const tag = el('span', 'small mode-tag', label);
      tag.title = hint;
      row.appendChild(tag);
      for (const [key, p] of Object.entries(specs)) {
        const recipe = Object.entries(p.recipe)
          .map(([k, n]) => `${nameOf(k)}×${n}`)
          .join('+');
        // 0.18 과 0.22 가 똑같이 "0.2" 로 보이지 않도록 두 자리까지 쓴다 (연구 보너스 포함)
        const rate = Math.round(p.rate * level * researchMult('production') * 100) / 100;
        // 재료는 툴팁으로 뺀다 — 한 줄에 들어가야 패널이 두꺼워지지 않는다
        const btn = el('button', 'chip' + (mode === key ? ' on' : ''), `${p.name} ${rate}/초`);
        btn.title = `재료 ${recipe}`;
        btn.addEventListener('click', () => emit('setFactoryMode', { idx: selectedTile, mode: key }));
        row.appendChild(btn);
      }
      panel.appendChild(row);
    };
    modeGroup('🚚 배송', '도시로 자동 배송해 판매합니다', C.products);
    modeGroup('🔬 하이테크', '재고로 쌓아 두었다가 시장 탭에서 팝니다', C.hitech);
    upgradeButton();

    const idleRow = el('div', 'tp-row warn', '⚠️ 재료가 없어 멈춰 있습니다');
    panel.appendChild(idleRow);
    live.push(() => {
      const t = S.game.map.tiles[selectedTile];
      idleRow.classList.toggle('hidden', !(t && t.idle));
    });

    if (isHitech(mode)) {
      // 하이테크는 도시로 안 간다 — 재고로 쌓아 시장에서 판다
      const note = el('div', 'tp-row small hitech-note');
      panel.appendChild(note);
      live.push(() => {
        const mk = S.game.market[mode];
        const held = me() ? me().inv[mode] || 0 : 0;
        note.textContent = `재고 ${fmt1(held)}개 · 시세 ${fmt1(mk ? mk.price : 0)}/개 — 시장 탭에서 파세요`;
      });
    } else {
      // 배송 노선 — 도시별 초당 순이익 (수요에 따라 계속 변한다)
      panel.appendChild(el('div', 'tp-row', '🚚 배송 노선 · 초당 순이익'));
      const rows = [];
      g.cities.forEach((c, ci) => {
        const row = el('button', 'route-row' + (tile.route === ci ? ' on' : ''));
        const net = el('span', 'route-net');
        const info = el('span', 'route-info small');
        row.appendChild(el('span', 'route-city', c.name));
        row.appendChild(net);
        row.appendChild(info);
        row.addEventListener('click', () =>
          emit('setRoute', { idx: selectedTile, city: S.game.map.tiles[selectedTile].route === ci ? null : ci })
        );
        panel.appendChild(row);
        rows.push({ ci, row, net, info });
      });

      const hint = el('div', 'tp-row small');
      panel.appendChild(hint);

      live.push(() => {
        const t = S.game.map.tiles[selectedTile];
        if (!t) return;
        const m = t.mode || 'machine';
        const quotes = rows.map((r) => ({ ...r, q: routeQuote(selectedTile, r.ci, m) }));
        const bestNet = Math.max(...quotes.map((x) => (x.q ? x.q.net : -Infinity)));
        for (const { q, row, net, info } of quotes) {
          if (!q) continue;
          net.textContent = `${q.net >= 0 ? '+' : ''}${fmt1(q.net)}/초`;
          net.classList.toggle('down', q.net < 0);
          info.textContent = `${q.dist}칸 · ${q.transport.name} -${fmt1(q.transport.cost)}/초`;
          row.classList.toggle('best', q.net === bestNet);
        }
        // 노선을 끄면 재고가 쌓인다 — 하이테크 재료를 모으는 방법이다
        const off = t.route === null || t.route === undefined;
        hint.textContent = off
          ? `노선 없음 — ${nameOf(m)}가 재고로 쌓이기만 합니다`
          : '만들어지는 대로 자동 판매됩니다.';
        hint.classList.toggle('listed', off);
      });
    }
  }

  // 내 땅이면 팔 수 있다 — 자주 쓰는 기능이 아니므로 접어 둔다
  if (tile.owner === ME) {
    const value = tileValue(selectedTile);
    const box = document.createElement('details');
    box.className = 'tp-fold';
    const sum = document.createElement('summary');
    sum.textContent = tile.listPrice ? `💰 매각 · 🏠 ${fmt(tile.listPrice)} 매물 중` : `💰 매각 · 부동산`;
    box.appendChild(sum);

    const sell = el('button', 'wide danger', `은행에 매각 (${fmt(value)})`);
    sell.addEventListener('click', () => {
      emit('sellTile', { idx: selectedTile });
      selectedTile = null;
    });
    box.appendChild(sell);

    const listRow = el('div', 'tp-inline');
    const price = el('input');
    price.type = 'number';
    price.min = '1';
    price.placeholder = '희망가';
    keepInput(price, 'list-price');
    const listBtn = el('button', '', tile.listPrice ? '내리기' : '🏠 내놓기');
    listBtn.addEventListener('click', () => {
      if (tile.listPrice) {
        emit('unlistTile', { idx: selectedTile });
      } else {
        const v = Math.floor(Number(price.value) || 0);
        if (v < 1) return toast('희망 가격을 입력해 주세요.');
        emit('listTile', { idx: selectedTile, price: v });
      }
    });
    listRow.appendChild(price);
    listRow.appendChild(listBtn);
    box.appendChild(listRow);
    panel.appendChild(box);
  }
}

/** 땅+건물 평가액 (서버의 tileValue 와 같은 계산) */
function tileValue(idx) {
  const g = S.game;
  const C = g.constants;
  const tile = g.map.tiles[idx];
  if (!tile) return 0;
  let v = C.tileTypes[tile.t].price || 0;
  if (tile.b) v += C.buildings[tile.b].cost * C.resaleRate;
  for (let lv = 1; lv < (tile.level || 1); lv++) {
    v += C.buildings.factory.upgradeCost * lv * C.resaleRate;
  }
  return Math.round(v);
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
  const sig = ['market', Object.keys(g.market).join(','), !!me(), g.ended].join('|');
  renderPane('market', sig, (live) => {
    const box = $('#tab-market');
    const my = me();
    box.innerHTML = '';
    box.appendChild(el('p', 'tab-hint', '사면 오르고 팔면 내립니다. 시간이 지나면 기준가로 돌아갑니다.'));

    // 원자재를 먼저, 하이테크 제품을 뒤에 묶어서 보여준다
    const keys = Object.keys(g.market).sort((a, b) => (isHitech(a) ? 1 : 0) - (isHitech(b) ? 1 : 0));
    let hitechHeaderDone = false;
    for (const key of keys) {
      if (isHitech(key) && !hitechHeaderDone) {
        hitechHeaderDone = true;
        box.appendChild(el('p', 'tab-hint', '🔬 하이테크 — 공장에서 만들어 재고로 쌓았다가 여기서 팝니다.'));
      }
      const row = el('div', 'trade-row');
      const info = el('div', 'trade-info');
      info.appendChild(el('b', '', nameOf(key)));
      const price = el('span', '');
      const base = el('span', 'small', '');
      const held = el('span', 'small', '');
      const spark = makeSpark('최근 1분 시세');
      info.appendChild(price);
      info.appendChild(base);
      info.appendChild(held);
      info.appendChild(spark);
      row.appendChild(info);

      live.push(() => {
        const m = S.game.market[key];
        const diff = m.price - m.base;
        price.textContent = ` ${fmt1(m.price)}`;
        price.className = diff > 0.01 ? 'up' : diff < -0.01 ? 'down' : '';
        // 사건 중에는 기준가 자체가 흔들리므로 매번 다시 쓴다
        base.textContent = ` (기준 ${fmt1(m.base)})`;
        base.classList.toggle('event-base', Math.abs(m.base - m.baseline) > 0.01);
        const p = me();
        held.textContent = p ? ` · 보유 ${fmt1(p.inv[key] || 0)}` : '';
        drawSpark(spark, priceHistory['mat:' + key]);
      });

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

        // 수량 유지 — 공장이 재료 없이 멈추지 않게 모자라면 알아서 사 온다
        const keepBox = el('span', 'auto-buy');
        keepBox.appendChild(el('span', 'small', '유지'));
        const target = el('input');
        target.type = 'number';
        target.min = '0';
        target.placeholder = '0';
        target.title = '이 수량보다 적으면 매 초 자동으로 사 옵니다. 운영자금은 남겨 둡니다. (0이면 끔)';
        target.addEventListener('change', () =>
          emit('setAutoBuy', { mat: key, target: Math.max(0, Math.floor(Number(target.value) || 0)) })
        );
        keepBox.appendChild(target);
        controls.appendChild(keepBox);
        row.appendChild(controls);

        live.push(() => {
          const p = me();
          const t = p && p.autoBuy ? p.autoBuy[key] || 0 : 0;
          // 입력 중에는 건드리지 않는다
          if (document.activeElement !== target) target.value = t ? String(t) : '';
          keepBox.classList.toggle('on', t > 0);
        });
      }
      box.appendChild(row);
    }

    box.appendChild(el('p', 'tab-hint', '도시 수요 — 많이 팔린 곳은 값이 내려가고 시간이 지나면 회복됩니다.'));

    // 도시가 커지면 상가·물류 수요도 함께 움직인다
    const rentRow = el('div', 'city-row');
    rentRow.appendChild(el('b', '', '🏬 임대'));
    const rentInfo = el('span', 'small');
    rentRow.appendChild(rentInfo);
    box.appendChild(rentRow);

    const freightRow = el('div', 'city-row');
    freightRow.appendChild(el('b', '', '🚛 운송'));
    const freightInfo = el('span', 'small');
    freightRow.appendChild(freightInfo);
    box.appendChild(freightRow);

    live.push(() => {
      const gg = S.game;
      const CC = gg.constants;
      const rSupply = gg.rentalSupply || 0;
      const rDemand = gg.rentalDemand || 1;
      const rent = (CC.buildings.rental.rent * rDemand) / (1 + rSupply * CC.rentSaturation);
      rentInfo.textContent = `수요 ${fmt1(rDemand)}배 · 공급 ${rSupply} · 1단계당 ${fmt1(rent)}/초`;
      rentInfo.classList.toggle('down', rSupply > 0 && rent < CC.buildings.rental.rent);

      const dSupply = gg.depotSupply || 0;
      const fDemand = gg.freightDemand || 0;
      const pay = (CC.buildings.depot.freight * fDemand) / (1 + dSupply * CC.freightSaturation);
      freightInfo.textContent = `화물 ${fmt1(fDemand)}/초 · 물류 ${dSupply} · 1단계당 ${fmt1(pay)}/초`;
    });

    g.cities.forEach((c, ci) => {
      const row = el('div', 'city-row');
      row.appendChild(el('b', '', `🏙️ ${c.name}`));
      for (const key of ['machine', 'food']) {
        const span = el('span', 'small');
        row.appendChild(span);
        live.push(() => {
          const city = S.game.cities[ci];
          const p = S.game.constants.products[key];
          span.textContent = `${p.name} ${fmt1(p.base * city.mod[key] * city.demand[key])} (${Math.round(
            city.demand[key] * 100
          )}%)`;
          span.classList.toggle('down', city.demand[key] < 0.75);
        });
      }
      box.appendChild(row);
    });
  });
}

/* ---------- 주가 미니 차트 ---------- */

// 서버가 0.5초마다 보내주는 시세를 1초에 하나씩 모아 스파크라인으로 그린다.
// 서버가 기록을 따로 보내주지 않아도 되므로 트래픽이 늘지 않는다.
// 키는 'stock:<회사id>' 와 'mat:<자재>' 로 구분한다.
const priceHistory = {};
const HISTORY_LEN = 60; // 최근 1분
let lastSampleAt = 0;

function pushSample(key, value) {
  const arr = priceHistory[key] || (priceHistory[key] = []);
  arr.push(value);
  if (arr.length > HISTORY_LEN) arr.shift();
}

function samplePrices() {
  if (!S || !S.game || S.game.ended) return;
  const now = Date.now();
  if (now - lastSampleAt < 900) return;
  lastSampleAt = now;
  for (const p of S.game.players) {
    const s = S.game.stocks[p.id];
    if (s) pushSample('stock:' + p.id, s.price);
  }
  for (const [key, m] of Object.entries(S.game.market)) {
    pushSample('mat:' + key, m.price);
  }
}

/** 시세 차트용 캔버스를 만든다 */
function makeSpark(title) {
  const c = document.createElement('canvas');
  c.className = 'spark';
  c.title = title;
  return c;
}

function drawSpark(canvas, data) {
  const w = canvas.clientWidth || 72;
  const h = canvas.clientHeight || 20;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;

  let lo = Math.min(...data);
  let hi = Math.max(...data);
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const px = (i) => 1 + (i / (data.length - 1)) * (w - 2);
  const py = (v) => h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
  const rising = data[data.length - 1] >= data[0];
  const color = rising ? '#4ade80' : '#ff8080';

  // 옅은 면 + 선
  ctx.beginPath();
  ctx.moveTo(px(0), h);
  data.forEach((v, i) => ctx.lineTo(px(i), py(v)));
  ctx.lineTo(px(data.length - 1), h);
  ctx.closePath();
  ctx.fillStyle = rising ? 'rgba(74,222,128,0.15)' : 'rgba(255,128,128,0.15)';
  ctx.fill();

  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

/* ---------- 주식 ---------- */

function renderStocks() {
  const g = S.game;
  const sig = ['stocks', g.players.map((p) => p.id).join(','), !!me(), g.ended].join('|');
  renderPane('stocks', sig, (live) => {
    const box = $('#tab-stocks');
    const my = me();
    box.innerHTML = '';
    const yieldPct = Math.round(g.constants.dividendYield * 100000) / 1000;
    box.appendChild(
      el(
        'p',
        'tab-hint',
        `회사당 ${g.constants.totalShares}주 · 배당은 주가의 ${yieldPct}%/초 · ` +
          `${g.constants.takeoverShares}주를 모으면 경영권 인수`
      )
    );

    // 한 회사당 두 줄(요약 + 거래)로 눌러 담는다. 회사가 6개까지 늘어나므로
    // 줄 수를 줄이지 않으면 스크롤이 너무 길어진다.
    for (const p of g.players) {
      const row = el('div', 'stock-row');

      // 1줄: ● 이름 · 주가 · 물량 · 경영권
      const head = el('div', 'trade-info');
      const dot = el('span', 'dot');
      dot.style.background = p.color;
      head.appendChild(dot);
      head.appendChild(el('b', '', labelOf(p)));
      const price = el('span', 'stock-price');
      const float = el('span', 'small');
      const takeover = el('span', 'takeover hidden');
      const spark = makeSpark('최근 1분 주가');
      head.appendChild(price);
      head.appendChild(float);
      head.appendChild(takeover);
      head.appendChild(spark);
      row.appendChild(head);

      // 2줄: 내 배당 · 보유자 (공매도 잔고가 있으면 뒤에 붙는다)
      const meta = el('div', 'small stock-meta');
      const div = el('span', 'dividend');
      const holders = el('span', 'holders');
      const shortInfo = el('span', 'short-row hidden');
      meta.appendChild(div);
      meta.appendChild(holders);
      meta.appendChild(shortInfo);
      row.appendChild(meta);

      live.push(() => {
        const gg = S.game;
        const s = gg.stocks[p.id];
        const now = gg.players.find((x) => x.id === p.id);
        const y = gg.constants.dividendYield;
        const mine = me();
        price.textContent = `${fmt2(s.price)}/주`;
        // 살 수 있는 물량 + 외인·기관 거래량 (미상장 물량이 남았으면 함께 알려준다)
        const pending = s.unissued > 0 ? ` (미상장 ${fmt(s.unissued)})` : '';
        float.textContent = `물량 ${fmt(s.float + s.npc)}${pending} · 거래 ${fmt(s.volume || 0)}/초`;
        drawSpark(spark, priceHistory['stock:' + p.id]);

        // 이 회사 주식에서 내가 받는 배당 / 내 회사가 물고 있는 배당
        if (p.id === ME) {
          let out = 0;
          for (const h of gg.players) {
            if (h.id !== ME) out += h.shares[ME] || 0;
          }
          div.textContent = out > 0 ? `배당 -${fmt1(s.price * out * y)}/초` : '배당 없음';
          div.classList.toggle('down', out > 0);
          div.classList.remove('up');
        } else {
          const n = mine ? mine.shares[p.id] || 0 : 0;
          div.textContent = n > 0 ? `내 ${n}주 배당 +${fmt1(s.price * n * y)}/초` : '보유 없음';
          div.classList.toggle('up', n > 0);
          div.classList.remove('down');
        }

        // 6인이면 보유자 목록이 줄바꿈되어 칸이 두꺼워진다.
        // 인수 위협을 알아보는 게 목적이므로 지분 큰 순으로 셋만 보여준다.
        const owners = gg.players
          .map((h) => ({ name: h.name, n: h.shares[p.id] || 0 }))
          .filter((h) => h.n > 0)
          .sort((x, y) => y.n - x.n);
        const shown = owners.slice(0, 3).map((h) => `${h.name} ${h.n}`);
        if (owners.length > 3) shown.push(`외 ${owners.length - 3}`);
        holders.textContent = shown.length ? '· ' + shown.join(', ') : '';
        // 좁은 화면에서는 말줄임되므로 전체 목록은 툴팁으로 남겨 둔다
        holders.title = owners.map((h) => `${h.name} ${h.n}주`).join(' · ');

        const ctrlId = now && now.controller;
        takeover.classList.toggle('hidden', !ctrlId);
        if (ctrlId) {
          const ctrl = gg.players.find((x) => x.id === ctrlId);
          takeover.textContent = `⚡${ctrl ? ctrl.name : '?'}`;
        }

        const pos = mine && mine.shorts ? mine.shorts[p.id] : null;
        if (!pos || !pos.shares) {
          shortInfo.classList.add('hidden');
        } else {
          const pnl = (pos.avg - s.price) * pos.shares;
          shortInfo.classList.remove('hidden');
          shortInfo.textContent = ` · 📉공매도 ${fmt(pos.shares)}주 ${pnl >= 0 ? '+' : ''}${fmt(pnl)}`;
          shortInfo.classList.toggle('up', pnl >= 0);
          shortInfo.classList.toggle('down', pnl < 0);
        }
      });

      // 3줄: 거래 버튼
      if (my && !g.ended) {
        const controls = el('div', 'trade-controls');
        const qty = el('input');
        qty.type = 'number';
        qty.min = '1';
        qty.placeholder = '주';
        keepInput(qty, 'stk-' + p.id);
        const amount = () => keptValue('stk-' + p.id, 1);
        const buy = el('button', 'buy', '매수');
        const sell = el('button', 'sell', '매도');
        buy.addEventListener('click', () => emit('stockTrade', { company: p.id, qty: amount(), side: 'buy' }));
        sell.addEventListener('click', () => emit('stockTrade', { company: p.id, qty: amount(), side: 'sell' }));
        controls.appendChild(qty);
        controls.appendChild(buy);
        controls.appendChild(sell);

        // 자기 회사는 공매도할 수 없다
        if (p.id !== ME) {
          const shortBtn = el('button', 'short', '공매도');
          const coverBtn = el('button', 'cover', '환매');
          shortBtn.title = '주식을 빌려 미리 판다. 주가가 내려가면 싸게 되사서 차익을 남긴다.';
          coverBtn.title = '빌린 주식을 되사서 갚는다.';
          shortBtn.addEventListener('click', () => emit('shortSell', { company: p.id, qty: amount() }));
          coverBtn.addEventListener('click', () => emit('coverShort', { company: p.id, qty: amount() }));
          controls.appendChild(shortBtn);
          controls.appendChild(coverBtn);
        }
        row.appendChild(controls);
      }
      box.appendChild(row);
    }
  });
}

/* ---------- 회사 현황 ---------- */

function renderCompany() {
  const g = S.game;
  // 순위가 바뀔 때만 카드 순서를 다시 짠다 (매번 다시 그리면 화면이 요동친다)
  const order = [...g.players].sort((a, b) => b.netWorth - a.netWorth).map((p) => p.id);
  renderPane('company', 'company|' + order.join(',') + '|' + !!me() + '|' + g.ended, (live) => {
    const box = $('#tab-company');
    box.innerHTML = '';

    // 연구개발 — 회사 전체에 붙는 영구 보너스. 후반에 남는 돈을 넣는 곳.
    if (me() && !g.ended) {
      const card = el('div', 'company-card rnd-card');
      card.appendChild(el('b', '', '🔬 연구개발'));
      for (const [kind, spec] of Object.entries(g.constants.research)) {
        const row = el('div', 'loan-row');
        const label = el('span', 'small rnd-label');
        const btn = el('button', 'buy', '연구');
        btn.addEventListener('click', () => emit('research', { kind }));
        row.appendChild(label);
        row.appendChild(btn);
        card.appendChild(row);
        live.push(() => {
          const my = me();
          if (!my) return;
          const lv = (my.research && my.research[kind]) || 0;
          const cost = my.researchCost ? my.researchCost[kind] : null;
          // step 이 음수인 연구(운송비·유지비 등)는 깎아 주는 것이므로 부호를 그대로 보여준다
          const pct = Math.round(lv * spec.step * 100);
          const sign = (n) => (n > 0 ? '+' : '') + n + '%';
          label.textContent = `${spec.name} ${lv}/${g.constants.researchMax} · ${spec.effect} ${sign(pct)}`;
          label.classList.toggle('rnd-on', lv > 0);
          btn.textContent = cost === null ? '최대' : `${fmt(cost)}`;
          btn.disabled = cost === null || my.cash < cost;
          btn.title =
            cost === null ? '' : `다음 단계: ${spec.effect} ${sign(Math.round(spec.step * 100))}`;
        });
      }
      box.appendChild(card);
    }

    // 대출 — 초반에 설비를 깔 돈이 모자랄 때 쓴다. 금액은 100단위 버튼으로 고른다.
    if (me() && !g.ended) {
      const card = el('div', 'company-card loan-card');
      card.appendChild(el('b', '', '🏦 대출'));
      const info = el('div', 'small');
      card.appendChild(info);

      const borrowRow = el('div', 'loan-row');
      borrowRow.appendChild(el('span', 'small loan-label', '대출'));
      const borrowBtns = [100, 500, 1000].map((amt) => {
        const b = el('button', 'buy', `+${fmt(amt)}`);
        b.addEventListener('click', () => emit('borrow', { amount: amt }));
        borrowRow.appendChild(b);
        return { b, amt };
      });
      const maxBtn = el('button', 'buy', '최대');
      maxBtn.addEventListener('click', () => {
        const my = me();
        // 100단위로 내림해서 빌린다
        const amt = my ? Math.floor(my.credit / 100) * 100 : 0;
        if (amt < 100) return toast('빌릴 수 있는 금액이 100 미만입니다.');
        emit('borrow', { amount: amt });
      });
      borrowRow.appendChild(maxBtn);
      card.appendChild(borrowRow);

      const repayRow = el('div', 'loan-row');
      repayRow.appendChild(el('span', 'small loan-label', '상환'));
      const repayBtns = [100, 500, 1000].map((amt) => {
        const b = el('button', 'sell', `-${fmt(amt)}`);
        b.addEventListener('click', () => emit('repay', { amount: amt }));
        repayRow.appendChild(b);
        return { b, amt };
      });
      const allBtn = el('button', 'sell', '전액');
      allBtn.addEventListener('click', () => {
        const my = me();
        if (!my || my.debt < 1) return toast('갚을 빚이 없습니다.');
        emit('repay', { amount: Math.ceil(my.debt) });
      });
      repayRow.appendChild(allBtn);
      card.appendChild(repayRow);
      box.appendChild(card);

      live.push(() => {
        const my = me();
        if (!my) return;
        const C = S.game.constants;
        const rate = Math.round(C.loanInterest * 10000) / 100;
        info.innerHTML = '';
        info.appendChild(el('span', my.debt > 0 ? 'down' : '', `빚 ${fmt(my.debt)}`));
        info.appendChild(
          el('span', '', ` · 이자 ${rate}%/초 (-${fmt1(my.debt * C.loanInterest)}/초) · 한도 ${fmt(my.credit)}`)
        );
        // 한도·현금·빚에 따라 못 누르는 버튼은 잠근다
        for (const { b, amt } of borrowBtns) b.disabled = my.credit < amt;
        maxBtn.disabled = my.credit < 100;
        for (const { b, amt } of repayBtns) b.disabled = my.debt < 1 || my.cash < amt;
        allBtn.disabled = my.debt < 1 || my.cash < 1;
      });
    }

    // 채권 — 당장 쓸 데 없는 여윳돈을 넣어 두면 초당 이자가 붙는 안전 자산.
    if (me() && !g.ended) {
      const card = el('div', 'company-card bond-card');
      card.appendChild(el('b', '', '📜 채권'));
      const info = el('div', 'small');
      card.appendChild(info);

      const buyRow = el('div', 'loan-row');
      buyRow.appendChild(el('span', 'small loan-label', '매입'));
      const buyBtns = [100, 500, 1000].map((amt) => {
        const b = el('button', 'buy', `+${fmt(amt)}`);
        b.addEventListener('click', () => emit('buyBond', { amount: amt }));
        buyRow.appendChild(b);
        return { b, amt };
      });
      card.appendChild(buyRow);

      const redeemRow = el('div', 'loan-row');
      redeemRow.appendChild(el('span', 'small loan-label', '현금화'));
      const redeemBtns = [100, 500, 1000].map((amt) => {
        const b = el('button', 'sell', `-${fmt(amt)}`);
        b.addEventListener('click', () => emit('redeemBond', { amount: amt }));
        redeemRow.appendChild(b);
        return { b, amt };
      });
      const allRedeemBtn = el('button', 'sell', '전액');
      allRedeemBtn.addEventListener('click', () => {
        const my = me();
        if (!my || my.bonds < 1) return toast('보유한 채권이 없습니다.');
        emit('redeemBond', { amount: Math.ceil(my.bonds) });
      });
      redeemRow.appendChild(allRedeemBtn);
      card.appendChild(redeemRow);
      box.appendChild(card);

      live.push(() => {
        const my = me();
        if (!my) return;
        const C = S.game.constants;
        const rate = Math.round(C.bondInterest * 10000) / 100;
        info.innerHTML = '';
        info.appendChild(el('span', my.bonds > 0 ? 'up' : '', `보유 ${fmt(my.bonds)}`));
        info.appendChild(el('span', '', ` · 이자 ${rate}%/초 (+${fmt1(my.bonds * C.bondInterest)}/초)`));
        for (const { b, amt } of buyBtns) b.disabled = my.cash < amt;
        for (const { b, amt } of redeemBtns) b.disabled = my.bonds < amt;
        allRedeemBtn.disabled = my.bonds < 1;
      });
    }

    order.forEach((pid, i) => {
      const p = g.players.find((x) => x.id === pid);
      const card = el('div', 'company-card');
      const head = el('div', 'trade-info');
      head.appendChild(el('span', 'rank', `${i + 1}위`));
      const dot = el('span', 'dot');
      dot.style.background = p.color;
      head.appendChild(dot);
      head.appendChild(el('b', '', labelOf(p)));
      card.appendChild(head);

      const money = el('div', 'small');
      const moneyText = el('span', '');
      const incomeText = el('span', '');
      money.appendChild(moneyText);
      money.appendChild(incomeText);
      card.appendChild(money);

      const invRow = el('div', 'small');
      const bRow = el('div', 'small');
      card.appendChild(invRow);
      card.appendChild(bRow);
      box.appendChild(card);

      live.push(() => {
        const gg = S.game;
        const now = gg.players.find((x) => x.id === pid);
        if (!now) return;
        const debt = now.debt > 0 ? ` · 빚 ${fmt(now.debt)}` : '';
        const bonds = now.bonds > 0 ? ` · 채권 ${fmt(now.bonds)}` : '';
        moneyText.textContent = `현금 ${fmt(now.cash)} · 순자산 ${fmt(now.netWorth)}${debt}${bonds} · `;
        incomeText.textContent = `${now.incomePerSec >= 0 ? '+' : ''}${fmt1(now.incomePerSec)}/초`;
        incomeText.className = now.incomePerSec > 0.05 ? 'up' : now.incomePerSec < -0.05 ? 'down' : '';

        const invParts = Object.entries(now.inv)
          .filter(([, n]) => n >= 0.1)
          .map(([k, n]) => `${nameOf(k)} ${fmt1(n)}`);
        invRow.textContent = invParts.length ? '재고: ' + invParts.join(', ') : '재고 없음';

        const counts = {};
        for (const tile of gg.map.tiles) {
          if (tile.owner === pid && tile.b) counts[tile.b] = (counts[tile.b] || 0) + 1;
        }
        const bParts = Object.entries(counts).map(([k, n]) => `${gg.constants.buildings[k].name} ${n}`);
        bRow.textContent = bParts.length ? '건물: ' + bParts.join(', ') : '건물 없음';
      });
    });
  });
}

/* ---------- 기록 ---------- */

/** 게임 사건과 채팅을 시간순으로 한 목록에 모아 보여준다 */
function renderLog() {
  const list = $('#log-list');
  const items = [
    ...(S.log || []).map((x) => ({ t: x.t, text: x.text })),
    ...(S.chat || []).map((x) => ({ t: x.t, name: x.name, text: x.text })),
  ]
    .sort((a, b) => a.t - b.t)
    .slice(-80);

  // 내용이 그대로면 스크롤 위치를 흔들지 않는다
  const key = items.length + ':' + (items.length ? items[items.length - 1].t : 0);
  if (list.dataset.key === key) return;
  list.dataset.key = key;

  list.innerHTML = '';
  for (const item of items) {
    const row = el('div', 'log-item');
    // '알림' 은 서버가 붙인 시스템 메시지라 발화자처럼 보이지 않게 한다
    if (item.name && item.name !== '알림') {
      row.classList.add('chat');
      row.appendChild(el('b', '', item.name + ': '));
      row.appendChild(el('span', '', item.text));
    } else {
      row.textContent = item.text;
    }
    list.appendChild(row);
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

  const isHost = ME === S.hostId;
  $('#result-restart').classList.toggle('hidden', !isHost);
  $('#result-hint').textContent = isHost
    ? '다시 하기를 누르면 대기실로 돌아갑니다. 설정을 바꿔 다시 시작하세요.'
    : '방장이 다시 시작하기를 기다리는 중...';
}
$('#result-close').addEventListener('click', () => {
  resultDismissed = true;
  $('#result-overlay').classList.add('hidden');
});
$('#result-restart').addEventListener('click', () => {
  resultDismissed = true;
  emit('restart');
});

/* ------------------------------------------------------------------ 채팅 */

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
  // 상단바에 있으므로 짧게 (자세한 설명은 툴팁으로)
  toggle.textContent = Voice.active ? '🎙️ 끄기' : '🎙️ 음성';
  toggle.title = Voice.active ? '음성 채팅 나가기' : '음성 채팅 참여';
  toggle.classList.toggle('on', Voice.active);
  mute.classList.toggle('hidden', !Voice.active);
  mute.textContent = Voice.muted ? '🔊' : '🔇';
  mute.title = Voice.muted ? '음소거 해제' : '음소거';
  mute.classList.toggle('on', Voice.muted);

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
