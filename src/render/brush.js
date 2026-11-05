// 붓터치 프리미티브 (PLAN 4.5, PRD 6.5/7.1).
//  - brushPoly : 닫힌 다각형. 둘레를 재샘플 → 법선 방향 노이즈 변위 → strokeLayers 겹 반투명 누적(≈0.92)
//  - brushLine : 열린 곡선. Chaikin 평활 → 리본 폴리곤, 폭 wMin~wMax, 양 끝 테이퍼
//  - brushBlob : 반지름 노이즈 타원 (불규칙한 둥근 덩어리)
// 스톱모션: 호출자가 o.seed 에 hash(epoch, 스트로크 id) 를 넣는다. 시드가 같으면 모양이 완전히 같고,
// 위치·크기는 매 프레임 입력 좌표로 바뀐다. 렌더 경로에서 Math.random 을 쓰지 않는다.
// 금지: 매끈한 그라데이션, 완벽한 원, 자로 그은 직선, 검정 윤곽선.

import { hash32, hashStr, noise1, noise2, noiseLoopCS } from './noise.js';

export const BRUSH = Object.freeze({
  opacity: 0.92, // 겹 누적 불투명도 목표
  spacing: 24, // 다각형 둘레 재샘플 간격(px) — 원래 꼭짓점은 항상 보존
  coarse: 130, // 큰 일렁임 파장(px)
  fine: 46, // 잔 떨림 파장(px)
  lineSpacing: 8, // 리본 샘플 간격(px)
});

/** 겹당 α = 1 - (1-total)^(1/layers) → layers 겹 누적 불투명도가 total. */
export function layerAlpha(total, layers) {
  const L = Math.max(1, layers | 0);
  const t = total < 0 ? 0 : total > 0.999 ? 0.999 : total;
  return 1 - Math.pow(1 - t, 1 / L);
}

/** 스톱모션 시드: epoch 와 스트로크 id 해시로 결정. */
export function strokeSeed(epoch, idHash) {
  return hash32(epoch, idHash, 0x0b5e);
}

// ---------------------------------------------------------------------------
// 스크래치 버퍼 (프레임당 할당을 피한다). grow() 뒤에는 항상 SC.X 처럼 다시 읽는다.
// ---------------------------------------------------------------------------
const KEYS = ['X', 'Y', 'S', 'NX', 'NY', 'CS', 'SN', 'T1', 'T2', 'T3', 'T4'];
const SC = {};
for (const k of KEYS) SC[k] = new Float64Array(1024);

function grow(n) {
  if (SC.X.length >= n) return;
  const m = Math.max(n, SC.X.length * 2);
  for (const k of KEYS) SC[k] = new Float64Array(m);
}

const TWO_PI = Math.PI * 2;

