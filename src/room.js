'use strict';

const { Game } = require('./game');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

const DEFAULT_SETTINGS = {
  startCash: 1000, // 시작 자금
  rounds: 20, // 총 라운드
  roundTime: 90, // 라운드 제한 시간 (초)
};

const SETTING_CHOICES = {
  startCash: [500, 1000, 2000, 3000],
  rounds: [10, 15, 20, 30],
  roundTime: [60, 90, 120, 180],
};

/**
 * 방 하나. 대기실(로비) 상태와 게임 진행을 관리한다.
 * phase: 'lobby' | 'playing' | 'ended'
 */
class Room {
  /**
   * @param {string} id
   * @param {(room: Room) => void} onChange 상태가 바뀌면 호출 (브로드캐스트)
   */
  constructor(id, onChange) {
    this.id = id;
    this.onChange = onChange || (() => {});
    this.phase = 'lobby';
    this.settings = { ...DEFAULT_SETTINGS };
    /** @type {Array<{id,name,socketId,connected,voice,muted}>} */
    this.players = [];
    this.hostId = null;
    this.game = null;
    this.chat = [];
    this.updatedAt = Date.now();
    this.roundEndsAt = null;
    this._roundTimer = null;
  }

  touch() {
    this.updatedAt = Date.now();
  }

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  isEmpty() {
    return !this.players.some((p) => p.connected);
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
      if (this.hostId === playerId) {
        this.hostId = this.players[0] ? this.players[0].id : null;
      }
    } else {
      // 게임 중에는 자리를 유지한다 (재접속 가능)
      p.connected = false;
      p.socketId = null;
      this.pushLog(`${p.name} 님이 자리를 비웠습니다.`);
    }
    return { ok: true };
  }

  disconnect(socketId) {
    const p = this.players.find((x) => x.socketId === socketId);
    if (!p) return;
    this.touch();
    p.socketId = null;
    p.connected = false;
    p.voice = false;
    p.muted = false;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((x) => x.id !== p.id);
      if (this.hostId === p.id) {
        this.hostId = this.players[0] ? this.players[0].id : null;
      }
      this.pushLog(`${p.name} 님이 나갔습니다.`);
    } else {
      this.pushLog(`${p.name} 님의 연결이 끊겼습니다.`);
    }
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
    this.game.pushLog(`게임 시작! 시작 자금 ${this.settings.startCash}, 총 ${this.settings.rounds}라운드`);
    this.startRoundTimer();
    this.touch();
    return { ok: true };
  }

  resetToLobby() {
    this.clearAutoTimer();
    this.phase = 'lobby';
    this.game = null;
    this.roundEndsAt = null;
    this.touch();
  }

  /* ---------------------------------------------------------------- 라운드 타이머 */

  startRoundTimer() {
    this.clearAutoTimer();
    if (!this.game || this.game.ended) {
      this.roundEndsAt = null;
      return;
    }
    const ms = this.settings.roundTime * 1000;
    this.roundEndsAt = Date.now() + ms;
    this._roundTimer = setTimeout(() => this.finishRound(), ms);
  }

  clearAutoTimer() {
    if (this._roundTimer) {
      clearTimeout(this._roundTimer);
      this._roundTimer = null;
    }
  }

  finishRound() {
    if (this.phase !== 'playing' || !this.game) return;
    this.game.resolveRound();
    if (this.game.ended) {
      this.phase = 'ended';
      this.roundEndsAt = null;
      this.clearAutoTimer();
    } else {
      this.startRoundTimer();
    }
    this.touch();
    this.onChange(this);
  }

  setReady(playerId, ready) {
    if (this.phase !== 'playing' || !this.game) return { ok: false, error: '게임 중이 아닙니다.' };
    const gp = this.game.player(playerId);
    if (!gp) return { ok: false, error: '게임 참가자가 아닙니다.' };
    gp.ready = !!ready;
    // 접속 중인 전원이 준비되면 바로 정산
    const allReady = this.game.players.every((gp2) => {
      const rp = this.player(gp2.id);
      return gp2.ready || !rp || !rp.connected;
    });
    if (allReady) {
      // 브로드캐스트는 finishRound 가 한다. 중복 방지를 위해 여기서는 ok 만 반환.
      setImmediate(() => this.finishRound());
    }
    this.touch();
    return { ok: true };
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

  stateFor(playerId) {
    const base = {
      roomId: this.id,
      phase: this.phase,
      you: playerId,
      hostId: this.hostId,
      settings: this.settings,
      settingChoices: SETTING_CHOICES,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      roundEndsAt: this.roundEndsAt,
      chat: this.chat.slice(-60),
      roomPlayers: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        voice: p.voice,
        muted: p.muted,
      })),
    };
    if (this.game) {
      base.game = this.game.publicState();
      base.log = this.game.log.slice(-60);
    }
    return base;
  }
}

module.exports = { Room, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_SETTINGS, SETTING_CHOICES };
