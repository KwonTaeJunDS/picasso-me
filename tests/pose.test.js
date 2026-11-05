import { describe, it, expect, vi } from 'vitest';
import {
  rotationFromMatrix,
  eulerFromMatrix,
  matrixFromEuler,
  translationOf,
  toScreenAngles,
  normalizeAngles,
  landmarkYaw,
  eyeDistancePx,
  createSignChecker,
  LM,
} from '../src/tracking/pose.js';
import { createParams } from '../src/config/params.js';

const rad = (d) => (d * Math.PI) / 180;
const cos = (d) => Math.cos(rad(d));
const sin = (d) => Math.sin(rad(d));

describe('행렬 규약: column-major, R[row][col] = d[col*4+row]', () => {
  it('Ry(90°) 직접 작성한 행렬에서 yaw=+90°', () => {
    // R = [[0,0,1],[0,1,0],[-1,0,0]] → 열 우선: col0=(0,0,-1) col1=(0,1,0) col2=(1,0,0)
    const d = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 2, -40, 1];
    const e = eulerFromMatrix(d);
    expect(e.yaw).toBeCloseTo(90, 6);
    expect(e.pitch).toBeCloseTo(0, 6);
    expect(e.roll).toBeCloseTo(0, 6);
    // 행 우선으로 잘못 읽으면 −90° 가 나온다
    expect(translationOf(d)).toEqual({ x: 1, y: 2, z: -40 });
  });

  it('Rx(30°) 직접 작성한 행렬에서 pitch=+30° (R12 = −sin)', () => {
    const c = cos(30);
    const s = sin(30);
    const d = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, -40, 1];
    const e = eulerFromMatrix(d);
    expect(e.pitch).toBeCloseTo(30, 6);
    expect(e.yaw).toBeCloseTo(0, 6);
    expect(e.roll).toBeCloseTo(0, 6);
  });

  it('Rz(20°) 직접 작성한 행렬에서 roll=+20°', () => {
    const c = cos(20);
    const s = sin(20);
    const d = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, -40, 1];
    expect(eulerFromMatrix(d).roll).toBeCloseTo(20, 6);
  });

  it('열벡터를 정규화한다: 균일 스케일이 있어도 같은 각도', () => {
    const a = eulerFromMatrix(matrixFromEuler(25, -10, 15, { scale: 1 }));
    const b = eulerFromMatrix(matrixFromEuler(25, -10, 15, { scale: 3.7 }));
    expect(b.yaw).toBeCloseTo(a.yaw, 8);
    expect(b.pitch).toBeCloseTo(a.pitch, 8);
    expect(b.roll).toBeCloseTo(a.roll, 8);
    const R = rotationFromMatrix(matrixFromEuler(25, -10, 15, { scale: 3.7 }));
    for (let c = 0; c < 3; c++) expect(Math.hypot(R[0][c], R[1][c], R[2][c])).toBeCloseTo(1, 10);
  });

  it('이동량은 각도에 영향을 주지 않는다', () => {
    const a = eulerFromMatrix(matrixFromEuler(10, 5, -5, { x: 0, y: 0, z: -30 }));
    const b = eulerFromMatrix(matrixFromEuler(10, 5, -5, { x: 12, y: -7, z: -80 }));
    expect(b).toEqual(a);
  });
});

