// 귀 (주황, τ250): σ≈0 에서는 양옆에 작게. 회전하면 뒤통수 쪽 귀가 분할선 근처 안쪽으로 들어오며
// 최대 1.8배로 강조되고, 코 쪽(앞쪽) 귀는 줄어들어 사라진다. 귀 id 는 화면 고정(ear.L / ear.R).

import { PALETTE } from '../palette.js';
import { V_EAR, clamp, lerp, smoothstep, sgn, blobStroke, lineStroke } from './geom.js';
import { ease } from './model.js';

const EAR_RX = 25;
const EAR_RY = 52;

/** @param model buildModel 결과 (현재 윤곽)  @param earState 귀의 지연된 {t,p,r,k} */
export function emitEars(out, model, earState) {
  const t = clamp(earState.t, -1, 1);
  const sE = sgn(t);
  const sig = Math.abs(t);
  const e = ease(sig);
  const y = model.y(V_EAR);
  for (const sx of [-1, 1]) {
    const isBack = sx === -sE; // 뒤통수 쪽 귀
    const outU = sx < 0 ? model.edgeL(V_EAR) - 0.035 : model.edgeR(V_EAR) + 0.035;
    let u = outU;
    let scale;
    if (isBack) {
      // 분할선 안쪽(옆모습 반쪽 쪽)으로 이동, 최대 1.8배
      const inU = model.splitAt(V_EAR) + sE * 0.12;
      u = lerp(outU, inU, e);
      scale = 1 + 0.8 * e;
    } else {
      u = lerp(outU, outU - sx * 0.1, e);
      scale = 1 - smoothstep(0, 0.7, sig);
    }
    if (scale < 0.05) continue;
    const asym = sx < 0 ? 1.06 : 0.97; // 고정 비대칭
    const cx = model.x(u);
    const id = sx < 0 ? 'ear.L' : 'ear.R';
    const rx = EAR_RX * scale * asym;
    const ry = EAR_RY * scale * asym;
    const rot = sx * 0.16;
    const alphaK = smoothstep(0.05, 0.4, scale);
    out.push(blobStroke(id, PALETTE.orange, cx, y, rx, ry, rot, id, 'ears', { lump: 0.14, pivot: [cx, y], alphaK }));
    // 귀 안쪽 곡선 (네이비 테이퍼 선) — 귀가 충분히 클 때만
    if (scale > 0.3) {
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const loc = [sx * 0.2 * rx, -0.62 * ry, sx * 0.56 * rx, -0.22 * ry, sx * 0.54 * rx, 0.26 * ry, sx * 0.14 * rx, 0.64 * ry];
      const pts = [];
      for (let i = 0; i < loc.length; i += 2) pts.push(cx + loc[i] * cr - loc[i + 1] * sr, y + loc[i] * sr + loc[i + 1] * cr);
      out.push(lineStroke(sx < 0 ? 'ear.inL' : 'ear.inR', PALETTE.line, pts, 4, 8, id, 'ears', { pivot: [cx, y], ampK: 0.5, alphaK: smoothstep(0.3, 0.55, scale) }));
    }
  }
}

