import { describe, it, expect, vi } from 'vitest';
import {
  hash32, hashStr, rand01, rand11, mulberry32, epochOf,
  noise1, noise1Periodic, noise2, noiseLoop, fbm1,
} from '../src/render/noise.js';

describe('hash', () => {
  it('같은 입력은 같은 해시, 다른 입력은 다른 해시', () => {
    expect(hash32(1, 2, 3, 4)).toBe(hash32(1, 2, 3, 4));
    expect(hash32(1, 2, 3, 4)).not.toBe(hash32(1, 2, 3, 5));
    expect(hash32(1, 2)).not.toBe(hash32(2, 1));
    expect(hashStr('eyeL.white')).toBe(hashStr('eyeL.white'));
    expect(hashStr('eyeL.white')).not.toBe(hashStr('eyeR.white'));
  });

  it('uint32 범위, rand01 은 [0,1) 이고 분포가 고르다', () => {
    let sum = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const h = hash32(i, 7);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(4294967296);
      const r = rand01(h);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
      sum += r;
    }
    expect(sum / N).toBeGreaterThan(0.48);
    expect(sum / N).toBeLessThan(0.52);
    expect(rand11(0x80000000)).toBeCloseTo(0, 6);
  });

  it('mulberry32 는 시드가 같으면 같은 수열', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const sa = Array.from({ length: 8 }, () => a());
    const sb = Array.from({ length: 8 }, () => b());
    const sc = Array.from({ length: 8 }, () => c());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    sa.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    });
  });
});

describe('epoch', () => {
  it('초당 fps 번만 바뀐다', () => {
    expect(epochOf(0, 10)).toBe(0);
    expect(epochOf(99.9, 10)).toBe(0);
    expect(epochOf(100, 10)).toBe(1);
    expect(epochOf(1000, 10)).toBe(10);
    expect(epochOf(1000, 8)).toBe(8);
    // 1초 동안 60fps 프레임을 돌리면 서로 다른 epoch 가 fps 개
    const set = new Set();
    for (let i = 0; i < 60; i++) set.add(epochOf(5000 + (i * 1000) / 60, 10));
    expect(set.size).toBe(10);
  });
});

describe('값 노이즈', () => {
  it('범위 [-1,1] 이고 결정적이다', () => {
    for (let i = 0; i < 2000; i++) {
      const x = i * 0.137 - 100;
      const v = noise1(x, 3);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      expect(noise1(x, 3)).toBe(v);
      const w = noise2(x, x * 0.7 + 3, 9);
      expect(Math.abs(w)).toBeLessThanOrEqual(1);
    }
  });

  it('시드가 다르면 다른 값', () => {
    let diff = 0;
    for (let i = 0; i < 100; i++) if (Math.abs(noise1(i + 0.5, 1) - noise1(i + 0.5, 2)) > 1e-6) diff++;
    expect(diff).toBeGreaterThan(90);
  });

  it('연속적이다 (작은 이동 → 작은 변화)', () => {
    let maxStep = 0;
    for (let i = 0; i < 4000; i++) {
      const x = i * 0.01;
      maxStep = Math.max(maxStep, Math.abs(noise1(x + 0.01, 5) - noise1(x, 5)));
      maxStep = Math.max(maxStep, Math.abs(noise2(x + 0.01, 1.3, 5) - noise2(x, 1.3, 5)));
    }
    expect(maxStep).toBeLessThan(0.05);
  });

  it('분산이 0 이 아니다 (평평하지 않음)', () => {
    let s = 0, s2 = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const v = noise1(i * 0.31, 11);
      s += v;
      s2 += v * v;
    }
    const mean = s / N;
    const varc = s2 / N - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.1);
    expect(varc).toBeGreaterThan(0.1);
  });

  it('주기 노이즈는 period 마다 되감긴다', () => {
    for (let i = 0; i < 100; i++) {
      const x = i * 0.173;
      expect(noise1Periodic(x, 7, 4)).toBeCloseTo(noise1Periodic(x + 7, 7, 4), 10);
      expect(noise1Periodic(x, 7, 4)).toBeCloseTo(noise1Periodic(x - 14, 7, 4), 10);
    }
  });

  it('원형 노이즈는 이음매가 없고 둘레가 변해도 연속이다', () => {
    expect(noiseLoop(0, 6, 2)).toBeCloseTo(noiseLoop(1, 6, 2), 10);
    expect(noiseLoop(0.0, 9.3, 2)).toBeCloseTo(noiseLoop(0.999999, 9.3, 2), 3);
    // 둘레(cycles)가 조금 변할 때 같은 위치의 값이 급변하지 않는다
    let maxJump = 0;
    for (let c = 4; c < 12; c += 0.01) {
      for (const lam of [0.1, 0.37, 0.8]) {
        maxJump = Math.max(maxJump, Math.abs(noiseLoop(lam, c + 0.01, 3) - noiseLoop(lam, c, 3)));
      }
    }
    expect(maxJump).toBeLessThan(0.08);
  });

  it('fbm1 은 [-1,1]', () => {
    for (let i = 0; i < 500; i++) expect(Math.abs(fbm1(i * 0.21, 8))).toBeLessThanOrEqual(1);
  });

  it('Math.random 을 부르지 않는다', () => {
    const spy = vi.spyOn(Math, 'random');
    hash32(1, 2, 3);
    hashStr('x');
    noise1(1.5, 1);
    noise2(1.5, 2.5, 1);
    noiseLoop(0.3, 5, 1);
    mulberry32(1)();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