describe('YXZ 왕복', () => {
  const yaws = [-80, -45, -10, 0, 10, 45, 80];
  const pitches = [-60, -25, 0, 25, 60];
  const rolls = [-60, -30, 0, 30, 60];

  it('합성 행렬 → 각도 복원 (스케일·이동 포함)', () => {
    for (const y of yaws) {
      for (const p of pitches) {
        for (const r of rolls) {
          const d = matrixFromEuler(y, p, r, { scale: 1.3, x: 3, y: -2, z: -45 });
          const e = eulerFromMatrix(d);
          expect(e.yaw).toBeCloseTo(y, 5);
          expect(e.pitch).toBeCloseTo(p, 5);
          expect(e.roll).toBeCloseTo(r, 5);
        }
      }
    }
  });

  it('특이점(pitch=±90°): roll=0 으로 두고 yaw 에 합쳐 같은 회전을 복원한다', () => {
    for (const p of [90, -90]) {
      const d = matrixFromEuler(30, p, 20);
      const e = eulerFromMatrix(d);
      expect(e.roll).toBe(0);
      expect(e.pitch).toBeCloseTo(p, 4);
      // pitch=+90 이면 yaw−roll, −90 이면 yaw+roll 만 정해진다
      expect(e.yaw).toBeCloseTo(p > 0 ? 10 : 50, 4);
      const R0 = rotationFromMatrix(d);
      const R1 = rotationFromMatrix(matrixFromEuler(e.yaw, e.pitch, e.roll));
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(R1[i][j]).toBeCloseTo(R0[i][j], 6);
    }
  });

  it('특이점 근처(89.9°)에서도 값이 크게 튀지 않는다', () => {
    const e = eulerFromMatrix(matrixFromEuler(30, 89.9, 0));
    expect(e.pitch).toBeCloseTo(89.9, 3);
    expect(e.yaw).toBeCloseTo(30, 0);
    expect(Number.isFinite(e.roll)).toBe(true);
  });

  it('사용할 수 없는 행렬은 null', () => {
    expect(eulerFromMatrix(null)).toBeNull();
    expect(eulerFromMatrix(undefined)).toBeNull();
    expect(eulerFromMatrix([])).toBeNull();
    expect(eulerFromMatrix(new Array(15).fill(1))).toBeNull();
    expect(eulerFromMatrix(new Array(16).fill(0))).toBeNull(); // 영벡터 열
    expect(eulerFromMatrix(matrixFromEuler(0, 0, 0).map((v, i) => (i === 5 ? NaN : v)))).toBeNull();
    expect(translationOf(null)).toBeNull();
  });

  it('Float32Array 도 받는다', () => {
    const d = Float32Array.from(matrixFromEuler(20, 10, -5));
    const e = eulerFromMatrix(d);
    expect(e.yaw).toBeCloseTo(20, 3);
    expect(e.pitch).toBeCloseTo(10, 3);
    expect(e.roll).toBeCloseTo(-5, 3);
  });
});

describe('화면(거울) 기준 부호 규약', () => {
  const params = createParams(); // yaw 45°, pitch 25°, roll 30°

  it('코가 원본 영상 오른쪽(+yaw)이면 거울 화면에서는 왼쪽 → t < 0', () => {
    const e = eulerFromMatrix(matrixFromEuler(30, 0, 0));
    const n = normalizeAngles(toScreenAngles(e, params), params);
    expect(n.t).toBeCloseTo(-30 / 45, 8);
    expect(n.p).toBeCloseTo(0, 8);
    expect(n.r).toBeCloseTo(0, 8);
  });

  it('고개를 숙이면(+pitch, 코 방향이 아래) p > 0', () => {
    const d = matrixFromEuler(0, 20, 0);
    expect(d[9]).toBeLessThan(0); // 정면 방향 벡터(3열)의 y 성분이 음수 = 아래를 봄
    const n = normalizeAngles(toScreenAngles(eulerFromMatrix(d), params), params);
    expect(n.p).toBeCloseTo(20 / 25, 8);
  });

  it('원본 영상에서 반시계로 기울면(+roll) 거울 화면에서는 시계방향 → r > 0', () => {
    const d = matrixFromEuler(0, 0, 15);
    expect(d[4]).toBeLessThan(0); // 위쪽 벡터(2열)가 원본 영상 왼쪽으로 기움
    const n = normalizeAngles(toScreenAngles(eulerFromMatrix(d), params), params);
    expect(n.r).toBeCloseTo(15 / 30, 8);
  });

  it('범위를 넘으면 ±1 로 clamp', () => {
    const e = eulerFromMatrix(matrixFromEuler(80, -60, 55));
    const n = normalizeAngles(toScreenAngles(e, params), params);
    expect(n.t).toBe(-1);
    expect(n.p).toBe(-1);
    expect(n.r).toBe(1);
  });

  it('범위 값이 바뀌면 정규화가 따라간다', () => {
    const e = eulerFromMatrix(matrixFromEuler(30, 0, 0));
    const p2 = createParams({ yawRange: 60 });
    expect(normalizeAngles(toScreenAngles(e, p2), p2).t).toBeCloseTo(-0.5, 8);
  });

  it('반전 토글은 해당 축 부호만 뒤집는다', () => {
    const e = eulerFromMatrix(matrixFromEuler(30, 10, 15));
    const base = normalizeAngles(toScreenAngles(e, params), params);
    const pi = createParams({ invertYaw: true, invertPitch: true, invertRoll: true });
    const inv = normalizeAngles(toScreenAngles(e, pi), pi);
    expect(inv.t).toBeCloseTo(-base.t, 10);
    expect(inv.p).toBeCloseTo(-base.p, 10);
    expect(inv.r).toBeCloseTo(-base.r, 10);
    const onlyYaw = createParams({ invertYaw: true });
    const y = normalizeAngles(toScreenAngles(e, onlyYaw), onlyYaw);
    expect(y.t).toBeCloseTo(-base.t, 10);
    expect(y.p).toBeCloseTo(base.p, 10);
    expect(y.r).toBeCloseTo(base.r, 10);
  });

  it('toScreenAngles 는 도 단위 부호만 바꾼다 (패널 표시용)', () => {
    const s = toScreenAngles({ yaw: 20, pitch: 10, roll: -5 }, params);
    expect(s).toEqual({ yaw: -20, pitch: 10, roll: -5 });
  });
});

