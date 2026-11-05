// 목(좁은 세로 색면: 피부 + 네이비 그림자)과 어깨(하단을 가로지르는 넓은 2톤 색면).
// 둘 다 roll 을 0.2배만 받는다 (PLAN 4.3). 어깨는 정적 레이어 캐시 대상(roll 이 변하면 서명이 달라져 다시 그려짐).

import { PALETTE } from '../palette.js';
import { CX, pwl, polyStroke, lineStroke } from './geom.js';

const SHOULDER_A = [
  -130, 944, -130, 912, 110, 888, 322, 858, 440, 850, 540, 868, 640, 850, 758, 858, 970, 888, 1210, 912, 1210, 1260, -130, 1260,
];
/** 어깨 윗선(왼→오): 흘러내림 시작점이 이 선에서 출발한다 */
const TOP_LINE = [[-130, 912], [110, 888], [322, 858], [440, 850], [540, 868], [640, 850], [758, 858], [970, 888], [1210, 912]];
export function shoulderTopY(x) {
  return pwl(TOP_LINE, x);
}

const SHOULDER_B = [
  -130, 944, -130, 912, 110, 888, 322, 858, 440, 850, 505, 905, 478, 1010, 372, 1260, -130, 1260,
];

export function emitShoulders(out) {
  out.push(polyStroke('sh.a', PALETTE.navy, SHOULDER_A.slice(), 'sh', 'contour', { rollW: 0.2, ampK: 1.3, spacing: 40 }));
  out.push(polyStroke('sh.b', PALETTE.teal, SHOULDER_B.slice(), 'sh', 'contour', { rollW: 0.2, ampK: 1.3, spacing: 40 }));
  // 어깨 윗선을 따라 흰 손그림 선 (가운데는 목이 덮는다)
  const line = [];
  for (const [x, y] of TOP_LINE) line.push(x, y + 14);
  out.push(lineStroke('sh.line', PALETTE.line, line, 5, 9, 'sh', 'contour', { rollW: 0.2, ampK: 1.2 }));
}

export function emitNeck(out, model) {
  const yTop = 690;
  const skin = [
    CX - 86, yTop, CX + 86, yTop, CX + 94, 790, CX + 108, 880, CX - 112, 880, CX - 98, 790,
  ];
  out.push(polyStroke('neck.skin', PALETTE.orange, skin, 'neck', 'contour', { rollW: 0.2 }));
  // 턱 밑 그림자 (네이비 색면)
  const shade = [CX - 78, 772, CX + 6, 770, CX + 98, 764, CX + 112, 880, CX + 26, 880, CX + 12, 824, CX - 52, 800];
  out.push(polyStroke('neck.shade', PALETTE.navy, shade, 'neck', 'contour', { rollW: 0.2 }));
}
