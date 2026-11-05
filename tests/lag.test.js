import { describe, it, expect } from 'vitest';
import { createLag, updateLag, snapLag, settleFactor, PART_KEYS } from '../src/render/lag.js';
import { LAG_TAU_MS, LAG_SETTLE } from '../src/config/params.js';

const DT = 1000 / 60;
const T = (t = 0, p = 0, r = 0, k = 0) => ({ t, p, r, k });

function maxResidual(lag, target) {
  let m = 0;
  for (const key of PART_KEYS) {
    const s = lag.parts[key];
    m = Math.max(m, Math.abs(s.t - target.t), Math.abs(s.p - target.p), Math.abs(s.r - target.r), Math.abs(s.k - target.k));
  }
  return m;
}

describe('lag 기본', () => {
  it('τ=0 부품(윤곽·분할선)은 즉시 따라온다', () => {
    const lag = createLag();
    updateLag(lag, T(0.8, -0.5, 0.3, 0.6), DT, 1);
    for (const key of ['contour', 'split']) {
      expect(lag.parts[key]).toEqual(T(0.8, -0.5, 0.3, 0.6));
    }
    // 나머지는 아직 덜 따라옴
    expect(lag.parts.hair.t).toBeLessThan(0.2);
  });

  it('lagScale=0 이면 모든 부품이 즉시', () => {
    const lag = createLag();
    updateLag(lag, T(-1, 1, -1, 1), DT, 0);
    for (const key of PART_KEYS) expect(lag.parts[key]).toEqual(T(-1, 1, -1, 1));
  });

  it('움직이는 동안 τ 순서대로 어긋난다 (귀·머리카락 > 코 > 입 > 눈 > 윤곽)', () => {
    const lag = createLag(T(-1));
    snapLag(lag, T(-1));
    let tg = -1;
    // 일정 속도 2/s (정지 판정이 되지 않는 빠르기) 로 1초 동안 -1 → +1
    for (let i = 0; i < 60; i++) {
      tg += (2 * DT) / 1000;
      updateLag(lag, T(tg), DT, 1);
    }
    const off = (key) => tg - lag.parts[key].t;
    expect(off('contour')).toBeCloseTo(0, 6);
    expect(off('split')).toBeCloseTo(0, 6);
    expect(off('eyes')).toBeGreaterThan(0.04);
    expect(off('mouth')).toBeGreaterThan(off('eyes'));
    expect(off('nose')).toBeGreaterThan(off('mouth'));
    expect(off('ears')).toBeGreaterThan(off('nose'));
    expect(off('hair')).toBeCloseTo(off('ears'), 6);
    // 정상 상태 오프셋 ≈ 속도 × τ
    expect(off('hair')).toBeGreaterThan(0.42);
    expect(off('hair')).toBeLessThan(0.55);
    expect(off('nose')).toBeGreaterThan(0.25);
    expect(off('nose')).toBeLessThan(0.33);
  });

  it('빠른 회전 후 정지 → 0.5초 안에 모든 부품 잔차 < 5%', () => {
    const lag = createLag(T(-1, -1, -1, 0));
    snapLag(lag, T(-1, -1, -1, 0));
    let target = T(-1, -1, -1, 0);
    // 0.3초에 -1 → +1 (t,p,r), k 도 0 → 1
    const steps = Math.round(300 / DT);
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      target = T(-1 + 2 * f, -1 + 2 * f, -1 + 2 * f, f);
      updateLag(lag, target, DT, 1);
    }
    const during = maxResidual(lag, target);
    expect(during).toBeGreaterThan(0.3); // 움직이는 동안은 확실히 어긋남
    // 정지 후 500ms
    const stopSteps = Math.round(500 / DT);
    for (let i = 0; i < stopSteps; i++) updateLag(lag, target, DT, 1);
    // 전체 범위(2)의 5% = 0.1 미만, 실제로는 이보다 훨씬 작아야 한다
    expect(maxResidual(lag, target)).toBeLessThan(0.05);
  });

  it('lagScale 가 커도(2) 정지 후 0.5초 안에 대부분 수렴한다', () => {
    const lag = createLag(T(-1));
    snapLag(lag, T(-1));
    let target = T(-1);
    const steps = Math.round(300 / DT);
    for (let i = 1; i <= steps; i++) {
      target = T(-1 + (2 * i) / steps);
      updateLag(lag, target, DT, 2);
    }
    for (let i = 0; i < Math.round(500 / DT); i++) updateLag(lag, target, DT, 2);
    expect(maxResidual(lag, target)).toBeLessThan(0.2);
  });

  it('30Hz 로 갱신되는 계단형 목표에서도 정지 후 수렴한다', () => {
    const lag = createLag(T(-1));
    snapLag(lag, T(-1));
    let target = T(-1);
    // 신호는 33.3ms 마다만 갱신 (카메라 30fps), 렌더는 16.7ms
    let sampleClock = 0;
    for (let i = 0; i < 24; i++) {
      sampleClock += DT;
      if (sampleClock >= 33.3) {
        sampleClock -= 33.3;
        target = T(Math.min(1, target.t + (2 * 33.3) / 400)); // 0.4초에 -1 → +1
      }
      updateLag(lag, target, DT, 1);
    }
    for (let i = 0; i < Math.round(500 / DT); i++) updateLag(lag, target, DT, 1);
    expect(Math.abs(lag.parts.hair.t - target.t)).toBeLessThan(0.05);
  });

  it('settleFactor 는 1 → minFactor 로 단조 감소', () => {
    expect(settleFactor(0)).toBe(1);
    expect(settleFactor(LAG_SETTLE.rampMs)).toBeCloseTo(LAG_SETTLE.minFactor, 6);
    expect(settleFactor(10000)).toBeCloseTo(LAG_SETTLE.minFactor, 6);
    let prev = 2;
    for (let ms = 0; ms <= 200; ms += 5) {
      const v = settleFactor(ms);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });

  it('snapLag 는 모든 부품을 즉시 맞춘다', () => {
    const lag = createLag();
    snapLag(lag, T(0.4, 0.2, -0.6, 0.9));
    for (const key of PART_KEYS) expect(lag.parts[key]).toEqual(T(0.4, 0.2, -0.6, 0.9));
    // 이후 같은 목표면 움직이지 않는다
    updateLag(lag, T(0.4, 0.2, -0.6, 0.9), DT, 1);
    for (const key of PART_KEYS) expect(lag.parts[key]).toEqual(T(0.4, 0.2, -0.6, 0.9));
  });

  it('dt=0·음수·큰 dt 에서도 NaN 이 없다', () => {
    const lag = createLag();
    updateLag(lag, T(1, 1, 1, 1), 0, 1);
    updateLag(lag, T(-1, 1, 1, 1), 5000, 1);
    updateLag(lag, T(-1, 1, 1, 1), -5, 1);
    for (const key of PART_KEYS) {
      const s = lag.parts[key];
      expect(Number.isFinite(s.t + s.p + s.r + s.k)).toBe(true);
    }
    // 큰 dt 에서는 거의 수렴
    expect(lag.parts.hair.t).toBeCloseTo(-1, 3);
  });

  it('τ 표는 params 의 LAG_TAU_MS 를 따른다', () => {
    expect(LAG_TAU_MS.contour).toBe(0);
    expect(LAG_TAU_MS.hair).toBe(250);
    expect(PART_KEYS.every((k) => k in LAG_TAU_MS)).toBe(true);
  });
});