/** 닫힌 다각형 pts(flat) → SC.X/Y/S/NX/NY/CS/SN. 원래 꼭짓점을 보존하며 spacing 이하로 쪼갠다. 반환 [n, 둘레]. */
function prepareLoop(pts, spacing, count) {
  const m = count === undefined ? pts.length >> 1 : count;
  // 1차: 필요한 크기
  let total = 0;
  let need = 0;
  for (let i = 0; i < m; i++) {
    const j = i + 1 === m ? 0 : i + 1;
    const dx = pts[2 * j] - pts[2 * i];
    const dy = pts[2 * j + 1] - pts[2 * i + 1];
    const len = Math.sqrt(dx * dx + dy * dy);
    total += len;
    need += Math.max(1, Math.ceil(len / spacing));
  }
  grow(need + 4);
  const X = SC.X, Y = SC.Y, S = SC.S;
  let n = 0;
  let acc = 0;
  for (let i = 0; i < m; i++) {
    const j = i + 1 === m ? 0 : i + 1;
    const x0 = pts[2 * i], y0 = pts[2 * i + 1];
    const dx = pts[2 * j] - x0;
    const dy = pts[2 * j + 1] - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) continue; // 겹친 꼭짓점 제거
    const seg = Math.max(1, Math.ceil(len / spacing));
    for (let q = 0; q < seg; q++) {
      const f = q / seg;
      X[n] = x0 + dx * f;
      Y[n] = y0 + dy * f;
      S[n] = acc + len * f;
      n++;
    }
    acc += len;
  }
  if (n < 3 || acc < 1e-6) return [0, 0];

  // 방향 부호(shoelace) → 바깥쪽 법선
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    area2 += X[i] * Y[j] - X[j] * Y[i];
  }
  const sgn = area2 >= 0 ? 1 : -1;
  const NX = SC.NX, NY = SC.NY, CS = SC.CS, SN = SC.SN;
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? n - 1 : i - 1;
    const b = i + 1 === n ? 0 : i + 1;
    const tx = X[b] - X[a];
    const ty = Y[b] - Y[a];
    const l = Math.sqrt(tx * tx + ty * ty) || 1;
    NX[i] = (sgn * ty) / l;
    NY[i] = (-sgn * tx) / l;
    const ang = (S[i] / acc) * TWO_PI;
    CS[i] = Math.cos(ang);
    SN[i] = Math.sin(ang);
  }
  return [n, acc];
}

