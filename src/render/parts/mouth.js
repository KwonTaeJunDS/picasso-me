// 입 (τ100). 정면 입술 → 옆에서 본 입술(가장자리로 튀어나온 두 겹). 세로 크기는 jaw 에 비례하며 시간차 없이 즉시.
// 뿌리는 현재 윤곽(τ=0)에 부착 + 지연 변위 ±0.12a 제한 (코와 같은 규칙), 얼굴 안으로 12px 겹침.

import { PALETTE } from '../palette.js';
import { A, B, V_MOUTH, clamp, smoothstep, sgn, polyStroke, lineStroke } from './geom.js';
import { profileEdgeU } from './model.js';
import { morphPoly } from './morph.js';

export const MOUTH_OVL = 12;
export const JAW_MAX = 84; // jaw=1 일 때 벌어지는 높이(px)
export const MIN_OPEN = 5; // 다문 입도 얇은 네이비 선이 남는다

const attachG = (s) => smoothstep(0.12, 0.78, s);
const att = (sig, s, edgeAbs) => s * attachG(sig) * Math.max(0, edgeAbs - MOUTH_OVL / A);

// 로컬 px: x=옆모습 방향(+), y=아래(+). h = 벌어진 높이. 각 도형의 좌우 거울쌍 인덱스는 *_MI.
const UP_F = [[-70, 2], [-42, -17], [-14, -22], [0, -14], [14, -22], [42, -17], [70, 2], [34, 7], [0, 4], [-34, 7]];
const UP_MI = [6, 5, 4, 3, 2, 1, 0, 9, 8, 7];
const LO_MI = [4, 3, 2, 1, 0, 7, 6, 5];
const IN_MI = [4, 3, 2, 1, 0, 7, 6, 5];
const HL_MI = [2, 1, 0];

const upperQ = (o) => [[-24, 2], [-16, -20], [o - 2, -26], [o + 20, -24], [o + 38, -10], [o + 40, 2], [o + 26, 8], [o, 7], [-6, 5], [-20, 6]];
const lowerF = (h) => [[-68, 2 + h], [-34, 7 + h], [0, 5 + h], [34, 7 + h], [68, 2 + h], [48, 26 + h], [0, 37 + h], [-48, 26 + h]];
const lowerQ = (o, h) => [[-22, 6 + h], [-8, 9 + h], [o, 9 + h], [o + 22, 11 + h], [o + 36, 18 + h], [o + 24, 38 + h], [o - 2, 42 + h], [-16, 32 + h]];
const inF = (h) => [[-66, 2], [-34, 6], [0, 3], [34, 6], [66, 2], [34, 7 + h], [0, 5 + h], [-34, 7 + h]];
const inQ = (o, h) => [[-26, 3], [-10, 6], [o - 2, 4], [o + 6, 6], [o + 4, 5], [o + 4, 8 + h], [o - 4, 7 + h], [-10, 8 + h]];
const hlF = (h) => [[-26, 19 + h], [0, 26 + h], [28, 19 + h]];
const hlQ = (o, h) => [[-6, 20 + h], [o + 2, 24 + h], [o + 10, 20 + h]];

export function emitMouth(out, model, ps, params, anchors) {
  const M = ps.mouth;
  const t = clamp(M.t, -1, 1);
  const sM = sgn(t);
  const sig = Math.abs(t);
  const mu = smoothstep(0.1, 0.85, sig);
  const jaw = clamp(ps.jaw, 0, 1);
  const h = MIN_OPEN + JAW_MAX * jaw;
  const o = MOUTH_OVL;

  const ovlU = MOUTH_OVL / A;
  const edgeC = model.s > 0 ? model.edgeR(V_MOUTH) : -model.edgeL(V_MOUTH);
  const attC = att(model.sigma, model.s, edgeC);
  const attN = att(sig, sM, profileEdgeU(V_MOUTH, sig));
  let uRoot = attC + clamp(attN - attC, -0.12, 0.12);
  uRoot = clamp(uRoot, model.edgeL(V_MOUTH) + ovlU, model.edgeR(V_MOUTH) - ovlU);
  const rx = model.x(uRoot);
  const ry = model.y(V_MOUTH) + 0.1 * clamp(M.p, -1, 1) * B;
  if (anchors) anchors.mouthRoot = [rx, ry];

  const skew = (-3 * (1 - mu)) / 70; // 고정 비대칭: 입꼬리가 한쪽으로 살짝 기운다
  const pivot = [rx, ry];
  out.push(polyStroke('mouth.in', PALETTE.navy, morphPoly(inF(h), inQ(o, h), IN_MI, sM, mu, rx, ry, 0, skew), 'mouth', 'mouth', { pivot, ampK: 0.7, spacing: 16 }));
  out.push(polyStroke('mouth.up', PALETTE.red, morphPoly(UP_F, upperQ(o), UP_MI, sM, mu, rx, ry, 0, skew), 'mouth', 'mouth', { pivot, ampK: 0.8, spacing: 16 }));
  out.push(polyStroke('mouth.lo', PALETTE.red, morphPoly(lowerF(h), lowerQ(o, h), LO_MI, sM, mu, rx, ry, 0, skew), 'mouth', 'mouth', { pivot, ampK: 0.8, spacing: 16 }));
  out.push(lineStroke('mouth.hl', PALETTE.line, morphPoly(hlF(h), hlQ(o, h), HL_MI, sM, mu, rx, ry, 0, skew), 4, 8, 'mouth', 'mouth', { pivot, ampK: 0.6 }));
}
