import { describe, it, expect, vi } from 'vitest';
import { createSignalProcessor, median } from '../src/tracking/signals.js';
import { createParams, TRACKING } from '../src/config/params.js';
import { matrixFromEuler } from '../src/tracking/pose.js';

const DT = 1000 / 30; // 30Hz 표본

/** 표본 하나. yaw/pitch/roll 은 카메라 공간 각도(°), z 는 변환 행렬 이동량, e 는 눈꼬리 픽셀 거리 */
function sample(at, o = {}) {
  const { yaw = 0, pitch = 0, roll = 0, z = -40, e = 120, blinkLeft = 0, blinkRight = 0, jawOpen = 0, faces = 1 } = o;
  return {
    at,
    hasFace: true,
    faces,
    matrix: matrixFromEuler(yaw, pitch, roll, { z, scale: 1.1 }),
    eyeDistPx: e,
    landmarkYaw: 0.05,
    blinkLeft,
    blinkRight,
    jawOpen,
  };
}

/** 프로세서에 30Hz 로 표본을 넣고 시각을 관리하는 보조 */
function sim(paramsOverride = {}, cfg) {
  const params = createParams({ filterEnabled: false, ...paramsOverride });
  const proc = createSignalProcessor(params, cfg);
  const s = {
    params,
    proc,
    t: 1000,
    step(o = {}) {
      proc.push(sample(s.t, o), s.t);
      s.t += DT;
    },
    run(n, o = {}) {
      for (let i = 0; i < n; i++) s.step(o);
    },
    gap() {
      proc.push({ at: s.t, hasFace: false, faces: 0 }, s.t);
      s.t += DT;
    },
    /** 마지막 표본 시각 기준 현재 신호 */
    now() {
      return proc.signals(s.t - DT);
    },
  };
  return s;
}

describe('median', () => {
  it('홀수·짝수·빈 배열', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNaN();
  });
});

describe('각도 → t,p,r (화면 거울 기준 정규화)', () => {
  it('yaw +30°(코가 원본 오른쪽) → t = −30/45, pitch +10° → p, roll +15° → r', () => {
    const s = sim();
    s.step({ yaw: 30, pitch: 10, roll: 15 });
    const g = s.now();
    expect(g.t).toBeCloseTo(-30 / 45, 6);
    expect(g.p).toBeCloseTo(10 / 25, 6);
    expect(g.r).toBeCloseTo(15 / 30, 6);
    expect(g.present).toBe(true);
  });

  it('범위를 넘으면 ±1 로 clamp', () => {
    const s = sim();
    s.step({ yaw: -80, pitch: 70, roll: 80 });
    const g = s.now();
    expect(g.t).toBe(1);
    expect(g.p).toBe(1);
    expect(g.r).toBe(1);
  });

  it('패널 값(범위·반전)이 즉시 반영된다 — 새 표본이 없어도', () => {
    const s = sim();
    s.step({ yaw: 30, pitch: 10, roll: 15 });
    s.params.yawRange = 60;
    s.params.invertPitch = true;
    s.params.invertRoll = true;
    const g = s.now();
    expect(g.t).toBeCloseTo(-0.5, 6);
    expect(g.p).toBeCloseTo(-10 / 25, 6);
    expect(g.r).toBeCloseTo(-15 / 30, 6);
    s.params.invertYaw = true;
    expect(s.now().t).toBeCloseTo(0.5, 6);
  });

  it('metrics 는 화면 기준 각도(도)를 준다', () => {
    const s = sim();
    s.step({ yaw: 30, pitch: 10, roll: -5, faces: 2 });
    const m = s.proc.metrics();
    expect(m.yawDeg).toBeCloseTo(-30, 6);
    expect(m.pitchDeg).toBeCloseTo(10, 6);
    expect(m.rollDeg).toBeCloseTo(-5, 6);
    expect(m.faces).toBe(2);
    expect(m.proximity).toBe(1);
  });
});

