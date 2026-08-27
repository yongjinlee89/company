'use strict';

const { Game } = require('./game');
const { think: botThink } = require('./bot');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

const BOT_NAMES = ['알파', '베타', '감마', '델타', '엡실론'];

const TICK_MS = 250; // 시뮬레이션 간격
const BROADCAST_EVERY = 2; // 몇 틱마다 화면을 갱신할지 (250ms × 2 = 0.5초)
const BOT_THINK_MS = 2500; // 컴퓨터가 판단하는 주기

const DEFAULT_SETTINGS = {
  startCash: 1000, // 시작 자금
  duration: 600, // 게임 시간 (초)
};

const SETTING_CHOICES = {
  startCash: [500, 1000, 2000, 3000],
  duration: [300, 600, 900, 1200],
};

/**
 * 방 하나. 대기실 상태와 실시간 게임 루프를 관리한다.
 * phase: 'lobby' | 'playing' | 'ended'
 */
class Room {
  /**
   * @param {string} id
   * @param {(room: Room, full?: boolean) => void} onChange 상태가 바뀌면 호출 (브로드캐스트)
   */
  constructor(id, onChange) {
    this.id = id;
    this.onChange = onChange || (() => {});
    this.phase = 'lobby';
    this.settings = { ...DEFAULT_SETTINGS };
    /** @type {Array<{id,name,socketId,connected,isBot,voice,muted}>} */
    this.players = [];
    this.hostId = null;
    this.game = null;
    this.chat = [];
    this.updatedAt = Date.now();
    this._loop = null;
    this._ticks = 0;
    this._botClock = 0;
    // 채팅/기록은 바뀌었을 때만 실어 보내려고 마지막으로 보낸 길이를 기억해 둔다
    this._sentChatLen = -1;
    this._sentLogLen = -1;
  }

  touch() {
    this.updatedAt = Date.now();
  }

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  /** 봇만 남은 방은 빈 방으로 본다 (그렇지 않으면 영원히 정리되지 않는다) */
  isEmpty() {
    return !this.players.some((p) => p.connected && !p.isBot);
  }

  /** 방장은 사람 중에서 고른다 */
  reassignHost() {
    const next = this.players.find((p) => !p.isBot) || null;
    this.hostId = next ? next.id : null;
  }

  /* ---------------------------------------------------------------- 입장/퇴장 */

