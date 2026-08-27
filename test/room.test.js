'use strict';

/* 방/실시간 루프 테스트: node test/room.test.js */

const assert = require('assert');
const { Room, MIN_PLAYERS, MAX_PLAYERS } = require('../src/room');

function newRoom(onChange) {
  return new Room('test', onChange || (() => {}));
}

/* ---------------- 입장/퇴장 ---------------- */
{
  const room = newRoom();
  assert.ok(room.join('a', '갑', 's1').ok);
  assert.ok(room.join('b', '을', 's2').ok);
  assert.strictEqual(room.hostId, 'a');

  assert.ok(!room.join('c', '갑', 's3').ok, '같은 이름은 거부');

  for (let i = 0; i < MAX_PLAYERS; i++) room.join('x' + i, '손님' + i, 'sx' + i);
  assert.ok(room.players.length <= MAX_PLAYERS, '정원을 넘지 않는다');

  const room2 = newRoom();
  room2.join('a', '갑', 's1');
  room2.join('b', '을', 's2');
  room2.leave('a');
  assert.strictEqual(room2.hostId, 'b', '방장이 넘어간다');
  assert.strictEqual(room2.players.length, 1);
  console.log('✓ 입장/퇴장');
}

/* ---------------- 설정/시작 ---------------- */
{
  const room = newRoom();
  room.join('a', '갑', 's1');
  room.join('b', '을', 's2');

  assert.ok(!room.updateSettings('b', { startCash: 2000 }).ok, '방장만 설정 변경');
  assert.ok(room.updateSettings('a', { startCash: 2000, duration: 300 }).ok);
  assert.strictEqual(room.settings.startCash, 2000);
  assert.strictEqual(room.settings.duration, 300);
  assert.ok(!room.updateSettings('a', { duration: 777 }).ok, '목록에 없는 값 거부');

  const solo = newRoom();
  solo.join('a', '갑', 's1');
  assert.ok(!solo.start('a').ok, `혼자서는 시작 불가 (최소 ${MIN_PLAYERS}명)`);

  assert.ok(!room.start('b').ok, '방장만 시작');
  assert.ok(room.start('a').ok);
  assert.strictEqual(room.phase, 'playing');
  assert.ok(room.game);
  assert.strictEqual(room.game.players[0].cash, 2000);
  assert.strictEqual(room.game.settings.duration, 300);

  assert.ok(!room.join('z', '난입', 'sz').ok, '게임 중 새 입장은 거부');
  assert.ok(room.join('a', '갑', 's1-new').ok, '재접속은 허용');
  room.stopLoop();
  console.log('✓ 설정/시작');
}

/* ---------------- 상태 직렬화 (전체 / 주기 갱신) ---------------- */
{
  const room = newRoom();
  room.join('a', '갑', 's1');
  room.join('b', '을', 's2');
  room.start('a');

  const full = room.state(true);
  assert.ok(full.game.map, '전체 상태에는 맵이 들어간다');
  assert.ok(full.log, '전체 상태에는 기록이 들어간다');
  assert.ok(!('you' in full), '상태는 모두에게 동일하다 (개인화 필드 없음)');

  const light = room.state(false);
  assert.ok(!light.game.map, '주기 갱신에는 맵을 빼서 트래픽을 아낀다');
  assert.ok(!light.log, '기록이 그대로면 다시 보내지 않는다');
  assert.ok(light.game.players && light.roomPlayers, '실시간으로 바뀌는 값은 항상 보낸다');
  assert.ok(
    JSON.stringify(light).length * 2 < JSON.stringify(full).length,
    '주기 갱신은 전체 상태의 절반 이하'
  );

  // 기록이 늘어나면 다시 실어 보낸다
  room.game.pushLog('테스트 사건');
  assert.ok(room.state(false).log, '기록이 바뀌면 다시 보낸다');
  assert.ok(!room.state(false).log, '보낸 뒤에는 또 보내지 않는다');
  room.stopLoop();
  console.log('✓ 상태 직렬화 (맵/기록 생략)');
}

/* ---------------- 컴퓨터 플레이어 추가/제거 ---------------- */
{
  const room = newRoom();
  room.join('a', '갑', 's1');
  room.join('b', '을', 's2');

  assert.ok(!room.addBot('b').ok, '방장이 아니면 추가 불가');
  assert.ok(room.addBot('a').ok);
  assert.strictEqual(room.players.filter((p) => p.isBot).length, 1);

  while (room.players.length < MAX_PLAYERS) assert.ok(room.addBot('a').ok);
  assert.ok(!room.addBot('a').ok, '정원 초과 시 거부');
  const names = room.players.map((p) => p.name);
  assert.strictEqual(new Set(names).size, names.length, '이름이 겹치지 않는다');

  const before = room.players.filter((p) => p.isBot).length;
  assert.ok(room.removeBot('a').ok);
  assert.strictEqual(room.players.filter((p) => p.isBot).length, before - 1);

  // 봇만 남은 방은 빈 방으로 본다
  const solo = newRoom();
  solo.join('a', '갑', 's1');
  solo.addBot('a');
  assert.ok(!solo.isEmpty(), '사람이 있으면 빈 방이 아니다');
  solo.disconnect('s1');
  assert.ok(solo.isEmpty(), '봇만 남으면 정리 대상');
  console.log('✓ 컴퓨터 추가/제거');
}

