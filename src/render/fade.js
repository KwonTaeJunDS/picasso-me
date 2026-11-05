// 미감지 페이드 (PLAN 4.7, PRD 6.6).
// 연속 레벨 L ∈ [0,1]. 시작은 L=0. 얼굴이 lostDelayMs(300ms) 이상 연속으로 안 잡히면 미감지로 확정하고
// L 을 -1/outMs 로 내린다. 다시 잡히면 +1/inMs 로 올린다. 진행 중 반전은 현재 L 에서 이어간다.
// 스트로크별 가시도는 고정 순위 ρ 로 계산한다: vis = clamp((L - ρ(1-w))/w, 0, 1).

import { FADE } from '../config/params.js';

/** 가시도 구간 폭 w — 스트로크 하나가 0→1 이 되는 데 걸리는 L 의 폭. */
export const REVEAL_W = 0.15;

export function visibility(L, rho, w = REVEAL_W) {
  const v = (L - rho * (1 - w)) / w;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** @returns {{L:number, lastSeenAt:number, effective:boolean}} */
export function createFade() {
  return { L: 0, lastSeenAt: -Infinity, effective: false };
}

/**
 * @param f createFade() 상태 (제자리 수정)
 * @param present 이번 프레임 검출 여부 (원시, 짧은 끊김 포함)
 * @param nowMs 현재 시각
 * @param dtMs 직전 프레임과의 간격
 * @param opts.snap true 면 present 일 때 즉시 L=1
 * @returns f
 */
export function updateFade(f, present, nowMs, dtMs, cfg = FADE, opts = {}) {
  if (present) f.lastSeenAt = nowMs;
  // 300ms 미만 미검출은 무시: 마지막으로 본 지 lostDelayMs 이내면 계속 "있음"으로 본다
  f.effective = nowMs - f.lastSeenAt < cfg.lostDelayMs;
  const dt = dtMs > 0 ? dtMs : 0;
  if (opts.snap && present) {
    f.L = 1;
  } else if (f.effective) {
    f.L = Math.min(1, f.L + dt / cfg.inMs);
  } else {
    f.L = Math.max(0, f.L - dt / cfg.outMs);
  }
  return f;
}

/** 'hidden' | 'in' | 'visible' | 'out' */
export function fadePhase(f) {
  if (f.effective) return f.L >= 1 ? 'visible' : 'in';
  return f.L > 0 ? 'out' : 'hidden';
}