describe('One Euro: 새 표본에만, 재등장 시 리셋', () => {
  it('signals() 를 몇 번 불러도 값이 변하지 않는다 (필터 상태는 표본에서만 갱신)', () => {
    const s = sim({ filterEnabled: true });
    s.step({ yaw: 5 });
    s.step({ yaw: 20 });
    const a = s.proc.signals(s.t);
    for (let i = 0; i < 10; i++) s.proc.signals(s.t + i);
    const b = s.proc.signals(s.t + 20);
    expect(b.t).toBe(a.t);
    expect(b.p).toBe(a.p);
    expect(b.jaw).toBe(a.jaw);
  });

  it('필터가 켜져 있으면 떨림이 줄고, 꺼져 있으면 원시값 그대로', () => {
    const noisy = (filterEnabled) => {
      const s = sim({ filterEnabled });
      const out = [];
      for (let i = 0; i < 90; i++) {
        s.step({ yaw: 20 + (i % 2 ? 0.8 : -0.8) });
        out.push(s.now().t);
      }
      const tail = out.slice(45);
      return Math.max(...tail) - Math.min(...tail);
    };
    const on = noisy(true);
    const off = noisy(false);
    expect(off).toBeCloseTo(1.6 / 45, 6); // 원시 진폭 그대로 (yaw p-p 1.6° / 45°)
    expect(on).toBeLessThan(off * 0.5);
  });

  it('얼굴이 없다가 다시 나타나면 필터를 리셋해 첫 표본이 그대로 통과한다', () => {
    const s = sim({ filterEnabled: true });
    s.run(30, { yaw: -30 });
    expect(s.now().t).toBeCloseTo(30 / 45, 3);
    s.gap();
    s.step({ yaw: 30 }); // 재등장
    expect(s.now().t).toBeCloseTo(-30 / 45, 6); // 이전 값에 끌려가지 않는다
    expect(s.now().present).toBe(true);
  });

  it('얼굴이 계속 있으면 급변을 부드럽게 따라간다 (리셋하지 않음)', () => {
    const s = sim({ filterEnabled: true });
    s.run(30, { yaw: -30 });
    s.step({ yaw: 30 });
    const t = s.now().t;
    expect(t).toBeGreaterThan(-30 / 45 + 0.05); // 즉시 도달하지 않음
    expect(t).toBeLessThan(30 / 45);
  });

  it('필터 off → on 전환이 튀지 않는다', () => {
    const s = sim({ filterEnabled: false });
    s.run(10, { yaw: 20 });
    s.params.filterEnabled = true;
    s.step({ yaw: 20 });
    expect(s.now().t).toBeCloseTo(-20 / 45, 6);
  });
});

describe('present 와 값 유지', () => {
  it('최근 표본(<250ms)에 얼굴이 있으면 present', () => {
    const s = sim();
    s.step({ yaw: 10 });
    const at = s.t - DT;
    expect(s.proc.signals(at).present).toBe(true);
    expect(s.proc.signals(at + TRACKING.staleMs - 1).present).toBe(true);
    expect(s.proc.signals(at + TRACKING.staleMs).present).toBe(false); // 영상 정지 대비
  });

  it('얼굴 없는 표본이 오면 바로 present=false, 나머지 값은 마지막 값 유지', () => {
    const s = sim();
    s.step({ yaw: 30, pitch: -10, roll: 12, jawOpen: 0.6, z: -40 });
    const before = s.now();
    s.gap();
    const after = s.proc.signals(s.t - DT);
    expect(after.present).toBe(false);
    expect({ ...after, present: true }).toEqual(before);
    // 한참 뒤에도 유지
    expect({ ...s.proc.signals(s.t + 5000), present: true }).toEqual(before);
  });

  it('표본이 한 번도 없으면 present=false 이고 중립값', () => {
    const s = sim();
    expect(s.proc.signals(0)).toEqual({ present: false, t: 0, p: 0, r: 0, k: 0, blinkL: 0, blinkR: 0, jaw: 0 });
    expect(s.proc.sampledAt).toBeNull();
  });

  it('sampledAt 은 얼굴 유무와 관계없이 마지막 표본 시각', () => {
    const s = sim();
    s.step();
    expect(s.proc.sampledAt).toBe(1000);
    s.gap();
    expect(s.proc.sampledAt).toBeCloseTo(1000 + DT, 6);
  });
});