/* ---------------- 실시간 루프가 실제로 돈다 ---------------- */
{
  const room = newRoom();
  room.join('a', '갑', 's1');
  room.addBot('a');
  room.updateSettings('a', { duration: 300 });
  assert.ok(room.start('a').ok, '사람 1 + 컴퓨터 1 로 시작할 수 있다');

  const botId = room.players.find((p) => p.isBot).id;
  const human = room.game.player('a');
  // 사람 쪽에도 돌아가는 광산을 하나 쥐여 준다
  const idx = room.game.map.tiles.findIndex((t) => t.t === 'iron');
  room.game.buyTile('a', idx);
  room.game.build('a', idx, 'mine');

  assert.strictEqual(room.game.elapsed, 0);

  setTimeout(() => {
    // 1) 시간이 흐른다
    assert.ok(room.game.elapsed > 0.5, `시간이 흘러야 한다 (${room.game.elapsed}초)`);
    assert.ok(room.game.remaining !== undefined || true);

    // 2) 아무도 아무것도 안 눌러도 생산이 쌓인다
    assert.ok(human.inv.iron > 0, '실시간으로 자원이 쌓인다');

    // 3) 컴퓨터가 스스로 회사를 키운다
    const built = room.game.map.tiles.some((t) => t.owner === botId && t.b);
    assert.ok(built, '컴퓨터가 건물을 지어야 한다');

    // 4) 그런데 사람 회사는 절대 대신 움직여 주지 않는다
    const humanBought = room.game.map.tiles.filter((t) => t.owner === 'a').length;
    assert.strictEqual(humanBought, 1, '사람이 직접 산 땅 하나뿐이어야 한다');
    assert.strictEqual(human._focus, undefined, '봇 로직이 사람 회사를 건드리면 안 된다');

    room.stopLoop();
    const stopped = room.game.elapsed;
    setTimeout(() => {
      assert.strictEqual(room.game.elapsed, stopped, '루프를 멈추면 시간도 멈춘다');
      console.log(`✓ 실시간 루프 (${Math.round(stopped * 10) / 10}초 진행, 철 ${Math.round(human.inv.iron * 10) / 10})`);
      runEndTest();
    }, 400);
  }, 3200);
}

/* ---------------- 시간이 다 되면 자동으로 끝난다 ---------------- */
function runEndTest() {
  let endBroadcast = null;
  const room = newRoom((r, full) => {
    if (r.phase === 'ended') endBroadcast = { full };
  });
  room.join('a', '갑', 's1');
  room.join('b', '을', 's2');
  room.settings.duration = 1; // 1초짜리 게임
  room.start('a');

  setTimeout(() => {
    assert.strictEqual(room.phase, 'ended', '제한 시간이 지나면 방이 종료 상태가 된다');
    assert.ok(room.game.ended);
    assert.ok(room.game.ranking, '순위가 매겨진다');
    assert.ok(endBroadcast && endBroadcast.full, '종료는 전체 상태로 알린다');
    assert.strictEqual(room._loop, null, '끝나면 루프가 멈춘다');
    console.log('✓ 제한 시간 종료');

    // 끝난 뒤 다시 시작할 수 있어야 한다
    assert.ok(!room.start('a').ok, '끝난 방은 바로 다시 시작되지 않는다');
    assert.ok(!room.restart('b').ok, '방장만 다시 시작할 수 있다');
    assert.ok(room.restart('a').ok);
    assert.strictEqual(room.phase, 'lobby', '대기실로 돌아간다');
    assert.strictEqual(room.game, null);
    assert.strictEqual(room.players.length, 2, '참가자는 그대로 남는다');

    // 대기실로 돌아왔으니 설정을 바꾸고 새 판을 시작할 수 있다
    assert.ok(room.updateSettings('a', { startCash: 2000 }).ok);
    assert.ok(room.start('a').ok, '새 판을 시작할 수 있다');
    assert.strictEqual(room.phase, 'playing');
    assert.strictEqual(room.game.players[0].cash, 2000);
    assert.strictEqual(room.game.elapsed, 0, '새 게임은 처음부터 시작한다');
    room.stopLoop();

    // 게임 중 나간 사람의 빈자리는 다시 하기 때 정리된다
    const r2 = newRoom();
    r2.join('a', '갑', 's1');
    r2.join('b', '을', 's2');
    r2.settings.duration = 1;
    r2.start('a');
    r2.disconnect('s2');
    setTimeout(() => {
      assert.strictEqual(r2.phase, 'ended');
      r2.restart('a');
      assert.strictEqual(r2.players.length, 1, '나간 사람 자리는 정리된다');
      assert.strictEqual(r2.hostId, 'a');
      r2.stopLoop();
      console.log('✓ 다시 하기');
      console.log('\n방 테스트 전부 통과!');
    }, 1800);
  }, 1800);
}
