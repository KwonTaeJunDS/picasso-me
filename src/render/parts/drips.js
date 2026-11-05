// 물감 흘러내림: 어깨 라인에서 아래로 흐르는 세로 줄기 9개 (예약 12칸). 고정 시드 배치 — 떨림만 적용.
// 진짜 물감처럼 위는 번진 자국, 줄기는 가늘고, 끝에 굵은 방울이 맺힌다 (길이 60~260px, 폭 8~22px).

import { PALETTE } from '../palette.js';
import { mulberry32 } from '../noise.js';
import { polyStroke } from './geom.js';
import { shoulderTopY } from './neck.js';

// 색은 흘러나온 색면의 색: 어깨선 위 배경 청색 계열(sky·cobalt·pale)과 목·턱의 피부색(orange·red·pink).
// 2~3개씩 뭉치고 간격은 불규칙하다.
const BLUES = [PALETTE.sky, PALETTE.cobalt, PALETTE.pale];
const SKIN = [PALETTE.orange, PALETTE.red, PALETTE.pink];
// 군집: 중심 x, 개수, 색 계열
const CLUSTERS = [
  { x: 70, n: 2, c: BLUES },
  { x: 215, n: 3, c: BLUES },
  { x: 480, n: 3, c: SKIN }, // 목·턱에서 흐른 피부색
  { x: 745, n: 1, c: BLUES },
  { x: 905, n: 2, c: BLUES },
];

/** 고정 시드로 한 번만 만든다 (예약 12칸 중 11개). */
const DRIPS = (() => {
  const rnd = mulberry32(0xd71b5);
  const list = [];
  let i = 0;
  for (const cl of CLUSTERS) {
    let x = cl.x - ((cl.n - 1) * 24) / 2;
    for (let k = 0; k < cl.n; k++) {
      x += 14 + rnd() * 30;
      const w = 10 + rnd() * 18; // 줄기 쪽 폭 10~28
      const len = 40 + Math.pow(rnd(), 1.4) * 260; // 40~300, 짧은 것이 더 많다
      const skin = cl.c === SKIN;
      const y0 = skin ? 835 + rnd() * 20 : shoulderTopY(x) - 16 + rnd() * 10; // 출처 색면 위에서 시작
      list.push({
        i: i++,
        x,
        y0,
        len,
        stem: Math.max(8, w * 0.55),
        head: w * 1.6 + 16 + rnd() * 14, // 출처에 붙은 넓은 뿌리
        bulb: w * 0.5 + 3, // 끝 눈물방울 반지름
        sway: (rnd() - 0.5) * 22,
        color: cl.c[Math.floor(rnd() * cl.c.length)],
      });
    }
  }
  return list;
})();

function dripPolygon(d) {
  const steps = 9;
  const left = [];
  const right = [];
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    const cx = d.x + d.sway * Math.sin(f * 2.4) * 0.6;
    const y = d.y0 + d.len * f;
    // 위쪽 번짐 → 가는 줄기 (아래로 갈수록 아주 조금 굵어지며 방울로 이어진다)
    const headK = f < 0.22 ? Math.pow(1 - f / 0.22, 2) : 0;
    const hw = 0.5 * (d.stem * (1 + 0.25 * f) + (d.head - d.stem) * headK);
    left.push(cx - hw, y);
    right.push(cx + hw, y);
  }
  const endX = d.x + d.sway * Math.sin(2.4) * 0.6;
  const endY = d.y0 + d.len;
  // 끝 방울: 줄기 끝에서 부풀었다가 둥글게 닫힌다
  const bulb = [];
  const br = d.bulb;
  for (let k = 0; k <= 6; k++) {
    const th = Math.PI * (k / 6); // 왼쪽 → 아래 → 오른쪽
    bulb.push(endX - Math.cos(th) * br, endY + br * 0.55 + Math.sin(th) * br * 1.15);
  }
  const pts = [];
  for (let k = 0; k < left.length; k += 2) pts.push(left[k], left[k + 1]);
  for (let k = 0; k < bulb.length; k += 2) pts.push(bulb[k], bulb[k + 1]);
  for (let k = right.length - 2; k >= 0; k -= 2) pts.push(right[k], right[k + 1]);
  return pts;
}

export function emitDrips(out) {
  for (const d of DRIPS) {
    out.push(
      polyStroke(`drip.${d.i}`, d.color, dripPolygon(d), 'sh', 'contour', {
        rollW: 0.2,
        ampK: 0.5, // 가는 줄기는 떨림을 줄여 형태가 무너지지 않게
        spacing: 12,
      }),
    );
  }
}
