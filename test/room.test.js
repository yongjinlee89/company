'use strict';

/* 방/라운드 진행 테스트: node test/room.test.js */

const assert = require('assert');
const { Room, MIN_PLAYERS, MAX_PLAYERS } = require('../src/room');

function newRoom() {
  return new Room('test', () => {});
}

/* ---------------- 입장/퇴장 ---------------- */
{
  const room = newRoom();
  assert.ok(room.join('a', '갑', 's1').ok);
  assert.ok(room.join('b', '을', 's2').ok);
  assert.strictEqual(room.hostId, 'a');

  // 같은 이름 거부
  assert.ok(!room.join('c', '갑', 's3').ok);

  // 정원 초과 거부
  for (let i = 0; i < MAX_PLAYERS; i++) room.join('x' + i, '손님' + i, 'sx' + i);
  assert.ok(room.players.length <= MAX_PLAYERS);

  // 로비에서 나가면 자리가 사라지고 방장이 넘어간다
  const room2 = newRoom();
  room2.join('a', '갑', 's1');
  room2.join('b', '을', 's2');
  room2.leave('a');
  assert.strictEqual(room2.hostId, 'b');
  assert.strictEqual(room2.players.length, 1);
  console.log('✓ 입장/퇴장');
}

/* ---------------- 설정/시작 ---------------- */
{
  const room = newRoom();
  room.join('a', '갑', 's1');
  room.join('b', '을', 's2');

  // 방장만 설정 변경
  assert.ok(!room.updateSettings('b', { startCash: 2000 }).ok);
  assert.ok(room.updateSettings('a', { startCash: 2000, rounds: 10 }).ok);
  assert.strictEqual(room.settings.startCash, 2000);
  assert.ok(!room.updateSettings('a', { startCash: 777 }).ok, '목록에 없는 값 거부');

  // 혼자서는 시작 불가
  const solo = newRoom();
  solo.join('a', '갑', 's1');
  assert.ok(!solo.start('a').ok);

  // 방장만 시작
  assert.ok(!room.start('b').ok);
  assert.ok(room.start('a').ok);
  assert.strictEqual(room.phase, 'playing');
  assert.ok(room.game);
  assert.strictEqual(room.game.players[0].cash, 2000);
  assert.ok(room.roundEndsAt > Date.now());

  // 게임 중 입장 거부 (새 사람)
  assert.ok(!room.join('z', '난입', 'sz').ok);
  // 재접속은 허용
  assert.ok(room.join('a', '갑', 's1-new').ok);
  room.clearAutoTimer();
  console.log('✓ 설정/시작');
}

/* ---------------- 준비/라운드 진행 ---------------- */
{
  const room = newRoom();
  room.join('a', '갑', 's1');
  room.join('b', '을', 's2');
  room.updateSettings('a', { rounds: 10 });
  room.start('a');

  assert.strictEqual(room.game.round, 1);
  room.setReady('a', true);
  assert.strictEqual(room.game.round, 1, '한 명 준비로는 정산 안 됨');
  room.setReady('b', true);

  // setImmediate 로 정산되므로 다음 틱에 확인
  setImmediate(() => {
    assert.strictEqual(room.game.round, 2, '전원 준비 시 즉시 정산');
    assert.ok(room.game.players.every((p) => !p.ready), '정산 후 준비 해제');

    // 연결 끊긴 사람은 준비를 기다리지 않는다
    room.disconnect('s2');
    room.setReady('a', true);
    setImmediate(() => {
      assert.strictEqual(room.game.round, 3, '접속자 전원 준비면 정산');
      room.clearAutoTimer();
      console.log('✓ 준비/라운드 진행');
      console.log('\n방 테스트 전부 통과!');
    });
  });
}
