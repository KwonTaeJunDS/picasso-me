// 얼굴: 바탕(뒤), 분할선으로 나뉜 화면 왼쪽(따뜻함)/오른쪽(차가움) 반쪽, 색면(뺨·관자놀이·그림자), 흰 선.
// 반쪽은 화면 기준(L/R)이라 t 부호가 바뀌어도 색이 튀지 않는다. 옆모습 쪽은 model 의 윤곽이 결정한다.
// 색면·선은 반쪽 안의 상대 좌표 (λ,v) 로 정의 — 반쪽이 좁아지면 같이 좁아지고 너무 좁으면 생략된다.

import { PALETTE } from '../palette.js';
import { A, GN, VG, clamp, smoothstep, polyArea, polyStroke, lineStroke } from './geom.js';

const OVERLAP_U = 0.02; // L 이 분할선 너머로 살짝 겹쳐 틈이 없게 (약 4.5px)

function ringPoints(model, lb, rb) {
  const pts = [];
  for (let i = 0; i < GN; i++) pts.push(model.x(lb[i]), model.ys[i]);
  for (let i = GN - 1; i >= 0; i--) pts.push(model.x(rb[i]), model.ys[i]);
  return pts;
}

/** 얼굴 뒤 바탕 + 두 반쪽. 반쪽 경계 배열도 돌려 색면·선·부품이 쓴다. */
export function emitFaceBase(out, model) {
  const rbL = new Float64Array(GN);
  for (let i = 0; i < GN; i++) rbL[i] = clamp(model.sp[i] + OVERLAP_U, model.eL[i], model.eR[i]);
  out.push(polyStroke('face.back', PALETTE.orange, ringPoints(model, model.eL, model.eR), 'face.back', 'contour', { pivot: [model.x(0), model.y(0)], layers: 1 }));
  out.push(polyStroke('face.L', PALETTE.red, ringPoints(model, model.eL, rbL), 'face.L', 'contour', { pivot: regionPivot(model, 'L') }));
  out.push(polyStroke('face.R', PALETTE.pale, ringPoints(model, model.spc, model.eR), 'face.R', 'contour', { pivot: regionPivot(model, 'R') }));
}

function regionPivot(model, region) {
  const [l, r] = model.bounds(region, 0.05);
  return [model.x(0.5 * (l + r)), model.y(0.05)];
}

/** (λ,v) 목록 → 설계 공간 점. region 'L'|'R'. */
function regionPoints(model, region, uv) {
  const pts = [];
  for (let k = 0; k < uv.length; k += 2) {
    const lam = uv[k];
    const v = uv[k + 1];
    const [l, r] = model.bounds(region, v);
    pts.push(model.x(l + lam * (r - l)), model.y(v));
  }
  return pts;
}

/** 해당 반쪽의 v 높이에서 폭(px) */
function regionWidthPx(model, region, v) {
  const [l, r] = model.bounds(region, v);
  return (r - l) * A;
}

// 색면 정의: id, 반쪽, 색, (λ,v) 꼭짓점 — 각진 면으로 쪼갠 뺨·관자놀이·턱 그림자
const PLANES = [
  { id: 'L.fore', region: 'L', color: PALETTE.orange, uv: [0.0, -0.56, 0.72, -0.62, 1.0, -0.36, 0.5, -0.24, 0.0, -0.2] },
  { id: 'L.cheek', region: 'L', color: PALETTE.pink, uv: [0.06, 0.1, 0.7, 0.16, 0.76, 0.55, 0.3, 0.64, 0.0, 0.42] },
  { id: 'L.jaw', region: 'L', color: PALETTE.navy, uv: [0.0, 0.72, 0.62, 0.78, 0.5, 1.0, 0.0, 1.0] },
  { id: 'R.fore', region: 'R', color: PALETTE.sky, uv: [0.0, -0.6, 0.9, -0.56, 1.0, -0.22, 0.3, -0.26] },
  { id: 'R.shade', region: 'R', color: PALETTE.navy, uv: [0.56, -0.18, 1.0, -0.08, 1.0, 0.72, 0.5, 0.92, 0.34, 0.42] },
  { id: 'R.cheek', region: 'R', color: PALETTE.pink, uv: [0.22, 0.16, 0.5, 0.06, 0.8, 0.3, 0.62, 0.58, 0.28, 0.46] },
  { id: 'R.jaw', region: 'R', color: PALETTE.sky, uv: [0.0, 0.74, 0.55, 0.78, 0.4, 0.98, 0.0, 0.98] },
];

