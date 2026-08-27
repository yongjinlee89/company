'use strict';

const { Game } = require('./game');
const { playRound: botPlayRound } = require('./bot');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

const BOT_NAMES = ['알파', '베타', '감마', '델타', '엡실론'];

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
    /** 봇 행동 예약 타이머 (라운드가 바뀌거나 방이 정리될 때 모두 취소한다) */
    this._botTimers = [];
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
      // 게임 중에는 자리를 유지한다 (재접속 가능)
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

  /**
   * 이번 라운드의 봇 행동을 예약한다.
   * 사람이 보기에 자연스럽도록 조금씩 시차를 두고 움직인 뒤 준비를 누른다.
   */
  scheduleBots() {
    this.clearBotTimers();
    if (this.phase !== 'playing' || !this.game || this.game.ended) return;
    const round = this.game.round;
    const stale = () => this.phase !== 'playing' || !this.game || this.game.round !== round;

    this.players
      .filter((p) => p.isBot)
      .forEach((bot, i) => {
        const delay = 1200 + i * 700 + Math.floor(Math.random() * 900);
        this._botTimers.push(
          setTimeout(() => {
            if (stale()) return;
            try {
              botPlayRound(this.game, bot.id);
            } catch (err) {
              console.error('[bot] 행동 중 오류', err);
            }
            this.touch();
            this.onChange(this);
            this._botTimers.push(
              setTimeout(() => {
                if (stale()) return;
                // setReady 안에서 전원 준비 시 정산 + 브로드캐스트까지 처리된다
                if (this.setReady(bot.id, true).ok) this.onChange(this);
              }, 600 + Math.floor(Math.random() * 700))
            );
          }, delay)
        );
      });
  }

  clearBotTimers() {
    for (const t of this._botTimers) clearTimeout(t);
    this._botTimers = [];
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
    this.scheduleBots();
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
    this.clearBotTimers();
  }

  finishRound() {
    if (this.phase !== 'playing' || !this.game) return;
    this.clearBotTimers();
    this.game.resolveRound();
    if (this.game.ended) {
      this.phase = 'ended';
      this.roundEndsAt = null;
      this.clearAutoTimer();
    } else {
      this.startRoundTimer();
      this.scheduleBots();
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
        isBot: !!p.isBot,
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
