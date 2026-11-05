// 고정 스트로크 레지스트리 (PLAN 4.7).
// 논리 스트로크마다 영구 id 와 고정 공개 순위 ρ ∈ (0,1) 를 갖는다.
//  - 순서: 배경 → 윤곽 → 색면 → 이목구비, 카테고리 안에서도 고정 순서.
//  - 이번 프레임에 그리지 않는 부품(예: 사라진 눈, 6~9번 머리카락)도 순위를 예약해 둔다.
//  - 붓터치 겹수(strokeLayers)는 순위와 무관하다. 열린 눈·감긴 눈은 같은 id·ρ 를 쓴다.
// 즉 ρ 는 id 에만 의존하며, 프레임마다 몇 개가 그려지는지와 무관하게 항상 같다.

import { hashStr } from './noise.js';

export const CATEGORY = Object.freeze({ BG: 0, CONTOUR: 1, PLANE: 2, FEATURE: 3 });

const seq = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}.${i}`);

/** [카테고리, id 목록] — 이 순서가 곧 공개 순서(인)이며 역순이 사라지는 순서(아웃)다. */
const GROUPS = [
  [CATEGORY.BG, ['bg.base', ...seq('bg', 5), ...seq('bgs', 6), ...seq('drip', 12)]],
  [
    CATEGORY.CONTOUR,
    [
      'sh.a', 'sh.b', 'sh.line', 'neck.skin',
      ...seq('hair', 9),
      'face.back', 'face.L', 'face.R', 'ear.L', 'ear.R', 'ear.inL', 'ear.inR', 'line.outL', 'line.outR',
    ],
  ],
  [
    CATEGORY.PLANE,
    ['neck.shade', 'L.fore', 'L.cheek', 'L.jaw', 'R.fore', 'R.shade', 'R.cheek', 'R.jaw'],
  ],
  [
    CATEGORY.FEATURE,
    [
      'line.split', 'line.cheekL', 'line.cheekR', 'line.fore', 'line.chin', 'line.hair0', 'line.hair1',
      'eyeL.brow', 'eyeL.white', 'eyeL.iris', 'eyeL.lid',
      'eyeR.brow', 'eyeR.white', 'eyeR.iris', 'eyeR.lid',
      'nose.plane', 'nose.shade', 'nose.bridge', 'nose.nostrilL', 'nose.nostrilR',
      'mouth.in', 'mouth.up', 'mouth.lo', 'mouth.hl',
    ],
  ],
];

const ORDERED = [];
const CAT_OF = new Map();
for (const [cat, ids] of GROUPS) {
  for (const id of ids) {
    if (CAT_OF.has(id)) throw new Error(`중복 스트로크 id: ${id}`);
    CAT_OF.set(id, cat);
    ORDERED.push(id);
  }
}

export const STROKE_IDS = Object.freeze(ORDERED.slice());
export const STROKE_COUNT = STROKE_IDS.length;

const RANK = new Map();
const HASH = new Map();
STROKE_IDS.forEach((id, i) => {
  RANK.set(id, (i + 0.5) / STROKE_COUNT);
  HASH.set(id, hashStr(id));
});

/** 고정 공개 순위 ρ. 등록되지 않은 id 는 맨 끝(이목구비 이후)으로 취급한다. */
export function rankOf(id) {
  const r = RANK.get(id);
  return r === undefined ? 1 : r;
}

export function categoryOf(id) {
  const c = CAT_OF.get(id);
  return c === undefined ? CATEGORY.FEATURE : c;
}

/** id 해시 (시드·roll 계수용). */
export function idHashOf(id) {
  const h = HASH.get(id);
  return h === undefined ? hashStr(id) : h;
}

export function isRegistered(id) {
  return RANK.has(id);
}