  join(playerId, name, socketId) {
    this.touch();
    const existing = this.player(playerId);
    if (existing) {
      // 재접속
      existing.socketId = socketId;
      existing.connected = true;
      existing.name = name || existing.name;
      this.pushLog(`${existing.name} 님이 다시 접속했습니다.`);
      return { ok: true };
    }
    if (this.phase !== 'lobby') {
      return { ok: false, error: '이미 게임이 진행 중인 방입니다.' };
    }
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: `최대 ${MAX_PLAYERS}명까지 입장할 수 있습니다.` };
    }
    if (this.players.some((p) => p.name === name)) {
      return { ok: false, error: '같은 이름이 이미 방에 있습니다.' };
    }
    this.players.push({ id: playerId, name, socketId, connected: true, voice: false, muted: false });
    if (!this.hostId) this.hostId = playerId;
    this.pushLog(`${name} 님이 입장했습니다.`);
    return { ok: true };
  }

  leave(playerId) {
    this.touch();
    const p = this.player(playerId);
    if (!p) return { ok: true };
    if (this.phase === 'lobby') {
      this.players = this.players.filter((x) => x.id !== playerId);
      this.pushLog(`${p.name} 님이 나갔습니다.`);
      if (this.hostId === playerId) this.reassignHost();
    } else {
      // 게임 중에는 자리를 유지한다 (재접속 가능, 회사는 계속 돌아간다)
      p.connected = false;
      p.socketId = null;
      this.pushLog(`${p.name} 님이 자리를 비웠습니다.`);
    }
    return { ok: true };
  }

  disconnect(socketId) {
    if (!socketId) return; // 봇은 socketId 가 null 이므로 실수로 매칭되지 않게 막는다
    const p = this.players.find((x) => x.socketId === socketId);
    if (!p) return;
    this.touch();
    p.socketId = null;
    p.connected = false;
    p.voice = false;
    p.muted = false;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((x) => x.id !== p.id);
      if (this.hostId === p.id) this.reassignHost();
      this.pushLog(`${p.name} 님이 나갔습니다.`);
    } else {
      this.pushLog(`${p.name} 님의 연결이 끊겼습니다.`);
    }
  }

  /* ---------------------------------------------------------------- 컴퓨터 플레이어 */

  addBot(playerId) {
    if (this.phase !== 'lobby') return { ok: false, error: '게임 중에는 추가할 수 없습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 컴퓨터를 추가할 수 있습니다.' };
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: `최대 ${MAX_PLAYERS}명까지 참가할 수 있습니다.` };
    }
    const used = new Set(this.players.map((p) => p.name));
    const label = BOT_NAMES.map((n) => '컴퓨터 ' + n).find((n) => !used.has(n));
    if (!label) return { ok: false, error: '더 추가할 수 없습니다.' };

    this.players.push({
      id: 'bot_' + Math.random().toString(36).slice(2, 10),
      name: label,
      socketId: null,
      connected: true,
      isBot: true,
      voice: false,
      muted: false,
    });
    this.pushLog(`${label} 님이 참가했습니다.`);
    this.touch();
    return { ok: true };
  }

  removeBot(playerId) {
    if (this.phase !== 'lobby') return { ok: false, error: '게임 중에는 뺄 수 없습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 컴퓨터를 뺄 수 있습니다.' };
    for (let i = this.players.length - 1; i >= 0; i--) {
      if (this.players[i].isBot) {
        const [removed] = this.players.splice(i, 1);
        this.pushLog(`${removed.name} 님이 나갔습니다.`);
        this.touch();
        return { ok: true };
      }
    }
    return { ok: false, error: '뺄 컴퓨터가 없습니다.' };
  }

  /* ---------------------------------------------------------------- 설정/시작 */

  updateSettings(playerId, patch) {
    if (this.phase !== 'lobby') return { ok: false, error: '게임 중에는 설정을 바꿀 수 없습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 설정을 바꿀 수 있습니다.' };
    for (const [key, choices] of Object.entries(SETTING_CHOICES)) {
      if (patch[key] !== undefined) {
        const v = Number(patch[key]);
        if (!choices.includes(v)) return { ok: false, error: '잘못된 설정 값입니다.' };
        this.settings[key] = v;
      }
    }
    this.touch();
    return { ok: true };
  }

  start(playerId) {
    if (this.phase !== 'lobby') return { ok: false, error: '이미 시작했습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 시작할 수 있습니다.' };
    const connected = this.players.filter((p) => p.connected);
    if (connected.length < MIN_PLAYERS) {
      return { ok: false, error: `최소 ${MIN_PLAYERS}명이 필요합니다.` };
    }
    this.phase = 'playing';
    this.game = new Game(
      connected.map((p) => ({ id: p.id, name: p.name })),
      { ...this.settings }
    );
    this.game.pushLog(
      `게임 시작! 시작 자금 ${this.settings.startCash}, 제한 시간 ${Math.round(this.settings.duration / 60)}분`
    );
    this.startLoop();
    this.touch();
    return { ok: true };
  }

  resetToLobby() {
    this.stopLoop();
    this.phase = 'lobby';
    this.game = null;
    // 게임 중 나간 사람의 빈자리는 정리한다 (봇은 그대로 두고 다시 쓴다)
    this.players = this.players.filter((p) => p.connected || p.isBot);
    if (!this.player(this.hostId)) this.reassignHost();
    this.touch();
  }

  /** 게임이 끝난 뒤 대기실로 되돌린다 (다시 하기) */
  restart(playerId) {
    if (this.phase === 'lobby') return { ok: true };
    if (this.phase !== 'ended') return { ok: false, error: '게임이 아직 진행 중입니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 다시 시작할 수 있습니다.' };
    this.resetToLobby();
    this.pushLog('대기실로 돌아왔습니다. 설정을 바꾸고 다시 시작하세요.');
    return { ok: true };
  }

  /* ---------------------------------------------------------------- 실시간 루프 */

  startLoop() {
    this.stopLoop();
    this._ticks = 0;
    this._botClock = 0;
    this._loop = setInterval(() => this.step(), TICK_MS);
  }

  stopLoop() {
    if (this._loop) {
      clearInterval(this._loop);
      this._loop = null;
    }
  }

  /** 예전 이름 호환 — 방 정리 시 호출된다 */
  clearAutoTimer() {
    this.stopLoop();
  }

  step() {
    if (this.phase !== 'playing' || !this.game) return;
    this.game.tick(TICK_MS / 1000);

    // 컴퓨터 플레이어 판단
    this._botClock += TICK_MS;
    if (this._botClock >= BOT_THINK_MS) {
      this._botClock = 0;
      let mapChanged = false;
      for (const p of this.players) {
        if (!p.isBot) continue;
        try {
          if (botThink(this.game, p.id)) mapChanged = true;
        } catch (err) {
          console.error('[bot] 판단 중 오류', err);
        }
      }
      // 맵이 바뀌었으니 전체 상태를 보낸다.
      // (touch() 는 하지 않는다 — 사람이 모두 나간 방은 그대로 정리 대상이어야 한다)
      if (mapChanged) {
        this.onChange(this, true);
        return;
      }
    }

    if (this.game.ended) {
      this.phase = 'ended';
      this.stopLoop();
      this.touch();
      this.onChange(this, true);
      return;
    }

    this._ticks++;
    if (this._ticks % BROADCAST_EVERY === 0) this.onChange(this);
  }

  /* ---------------------------------------------------------------- 게임 행동 위임 */

  gameAction(playerId, fn) {
    if (this.phase !== 'playing' || !this.game) return { ok: false, error: '게임 중이 아닙니다.' };
    if (!this.game.player(playerId)) return { ok: false, error: '게임 참가자가 아닙니다.' };
    const result = fn(this.game);
    if (result && result.ok) this.touch();
    return result;
  }

  /* ---------------------------------------------------------------- 로그/상태 */

  pushLog(text) {
    if (this.game) {
      this.game.pushLog(text);
    } else {
      this.chat.push({ t: Date.now(), name: '알림', text });
      if (this.chat.length > 100) this.chat.shift();
    }
  }

  /**
   * 방 전체에 뿌릴 상태를 만든다.
   *
   * 이 게임에는 숨겨진 정보가 없으므로(달무티의 손패 같은 것) 모두가 같은 상태를 본다.
   * 그래서 플레이어마다 따로 만들지 않고 한 번만 만들어 방에 통째로 보낸다.
   * 자기 자신이 누구인지는 클라이언트가 이미 알고 있다.
   *
   * @param {boolean} full 맵·상수까지 모두 보낼지.
   *   맵은 땅을 사거나 건물을 지을 때만 바뀌므로, 0.5초마다 도는 주기 갱신에서는 빼서
   *   트래픽을 아낀다. 클라이언트는 직전에 받은 맵을 그대로 이어 쓴다.
   */
  state(full = true) {
    const base = {
      roomId: this.id,
      phase: this.phase,
      hostId: this.hostId,
      settings: this.settings,
      settingChoices: SETTING_CHOICES,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      roomPlayers: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isBot: !!p.isBot,
        voice: p.voice,
        muted: p.muted,
      })),
    };
    // 채팅·기록은 내용이 바뀌었을 때만 싣는다
    if (full || this.chat.length !== this._sentChatLen) {
      base.chat = this.chat.slice(-60);
      this._sentChatLen = this.chat.length;
    }
    if (this.game) {
      base.game = this.game.publicState(full);
      if (full || this.game.log.length !== this._sentLogLen) {
        base.log = this.game.log.slice(-40);
        this._sentLogLen = this.game.log.length;
      }
    }
    return base;
  }
}

module.exports = { Room, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_SETTINGS, SETTING_CHOICES, TICK_MS };
