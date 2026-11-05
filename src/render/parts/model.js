// 얼굴 다시점 모델 (PLAN 4.2/4.3). composePortrait 가 프레임마다 한 번 만든다.
//
// 공통 정면 기하 G0(좌우 비대칭 포함)에서 σ=|t| 에 따라 옆모습 목표 G+ (t>0, 오른쪽 옆모습) 또는
// G- (t<0, G+ 의 좌우 거울) 로 보간한다: G(t) = lerp(G0, G±, ease(σ)).
// 정면 도형은 뒤집지 않으므로 t=±ε 에서 튀지 않는다.
//
// 좌표: 얼굴 로컬 (u, v), u ∈ [-1,1] 화면 좌→우(× a), v ∈ [-1,1] 이마 위→턱(× b).
// 세로 재매핑(끄덕임 p): vp(v) = v + m·bump(v), m = 0.12·p (눈높이 기준선이 m 만큼 이동, 이마·턱 끝은 고정).
//
// 분할선은 면적 기준이다: 옆모습 쪽 반쪽의 면적 비율 f = 0.5 + 0.45·σ 가 되는 위치를 이분법으로 구한다
// (기본 타원이면 타원 면적의 역함수와 같다). 옆모습 쪽은 회전 방향이고 분할선은 반대쪽으로 이동한다.

import {
  CX, CY, A, B, GN, VG, V_EYE, clamp, lerp, smoothstep, sgn, pwl, sampleGrid,
} from './geom.js';

/** 정면 기본 반폭 (super-ellipse + 턱 모으기) */
export function baseHalfWidth(v) {
  const a = Math.abs(v);
  const sup = Math.pow(Math.max(0, 1 - Math.pow(a, 2.35)), 1 / 2.35);
  return sup * (1 - 0.2 * smoothstep(0.1, 1, v));
}

// G0 의 손맛 비대칭 (고정): 턱이 오른쪽으로 살짝 치우치고, 왼쪽 관자놀이가 조금 넓다
const c0 = (v) => 0.03 * smoothstep(0.35, 1, v);
const baseL = (v) => c0(v) - baseHalfWidth(v) * 1.025;
const baseR = (v) => c0(v) + baseHalfWidth(v) * (0.99 + 0.03 * smoothstep(0.1, 0.8, v));

/** 오른쪽 옆모습 목표 실루엣의 반폭 노드 (이마 경사, 눈썹뼈, 코뿌리 오목, 입술, 턱). 코·입술은 별도 부품. */
const PROFILE = [
  [-1.0, 0.2], [-0.92, 0.46], [-0.8, 0.74], [-0.62, 0.88], [-0.44, 0.93], [-0.3, 0.86], [-0.18, 0.79],
  [-0.02, 0.77], [0.12, 0.8], [0.24, 0.87], [0.34, 0.84], [0.42, 0.79], [0.52, 0.85], [0.64, 0.77],
  [0.78, 0.74], [0.9, 0.56], [1.0, 0.22],
];
export const profileHalfWidth = (v) => pwl(PROFILE, v);

export const ease = (s) => smoothstep(0, 1, s);

/** 옆모습 쪽 윤곽의 현재(σ) 절대 위치 u (프로필 방향 +) — 코·입 부착점 계산용 폐형식 */
export function profileEdgeU(v, sigma) {
  return lerp(baseR(v), profileHalfWidth(v), ease(sigma));
}

// 분할선 꺾임: 옆모습 쪽으로 코 높이에서 살짝 꺾인다. σ 가 0 이면 사라져 부호가 바뀌어도 연속.
const zig = (v) => 0.05 * Math.max(0, 1 - Math.abs(v - 0.08) / (v < 0.08 ? 1.08 : 0.92));
const zig0 = (v) => 0.012 * Math.sin((v + 0.3) * 3.2); // 고정된 미세 손맛

/** pitch 재매핑 범프: 눈높이에서 1, 이마 위·턱 끝에서 0 */
export function pitchBump(v) {
  const ve = V_EYE;
  if (v <= ve) {
    const x = Math.sin(((v + 1) / (ve + 1)) * Math.PI * 0.5);
    return x * x;
  }
  const x = Math.sin(((1 - v) / (1 - ve)) * Math.PI * 0.5);
  return x * x;
}

