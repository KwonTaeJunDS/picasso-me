import { describe, it, expect } from 'vitest';
import {
  CYCLE_SEC,
  CYCLE_TICKS,
  MOCK_HZ,
  TICK_MS,
  createMockTracker,
  isMockRequested,
  keyframes,
  mockSample,
  parseMockOptions,
} from '../src/tracking/mock.js';
import { createParams, BLINK } from '../src/config/params.js';

const FRAME = 1000 / 60;

/** 60fps 렌더 루프를 흉내 내어 frames 를 모은다 */
function run(search, seconds, { params = createParams(), startMs = 5000 } = {}) {
  const tracker = createMockTracker(params, search);
  const frames = [];
  for (let t = 0; t <= seconds * 1000; t += FRAME) {
    const f = tracker.poll(startMs + t);
    frames.push({ ms: t, ...f.signals, status: f.status, sampledAt: f.sampledAt, metrics: f.metrics });
  }
  return { tracker, frames };
}

const inRange = (f) =>
  f.t >= -1 && f.t <= 1 && f.p >= -1 && f.p <= 1 && f.r >= -1 && f.r <= 1 && f.k >= 0 && f.k <= 1 && f.blinkL >= 0 && f.blinkL <= 1 && f.blinkR >= 0 && f.blinkR <= 1 && f.jaw >= 0 && f.jaw <= 1;

describe('parseMockOptions', () => {
  it('mock 이 없으면 null, 있으면 타임라인', () => {
    expect(parseMockOptions('')).toBeNull();
    expect(parseMockOptions('?debugpose')).toBeNull();
    expect(isMockRequested('?foo=1')).toBe(false);
    expect(parseMockOptions('?mock').mode).toBe('timeline');
    expect(parseMockOptions('?mock=1').mode).toBe('timeline');
    expect(isMockRequested('?mock')).toBe(true);
    expect(isMockRequested('?x=1&mock')).toBe(true);
  });

  it('mock=0/false/off 는 끈다', () => {
    for (const v of ['0', 'false', 'off', 'no']) expect(parseMockOptions(`?mock=${v}`)).toBeNull();
  });

  it('static 값 해석과 clamp', () => {
    const o = parseMockOptions('?mock=static&t=0.8&p=-0.5&r=0.25&k=0.6&bl=1&br=0.2&jaw=0.7&face=1');
    expect(o).toMatchObject({ mode: 'static', t: 0.8, p: -0.5, r: 0.25, k: 0.6, bl: 1, br: 0.2, jaw: 0.7, face: true });
    const c = parseMockOptions('?mock=static&t=5&p=-9&k=2&bl=-1&jaw=3');
    expect(c).toMatchObject({ t: 1, p: -1, k: 1, bl: 0, jaw: 1 });
  });

  it('잘못된 숫자는 기본값, face=0 이면 얼굴 없음', () => {
    const o = parseMockOptions('?mock=static&t=abc&p=&k=NaN');
    expect(o).toMatchObject({ t: 0, p: 0, k: 0, face: true });
    expect(parseMockOptions('?mock=static&face=0').face).toBe(false);
    expect(parseMockOptions('?mock=static&face=false').face).toBe(false);
    expect(parseMockOptions('?mock&at=6').at).toBe(6);
    expect(parseMockOptions('?mock&at=-3').at).toBe(0);
  });
});

describe('keyframes', () => {
  const keys = [[0, 0], [1, 10], [3, -10]];
  it('키에서 정확한 값, 사이는 smoothstep 보간', () => {
    expect(keyframes(0, keys)).toBe(0);
    expect(keyframes(1, keys)).toBe(10);
    expect(keyframes(3, keys)).toBe(-10);
    expect(keyframes(0.5, keys)).toBeCloseTo(5, 10); // smoothstep(0.5) = 0.5
    expect(keyframes(2, keys)).toBeCloseTo(0, 10);
  });
  it('범위 밖은 양 끝 값', () => {
    expect(keyframes(-5, keys)).toBe(0);
    expect(keyframes(99, keys)).toBe(-10);
  });
});

