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
    // 새 게임이 시작되면 화면 조각을 모두 새로 만든다
    resultDismissed = false;
    for (const k of Object.keys(panes)) delete panes[k];
  }
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
  renderChat();
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

  const inv = $('#hud-inv');
  inv.innerHTML = '';
  if (my) {
    const names = { iron: '⛏️철', oil: '🛢️유', grain: '🌾곡', machine: '⚙️기계', food: '🍞식품' };
    for (const [k, label] of Object.entries(names)) {
      inv.appendChild(el('span', 'inv-item', `${label} ${fmt1(my.inv[k] || 0)}`));
    }
  }

  renderClock();
  drawMap();
  renderTilePanel();
  renderTabs();
  renderResult();
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
  return (C.materials[key] && C.materials[key].name) || (C.products[key] && C.products[key].name) || key;
}

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
  const rate = spec.rate * (tile.level || 1);
  const t = transportQuote(dist, rate);
  const revenue = spec.base * c.mod[mode] * c.demand[mode] * rate;
  return { dist, rate, transport: t, revenue, net: revenue - t.cost };
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
  const sig = [selectedTile, tile.t, tile.owner, tile.b, tile.mode, tile.level, tile.route, g.ended].join('|');
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
        : '제품 생산 (기계/식품)';
      costButton(`${spec.name} 건설 (${spec.cost}) — ${desc}`, spec.cost, () =>
        emit('build', { idx: selectedTile, kind })
      );
    }
  }

  // 공장: 생산 품목 + 증설 + 배송 노선
  if (tile.owner === ME && tile.b === 'factory') {
    const mode = tile.mode || 'machine';
    const level = tile.level || 1;
    const fSpec = C.buildings.factory;

    panel.appendChild(el('div', 'tp-row', `🏭 공장 ${level}단계`));

    const modeRow = el('div', 'tp-choices');
    for (const [key, p] of Object.entries(C.products)) {
      const recipe = Object.entries(p.recipe)
        .map(([k, n]) => `${nameOf(k)}×${n}`)
        .join('+');
      // 0.18 과 0.22 가 똑같이 "0.2" 로 보이지 않도록 두 자리까지 쓴다
      const rate = Math.round(p.rate * level * 100) / 100;
      const btn = el('button', 'chip' + (mode === key ? ' on' : ''), `${p.name} ${rate}/초 (${recipe})`);
      btn.addEventListener('click', () => emit('setFactoryMode', { idx: selectedTile, mode: key }));
      modeRow.appendChild(btn);
    }
    panel.appendChild(modeRow);

    if (level < fSpec.maxLevel) {
      const cost = fSpec.upgradeCost * level;
      costButton(`⬆️ ${level + 1}단계로 증설 (${cost}) — 생산량 ${level + 1}배`, cost, () =>
        emit('upgradeFactory', { idx: selectedTile })
      );
    }

    const idleRow = el('div', 'tp-row warn', '⚠️ 재료가 없어 멈춰 있습니다');
    panel.appendChild(idleRow);
    live.push(() => {
      const t = S.game.map.tiles[selectedTile];
      idleRow.classList.toggle('hidden', !(t && t.idle));
    });

    // 배송 노선 — 도시별 초당 순이익 (수요에 따라 계속 변한다)
    panel.appendChild(el('div', 'tp-row', '🚚 배송 노선 (초당 순이익)'));
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

    const hint = el('div', 'tp-row small', '노선을 고르면 만들어지는 대로 자동 판매됩니다.');
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
      hint.classList.toggle('hidden', t.route !== null && t.route !== undefined);
    });
  }
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

    for (const key of Object.keys(g.market)) {
      const row = el('div', 'trade-row');
      const info = el('div', 'trade-info');
      info.appendChild(el('b', '', nameOf(key)));
      const price = el('span', '');
      const base = el('span', 'small', ` (기준 ${g.market[key].base})`);
      const held = el('span', 'small', '');
      info.appendChild(price);
      info.appendChild(base);
      info.appendChild(held);
      row.appendChild(info);

      live.push(() => {
        const m = S.game.market[key];
        const diff = m.price - m.base;
        price.textContent = ` ${fmt1(m.price)}`;
        price.className = diff > 0.01 ? 'up' : diff < -0.01 ? 'down' : '';
        const p = me();
        held.textContent = p ? ` · 보유 ${fmt1(p.inv[key] || 0)}` : '';
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
        row.appendChild(controls);
      }
      box.appendChild(row);
    }

    box.appendChild(el('p', 'tab-hint', '도시 수요 — 많이 팔린 곳은 값이 내려가고 시간이 지나면 회복됩니다.'));
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

/* ---------- 주식 ---------- */

function renderStocks() {
  const g = S.game;
  const sig = ['stocks', g.players.map((p) => p.id).join(','), !!me(), g.ended].join('|');
  renderPane('stocks', sig, (live) => {
    const box = $('#tab-stocks');
    const my = me();
    box.innerHTML = '';
    const yieldPct = Math.round(g.constants.dividendYield * 1000) / 10;
    box.appendChild(
      el(
        'p',
        'tab-hint',
        `회사당 ${g.constants.totalShares}주 · 배당은 주가의 ${yieldPct}%/초 · ` +
          `${g.constants.takeoverShares}주를 모으면 경영권 인수`
      )
    );

    for (const p of g.players) {
      const row = el('div', 'stock-row');
      const head = el('div', 'trade-info');
      const dot = el('span', 'dot');
      dot.style.background = p.color;
      head.appendChild(dot);
      head.appendChild(el('b', '', labelOf(p)));
      const price = el('span', '');
      const float = el('span', 'small', '');
      head.appendChild(price);
      head.appendChild(float);
      row.appendChild(head);

      const div = el('div', 'small dividend');
      row.appendChild(div);
      const holders = el('div', 'small holders');
      row.appendChild(holders);
      const takeover = el('div', 'takeover hidden');
      row.appendChild(takeover);

      live.push(() => {
        const gg = S.game;
        const s = gg.stocks[p.id];
        const now = gg.players.find((x) => x.id === p.id);
        const y = gg.constants.dividendYield;
        price.textContent = ` ${fmt1(s.price)}/주`;
        float.textContent = ` 유통 ${s.float}주`;

        // 이 회사 주식에서 내가 받는 배당 / 내 회사가 물고 있는 배당
        const mine = me();
        if (p.id === ME) {
          let out = 0;
          for (const h of gg.players) {
            if (h.id !== ME) out += h.shares[ME] || 0;
          }
          div.textContent = out > 0 ? `내가 내는 배당 -${fmt1(s.price * out * y)}/초` : '나가는 배당 없음';
          div.classList.toggle('down', out > 0);
          div.classList.remove('up');
        } else {
          const n = mine ? mine.shares[p.id] || 0 : 0;
          div.textContent = n > 0 ? `내 배당 +${fmt1(s.price * n * y)}/초 (${n}주)` : '보유 없음';
          div.classList.toggle('up', n > 0);
          div.classList.remove('down');
        }

        const parts = [];
        for (const holder of gg.players) {
          const n = holder.shares[p.id] || 0;
          if (n > 0) parts.push(`${holder.name} ${n}주`);
        }
        holders.textContent = parts.join(' · ') || '보유자 없음';
        const ctrlId = now && now.controller;
        takeover.classList.toggle('hidden', !ctrlId);
        if (ctrlId) {
          const ctrl = gg.players.find((x) => x.id === ctrlId);
          takeover.textContent = `⚡ ${ctrl ? ctrl.name : '?'} 님이 경영권 보유 중`;
        }
      });

      if (my && !g.ended) {
        const controls = el('div', 'trade-controls');
        const qty = el('input');
        qty.type = 'number';
        qty.min = '1';
        qty.placeholder = '주';
        keepInput(qty, 'stk-' + p.id);
        const buy = el('button', 'buy', '매수');
        const sell = el('button', 'sell', '매도');
        buy.addEventListener('click', () =>
          emit('stockTrade', { company: p.id, qty: keptValue('stk-' + p.id, 1), side: 'buy' })
        );
        sell.addEventListener('click', () =>
          emit('stockTrade', { company: p.id, qty: keptValue('stk-' + p.id, 1), side: 'sell' })
        );
        controls.appendChild(qty);
        controls.appendChild(buy);
        controls.appendChild(sell);
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
  renderPane('company', 'company|' + order.join(','), (live) => {
    const box = $('#tab-company');
    box.innerHTML = '';

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
        moneyText.textContent = `현금 ${fmt(now.cash)} · 순자산 ${fmt(now.netWorth)} · `;
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

function renderLog() {
  const list = $('#log-list');
  const items = S.log || [];
  // 내용이 그대로면 스크롤 위치를 흔들지 않는다
  if (list.dataset.len === String(items.length)) return;
  list.dataset.len = String(items.length);
  list.innerHTML = '';
  for (const item of items) list.appendChild(el('div', 'log-item', item.text));
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
  const items = (S.chat || []).slice(-40);
  if (list.dataset.len === String(items.length)) return;
  list.dataset.len = String(items.length);
  list.innerHTML = '';
  for (const c of items) {
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