describe('거리: matrix 모드 (|z0|/|z|)', () => {
  it('연속 0.5초 정면 검출 후 자동 기준 → 가까워지면 proximity>1, k>0', () => {
    const s = sim();
    s.run(20, { z: -40 }); // 0.63초
    expect(s.proc.hasBaseline).toBe(true);
    expect(s.proc.metrics().proximity).toBeCloseTo(1, 8);
    expect(s.now().k).toBe(0);
    s.step({ z: -30 });
    expect(s.proc.metrics().proximity).toBeCloseTo(40 / 30, 8);
    expect(s.now().k).toBeCloseTo((40 / 30 - 1) / 0.6, 8);
  });

  it('기준 전(0.5초 미만)에는 proximity=1, k=0', () => {
    const s = sim();
    s.run(10, { z: -40 }); // 0.3초
    expect(s.proc.hasBaseline).toBe(false);
    s.step({ z: -20 });
    expect(s.proc.metrics().proximity).toBe(1);
    expect(s.now().k).toBe(0);
  });

  it('멀어지면 k=0 (proximity<1)', () => {
    const s = sim();
    s.run(20, { z: -40 });
    s.step({ z: -60 });
    expect(s.proc.metrics().proximity).toBeCloseTo(40 / 60, 8);
    expect(s.now().k).toBe(0);
  });

  it('maxProximity 이상 가까우면 k=1, maxProximity 가 바뀌면 즉시 재계산', () => {
    const s = sim();
    s.run(20, { z: -40 });
    s.step({ z: -20 }); // proximity 2.0
    expect(s.now().k).toBe(1);
    s.params.maxProximity = 2.5;
    expect(s.now().k).toBeCloseTo(1 / 1.5, 8);
  });

  it('z 의 부호와 무관하다 (|z|)', () => {
    const s = sim();
    s.run(20, { z: 40 });
    s.step({ z: 30 });
    expect(s.proc.metrics().proximity).toBeCloseTo(40 / 30, 8);
  });

  it('자동 기준은 중앙값이라 이상치 한두 개에 흔들리지 않는다', () => {
    const s = sim();
    for (let i = 0; i < 20; i++) s.step({ z: i === 7 ? -80 : -40 });
    s.step({ z: -40 });
    expect(s.proc.metrics().proximity).toBeCloseTo(1, 8);
  });

  it('기준은 한 번만 자동으로 잡힌다 (이후 자세가 바뀌어도 유지)', () => {
    const s = sim();
    s.run(20, { z: -40 });
    s.run(40, { z: -30 }); // 계속 가까이
    expect(s.proc.metrics().proximity).toBeCloseTo(40 / 30, 8);
  });
});

describe('자동 기준 조건 (|yaw|,|pitch| < 15°, 연속 검출)', () => {
  it('고개를 15° 이상 돌린 구간은 기준으로 쓰지 않는다', () => {
    const s = sim();
    s.run(40, { yaw: 20, z: -40 });
    expect(s.proc.hasBaseline).toBe(false);
    s.run(40, { pitch: 20, z: -40 });
    expect(s.proc.hasBaseline).toBe(false);
    s.run(20, { yaw: 0, z: -50 }); // 정면으로 돌아오면 이 구간으로 기준
    expect(s.proc.hasBaseline).toBe(true);
    s.step({ z: -25 });
    expect(s.proc.metrics().proximity).toBeCloseTo(2, 8);
  });

  it('검출이 끊기면 연속 구간을 처음부터 센다', () => {
    const s = sim();
    s.run(12, { z: -40 }); // 0.4초
    s.gap();
    s.run(12, { z: -40 }); // 다시 0.4초 — 합쳐도 연속 0.5초 아님
    expect(s.proc.hasBaseline).toBe(false);
    s.run(8, { z: -40 });
    expect(s.proc.hasBaseline).toBe(true);
  });

  it('각도가 중간에 한계를 넘으면 구간이 리셋된다', () => {
    const s = sim();
    s.run(12, { z: -40 });
    s.step({ yaw: 25, z: -40 });
    s.run(12, { z: -40 });
    expect(s.proc.hasBaseline).toBe(false);
  });
});

