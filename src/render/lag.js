// 부품별 시간차 (PLAN 4.4, PRD 6.4).
// 부품마다 (t,p,r,k) 의 지수 평활 사본을 갖는다: x += (target - x)·(1 - exp(-dt/τ_eff)).
// τ = LAG_TAU_MS[부품] × lagScale, τ=0 이면 즉시. 깜빡임·jaw 는 여기 포함되지 않는다(즉시 반영).
// 정지 후 가속 수렴: τ=0 목표의 속도가 stillSpeed 미만으로 머무는 동안 τ 를 minFactor 까지 줄여
// 움직일 땐 PRD 의 τ 그대로 어긋나고, 멈추면 0.5초 안에 제자리로 맞춰지게 한다.

import { LAG_TAU_MS, LAG_SETTLE } from '../config/params.js';

export const PART_KEYS = Object.freeze(['contour', 'split', 'eyes', 'mouth', 'nose', 'ears', 'hair']);

const SPEED_EMA_MS = 50; // 목표 속도 평활 (30Hz 계단형 갱신을 고르게)

function copy4(dst, src) {
  dst.t = src.t;
  dst.p = src.p;
  dst.r = src.r;
  dst.k = src.k;
}

/** 부품 상태 묶음 생성. */
export function createLag(init = { t: 0, p: 0, r: 0, k: 0 }) {
  const parts = {};
  for (const key of PART_KEYS) parts[key] = { t: init.t, p: init.p, r: init.r, k: init.k };
  return {
    parts,
    prev: { t: init.t, p: init.p, r: init.r, k: init.k },
    hasPrev: false,
    speed: 0, // 평활된 목표 속도(정규화 단위/초)
    stillMs: 0, // 목표가 정지로 머문 시간
  };
}

/** 모든 부품을 목표에 즉시 맞춘다 (갤러리 snap, 재등장 시). */
export function snapLag(lag, target) {
  for (const key of PART_KEYS) copy4(lag.parts[key], target);
  copy4(lag.prev, target);
  lag.hasPrev = true;
  lag.speed = 0;
  lag.stillMs = 1e6;
  return lag;
}

const smooth01 = (x) => {
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * (3 - 2 * c);
};

/** 정지 경과 시간 → τ 배수 (1 → minFactor). */
export function settleFactor(stillMs, cfg = LAG_SETTLE) {
  return 1 + (cfg.minFactor - 1) * smooth01(stillMs / cfg.rampMs);
}

/**
 * @param lag createLag() 상태 (제자리 수정)
 * @param target {t,p,r,k} 필터된 신호
 * @param dtMs 프레임 간격
 * @param lagScale params.lagScale (0 = 끔)
 */
export function updateLag(lag, target, dtMs, lagScale = 1, cfg = LAG_SETTLE, taus = LAG_TAU_MS) {
  const dt = dtMs > 0 ? dtMs : 0;

  // 목표 속도로 정지 판정
  if (lag.hasPrev && dt > 0) {
    const dx = Math.max(
      Math.abs(target.t - lag.prev.t),
      Math.abs(target.p - lag.prev.p),
      Math.abs(target.r - lag.prev.r),
      Math.abs(target.k - lag.prev.k),
    );
    const inst = dx / (dt / 1000);
    const a = 1 - Math.exp(-dt / SPEED_EMA_MS);
    lag.speed += (inst - lag.speed) * a;
  }
  copy4(lag.prev, target);
  lag.hasPrev = true;
  if (dt > 0) {
    if (lag.speed < cfg.stillSpeed) lag.stillMs += dt;
    else lag.stillMs = 0;
  }
  const settle = settleFactor(lag.stillMs, cfg);

  for (const key of PART_KEYS) {
    const tau = (taus[key] || 0) * lagScale * settle;
    const s = lag.parts[key];
    if (tau <= 1e-6 || dt <= 0) {
      if (tau <= 1e-6) copy4(s, target);
      continue;
    }
    const a = 1 - Math.exp(-dt / tau);
    s.t += (target.t - s.t) * a;
    s.p += (target.p - s.p) * a;
    s.r += (target.r - s.r) * a;
    s.k += (target.k - s.k) * a;
  }
  return lag;
}