/**
 * @typedef {Object} FaceModel
 * @property {number} s 옆모습 방향 (+1 오른쪽, -1 왼쪽)
 * @property {number} sigma |t|
 * @property {number} uS 분할선 기준 u
 * @property {number} m 세로 재매핑 이동량
 * @property {Float64Array} eL 왼쪽 윤곽 u (격자)
 * @property {Float64Array} eR 오른쪽 윤곽 u
 * @property {Float64Array} sp 분할선 u (윤곽 안으로 클램프 전)
 * @property {Float64Array} spc 분할선 u (윤곽 안으로 클램프 후)
 * @property {Float64Array} ys 격자 y(px)
 */

export function buildModel(partStates, params) {
  const c = partStates.contour;
  const sp = partStates.split || c;
  const t = clamp(c.t, -1, 1);
  const sigma = Math.abs(t);
  const s = sgn(t);
  const e = ease(sigma);
  const m = 0.12 * clamp(c.p, -1, 1);

  const eL = new Float64Array(GN);
  const eR = new Float64Array(GN);
  const ys = new Float64Array(GN);
  for (let i = 0; i < GN; i++) {
    const v = VG[i];
    const wp = profileHalfWidth(v);
    eR[i] = s > 0 ? lerp(baseR(v), wp, e) : baseR(v);
    eL[i] = s < 0 ? lerp(baseL(v), -wp, e) : baseL(v);
    ys[i] = CY + (v + m * pitchBump(v)) * B;
  }

  // 분할선: 면적 기준으로 이분법
  const sSplit = sgn(clamp(sp.t, -1, 1));
  const sigSplit = Math.abs(clamp(sp.t, -1, 1));
  const bendK = smoothstep(0, 0.2, sigSplit) * sSplit;
  const z = new Float64Array(GN);
  for (let i = 0; i < GN; i++) z[i] = zig0(VG[i]) + bendK * zig(VG[i]);

  const fProfile = 0.5 + 0.45 * sigSplit;
  const targetRight = sSplit > 0 ? fProfile : 1 - fProfile;
  let lo = -1.3, hi = 1.3;
  for (let it = 0; it < 30; it++) {
    const mid = 0.5 * (lo + hi);
    // fractionRight 는 uS 에 대해 감소
    if (fractionRight(mid, eL, eR, z) > targetRight) lo = mid;
    else hi = mid;
  }
  const uS = 0.5 * (lo + hi);

  const spA = new Float64Array(GN);
  const spc = new Float64Array(GN);
  for (let i = 0; i < GN; i++) {
    spA[i] = uS + z[i];
    spc[i] = clamp(spA[i], eL[i], eR[i]);
  }

  return {
    s, sigma, e, uS, m, t,
    eL, eR, sp: spA, spc, ys,
    sigmaSplit: sigSplit, sSplit,
    /** u → x(px) */
    x: (u) => CX + u * A,
    /** v → y(px) (pitch 재매핑 포함) */
    y: (v) => CY + (v + m * pitchBump(v)) * B,
    edgeL: (v) => sampleGrid(eL, v),
    edgeR: (v) => sampleGrid(eR, v),
    splitAt: (v) => sampleGrid(spc, v),
    /** 화면 왼쪽(L)/오른쪽(R) 반쪽의 v 에서의 [왼경계, 오른경계] u */
    bounds(region, v) {
      const l = sampleGrid(eL, v);
      const r = sampleGrid(eR, v);
      const q = sampleGrid(spc, v);
      return region === 'L' ? [l, q] : [q, r];
    },
  };
}

/** uS 에서 (회전 방향 무관) 오른쪽 면적 비율. 행 단위 사다리꼴 적분. */
function fractionRight(uS, eL, eR, z) {
  let right = 0;
  let total = 0;
  for (let i = 0; i < GN; i++) {
    const w = i === 0 || i === GN - 1 ? 0.5 : 1;
    const span = eR[i] - eL[i];
    const cut = clamp(uS + z[i], eL[i], eR[i]);
    total += w * span;
    right += w * (eR[i] - cut);
  }
  return total > 1e-9 ? right / total : 0.5;
}

/** 옆모습 쪽 반쪽의 면적 비율(모델 격자 기준). 테스트·진단용. */
export function profileFraction(model) {
  let prof = 0;
  let total = 0;
  for (let i = 0; i < GN; i++) {
    const w = i === 0 || i === GN - 1 ? 0.5 : 1;
    const l = model.eL[i], r = model.eR[i], q = model.spc[i];
    total += w * (r - l);
    prof += w * (model.s > 0 ? r - q : q - l);
  }
  return total > 1e-9 ? prof / total : 0.5;
}
