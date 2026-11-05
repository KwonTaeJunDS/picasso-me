// 배경: 항상 불투명한 평면 바탕 #4A8FF0 + 큰 붓터치 색면 5개 (코발트·연파랑·하늘).
// 정적 레이어(오프스크린 캐시 대상). 고정 좌표 — 떨림만 brush 에서 적용된다.
// 차가운 반쪽(화면 오른쪽) 뒤는 코발트로 대비, 따뜻한 반쪽(왼쪽) 뒤는 연파랑.

import { PALETTE } from '../palette.js';
import { polyStroke, lineStroke } from './geom.js';

/** 캔버스(1080×1152) 밖으로 충분히 번지도록 여유를 둔 색면 */
const PLANES = [
  // bg.0 연파랑: 왼쪽 큰 면 (따뜻한 반쪽 뒤)
  {
    id: 'bg.0',
    color: PALETTE.pale,
    pts: [-90, -90, 330, -90, 560, -90, 610, 150, 575, 330, 618, 560, 560, 760, 585, 960, 540, 1250, -90, 1250],
  },
  // bg.1 코발트: 오른쪽 큰 면 (차가운 반쪽 뒤)
  {
    id: 'bg.1',
    color: PALETTE.cobalt,
    pts: [545, -90, 1170, -90, 1170, 1250, 520, 1250, 560, 960, 505, 760, 566, 560, 520, 330, 560, 150],
  },
  // bg.2 하늘: 오른쪽 위 쐐기 (코발트 위로 바탕색이 비침)
  {
    id: 'bg.2',
    color: PALETTE.sky,
    pts: [780, -90, 1170, -90, 1170, 360, 1020, 250, 880, 110],
  },
  // bg.3 코발트: 왼쪽 아래 쐐기
  {
    id: 'bg.3',
    color: PALETTE.cobalt,
    pts: [-90, 640, 120, 600, 300, 720, 210, 880, 40, 960, -90, 1010],
  },
  // bg.4 연파랑: 오른쪽 아래 쐐기 (코발트 위)
  {
    id: 'bg.4',
    color: PALETTE.pale,
    pts: [860, 690, 1170, 560, 1170, 1010, 1010, 940, 900, 840],
  },
];

// 붓 질감: 반투명 긴 스윕 3개 + 마른 붓 자국 3개 (색면 위에 겹쳐 평평한 벡터 느낌을 깬다)
const BRUSH_MARKS = [
  { id: 'bgs.0', color: PALETTE.pale, pts: [540, 150, 720, 112, 900, 156, 1130, 118], w: [26, 54], a: 0.42 },
  { id: 'bgs.1', color: PALETTE.cobalt, pts: [-60, 310, 150, 272, 330, 306, 530, 250], w: [24, 50], a: 0.38 },
  { id: 'bgs.2', color: PALETTE.sky, pts: [550, 720, 760, 762, 940, 714, 1140, 770], w: [22, 46], a: 0.45 },
  { id: 'bgs.3', color: PALETTE.pale, pts: [610, 402, 800, 378, 1000, 412, 1120, 396], w: [3, 7], a: 0.7 },
  { id: 'bgs.4', color: PALETTE.cobalt, pts: [-20, 520, 140, 544, 300, 510, 470, 540], w: [4, 8], a: 0.6 },
  { id: 'bgs.5', color: PALETTE.pale, pts: [620, 566, 820, 594, 1030, 560, 1130, 584], w: [3, 6], a: 0.6 },
];

export function emitBackground(out) {
  out.push({
    id: 'bg.base',
    kind: 'rect',
    color: PALETTE.sky,
    x: -40,
    y: -40,
    w: 1160,
    h: 1232,
    part: 'contour',
    piece: 'bg',
    rollW: 0,
    static: true,
    opaque: true, // 항상 불투명 (페이드 가시도와 무관)
  });
  for (const p of PLANES) {
    out.push(polyStroke(p.id, p.color, p.pts, 'bg', 'contour', { rollW: 0, static: true, ampK: 1.4, spacing: 44 }));
  }
  for (const m of BRUSH_MARKS) {
    out.push(lineStroke(m.id, m.color, m.pts, m.w[0], m.w[1], 'bg', 'contour', { rollW: 0, static: true, ampK: 1.2, alphaK: m.a }));
  }
}
