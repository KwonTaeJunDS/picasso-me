import { describe, it, expect } from 'vitest';
import { createBlink, blinkOutput } from '../src/tracking/blink.js';
import { BLINK } from '../src/config/params.js';

const DT = 1000 / 30; // 30Hz 표본 간격(ms)

/**
 * 30Hz 로 raws 를 넣으면서 1ms 간격으로 출력을 기록한다 (렌더 루프가 value(now)를 읽는 상황).
 * 표본 i 는 시각 (i+1)*DT 에 들어간다. 반환: 1ms 단위 출력 배열과 표본 시각들.
 */
function simulate(raws, tailMs = 300) {
  const eye = createBlink();
  const times = raws.map((_, i) => (i + 1) * DT);
  const end = times[times.length - 1] + tailMs;
  const out = [];
  let next = 0;
  for (let t = 0; t <= end; t++) {
    while (next < times.length && times[next] <= t) eye.push(raws[next], times[next++]);
    out.push(eye.value(t));
  }
  return { out, times };
}

/** 출력이 0.5 이상인 연속 구간들의 길이(ms) */
function closedRuns(out) {
  const runs = [];
  let len = 0;
  for (const v of out) {
    if (v >= 0.5) len++;
    else if (len) {
      runs.push(len);
      len = 0;
    }
  }
  if (len) runs.push(len);
  return runs;
}

describe('blinkOutput', () => {
  it('감김이면 max(raw, 0.5), 아니면 min(raw, 0.49)', () => {
    expect(blinkOutput(0.2, true)).toBe(0.5);
    expect(blinkOutput(0.9, true)).toBe(0.9);
    expect(blinkOutput(0.2, false)).toBe(0.2);
    expect(blinkOutput(0.495, false)).toBeCloseTo(0.49, 10);
    expect(blinkOutput(0.9, false)).toBeCloseTo(0.49, 10);
  });
  it('범위 밖·NaN 은 [0,1] 로 정리한다', () => {
    expect(blinkOutput(2, true)).toBe(1);
    expect(blinkOutput(-1, false)).toBe(0);
    expect(blinkOutput(NaN, false)).toBe(0);
    expect(blinkOutput(NaN, true)).toBe(0.5);
  });
});

describe('짧은 깜빡임 보존 (30Hz 표본)', () => {
  it('1프레임 깜빡임도 minHoldMs(80ms) 이상 감긴 상태로 보인다', () => {
    const { out } = simulate([0, 0, 1, 0, 0, 0, 0]);
    const runs = closedRuns(out);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toBeGreaterThanOrEqual(BLINK.minHoldMs - 1); // 1ms 단위 측정 오차
    expect(runs[0]).toBeLessThan(BLINK.minHoldMs + DT + 2); // 필요 이상으로 늘어지지 않는다
  });

  it('2프레임 깜빡임', () => {
    const runs = closedRuns(simulate([0, 0, 1, 1, 0, 0, 0, 0]).out);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toBeGreaterThanOrEqual(BLINK.minHoldMs - 1);
  });

  it('3프레임 깜빡임은 실제 지속시간(≈100ms)만큼 유지', () => {
    const runs = closedRuns(simulate([0, 0, 1, 1, 1, 0, 0, 0, 0]).out);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toBeGreaterThanOrEqual(3 * DT - 2);
    expect(runs[0]).toBeLessThan(3 * DT + 10);
  });

  it('연속된 두 번의 깜빡임은 두 번으로 센다', () => {
    const runs = closedRuns(simulate([0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]).out);
    expect(runs).toHaveLength(2);
  });

  it('감기 시작은 지연 없이 표본 시각에 바로 반영된다', () => {
    const eye = createBlink();
    eye.push(0, 100);
    eye.push(1, 133);
    expect(eye.value(133)).toBeGreaterThanOrEqual(0.5);
    expect(eye.isClosed(133)).toBe(true);
  });
});

describe('히스테리시스', () => {
  it('열린 눈의 raw 가 0.45 근처에서 흔들려도 감기지 않는다', () => {
    const { out } = simulate([0.3, 0.45, 0.48, 0.45, 0.49, 0.4, 0.45, 0.3]);
    expect(closedRuns(out)).toEqual([]);
    expect(Math.max(...out)).toBeLessThan(0.5);
  });

  it('감긴 뒤 raw 가 0.4~0.5 사이면 계속 감긴 상태', () => {
    const raws = [0, 0.9, 0.45, 0.42, 0.45, 0.41, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45];
    const { out, times } = simulate(raws, 0);
    // 마지막 표본 시각까지 감긴 상태 유지
    expect(out[Math.floor(times[times.length - 1])]).toBeGreaterThanOrEqual(0.5);
    expect(closedRuns(out)).toHaveLength(1);
  });

  it('openAt(0.4) 이하가 되고 최소 유지 시간이 지나면 뜬다', () => {
    const eye = createBlink();
    eye.push(1, 0);
    eye.push(0.4, 40); // 0.4 는 openAt 이하지만 아직 40ms
    expect(eye.value(40)).toBeGreaterThanOrEqual(0.5);
    expect(eye.value(79)).toBeGreaterThanOrEqual(0.5);
    expect(eye.value(80)).toBeLessThan(0.5);
    expect(eye.value(80)).toBeCloseTo(0.4, 10);
  });

  it('출력 ≥ 0.5 ⇔ 감김 (임의 입력에서도 규약 유지)', () => {
    // 간단한 결정적 의사 난수
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const eye = createBlink();
    let t = 0;
    for (let i = 0; i < 2000; i++) {
      t += DT;
      eye.push(rnd(), t);
      const v = eye.value(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v >= 0.5).toBe(eye.isClosed(t));
    }
  });

  it('reset 하면 열린 상태로 돌아간다', () => {
    const eye = createBlink();
    eye.push(1, 0);
    expect(eye.isClosed(10)).toBe(true);
    eye.reset();
    expect(eye.isClosed(10)).toBe(false);
    expect(eye.value(10)).toBe(0);
  });

  it('범위 밖·NaN raw 도 안전하다', () => {
    const eye = createBlink();
    eye.push(NaN, 0);
    expect(eye.value(0)).toBe(0);
    eye.push(5, 10);
    expect(eye.value(10)).toBe(1);
  });
});
