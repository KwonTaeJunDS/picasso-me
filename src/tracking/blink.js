// 눈 깜빡임 판정. One Euro 는 짧은 깜빡임을 삼키므로 원시 blendshape 에 히스테리시스 + 최소 유지 시간을 쓴다.
// 출력 규약(contracts.js): 값 ≥ 0.5 ⇔ 감김. 감김이면 max(raw, 0.5), 아니면 min(raw, 0.49).

import { BLINK } from '../config/params.js';

const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0); // NaN 은 0

/** 감김 상태와 원시값으로 출력값을 만든다 (순수 함수) */
export function blinkOutput(raw, closed, cfg = BLINK) {
  const r = clamp01(raw);
  return closed ? Math.max(r, cfg.closeAt) : Math.min(r, cfg.closeAt - 0.01);
}

/**
 * 눈 하나의 깜빡임 상태기계.
 *  - 감김: raw ≥ closeAt
 *  - 뜸:  raw ≤ openAt 이면서 감긴 지 minHoldMs 이상 지남 (사이 구간 openAt~closeAt 은 상태 유지)
 * 상태는 표본(push)과 시간 경과(value) 양쪽에서 갱신되므로 30Hz 1프레임 깜빡임도 minHoldMs 동안 보인다.
 */
export function createBlink(cfg = BLINK) {
  let closed = false;
  let closedAt = 0;
  let raw = 0;

  function settle(now) {
    if (closed && raw <= cfg.openAt && now - closedAt >= cfg.minHoldMs) closed = false;
  }

  return {
    /** 새 표본(원시 blendshape 값 0~1, 표본 시각 ms) */
    push(value, at) {
      raw = clamp01(value);
      if (!closed) {
        if (raw >= cfg.closeAt) {
          closed = true;
          closedAt = at;
        }
      } else {
        settle(at);
      }
    },
    /** 현재 시각의 출력값 */
    value(now) {
      settle(now);
      return blinkOutput(raw, closed, cfg);
    },
    isClosed(now) {
      settle(now);
      return closed;
    },
    reset() {
      closed = false;
      closedAt = 0;
      raw = 0;
    },
  };
}