describe('C 키: calibrate', () => {
  it('현재 거리를 기준으로 갱신하면 proximity=1, k=0 이고 그 뒤 접근이 반영된다', () => {
    const s = sim();
    s.run(20, { z: -40 });
    s.run(3, { z: -30 });
    expect(s.now().k).toBeGreaterThan(0);
    expect(s.proc.calibrate(s.t - DT)).toBe(true);
    expect(s.proc.metrics().proximity).toBeCloseTo(1, 8);
    expect(s.now().k).toBe(0);
    s.step({ z: -24 });
    expect(s.proc.metrics().proximity).toBeCloseTo(30 / 24, 8);
  });

  it('자동 기준이 잡히기 전에 눌러도 되고, 이후 자동 기준이 덮어쓰지 않는다', () => {
    const s = sim();
    s.run(5, { z: -50 });
    expect(s.proc.calibrate(s.t - DT)).toBe(true);
    s.run(40, { z: -50 });
    s.step({ z: -25 });
    expect(s.proc.metrics().proximity).toBeCloseTo(2, 8);
  });

  it('얼굴이 없으면 무시하고 false', () => {
    const s = sim();
    expect(s.proc.calibrate(0)).toBe(false); // 표본 없음
    s.run(20, { z: -40 });
    s.gap();
    expect(s.proc.calibrate(s.t - DT)).toBe(false); // 마지막 표본에 얼굴 없음
    s.step({ z: -40 });
    expect(s.proc.calibrate(s.t - DT + TRACKING.staleMs + 10)).toBe(false); // 오래된 표본
  });
});

describe('거리: eyes 모드 (눈꼬리 거리 / cos|yaw|)', () => {
  const eyes = () => sim({ distanceMode: 'eyes' });

  it('정면 기준 e0 대비 비율', () => {
    const s = eyes();
    s.run(20, { e: 100 });
    expect(s.proc.hasBaseline).toBe(true);
    s.step({ e: 130 });
    expect(s.proc.metrics().proximity).toBeCloseTo(1.3, 8);
    expect(s.now().k).toBeCloseTo(0.3 / 0.6, 8);
  });

  it('회전으로 줄어든 눈 간격은 cos|yaw| 로 보정한다', () => {
    const s = eyes();
    s.run(20, { e: 100 });
    const yaw = 20;
    s.step({ yaw, e: 100 * Math.cos((yaw * Math.PI) / 180) }); // 같은 거리에서 회전만 한 상태
    expect(s.proc.metrics().proximity).toBeCloseTo(1, 6);
    s.step({ yaw, e: 120 * Math.cos((yaw * Math.PI) / 180) });
    expect(s.proc.metrics().proximity).toBeCloseTo(1.2, 6);
    s.step({ yaw: -yaw, e: 120 * Math.cos((yaw * Math.PI) / 180) }); // 반대 방향도 같다
    expect(s.proc.metrics().proximity).toBeCloseTo(1.2, 6);
  });

  it('|yaw| > 30° 이면 갱신을 보류하고 직전 값을 유지한다', () => {
    const s = eyes();
    s.run(20, { e: 100 });
    s.step({ e: 120 });
    const held = s.proc.metrics().proximity;
    expect(held).toBeCloseTo(1.2, 8);
    s.step({ yaw: 40, e: 40 }); // 이상한 값이 들어와도
    expect(s.proc.metrics().proximity).toBe(held);
    s.step({ yaw: -45, e: 200 });
    expect(s.proc.metrics().proximity).toBe(held);
    s.step({ yaw: 10, e: 130 }); // 다시 30° 안쪽이면 갱신
    expect(s.proc.metrics().proximity).not.toBe(held);
  });

  it('30° 경계: 30°는 갱신, 30.5°는 보류', () => {
    const s = eyes();
    s.run(20, { e: 100 });
    s.step({ yaw: 30, e: 110 * Math.cos(Math.PI / 6) });
    expect(s.proc.metrics().proximity).toBeCloseTo(1.1, 6);
    s.step({ yaw: 30.5, e: 300 });
    expect(s.proc.metrics().proximity).toBeCloseTo(1.1, 6);
  });

  it('눈꼬리 거리를 못 구한 표본은 무시', () => {
    const s = eyes();
    s.run(20, { e: 100 });
    s.step({ e: 0 });
    s.step({ e: null });
    expect(s.proc.metrics().proximity).toBeCloseTo(1, 8);
  });
});