describe('타임라인 (mockSample)', () => {
  const samples = Array.from({ length: CYCLE_TICKS }, (_, n) => ({ n, u: n / MOCK_HZ, ...mockSample(n) }));

  it('36초 = 1080틱, 30Hz', () => {
    expect(CYCLE_SEC).toBe(36);
    expect(CYCLE_TICKS).toBe(1080);
    expect(TICK_MS).toBeCloseTo(33.333, 2);
  });

  it('모든 값이 유한하고 범위 안', () => {
    for (const s of samples) {
      expect(Object.values(s).every((v) => typeof v === 'boolean' || Number.isFinite(v))).toBe(true);
      expect(inRange(s)).toBe(true);
    }
  });

  it('주기적이다: 36초 뒤에 같은 값', () => {
    expect(mockSample(CYCLE_TICKS)).toEqual(mockSample(0));
    expect(mockSample(CYCLE_TICKS + 500)).toEqual(mockSample(500));
    expect(mockSample(-1)).toEqual(mockSample(CYCLE_TICKS - 1));
  });

  it('시나리오 B: 왼쪽(−1)→유지→정면→오른쪽(+1)→정면 + 표정', () => {
    const at = (sec) => mockSample(Math.round(sec * MOCK_HZ));
    expect(Math.abs(at(1).t)).toBeLessThan(0.05); // 0–2초 정면
    expect(at(6).t).toBeLessThan(-0.98); // 5–7초 완전 옆모습(화면 왼쪽)
    expect(Math.abs(at(9).t)).toBeLessThan(0.05); // 9초 정면 복귀
    expect(at(11).t).toBeGreaterThan(0.98); // 오른쪽
    expect(Math.abs(at(14).t)).toBeLessThan(0.05); // 12–15초 정면 + 표정
    expect(at(14).jaw).toBeGreaterThan(0.8); // 입 벌림
    const blink = samples.filter((s) => s.u >= 12 && s.u < 15 && (s.blinkL || s.blinkR));
    expect(blink.length).toBeGreaterThan(0); // 눈 깜빡임
  });

  it('얼굴 이탈은 정확히 2초(15~17초)', () => {
    const absent = samples.filter((s) => !s.present);
    expect(absent.length).toBe(2 * MOCK_HZ);
    expect(absent[0].u).toBe(15);
    expect(absent[absent.length - 1].u).toBeCloseTo(17 - 1 / MOCK_HZ, 8);
  });

  it('끄덕임·갸웃·접근이 모두 한계까지 간다', () => {
    const max = (key) => Math.max(...samples.map((s) => s[key]));
    const min = (key) => Math.min(...samples.map((s) => s[key]));
    expect(max('p')).toBeGreaterThan(0.98);
    expect(min('p')).toBeLessThan(-0.98);
    expect(max('r')).toBeGreaterThan(0.98);
    expect(min('r')).toBeLessThan(-0.98);
    expect(max('k')).toBeGreaterThan(0.99);
    expect(min('k')).toBe(0);
    expect(min('t')).toBeLessThan(-0.98);
    expect(max('t')).toBeGreaterThan(0.98);
  });

  it('빠른 회전 구간: 0.25초 안에 −1 → 정지 → +1 → 정지', () => {
    const at = (sec) => mockSample(Math.round(sec * MOCK_HZ)).t;
    expect(Math.abs(at(26.4))).toBeLessThan(0.05);
    expect(at(26.8)).toBeLessThan(-0.95); // 0.25초 만에 완료
    expect(at(27.9)).toBeLessThan(-0.95); // 정지 유지
    expect(at(28.3)).toBeGreaterThan(0.95);
    expect(at(29.4)).toBeGreaterThan(0.95);
    expect(Math.abs(at(30))).toBeLessThan(0.05);
    // 가장 빠른 구간의 변화 속도가 느린 회전(시나리오 B)보다 훨씬 크다
    const speed = (a, b) => Math.abs(mockSample(b).t - mockSample(a).t) * MOCK_HZ;
    const fast = Math.max(...Array.from({ length: 12 }, (_, i) => speed(Math.round(26.5 * MOCK_HZ) + i, Math.round(26.5 * MOCK_HZ) + i + 1)));
    const slow = Math.max(...Array.from({ length: 60 }, (_, i) => speed(Math.round(2 * MOCK_HZ) + i, Math.round(2 * MOCK_HZ) + i + 1)));
    expect(fast).toBeGreaterThan(slow * 5);
  });

  it('1프레임(1틱) 깜빡임이 들어 있다: 양쪽 / 왼쪽만 / 오른쪽만', () => {
    const only = (s) => s.blinkL !== s.blinkR;
    const runs = (key) => {
      const out = [];
      let len = 0;
      for (const s of samples) {
        if (s[key]) len++;
        else if (len) (out.push(len), (len = 0));
      }
      if (len) out.push(len);
      return out;
    };
    expect(runs('blinkL')).toContain(1);
    expect(runs('blinkR')).toContain(1);
    const left = samples.filter((s) => s.blinkL && !s.blinkR);
    const right = samples.filter((s) => s.blinkR && !s.blinkL);
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
    expect(samples.some(only)).toBe(true);
  });
});