describe('랜드마크 보조 계산', () => {
  const lm = [];
  lm[LM.NOSE_TIP] = { x: 0.55, y: 0.5 };
  lm[LM.CHEEK_R] = { x: 0.4, y: 0.5 };
  lm[LM.CHEEK_L] = { x: 0.6, y: 0.5 };
  lm[LM.EYE_OUTER_R] = { x: 0.4, y: 0.4 };
  lm[LM.EYE_OUTER_L] = { x: 0.6, y: 0.4 };

  it('landmarkYaw: 코가 볼 중점보다 영상 오른쪽이면 양수', () => {
    expect(landmarkYaw(lm)).toBeCloseTo(0.05, 10);
    const left = [...lm];
    left[LM.NOSE_TIP] = { x: 0.45, y: 0.5 };
    expect(landmarkYaw(left)).toBeCloseTo(-0.05, 10);
    expect(landmarkYaw([])).toBeNull();
    expect(landmarkYaw(null)).toBeNull();
  });

  it('eyeDistancePx: 종횡비를 반영한 픽셀 거리', () => {
    expect(eyeDistancePx(lm, 1280, 720)).toBeCloseTo(0.2 * 1280, 8);
    const tilted = [...lm];
    tilted[LM.EYE_OUTER_L] = { x: 0.6, y: 0.6 };
    expect(eyeDistancePx(tilted, 1000, 500)).toBeCloseTo(Math.hypot(0.2 * 1000, 0.2 * 500), 8);
    expect(eyeDistancePx([], 100, 100)).toBeNull();
  });
});

describe('부호 점검 (createSignChecker)', () => {
  const make = () => {
    const warn = vi.fn();
    return { warn, checker: createSignChecker({ warn }) };
  };

  it('부호가 일치하면 경고하지 않는다', () => {
    const { warn, checker } = make();
    for (let i = 0; i < 100; i++) {
      checker.push(30, 0.05);
      checker.push(-25, -0.04);
    }
    expect(warn).not.toHaveBeenCalled();
    expect(checker.warned).toBe(false);
  });

  it('|yaw|>15° 표본 20개 이상에서 80% 넘게 어긋나면 한 번만 경고한다', () => {
    const { warn, checker } = make();
    for (let i = 0; i < 19; i++) checker.push(30, -0.05);
    expect(warn).not.toHaveBeenCalled(); // 아직 20개 미만
    checker.push(30, -0.05);
    expect(warn).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) checker.push(30, -0.05);
    expect(warn).toHaveBeenCalledTimes(1); // 1회만
    expect(String(warn.mock.calls[0][0])).toContain('yaw');
  });

  it('작은 각도(≤15°)나 코-볼 차이가 거의 없는 표본은 세지 않는다', () => {
    const { warn, checker } = make();
    for (let i = 0; i < 100; i++) checker.push(10, -0.05);
    for (let i = 0; i < 100; i++) checker.push(30, -0.001);
    for (let i = 0; i < 100; i++) checker.push(NaN, 0.05);
    for (let i = 0; i < 100; i++) checker.push(30, null);
    expect(checker.stats.n).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('비율 경계: 20개 중 16개(80%)는 경고 없음, 17개(85%)는 경고', () => {
    const a = make();
    for (let i = 0; i < 16; i++) a.checker.push(30, -0.05);
    for (let i = 0; i < 4; i++) a.checker.push(30, 0.05);
    expect(a.warn).not.toHaveBeenCalled();
    const b = make();
    for (let i = 0; i < 17; i++) b.checker.push(30, -0.05);
    for (let i = 0; i < 3; i++) b.checker.push(30, 0.05);
    expect(b.warn).toHaveBeenCalledTimes(1);
  });
});