describe('모드 변경 시 기준 재설정', () => {
  it('matrix → eyes: 기준·k 가 즉시 초기화되고 새 모드에서 다시 자동 기준', () => {
    const s = sim();
    s.run(20, { z: -40, e: 100 });
    s.step({ z: -30, e: 100 });
    expect(s.now().k).toBeGreaterThan(0);

    s.params.distanceMode = 'eyes';
    expect(s.proc.metrics().proximity).toBe(1);
    expect(s.now().k).toBe(0);
    expect(s.proc.hasBaseline).toBe(false);

    s.run(20, { z: -30, e: 100 });
    expect(s.proc.hasBaseline).toBe(true);
    s.step({ z: -30, e: 125 });
    expect(s.proc.metrics().proximity).toBeCloseTo(1.25, 8);
  });

  it('eyes → matrix 도 마찬가지', () => {
    const s = sim({ distanceMode: 'eyes' });
    s.run(20, { e: 100, z: -40 });
    s.params.distanceMode = 'matrix';
    expect(s.proc.hasBaseline).toBe(false);
    expect(s.proc.metrics().proximity).toBe(1);
    s.run(20, { e: 100, z: -40 });
    s.step({ e: 100, z: -32 });
    expect(s.proc.metrics().proximity).toBeCloseTo(40 / 32, 8);
  });
});

describe('표정: 깜빡임·입', () => {
  it('eyeBlinkLeft → blinkL(화면 왼쪽), eyeBlinkRight → blinkR', () => {
    const s = sim();
    s.step({ blinkLeft: 0.9, blinkRight: 0.1 });
    const g = s.now();
    expect(g.blinkL).toBeGreaterThanOrEqual(0.5);
    expect(g.blinkR).toBeLessThan(0.5);
  });

  it('swapEyes 로 좌우를 바꾼다', () => {
    const s = sim({ swapEyes: true });
    s.step({ blinkLeft: 0.9, blinkRight: 0.1 });
    const g = s.now();
    expect(g.blinkL).toBeLessThan(0.5);
    expect(g.blinkR).toBeGreaterThanOrEqual(0.5);
  });

  it('30Hz 1프레임 깜빡임이 렌더 루프(60fps)에서 80ms 이상 감긴 상태로 보인다', () => {
    const s = sim({ filterEnabled: true }); // 필터가 켜져 있어도 깜빡임은 필터를 거치지 않는다
    // 표본 6번째(i=5)만 감김. 렌더 루프처럼 1ms 간격으로 signals() 를 읽는다
    const raws = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    const t0 = s.t;
    let next = 0;
    let closedMs = 0;
    for (let ms = 0; ms < 500; ms++) {
      const now = t0 + ms;
      while (next < raws.length && t0 + next * DT <= now) {
        s.proc.push(sample(t0 + next * DT, { blinkLeft: raws[next], blinkRight: raws[next] }), t0 + next * DT);
        next++;
      }
      if (s.proc.signals(now).blinkL >= 0.5) closedMs++;
    }
    expect(closedMs).toBeGreaterThanOrEqual(80 - 1); // 1ms 단위 측정 오차
    expect(closedMs).toBeLessThan(80 + DT + 2);
  });

  it('입 벌림은 [0,1] 로 clamp 되고 필터를 거친다', () => {
    const s = sim();
    s.step({ jawOpen: 0.7 });
    expect(s.now().jaw).toBeCloseTo(0.7, 8);
    s.step({ jawOpen: 5 });
    expect(s.now().jaw).toBe(1);
    s.step({ jawOpen: -2 });
    expect(s.now().jaw).toBe(0);

    const f = sim({ filterEnabled: true });
    f.step({ jawOpen: 0 });
    f.step({ jawOpen: 1 });
    expect(f.now().jaw).toBeGreaterThan(0);
    expect(f.now().jaw).toBeLessThan(1);
  });

  it('오래 이탈한 뒤(≥staleMs) 재등장하면 깜빡임 상태도 초기화된다', () => {
    const s = sim();
    s.step({ blinkLeft: 1 });
    s.t += 1000;
    s.step({ blinkLeft: 0 });
    expect(s.now().blinkL).toBeLessThan(0.5);
  });
});

