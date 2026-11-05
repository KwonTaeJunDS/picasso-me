// 눈 (τ40, 위치에만 시간차). 화면 고정 id eyeL / eyeR.
//  - 옆모습 쪽 눈은 끝까지 정면 아몬드(+네이비 홍채)로 남는다 → |t|=1 에서 정면 눈 1개 (피카소 시그니처).
//  - 반대쪽(정면 반쪽) 눈은 반쪽이 좁아지면 줄다가 σ ∈ [0.75, 1] 에서 연속으로 소거된다.
//  - blink ≥ 0.5 → 열린 눈 도형(흰자·홍채)은 빠지고 눈꺼풀 선 한 줄(같은 id eyeX.lid)이 감긴 곡선으로 바뀐다.
//    깜빡임에는 시간차를 걸지 않는다(즉시). 거리 k 는 눈 간격을 1 + 0.4·k·distortion 까지 벌린다.

import { PALETTE } from '../palette.js';
import { A, B, V_EYE, clamp, lerp, smoothstep, sgn, polyStroke, lineStroke, blobStroke } from './geom.js';
import { ease } from './model.js';

const EYE_W = 98; // px (정면 아몬드 폭)
const EYE_H = 46;

/** 열린 눈 아몬드 윤곽 (로컬 px, 12점) */
function almond(W, H, slantDir) {
  const pts = [];
  const upper = [];
  const lower = [];
  for (let j = 0; j <= 6; j++) {
    const x = -W / 2 + (W * j) / 6;
    const q = Math.max(0, 1 - Math.pow((2 * x) / W, 2));
    const raise = 0.09 * x * slantDir; // 바깥 눈꼬리가 약간 올라간다
    upper.push(x, -0.58 * H * Math.pow(q, 0.85) - raise);
    if (j >= 1 && j <= 5) lower.push(x, 0.42 * H * Math.pow(q, 0.85) - raise);
  }
  for (let k = 0; k < upper.length; k += 2) pts.push(upper[k], upper[k + 1]);
  for (let k = lower.length - 2; k >= 0; k -= 2) pts.push(lower[k], lower[k + 1]);
  return pts;
}

export function emitEyes(out, model, ps, params) {
  const E = ps.eyes;
  const t = clamp(E.t, -1, 1);
  const sE = sgn(t);
  const sig = Math.abs(t);
  const e = ease(sig);
  const spacing = 1 + 0.4 * clamp(E.k, 0, 1) * params.distortion;
  const pitchShift = 0.05 * clamp(E.p, -1, 1) * B;

  for (const sx of [-1, 1]) {
    const id = sx < 0 ? 'eyeL' : 'eyeR';
    const region = sx < 0 ? 'L' : 'R';
    const profileSide = sx === sE;
    const blink = sx < 0 ? ps.blinkL : ps.blinkR;
    const size = sx < 0 ? 1.07 : 0.94; // 고정 비대칭 (±10% 이내)
    const dv = sx < 0 ? -0.008 : 0.014;
    const v = V_EYE + dv;
    const yC = model.y(v) + pitchShift;
    const [lb, rb] = model.bounds(region, v);
    const eyeWu = (EYE_W * size) / A;

    let u;
    let scale;
    const u0 = sx * 0.44 * spacing;
    if (profileSide) {
      u = lerp(u0, sx * 0.3 * (1 + 0.2 * (spacing - 1)), e);
      scale = 1 + 0.08 * e;
    } else {
      const mid = 0.5 * (lb + rb);
      u = lerp(u0, mid, e);
      const fit = clamp((rb - lb) / (1.4 * eyeWu), 0, 1);
      scale = fit * (1 - smoothstep(0.75, 1.0, sig));
    }
    if (scale < 0.06) continue; // 완전히 소거 (순위는 레지스트리가 예약)

    // 반쪽 안에 머무르게 클램프
    const hw = 0.5 * eyeWu * scale + 0.025;
    if (rb - lb > 2 * hw) u = clamp(u, lb + hw, rb - hw);
    else u = 0.5 * (lb + rb);

    const xC = model.x(u);
    const W = EYE_W * size * scale;
    const H = EYE_H * size * scale;
    const slantDir = sx; // 바깥쪽 방향
    const pivot = [xC, yC];
    const alphaK = smoothstep(0.06, 0.3, scale); // 사라지기 직전에는 옅어진다
    const closed = blink >= 0.5;

    if (!closed) {
      const loc = almond(W, H, slantDir);
      const pts = new Array(loc.length);
      for (let k = 0; k < loc.length; k += 2) {
        pts[k] = xC + loc[k];
        pts[k + 1] = yC + loc[k + 1];
      }
      out.push(polyStroke(`${id}.white`, PALETTE.line, pts, id, 'eyes', { pivot, ampK: 0.6, spacing: 14, alphaK }));
      const gaze = sE * e * 0.16 * W; // 옆모습 쪽을 바라본다
      out.push(
        blobStroke(`${id}.iris`, PALETTE.navy, xC + gaze, yC + 0.02 * H, 0.4 * H, 0.45 * H, 0, id, 'eyes', {
          lump: 0.06,
          pivot,
          ampK: 0.5,
          alphaK,
        }),
      );
      // 위 눈꺼풀 선 (네이비, 테이퍼)
      const lid = [
        xC - 0.6 * W, yC + 0.02 * H - 0.09 * (-0.6 * W) * slantDir,
        xC - 0.3 * W, yC - 0.5 * H - 0.09 * (-0.3 * W) * slantDir,
        xC + 0.05 * W, yC - 0.62 * H,
        xC + 0.34 * W, yC - 0.5 * H - 0.09 * (0.34 * W) * slantDir,
        xC + 0.62 * W, yC - 0.02 * H - 0.09 * (0.62 * W) * slantDir,
      ];
      out.push(lineStroke(`${id}.lid`, PALETTE.navy, lid, 4, 9, id, 'eyes', { pivot, ampK: 0.6, alphaK }));
    } else {
      // 감긴 눈: 아래로 처진 곡선 한 줄 (같은 id)
      const cl = [
        xC - 0.56 * W, yC - 0.04 * H - 0.09 * (-0.56 * W) * slantDir,
        xC - 0.28 * W, yC + 0.3 * H - 0.09 * (-0.28 * W) * slantDir,
        xC + 0.02 * W, yC + 0.42 * H,
        xC + 0.3 * W, yC + 0.28 * H - 0.09 * (0.3 * W) * slantDir,
        xC + 0.58 * W, yC - 0.1 * H - 0.09 * (0.58 * W) * slantDir,
      ];
      out.push(lineStroke(`${id}.lid`, PALETTE.navy, cl, 4, 10, id, 'eyes', { pivot, ampK: 0.6, alphaK }));
    }

    // 눈썹: 안쪽(코 쪽)이 낮고 바깥이 높은 각진 호
    const inner = -sx;
    const brow = [];
    for (let j = 0; j <= 4; j++) {
      const d = -1 + (2 * j) / 4; // -1 안쪽 … +1 바깥
      const bx = xC + (-inner) * d * 0.62 * W;
      const lift = (sx < 0 ? 0.32 : 0.14) * d; // 왼쪽 눈썹은 더 가파르게 (비대칭)
      const by = yC - 1.18 * H - 0.55 * H * (1 - d * d) - lift * H;
      brow.push(bx, by);
    }
    out.push(lineStroke(`${id}.brow`, PALETTE.navy, brow, 6, 12, id, 'eyes', { pivot, ampK: 0.7, alphaK }));
  }
}
