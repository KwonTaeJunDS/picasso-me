// 머리카락: 둥근 붓터치 덩어리 7개 (예약 9칸) — 청록·초록·네이비, 머리 위·옆.
// 뒷머리(얼굴 뒤)와 앞머리(이마 위)로 나뉜다. yaw 시 뒤통수 쪽으로 -t·0.2a (τ250), 끄덕임 시 약간 아래로.

import { PALETTE } from '../palette.js';
import { CX, CY, A, B, clamp, smoothstep, sgn, blobStroke, lineStroke } from './geom.js';

// dx, dy: 얼굴 중심 기준 px / rx, ry: 반지름 / yaw: 뒤통수 이동 가중 / front: 앞머리 여부
const HAIR = [
  { i: 0, dx: 55, dy: -332, rx: 192, ry: 98, rot: 0.12, color: PALETTE.navy, yaw: 0.6, front: false },
  { i: 1, dx: -168, dy: -262, rx: 172, ry: 126, rot: -0.4, color: PALETTE.teal, yaw: 1.0, front: false },
  { i: 2, dx: 226, dy: -214, rx: 118, ry: 152, rot: 0.34, color: PALETTE.navy, yaw: 1.0, front: false },
  { i: 3, dx: -252, dy: -128, rx: 86, ry: 172, rot: 0.26, color: PALETTE.teal, yaw: 0.8, front: false, lock: -1 },
  { i: 4, dx: 262, dy: -64, rx: 50, ry: 118, rot: -0.1, color: PALETTE.navy, yaw: 0.8, front: false, lock: 1 },
  { i: 7, dx: -20, dy: -296, rx: 120, ry: 70, rot: -0.08, color: PALETTE.teal, yaw: 0.8, front: false },
  { i: 5, dx: -138, dy: -296, rx: 98, ry: 50, rot: -0.5, color: PALETTE.green, yaw: 0.5, front: true },
  { i: 6, dx: 62, dy: -316, rx: 150, ry: 44, rot: 0.1, color: PALETTE.teal, yaw: 0.5, front: true },
  { i: 8, dx: 178, dy: -282, rx: 56, ry: 38, rot: 0.5, color: PALETTE.green, yaw: 0.5, front: true },
];

export const HAIR_BACK = HAIR.filter((h) => !h.front);
export const HAIR_FRONT = HAIR.filter((h) => h.front);

/** 블롭의 현재 위치·크기 (yaw/pitch 이동 포함) */
function hairPlacement(h, hairState) {
  const t = clamp(hairState.t, -1, 1);
  const p = clamp(hairState.p, -1, 1);
  let x = CX + h.dx - t * 0.2 * A * h.yaw;
  const y = CY + h.dy + 0.1 * B * p * (h.front ? 1 : 0.5);
  let rx = h.rx;
  // 코가 향하는 쪽 옆머리 덩어리는 옆모습이 될수록 얼굴 뒤로 말려 들어가 윤곽(코·입술)을 가리지 않는다
  if (h.lock && h.lock === sgn(t)) {
    const hide = smoothstep(0.15, 0.95, Math.abs(t));
    x -= h.lock * 0.42 * Math.abs(h.dx) * hide;
    rx *= 1 - 0.55 * hide;
  }
  return { x, y, rx };
}

function hairStroke(h, hairState) {
  const { x, y, rx } = hairPlacement(h, hairState);
  return blobStroke(`hair.${h.i}`, h.color, x, y, rx, h.ry, h.rot, `hair.${h.i}`, 'hair', {
    lump: 0.2,
    pivot: [x, y],
    rollW: 0.85,
  });
}

export function emitHairBack(out, hairState) {
  for (const h of HAIR_BACK) out.push(hairStroke(h, hairState));
}

export function emitHairFront(out, hairState) {
  for (const h of HAIR_FRONT) out.push(hairStroke(h, hairState));
}

/** 앞머리 덩어리 위 흰 붓 자국 (손그림 하이라이트). 앞머리 블롭을 따라 움직인다. */
export function emitHairHighlights(out, hairState) {
  HAIR_FRONT.slice(0, 2).forEach((h, k) => {
    const { x, y, rx } = hairPlacement(h, hairState);
    const cr = Math.cos(h.rot), sr = Math.sin(h.rot);
    const pts = [];
    // 위쪽 가장자리 안쪽으로 휘는 호
    for (let j = 0; j <= 4; j++) {
      const th = ((-155 + (j * 70) / 4) * Math.PI) / 180;
      const ex = rx * 0.66 * Math.cos(th);
      const ey = h.ry * 0.6 * Math.sin(th);
      pts.push(x + ex * cr - ey * sr, y + ex * sr + ey * cr);
    }
    out.push(lineStroke(`line.hair${k}`, PALETTE.line, pts, 4, 8, `hair.${h.i}`, 'hair', { pivot: [x, y], rollW: 0.85, ampK: 0.8 }));
  });
}
