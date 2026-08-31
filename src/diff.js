'use strict';

/**
 * 상태 차이(diff) 프로토콜 — 트래픽을 극단적으로 줄이는 핵심 장치.
 *
 * 서버는 매 갱신마다 상태 전체를 보내는 대신, 직전에 보낸 스냅샷과 비교해
 * "바뀐 부분만" 보낸다. 클라이언트는 같은 규칙(applyPatch)으로 제자리에 합친다.
 *
 * 규칙:
 *  - 객체: 바뀐 키만 재귀적으로 담는다. 사라진 키는 DEL 마커.
 *  - 배열: 바뀐 인덱스만 담고, 길이가 달라지면 $len 을 함께 담는다.
 *  - 그 외(원시값·타입이 바뀐 값): 새 값을 통째로 담는다.
 *
 * 패치의 "객체" 는 부분 갱신, 실제 JSON 배열은 통째 교체로 해석한다.
 * (게임 상태에서 배열↔객체로 타입이 바뀌는 필드는 없으므로 안전하다)
 */

// 삭제 마커 — 게임 데이터(한글 텍스트·숫자)에 절대 나올 수 없는 문자열
const DEL = '\u0000~del~\u0000';

const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * a → b 로 가는 패치를 만든다. 차이가 없으면 undefined.
 * a, b 는 JSON 직렬화 가능한 값(스냅샷)이어야 한다.
 */
function diff(a, b) {
  if (a === b) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) {
    const patch = {};
    let changed = false;
    for (let i = 0; i < b.length; i++) {
      if (i < a.length) {
        const d = diff(a[i], b[i]);
        if (d !== undefined) {
          patch[i] = d;
          changed = true;
        }
      } else {
        patch[i] = b[i]; // 새로 늘어난 칸은 통째로
        changed = true;
      }
    }
    if (a.length !== b.length) {
      patch.$len = b.length;
      changed = true;
    }
    return changed ? patch : undefined;
  }
  if (isPlainObj(a) && isPlainObj(b)) {
    const patch = {};
    let changed = false;
    for (const k of Object.keys(b)) {
      const d = diff(a[k], b[k]);
      if (d !== undefined) {
        patch[k] = d;
        changed = true;
      }
    }
    for (const k of Object.keys(a)) {
      if (!(k in b)) {
        patch[k] = DEL;
        changed = true;
      }
    }
    return changed ? patch : undefined;
  }
  // 원시값이 다르거나 타입이 바뀌었다 — 새 값 통째로
  return b;
}

/**
 * diff() 가 만든 패치를 target 에 제자리로 합친다. (클라이언트에도 같은 코드가 있다)
 */
function applyPatch(target, patch) {
  for (const k of Object.keys(patch)) {
    if (k === '$len') continue;
    const v = patch[k];
    if (v === DEL) {
      delete target[k];
      continue;
    }
    const cur = target[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object') {
      applyPatch(cur, v);
    } else {
      target[k] = v;
    }
  }
  if (patch.$len !== undefined && Array.isArray(target)) target.length = patch.$len;
  return target;
}

module.exports = { diff, applyPatch, DEL };