/** prepareLoop 결과로 layers 겹을 칠한다. */
function paintLoop(ctx, n, perim, color, o) {
  const layers = Math.max(1, (o.layers ?? 3) | 0);
  const amp = o.amp ?? 3;
  const total = o.opacity ?? BRUSH.opacity;
  if (total <= 0.002) return;
  const a = layerAlpha(total, layers);
  const X = SC.X, Y = SC.Y, NX = SC.NX, NY = SC.NY, CS = SC.CS, SN = SC.SN;
  const cyc1 = Math.max(1.5, perim / BRUSH.coarse);
  const cyc2 = Math.max(2.5, perim / BRUSH.fine);
  ctx.fillStyle = color;
  ctx.globalAlpha = a;
  for (let L = 0; L < layers; L++) {
    const seed = hash32(o.seed | 0, L, 0x5eed);
    // 겹마다 살짝 안쪽/바깥쪽으로 어긋나 가장자리에 붓 자국 같은 층이 생긴다
    const bias = layers > 1 ? (L / (layers - 1) - 0.5) * amp * 0.5 : 0;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      let d = bias;
      if (amp > 0) {
        d +=
          amp * (0.75 * noise2(CS[i] * (cyc1 / TWO_PI) + 17.3, SN[i] * (cyc1 / TWO_PI) + 41.9, seed) +
            0.42 * noise2(CS[i] * (cyc2 / TWO_PI) + 5.1, SN[i] * (cyc2 / TWO_PI) + 23.7, seed + 977));
      }
      const x = X[i] + NX[i] * d;
      const y = Y[i] + NY[i] * d;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * 닫힌 다각형 붓터치.
 * @param pts [x0,y0,x1,y1,...]
 * @param o {seed, amp(px), layers, opacity(누적), spacing}
 */
export function brushPoly(ctx, pts, color, o = {}) {
  const [n, perim] = prepareLoop(pts, o.spacing ?? BRUSH.spacing);
  if (n < 3) return;
  paintLoop(ctx, n, perim, color, o);
}

/**
 * 반지름 노이즈 타원. 완벽한 원이 되지 않도록 o.lump(기본 0.1) 만큼 고정 시드로 일그러뜨린다.
 * o.shapeSeed 는 스트로크 고유의 고정 시드(떨림 시드와 별개).
 */
export function brushBlob(ctx, cx, cy, rx, ry, rot, color, o = {}) {
  const sp = o.spacing ?? BRUSH.spacing;
  const per = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const N = Math.max(12, Math.min(72, Math.round(per / sp)));
  const lump = o.lump ?? 0.1;
  const shapeSeed = o.shapeSeed | 0;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const tmp = blobScratch(N * 2);
  for (let j = 0; j < N; j++) {
    const th = (j / N) * TWO_PI;
    const c = Math.cos(th), s = Math.sin(th);
    const k = 1 + lump * noiseLoopCS(c, s, 3.2, shapeSeed);
    const ex = rx * k * c;
    const ey = ry * k * s;
    tmp[2 * j] = cx + ex * cr - ey * sr;
    tmp[2 * j + 1] = cy + ex * sr + ey * cr;
  }
  const [n, perim] = prepareLoop(tmp, sp * 4, N); // 이미 촘촘하므로 재분할 거의 없음
  if (n < 3) return;
  paintLoop(ctx, n, perim, color, o);
}

let BLOB = new Float64Array(160);
function blobScratch(len) {
  if (BLOB.length < len) BLOB = new Float64Array(len);
  return BLOB;
}

// ---------------------------------------------------------------------------
// 테이퍼 선
// ---------------------------------------------------------------------------

const smooth01 = (x) => {
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * (3 - 2 * c);
};

/** pts(flat) → Chaikin 2회 → 등간격 재샘플 → SC.X/Y/S/NX/NY. 반환 [n, 총길이(트림 전)]. */
function prepareLine(pts) {
  const m = pts.length >> 1;
  if (m < 2) return [0, 0];
  grow(m * 4 + 8);
  // Chaikin ×2 (끝점 보존)
  let ax = SC.T1, ay = SC.T2, bx = SC.T3, by = SC.T4;
  for (let i = 0; i < m; i++) {
    ax[i] = pts[2 * i];
    ay[i] = pts[2 * i + 1];
  }
  let cnt = m;
  for (let it = 0; it < 2; it++) {
    let w = 0;
    bx[w] = ax[0];
    by[w] = ay[0];
    w++;
    for (let i = 0; i < cnt - 1; i++) {
      bx[w] = 0.75 * ax[i] + 0.25 * ax[i + 1];
      by[w] = 0.75 * ay[i] + 0.25 * ay[i + 1];
      w++;
      bx[w] = 0.25 * ax[i] + 0.75 * ax[i + 1];
      by[w] = 0.25 * ay[i] + 0.75 * ay[i + 1];
      w++;
    }
    bx[w] = ax[cnt - 1];
    by[w] = ay[cnt - 1];
    w++;
    cnt = w;
    const tx = ax, ty = ay;
    ax = bx; ay = by; bx = tx; by = ty;
  }
  // 호 길이
  let len = 0;
  for (let i = 1; i < cnt; i++) len += Math.hypot(ax[i] - ax[i - 1], ay[i] - ay[i - 1]);
  if (len < 3) return [0, 0];
  const ds = BRUSH.lineSpacing;
  const n = Math.max(3, Math.ceil(len / ds) + 1);
  grow(n + 4);
  const X = SC.X, Y = SC.Y, S = SC.S;
  // 등간격 샘플 (선형 보간)
  let seg = 1;
  let segStart = 0;
  let segLen = Math.hypot(ax[1] - ax[0], ay[1] - ay[0]);
  for (let q = 0; q < n; q++) {
    const target = (q / (n - 1)) * len;
    while (seg < cnt - 1 && target > segStart + segLen) {
      segStart += segLen;
      seg++;
      segLen = Math.hypot(ax[seg] - ax[seg - 1], ay[seg] - ay[seg - 1]);
    }
    const f = segLen > 1e-9 ? Math.min(1, Math.max(0, (target - segStart) / segLen)) : 0;
    X[q] = ax[seg - 1] + (ax[seg] - ax[seg - 1]) * f;
    Y[q] = ay[seg - 1] + (ay[seg] - ay[seg - 1]) * f;
    S[q] = target;
  }
  return [n, len];
}

/**
 * 테이퍼 선 (리본 폴리곤).
 * @param pts [x0,y0,...] 제어점 (3개 이상 권장 — 곡선으로 만든다)
 * @param wMin 가장 가는 곳(끝 제외) 폭, wMax 가장 굵은 곳 폭 (4~10px)
 * @param o {seed, amp, layers, opacity, frac(0..1: 앞부분만 그림)}
 */
export function brushLine(ctx, pts, color, wMin, wMax, o = {}) {
  const [nFull, lenFull] = prepareLine(pts);
  if (nFull < 3) return;
  const frac = o.frac === undefined ? 1 : o.frac;
  if (frac <= 0.01) return;
  // 앞부분만: 샘플을 잘라낸다
  let n = nFull;
  let len = lenFull;
  const S = SC.S;
  if (frac < 0.999) {
    len = lenFull * frac;
    n = 2;
    while (n < nFull && S[n - 1] < len) n++;
    if (n < 3) return;
  }
  const X = SC.X, Y = SC.Y, NX = SC.NX, NY = SC.NY;
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? 0 : i - 1;
    const b = i === n - 1 ? n - 1 : i + 1;
    const tx = X[b] - X[a];
    const ty = Y[b] - Y[a];
    const l = Math.sqrt(tx * tx + ty * ty) || 1;
    NX[i] = ty / l;
    NY[i] = -tx / l;
  }
  const layers = Math.max(1, (o.layers ?? 3) | 0);
  const amp = o.amp ?? 3;
  const total = o.opacity ?? BRUSH.opacity;
  if (total <= 0.002) return;
  const a = layerAlpha(total, layers);
  const lastS = S[n - 1] || len;
  const W = SC.T1, OFF = SC.T2; // prepareLine 의 Chaikin 임시 버퍼는 이미 끝났으므로 재사용
  const w0 = wMin, dw = Math.max(0, wMax - wMin);
  // 폭 일렁임 진폭 배율: amp 0 이면 고정 시드 성분만(에포크와 무관), amp 3 이상이면 에포크 성분 전체
  const kAmp = Math.min(1, amp / 3);
  const idHash = o.idHash !== undefined ? o.idHash | 0 : o.id !== undefined ? hashStr(o.id) : 0;
  ctx.fillStyle = color;
  ctx.globalAlpha = a;
  for (let L = 0; L < layers; L++) {
    const seed = hash32(o.seed | 0, L, 0x71e);
    const fixSeed = hash32(idHash, L, 0x5a1);
    for (let i = 0; i < n; i++) {
      const lam = S[i] / lastS;
      let w = w0 + dw * Math.sin(Math.PI * lam);
      // 끝 테이퍼: 양 끝을 바늘처럼 가늘게 날린다
      const taper = smooth01(lam / 0.24) * smooth01((1 - lam) / 0.24);
      w *= 0.12 + 0.88 * taper;
      if (lam < 0.0001 || lam > 0.9999) w *= 0.25;
      // 폭 일렁임 (고정 시드 성분 + 진폭 비례 에포크 성분) + 중심선 변위
      const nFix = noise1(S[i] / 52, fixSeed + 3);
      const nn = kAmp === 0 ? nFix : kAmp === 1 ? noise1(S[i] / 52, seed + 3) : nFix + (noise1(S[i] / 52, seed + 3) - nFix) * kAmp;
      W[i] = w * (1 + 0.22 * nn) * 0.5;
      OFF[i] = amp > 0 ? amp * 0.8 * noise1((S[i] / BRUSH.coarse) * 1.7, seed) : 0;
    }
    ctx.beginPath();
    ctx.moveTo(X[0] + NX[0] * (OFF[0] + W[0]), Y[0] + NY[0] * (OFF[0] + W[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(X[i] + NX[i] * (OFF[i] + W[i]), Y[i] + NY[i] * (OFF[i] + W[i]));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(X[i] + NX[i] * (OFF[i] - W[i]), Y[i] + NY[i] * (OFF[i] - W[i]));
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
