import { describe, it, expect } from 'vitest';
import { createOneEuro, smoothingFactor } from '../src/tracking/oneEuro.js';

const DT = 1 / 60;

describe('smoothingFactor', () => {
  it('0~1 사이이고 cutoff·dt 가 클수록 커진다', () => {
    const a = smoothingFactor(1, DT);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(smoothingFactor(5, DT)).toBeGreaterThan(a);
    expect(smoothingFactor(1, DT * 4)).toBeGreaterThan(a);
  });
});

describe('createOneEuro', () => {
  it('첫 표본은 그대로 통과한다', () => {
    const f = createOneEuro();
    expect(f.value).toBeNull();
    expect(f.filter(12.5, DT, 1, 0.05)).toBe(12.5);
    expect(f.value).toBe(12.5);
  });

  it('상수 입력은 상수로 유지된다', () => {
    const f = createOneEuro();
    let y = 0;
    for (let i = 0; i < 100; i++) y = f.filter(7, DT, 1, 0.05);
    expect(y).toBeCloseTo(7, 10);
  });

  it('계단 입력에 단조롭게 수렴한다 (넘치지 않음)', () => {
    const f = createOneEuro();
    f.filter(0, DT, 1, 0);
    let prev = 0;
    let y = 0;
    for (let i = 0; i < 300; i++) {
      y = f.filter(10, DT, 1, 0);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y).toBeLessThanOrEqual(10 + 1e-9);
      prev = y;
    }
    expect(y).toBeGreaterThan(9.9);
  });

  it('작은 떨림(지터)은 줄인다', () => {
    const f = createOneEuro();
    const out = [];
    for (let i = 0; i < 120; i++) out.push(f.filter(5 + (i % 2 ? 0.5 : -0.5), DT, 1, 0.05));
    const tail = out.slice(60);
    const amp = (Math.max(...tail) - Math.min(...tail)) / 2;
    expect(amp).toBeLessThan(0.15); // 입력 진폭 0.5
  });

  it('beta 가 크면 빠른 움직임에서 지연이 줄어든다', () => {
    const lagAfterRamp = (beta) => {
      const f = createOneEuro();
      let y = 0;
      let x = 0;
      for (let i = 0; i < 60; i++) {
        x = 40 * (i * DT); // 40 단위/초로 1초 이동
        y = f.filter(x, DT, 1, beta);
      }
      return x - y;
    };
    const slow = lagAfterRamp(0);
    const fast = lagAfterRamp(0.5);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeLessThan(slow * 0.5);
  });

  it('minCutoff 를 호출 때마다 바꿀 수 있다 (패널 즉시 반영)', () => {
    const run = (cutoff) => {
      const f = createOneEuro();
      f.filter(0, DT, cutoff, 0);
      return f.filter(10, DT, cutoff, 0);
    };
    expect(run(5)).toBeGreaterThan(run(0.5));
  });

  it('dt <= 0 이거나 NaN 입력이면 직전 출력을 유지하고 NaN 을 만들지 않는다', () => {
    const f = createOneEuro();
    f.filter(3, DT, 1, 0.05);
    const y1 = f.filter(4, DT, 1, 0.05);
    expect(f.filter(100, 0, 1, 0.05)).toBe(y1);
    expect(f.filter(100, -1, 1, 0.05)).toBe(y1);
    expect(f.filter(NaN, DT, 1, 0.05)).toBe(y1);
    expect(f.filter(Infinity, DT, 1, 0.05)).toBe(y1);
    const g = createOneEuro();
    expect(g.filter(NaN, DT, 1, 0.05)).toBe(0); // 아직 상태가 없으면 0
  });

  it('reset 후 다음 표본은 다시 그대로 통과한다 (재등장 시 리셋)', () => {
    const f = createOneEuro();
    f.filter(0, DT, 1, 0.05);
    f.filter(1, DT, 1, 0.05);
    f.reset();
    expect(f.value).toBeNull();
    expect(f.filter(50, DT, 1, 0.05)).toBe(50);
  });

  it('pass(필터 비활성)는 값을 그대로 돌려주고 내부 상태를 따라간다', () => {
    const f = createOneEuro();
    expect(f.pass(10)).toBe(10);
    expect(f.pass(20)).toBe(20);
    expect(f.value).toBe(20);
    // 다시 켜면 마지막 값에서 이어서 필터링 (튀지 않음)
    const y = f.filter(20, DT, 1, 0.05);
    expect(y).toBeCloseTo(20, 10);
  });

  it('필터 인스턴스는 서로 독립이다', () => {
    const a = createOneEuro();
    const b = createOneEuro();
    a.filter(1, DT, 1, 0);
    b.filter(100, DT, 1, 0);
    expect(a.value).toBe(1);
    expect(b.value).toBe(100);
  });
});