describe('createMockTracker: 타임라인', () => {
  it('실제 추적기와 같은 인터페이스', () => {
    const t = createMockTracker(createParams(), '?mock');
    expect(typeof t.start).toBe('function');
    expect(typeof t.poll).toBe('function');
    expect(typeof t.calibrate).toBe('function');
    expect(t.video).toBeNull();
    const f = t.poll(1000);
    expect(f.status).toBe('running');
    expect(f.error).toBeUndefined();
    expect(Object.keys(f.signals).sort()).toEqual(['blinkL', 'blinkR', 'jaw', 'k', 'p', 'present', 'r', 't']);
    expect(Object.keys(f.metrics).sort()).toEqual(['camera', 'delegate', 'detectMs', 'detector', 'faces', 'mainMs', 'pitchDeg', 'proximity', 'rollDeg', 'yawDeg']);
  });

  it('start() 는 즉시 끝나고 throw 하지 않는다', async () => {
    await expect(createMockTracker(createParams(), '?mock').start()).resolves.toBeUndefined();
  });

  it('두 주기 동안 모든 값이 범위 안, sampledAt 단조 증가', () => {
    const { frames } = run('?mock', 75);
    expect(frames.every(inRange)).toBe(true);
    expect(frames.every((f) => f.status === 'running')).toBe(true);
    for (let i = 1; i < frames.length; i++) expect(frames[i].sampledAt).toBeGreaterThanOrEqual(frames[i - 1].sampledAt);
  });

  it('얼굴 이탈 약 2초 동안 present=false, 값은 마지막 값 유지, 이후 재등장', () => {
    const { frames } = run('?mock', 20);
    const absent = frames.filter((f) => !f.present && f.ms > 10000);
    expect(absent.length).toBeGreaterThan(0);
    const first = absent[0].ms;
    const last = absent[absent.length - 1].ms;
    expect(first).toBeGreaterThanOrEqual(15000);
    expect(first).toBeLessThan(15100);
    expect(last - first).toBeGreaterThan(1900);
    expect(last - first).toBeLessThan(2100);
    // 이탈 중에는 값이 변하지 않는다
    const before = [...frames].reverse().find((f) => f.ms < first && f.present);
    for (const f of absent) {
      expect([f.t, f.p, f.r, f.k, f.jaw]).toEqual([before.t, before.p, before.r, before.k, before.jaw]);
    }
    // 재등장: 고개를 돌린 채(t≈0.5) 나타난다
    const back = frames.find((f) => f.ms > last && f.present);
    expect(back.t).toBeGreaterThan(0.4);
    expect(back.r).toBeLessThan(-0.25);
  });

  it('1프레임 깜빡임도 감긴 상태가 80ms 이상 보인다 (32초 근처)', () => {
    const { frames } = run('?mock', 36);
    const win = frames.filter((f) => f.ms >= 31500 && f.ms < 32600);
    const runs = [];
    let start = null;
    for (const f of win) {
      if (f.blinkL >= 0.5 && start === null) start = f.ms;
      if (f.blinkL < 0.5 && start !== null) {
        runs.push(f.ms - start);
        start = null;
      }
    }
    expect(runs).toHaveLength(1);
    expect(runs[0]).toBeGreaterThanOrEqual(BLINK.minHoldMs - FRAME);
    expect(runs[0]).toBeLessThan(BLINK.minHoldMs + 2 * TICK_MS);
  });

  it('한쪽 눈 1프레임 깜빡임은 그 눈만 감긴다 (33초 왼쪽, 34초 오른쪽)', () => {
    const { frames } = run('?mock', 36);
    const l33 = frames.filter((f) => f.ms >= 32800 && f.ms < 33400);
    expect(l33.some((f) => f.blinkL >= 0.5)).toBe(true);
    expect(l33.every((f) => f.blinkR < 0.5)).toBe(true);
    const r34 = frames.filter((f) => f.ms >= 33800 && f.ms < 34400);
    expect(r34.some((f) => f.blinkR >= 0.5)).toBe(true);
    expect(r34.every((f) => f.blinkL < 0.5)).toBe(true);
  });

  it('프레임이 오래 멈췄다 돌아와도 한 번에 많은 틱을 처리하지 않고 정상 값을 낸다', () => {
    const t = createMockTracker(createParams(), '?mock');
    t.poll(0);
    const f = t.poll(10 * 3600 * 1000); // 10시간 뒤
    expect(inRange(f.signals)).toBe(true);
  });

  it('?mock&at=6 은 타임라인 6초 지점(완전 옆모습)에서 시작', () => {
    const f = createMockTracker(createParams(), '?mock&at=6').poll(100).signals;
    expect(f.present).toBe(true);
    expect(f.t).toBeLessThan(-0.98);
  });

  it('metrics: 각도는 정규화값 × 범위, proximity 는 k 로 환산', () => {
    const params = createParams({ yawRange: 40, pitchRange: 20, rollRange: 30, maxProximity: 1.6 });
    const t = createMockTracker(params, '?mock&at=6');
    const f = t.poll(0);
    expect(f.metrics.yawDeg).toBeCloseTo(f.signals.t * 40, 8);
    expect(f.metrics.pitchDeg).toBeCloseTo(f.signals.p * 20, 8);
    expect(f.metrics.proximity).toBeCloseTo(1 + f.signals.k * 0.6, 8);
    expect(f.metrics.camera).toBe('mock');
    expect(f.metrics.faces).toBe(1);
  });

  it('calibrate: 얼굴이 있을 때 true', () => {
    const t = createMockTracker(createParams(), '?mock');
    t.poll(0);
    expect(t.calibrate()).toBe(true);
    const away = createMockTracker(createParams(), '?mock&at=16');
    away.poll(0);
    expect(away.calibrate()).toBe(false);
  });
});

