// 코 (τ150). 정면: 세로 쐐기 + 흰 콧대 + 네이비 콧구멍 → 옆모습: 윤곽 밖으로 튀어나온 삼각 실루엣.
//  - 뿌리(부착점)는 현재 윤곽(τ=0)에서 계산해 항상 얼굴에 붙어 있다. 돌출·모양은 코 자신의 지연된 t 로 계산하고,
//    지연 위치와 현재 위치의 차이는 ±0.12a 로 제한한 상대 변위로만 더해 "늦게 따라오는 어긋남"을 보인다.
//  - 뿌리 쪽은 얼굴 안으로 NOSE_OVL(12px) 겹쳐 틈이 생기지 않는다.
//  - 거리 k: 폭·돌출 ×(1+0.8·k·distortion) (≤1.8), 길이는 그 40% 만큼만 늘어난다.

import { PALETTE } from '../palette.js';
import { A, B, clamp, smoothstep, sgn, polyStroke, lineStroke, blobStroke } from './geom.js';
import { profileEdgeU } from './model.js';
import { morphPoly, morphPoint } from './morph.js';

export const NOSE_OVL = 12;
const V_ROOT = 0.0;

// 정면 쐐기 7점 (로컬 px, 뿌리 기준): 위 꼭지, 오른쪽 중간, 오른쪽 콧방울, 오른쪽 아래, 왼쪽 아래, 왼쪽 콧방울, 왼쪽 중간
const F = [[0, -92], [20, -12], [44, 66], [15, 90], [-15, 90], [-44, 66], [-20, -12]];
const F_MI = [0, 6, 5, 4, 3, 2, 1];
// 정면 그림자(오른쪽 반) 6점
const SF = [[2, -80], [20, -12], [44, 66], [15, 90], [0, 90], [0, -10]];
const S_MI = [0, 1, 2, 3, 4, 5];
// 정면 콧대 선 4점
const BF = [[-1, -104], [3, -46], [7, 14], [3, 62]];
const B_MI = [0, 1, 2, 3];

const attachG = (s) => smoothstep(0.08, 0.72, s);

export function noseAttachU(sigC, sC, edgeAbs) {
  return sC * attachG(sigC) * Math.max(0, edgeAbs - NOSE_OVL / A);
}

export function emitNose(out, model, ps, params, anchors) {
  const N = ps.nose;
  const t = clamp(N.t, -1, 1);
  const sN = sgn(t);
  const sig = Math.abs(t);
  const mu = smoothstep(0.1, 0.85, sig); // 정면 → 옆모습 모양 보간
  const kk = clamp(N.k, 0, 1) * params.distortion;
  const ns = 1 + 0.8 * kk;
  const nsY = 1 + 0.4 * (ns - 1);

  // 뿌리: 현재 윤곽에 부착 + 제한된 지연 변위
  const ovlU = NOSE_OVL / A;
  const edgeC = model.s > 0 ? model.edgeR(V_ROOT) : -model.edgeL(V_ROOT);
  const attC = noseAttachU(model.sigma, model.s, edgeC);
  const attN = noseAttachU(sig, sN, profileEdgeU(V_ROOT, sig));
  let uRoot = attC + clamp(attN - attC, -0.12, 0.12);
  uRoot = clamp(uRoot, model.edgeL(V_ROOT) + ovlU, model.edgeR(V_ROOT) - ovlU);
  const rx = model.x(uRoot);
  const ry = model.y(V_ROOT) + 0.07 * clamp(N.p, -1, 1) * B;
  if (anchors) anchors.noseRoot = [rx, ry];

  const o = NOSE_OVL;
  const Q = [
    [o - 8, -96 * nsY], [o + 117 * ns, 46 * nsY], [o + 30 * ns, 84 * nsY], [o - 4, 92 * nsY],
    [-16, 90 * nsY], [-14, 66 * nsY], [-12, -12 * nsY],
  ];
  const SQ = [
    [o + 60 * ns, 30 * nsY], [o + 117 * ns, 46 * nsY], [o + 30 * ns, 84 * nsY], [o - 4, 92 * nsY], [-2, 92 * nsY], [-2, 40 * nsY],
  ];
  const BQ = [
    [o - 8, -116 * nsY], [o + 16, -52 * nsY], [o + 62 * ns, 10 * nsY], [o + 117 * ns, 44 * nsY],
  ];
  const Fs = F.map(([x, y]) => [x * ns, y * nsY]);
  const SFs = SF.map(([x, y]) => [x * ns, y * nsY]);
  const BFs = BF.map(([x, y]) => [x * ns, y * nsY]);

  const shear = (4 * (1 - mu)) / 92; // 정면의 고정 비대칭(살짝 기운 코)
  const pivot = [rx, ry];

  out.push(polyStroke('nose.plane', PALETTE.orange, morphPoly(Fs, Q, F_MI, sN, mu, rx, ry, shear), 'nose', 'nose', { pivot }));
  out.push(polyStroke('nose.shade', PALETTE.navy, morphPoly(SFs, SQ, S_MI, sN, mu, rx, ry, shear), 'nose', 'nose', { pivot }));

  // 콧구멍 (네이비): 화면 고정 id. 옆모습 쪽에 가까운 쪽은 남고 먼 쪽은 사라진다
  for (const side of [-1, 1]) {
    const id = side < 0 ? 'nose.nostrilL' : 'nose.nostrilR';
    const near = side === sN;
    const fx = side * 23 * ns;
    const fy = 76 * nsY;
    let k = 1;
    let qx;
    let qy;
    if (near) {
      qx = o + 8 * ns;
      qy = 74 * nsY;
    } else {
      qx = -6;
      qy = 76 * nsY;
      k = 1 - smoothstep(0.35, 0.9, sig);
    }
    if (k <= 0.08) continue;
    const [nx, ny] = morphPoint(fx, fy, qx, qy, sN, mu, rx, ry, shear);
    out.push(blobStroke(id, PALETTE.navy, nx, ny, 9.5 * ns * k, 6.5 * k, -0.2 * side, 'nose', 'nose', { lump: 0.1, pivot, ampK: 0.5, alphaK: smoothstep(0.08, 0.4, k) }));
  }

  // 콧대 흰 선: 정면=가운데 세로, 옆모습=앞쪽 모서리를 따라
  out.push(lineStroke('nose.bridge', PALETTE.line, morphPoly(BFs, BQ, B_MI, sN, mu, rx, ry, shear), 5, 10, 'nose', 'nose', { pivot }));
}