const MIN_AREA = 700; // px² 보다 작으면 그리지 않는다 (그 위로는 불투명도가 부드럽게 올라온다)
const MIN_WIDTH = 16; // 반쪽이 이보다 좁으면 그리지 않는다

export function emitFacePlanes(out, model) {
  for (const p of PLANES) {
    // 반쪽이 거의 없으면 생략 (순위는 레지스트리가 예약). 문턱 근처에서는 불투명도를 줄여 갑자기 튀어나오지 않게 한다
    const width = regionWidthPx(model, p.region, 0.2);
    if (width < MIN_WIDTH) continue;
    const pts = regionPoints(model, p.region, p.uv);
    const area = polyArea(pts);
    if (area < MIN_AREA) continue;
    const alphaK = smoothstep(MIN_AREA, MIN_AREA * 2.2, area) * smoothstep(MIN_WIDTH, MIN_WIDTH * 2.5, width);
    out.push(polyStroke(p.id, p.color, pts, p.region === 'L' ? 'face.L' : 'face.R', 'contour', { pivot: regionPivot(model, p.region), alphaK }));
  }
}

// 흰 선 (손그림, 끝 테이퍼) ----------------------------------------------------

const LINES = [
  { id: 'line.cheekL', region: 'L', uv: [0.04, 0.2, 0.36, 0.38, 0.62, 0.42], w: [4, 8] },
  { id: 'line.cheekR', region: 'R', uv: [0.62, 0.5, 0.82, 0.4, 0.97, 0.3], w: [4, 8] },
  { id: 'line.fore', region: 'L', uv: [0.1, -0.6, 0.55, -0.66, 0.96, -0.55], w: [4, 7] },
  { id: 'line.chin', region: 'R', uv: [0.14, 0.84, 0.5, 0.88, 0.9, 0.81], w: [4, 7] },
];

function edgeLinePts(model, arr, v0, v1, step) {
  const pts = [];
  for (let i = 0; i < GN; i += step) {
    const v = VG[i];
    if (v < v0 - 1e-9 || v > v1 + 1e-9) continue;
    pts.push(model.x(arr[i]), model.ys[i]);
  }
  return pts;
}

/** 턱선: 귀 아래에서 턱까지 양쪽 윤곽을 따라 (코·입 아래에 깔린다) */
export function emitFaceOutline(out, model) {
  const jawL = edgeLinePts(model, model.eL, 0.12, 0.97, 2);
  const jawR = edgeLinePts(model, model.eR, 0.12, 0.97, 2);
  if (jawL.length >= 6) out.push(lineStroke('line.outL', PALETTE.line, jawL, 6, 10, 'face.L', 'contour', { pivot: regionPivot(model, 'L') }));
  if (jawR.length >= 6) out.push(lineStroke('line.outR', PALETTE.line, jawR, 6, 10, 'face.R', 'contour', { pivot: regionPivot(model, 'R') }));
}

/** 세로 분할선(코 높이에서 꺾임)과 색면 사이 선들 */
export function emitFaceLines(out, model) {
  const split = edgeLinePts(model, model.spc, -0.62, 0.97, 2);
  out.push(lineStroke('line.split', PALETTE.line, split, 5, 10, 'face.R', 'contour', { pivot: regionPivot(model, 'R') }));

  for (const L of LINES) {
    const width = regionWidthPx(model, L.region, (L.uv[1] + L.uv[3]) * 0.5);
    if (width < 34) continue;
    const pts = regionPoints(model, L.region, L.uv);
    out.push(lineStroke(L.id, PALETTE.line, pts, L.w[0], L.w[1], L.region === 'L' ? 'face.L' : 'face.R', 'contour', { pivot: regionPivot(model, L.region), alphaK: smoothstep(34, 80, width) }));
  }
}
