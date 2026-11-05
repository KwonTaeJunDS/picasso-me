// 부품 공통 기하 상수와 수학 도우미. DOM 에 의존하지 않는다.

// 설계 공간 1080×1152 (PLAN 4.1): 얼굴 중심, 반너비 a, 반높이 b
export const CX = 540;
export const CY = 470;
export const A = 228;
export const B = 317;

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 부호 (0 은 +1 로 취급 — 정면에서 어느 쪽이든 모양이 같으므로 연속) */
export const sgn = (x) => (x < 0 ? -1 : 1);

// 얼굴 세로 기준선 (v: 이마 위 -1 … 턱 +1)
export const V_EYE = -0.13;
export const V_BROW = -0.3;
export const V_NOSE_TOP = -0.28;
export const V_NOSE_BASE = 0.27;
export const V_MOUTH = 0.5;
export const V_EAR = 0.02;

/** 세로 격자 (0.05 간격 41단계). 윤곽·분할선은 이 격자 위에서 계산한다. */
export const GN = 41;
export const VG = Array.from({ length: GN }, (_, i) => (i - 20) / 20);

/** 격자 배열 선형 보간. v ∈ [-1,1] */
export function sampleGrid(arr, v) {
  const f = clamp((v + 1) * 20, 0, GN - 1.000001);
  const i = Math.floor(f);
  const t = f - i;
  return arr[i] + (arr[i + 1] - arr[i]) * t;
}

/** 구간별 선형 노드 보간 [[x,y],...] */
export function pwl(knots, x) {
  if (x <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    if (x <= knots[i][0]) {
      const [x0, y0] = knots[i - 1];
      const [x1, y1] = knots[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return knots[knots.length - 1][1];
}

/** 다각형 부호 있는 면적(shoelace) */
export function signedArea(pts) {
  let a = 0;
  const n = pts.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    a += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
  }
  return a / 2;
}

export const polyArea = (pts) => Math.abs(signedArea(pts));

/** 점-다각형 내부 판정 (짝-홀 규칙) */
export function pointInPoly(x, y, pts) {
  let inside = false;
  const n = pts.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i], yi = pts[2 * i + 1];
    const xj = pts[2 * j], yj = pts[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 다각형 중심(꼭짓점 평균) */
export function centroid(pts) {
  const n = pts.length >> 1;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    sx += pts[2 * i];
    sy += pts[2 * i + 1];
  }
  return n ? [sx / n, sy / n] : [CX, CY];
}

// 스트로크 생성 도우미 -------------------------------------------------------

/**
 * @typedef {Object} Stroke
 * @property {string} id         영구 id (strokes.js 레지스트리)
 * @property {'poly'|'line'|'blob'|'rect'} kind
 * @property {string} color      팔레트 색 (palette.js)
 * @property {number[]} [pts]    poly/line: [x0,y0,x1,y1,...] 설계 공간(1080×1152) 좌표
 * @property {number} [cx] @property {number} [cy] @property {number} [rx] @property {number} [ry] @property {number} [rot]  blob
 * @property {number} [lump]     blob 불규칙도 (고정 시드)
 * @property {number} [wMin] @property {number} [wMax]  line 폭(px)
 * @property {string} part       roll 에 쓰는 시간차 상태 키 ('contour'|'eyes'|'mouth'|'nose'|'ears'|'hair')
 * @property {string} piece      roll 계수를 정하는 조각 이름 (같은 조각은 한 몸처럼 기울어짐)
 * @property {number} rollW      roll 가중 (기본 1, 목·어깨 0.2, 배경 0)
 * @property {number[]} [pivot]  조각 고유 기울임의 축 [x,y] (roll 적용 전 좌표)
 * @property {boolean} [static]  정적 레이어(오프스크린 캐시 대상)
 * 아래는 composePortrait 가 채운다:
 * @property {number} rank       고정 공개 순위 ρ
 * @property {number} vis        가시도 0..1
 * @property {number} seed       스톱모션 시드 hash(epoch, id)
 * @property {number} alpha      누적 불투명도 목표 (기본 0.92)
 */

export function polyStroke(id, color, pts, piece, part = 'contour', extra) {
  return { id, kind: 'poly', color, pts, part, piece, rollW: 1, ...extra };
}

export function lineStroke(id, color, pts, wMin, wMax, piece, part = 'contour', extra) {
  return { id, kind: 'line', color, pts, wMin, wMax, part, piece, rollW: 1, ...extra };
}

export function blobStroke(id, color, cx, cy, rx, ry, rot, piece, part = 'contour', extra) {
  return { id, kind: 'blob', color, cx, cy, rx, ry, rot, lump: 0.1, part, piece, rollW: 1, ...extra };
}