describe('createMockTracker: static', () => {
  it('고정값을 그대로 낸다', () => {
    const t = createMockTracker(createParams(), '?mock=static&t=0.8&p=-0.3&r=0.2&k=0.5&bl=0&br=0&jaw=0.4&face=1');
    expect(t.mock.mode).toBe('static');
    for (const now of [0, 16, 5000, 99999]) {
      const s = t.poll(now).signals;
      expect(s).toEqual({ present: true, t: 0.8, p: -0.3, r: 0.2, k: 0.5, blinkL: 0, blinkR: 0, jaw: 0.4 });
    }
  });

  it('bl/br 는 0.5 규약을 지킨다: 1 → 감김(≥0.5), 0.3 → 그대로, 0.6 → 감김', () => {
    const s = createMockTracker(createParams(), '?mock=static&bl=1&br=0.3').poll(0).signals;
    expect(s.blinkL).toBe(1);
    expect(s.blinkR).toBe(0.3);
    const s2 = createMockTracker(createParams(), '?mock=static&bl=0.6&br=0.49').poll(0).signals;
    expect(s2.blinkL).toBeGreaterThanOrEqual(0.5);
    expect(s2.blinkR).toBeLessThan(0.5);
  });

  it('face=0 이면 present=false (값은 그대로)', () => {
    const s = createMockTracker(createParams(), '?mock=static&face=0&t=-0.4').poll(0).signals;
    expect(s.present).toBe(false);
    expect(s.t).toBe(-0.4);
  });

  it('범위를 넘는 값은 clamp, status running, sampledAt 은 현재 시각', () => {
    const t = createMockTracker(createParams(), '?mock=static&t=9&k=7');
    const f = t.poll(1234);
    expect(f.signals.t).toBe(1);
    expect(f.signals.k).toBe(1);
    expect(f.status).toBe('running');
    expect(f.sampledAt).toBe(1234);
    expect(t.calibrate()).toBe(true);
  });
});