describe('reset / 부호 점검 연동', () => {
  it('reset() 후에는 처음 상태', () => {
    const s = sim();
    s.run(20, { yaw: 20, z: -40, jawOpen: 0.5, blinkLeft: 1 });
    s.proc.reset();
    expect(s.proc.hasBaseline).toBe(false);
    expect(s.proc.sampledAt).toBeNull();
    expect(s.proc.signals(s.t)).toEqual({ present: false, t: 0, p: 0, r: 0, k: 0, blinkL: 0, blinkR: 0, jaw: 0 });
  });

  it('행렬 yaw 와 랜드마크 yaw 를 부호 점검기에 넘긴다', () => {
    const checker = { push: vi.fn() };
    const s = sim({}, { signChecker: checker });
    s.step({ yaw: 25 });
    expect(checker.push).toHaveBeenCalledTimes(1);
    expect(checker.push.mock.calls[0][0]).toBeCloseTo(25, 6);
    expect(checker.push.mock.calls[0][1]).toBe(0.05);
  });

  it('쓸 수 없는 행렬이 와도 죽지 않고 이전 각도를 유지한다', () => {
    const s = sim();
    s.step({ yaw: 20 });
    s.proc.push({ at: s.t, hasFace: true, faces: 1, matrix: null, eyeDistPx: 100, blinkLeft: 0, blinkRight: 0, jawOpen: 0.3 }, s.t);
    s.t += DT;
    const g = s.now();
    expect(g.t).toBeCloseTo(-20 / 45, 6);
    expect(g.jaw).toBeCloseTo(0.3, 6);
    expect(g.present).toBe(true);
  });
});

describe('코드 리뷰 2차 회귀', () => {
  it('[4] 표본 간격이 staleMs 이상이면 "연속 0.5초"가 이어지지 않는다 (0ms·1000ms 두 표본으로 기준이 잡히면 안 됨)', () => {
    const s = sim();
    s.step({ z: -40 });
    s.t += 1000 - DT;
    s.step({ z: -40 });
    expect(s.proc.hasBaseline).toBe(false);
    s.run(20, { z: -40 }); // 그 뒤 실제로 0.5초 이상 연속이면 잡힌다
    expect(s.proc.hasBaseline).toBe(true);
  });

  it('[4] 긴 간격 뒤에는 예전 필터 상태를 이어 쓰지 않는다', () => {
    const s = sim({ filterEnabled: true });
    s.run(30, { yaw: -30 });
    s.t += 2000;
    s.step({ yaw: 30 });
    expect(s.now().t).toBeCloseTo(-30 / 45, 6);
  });

  it('[6] eyes 모드: 같은 표본의 원시 yaw 로 검사·보정한다 (지연된 필터 yaw 가 아님)', () => {
    const s = sim({ distanceMode: 'eyes', filterEnabled: true });
    s.run(20, { e: 100 });
    // 급회전: 원시 yaw 40° 인 첫 표본. 필터 yaw 는 아직 작지만 보류돼야 한다
    const before = s.proc.metrics().proximity;
    s.step({ yaw: 40, e: 300 });
    expect(s.proc.metrics().proximity).toBe(before);
    // 원시 yaw 20°: 필터 yaw 가 0 근처여도 cos(20°) 로 보정
    const t = sim({ distanceMode: 'eyes' });
    t.run(20, { e: 100 });
    t.step({ yaw: 20, e: 100 * Math.cos((20 * Math.PI) / 180) });
    expect(t.proc.metrics().proximity).toBeCloseTo(1, 6);
  });

  it('[7] eyes 모드에서 거리 갱신이 보류된 동안(옆으로 돎) C 는 false 이고 기준을 바꾸지 않는다', () => {
    const s = sim({ distanceMode: 'eyes' });
    s.run(20, { e: 100 });
    s.step({ e: 120 });
    s.step({ yaw: 40, e: 50 });
    expect(s.proc.calibrate(s.t - DT)).toBe(false);
    expect(s.proc.metrics().proximity).toBeCloseTo(1.2, 6); // 기준 그대로
    s.step({ yaw: 0, e: 120 });
    expect(s.proc.calibrate(s.t - DT)).toBe(true);
    expect(s.proc.metrics().proximity).toBeCloseTo(1, 6);
  });

  it('[8] 짧은 미검출(감김 → 33ms 미검출 → 66ms 뜸)에도 80ms 최소 유지가 지켜진다', () => {
    const s = sim();
    const t0 = s.t;
    s.step({ blinkLeft: 1 }); // t0: 감김
    s.gap(); // t0+33: 미검출
    s.step({ blinkLeft: 0 }); // t0+66: 뜸
    expect(s.proc.signals(t0 + 70).blinkL).toBeGreaterThanOrEqual(0.5);
    expect(s.proc.signals(t0 + 79).blinkL).toBeGreaterThanOrEqual(0.5);
    expect(s.proc.signals(t0 + 81).blinkL).toBeLessThan(0.5);
  });
});
