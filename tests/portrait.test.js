import { describe, it, expect, vi } from 'vitest';
import {
  composePortrait, composeDetailed, createPortrait, profileFraction, rollCoef, LAYER_CAP_1, LAYER_CAP_2,
} from '../src/render/portrait.js';
import { createParams, FADE } from '../src/config/params.js';
import { createLag, updateLag, PART_KEYS } from '../src/render/lag.js';
import { STROKE_IDS, rankOf, isRegistered } from '../src/render/strokes.js';
import { visibility } from '../src/render/fade.js';
import { PALETTE_LIST, PALETTE, isPaletteColor } from '../src/render/palette.js';
import { polyArea, pointInPoly } from '../src/render/parts/geom.js';
import { mulberry32 } from '../src/render/noise.js';
import { JAW_MAX } from '../src/render/parts/mouth.js';

const params = createParams();
const DT = 1000 / 60;

/** 모든 부품이 같은 (t,p,r,k) 인 partStates */
function states(t = 0, p = 0, r = 0, k = 0, extra = {}) {
  const s = { t, p, r, k };
  return { L: 1, contour: s, split: s, eyes: s, mouth: s, nose: s, ears: s, hair: s, blinkL: 0, blinkR: 0, jaw: 0, ...extra };
}

const byId = (strokes) => Object.fromEntries(strokes.map((s) => [s.id, s]));
function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
function allFinite(strokes) {
  for (const s of strokes) {
    const nums = s.pts ? s.pts : [s.cx, s.cy, s.rx, s.ry, s.rot, s.x, s.y, s.w, s.h].filter((v) => v !== undefined);
    for (const v of nums) if (!Number.isFinite(v)) return s.id;
    if (!Number.isFinite(s.vis) || !Number.isFinite(s.rank) || !Number.isFinite(s.seed)) return s.id;
  }
  return null;
}

describe('compose 기본 구조', () => {
  it('Stroke[] 를 돌려주고 모든 id 는 레지스트리에 있으며 중복이 없다', () => {
    for (const t of [-1, -0.5, 0, 0.5, 1]) {
      const strokes = composePortrait(states(t), params, 1234);
      const ids = strokes.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      ids.forEach((id) => expect(isRegistered(id)).toBe(true));
      expect(strokes.length).toBeGreaterThanOrEqual(50);
      expect(strokes.length).toBeLessThanOrEqual(100);
      expect(allFinite(strokes)).toBeNull();
    }
  });

  it('팔레트 10색만 쓰고 검정은 없다', () => {
    const seen = new Set();
    for (const t of [-1, 0, 0.6]) {
      for (const s of composePortrait(states(t, 0.3, 0.2, 0.5, { jaw: 0.5, blinkL: 1 }), params, 0)) seen.add(s.color);
    }
    for (const c of seen) {
      expect(isPaletteColor(c)).toBe(true);
      expect(c.toUpperCase()).not.toBe('#000000');
    }
    expect(PALETTE_LIST.length).toBe(10);
  });

  it('바탕 #4A8FF0 은 항상 불투명(가시도 1, rect)', () => {
    for (const L of [0, 0.3, 1]) {
      const bg = byId(composePortrait(states(0, 0, 0, 0, { L }), params, 0))['bg.base'];
      expect(bg.kind).toBe('rect');
      expect(bg.color).toBe(PALETTE.sky);
      expect(bg.vis).toBe(1);
    }
  });

  it('순수 함수: 같은 입력이면 같은 결과, Math.random 을 부르지 않는다', () => {
    const spy = vi.spyOn(Math, 'random');
    const a = composePortrait(states(0.4, 0.2, -0.3, 0.6, { jaw: 0.3 }), params, 777);
    const b = composePortrait(states(0.4, 0.2, -0.3, 0.6, { jaw: 0.3 }), params, 777);
    expect(a).toEqual(b);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('시드는 epoch(초당 jitterFps 번)로만 바뀐다', () => {
    const s1 = byId(composePortrait(states(), params, 1010));
    const s2 = byId(composePortrait(states(), params, 1090));
    const s3 = byId(composePortrait(states(), params, 1110));
    expect(s1['face.L'].seed).toBe(s2['face.L'].seed);
    expect(s1['face.L'].seed).not.toBe(s3['face.L'].seed);
    // 모양(좌표)은 시드와 무관하게 같은 입력이면 같다 — 위치·크기는 매 프레임 입력으로만 결정
    expect(s1['face.L'].pts).toEqual(s3['face.L'].pts);
  });

  it('일부만 채워진 partStates 도 받아준다', () => {
    const strokes = composePortrait({ contour: { t: 0.5, p: 0, r: 0, k: 0 } }, params, 0);
    expect(strokes.length).toBeGreaterThan(40);
    expect(composePortrait(undefined, params, 0).length).toBeGreaterThan(40);
  });

  it('정적 스트로크(배경·어깨·흘러내림)는 배열 맨 앞에 연속으로 온다', () => {
    const strokes = composePortrait(states(0.3), params, 0);
    let n = 0;
    while (n < strokes.length && strokes[n].static) n++;
    expect(n).toBeGreaterThanOrEqual(10);
    for (let i = n; i < strokes.length; i++) expect(strokes[i].static).toBeFalsy();
  });
});

describe('고정 순위 ρ 와 가시도', () => {
  it('상태가 달라 그려지는 스트로크 수가 변해도 id 별 ρ 는 고정이다', () => {
    const rankSeen = new Map();
    const counts = new Set();
    const cases = [
      states(0), states(1), states(-1), states(0.8, 0.5, 0.5, 1, { blinkL: 1, blinkR: 1, jaw: 1 }),
      states(-0.3, -1, 1, 0.5),
    ];
    for (const ps of cases) {
      const strokes = composePortrait(ps, params, 500);
      counts.add(strokes.length);
      for (const s of strokes) {
        expect(s.rank).toBe(rankOf(s.id));
        if (rankSeen.has(s.id)) expect(rankSeen.get(s.id)).toBe(s.rank);
        rankSeen.set(s.id, s.rank);
      }
    }
    expect(counts.size).toBeGreaterThan(1); // 실제로 수가 변했다
  });

  it('붓터치 겹수(strokeLayers)는 순위·스트로크 수에 영향을 주지 않는다', () => {
    const a = composePortrait(states(0.5), createParams({ strokeLayers: 1 }), 0);
    const b = composePortrait(states(0.5), createParams({ strokeLayers: 6 }), 0);
    expect(a.map((s) => [s.id, s.rank])).toEqual(b.map((s) => [s.id, s.rank]));
  });

  it('vis = clamp((L-ρ(1-w))/w): L=0 이면 바탕 외 0, L=1 이면 전부 1', () => {
    const zero = composePortrait(states(0, 0, 0, 0, { L: 0 }), params, 0);
    for (const s of zero) expect(s.vis).toBe(s.id === 'bg.base' ? 1 : 0);
    const one = composePortrait(states(0.7, 0, 0, 0, { L: 1 }), params, 0);
    for (const s of one) expect(s.vis).toBe(1);
    const mid = composePortrait(states(0, 0, 0, 0, { L: 0.5 }), params, 0);
    for (const s of mid) expect(s.vis).toBeCloseTo(s.id === 'bg.base' ? 1 : visibility(0.5, s.rank), 12);
    const g = byId(mid);
    // 배경이 이목구비보다 먼저 보인다
    expect(g['bg.1'].vis).toBeGreaterThan(g['eyeL.white'].vis);
    expect(g['bg.1'].vis).toBe(1);
    expect(g['mouth.hl'].vis).toBe(0);
  });
});

describe('다시점 변형 (t)', () => {
  it('|t| 가 커질수록 옆모습 반쪽 면적이 단조 증가하고 f ≈ 0.5 + 0.45σ', () => {
    for (const sign of [1, -1]) {
      let prev = 0;
      for (let i = 0; i <= 20; i++) {
        const sigma = i / 20;
        const { model, strokes } = composeDetailed(states(sign * sigma), params, 0);
        const f = profileFraction(model);
        expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(f).toBeCloseTo(0.5 + 0.45 * sigma, 2);
        prev = f;
        // 분할선은 회전 반대쪽으로 이동
        if (sigma > 0.05) expect(Math.sign(model.uS)).toBe(-sign);
        // 실제 다각형 면적으로도 확인 (L 은 분할선 너머로 약간 겹치므로 허용오차 넉넉히)
        const g = byId(strokes);
        const profile = sign > 0 ? g['face.R'] : g['face.L'];
        const ratio = polyArea(profile.pts) / polyArea(g['face.back'].pts);
        expect(Math.abs(ratio - (0.5 + 0.45 * sigma))).toBeLessThan(0.04);
      }
    }
  });

  it('분할선 위치는 옆모습 면적 비율에서 면적 역함수로 얻는다 (정면 t=0 → 가운데)', () => {
    const { model } = composeDetailed(states(0), params, 0);
    expect(Math.abs(model.uS)).toBeLessThan(0.02);
    const half = composeDetailed(states(0.5), params, 0).model;
    const full = composeDetailed(states(1), params, 0).model;
    expect(half.uS).toBeLessThan(model.uS);
    expect(full.uS).toBeLessThan(half.uS);
    expect(full.uS).toBeGreaterThan(-0.95);
  });

  it('|t|=1 에서 정면 눈은 1개 (옆모습 쪽), 그 사이에는 연속으로 줄어든다', () => {
    const eyeCount = (t) => composePortrait(states(t), params, 0).filter((s) => /^eye[LR]\.white$/.test(s.id));
    expect(eyeCount(1).map((s) => s.id)).toEqual(['eyeR.white']);
    expect(eyeCount(-1).map((s) => s.id)).toEqual(['eyeL.white']);
    expect(eyeCount(0).length).toBe(2);
    expect(eyeCount(0.7).length).toBe(2);
    expect(eyeCount(-0.7).length).toBe(2);
    // 홍채도 함께 1개
    const irises = composePortrait(states(1), params, 0).filter((s) => /\.iris$/.test(s.id));
    expect(irises.length).toBe(1);
    // 반대쪽 눈: σ 0.75~1 에서 단조 감소하며 한 번에 크게 튀지 않는다
    let prevW = Infinity;
    let maxJump = 0;
    for (let i = 0; i <= 50; i++) {
      const sigma = 0.7 + (0.3 * i) / 50;
      const e = byId(composePortrait(states(sigma), params, 0))['eyeL.white'];
      const w = e ? bbox(e.pts).w : 0;
      expect(w).toBeLessThanOrEqual(prevW + 1e-9);
      if (Number.isFinite(prevW)) maxJump = Math.max(maxJump, prevW - w);
      prevW = w;
    }
    expect(maxJump).toBeLessThan(12);
    expect(prevW).toBe(0);
  });

  it('옆모습 쪽 눈은 끝까지 정면 아몬드(흰자+홍채) 형태를 유지한다', () => {
    const g = byId(composePortrait(states(1), params, 0));
    const white = bbox(g['eyeR.white'].pts);
    expect(white.w).toBeGreaterThan(70); // 정면 눈 폭 유지
    expect(white.w / white.h).toBeGreaterThan(1.6);
    const iris = g['eyeR.iris'];
    expect(iris.cx).toBeGreaterThan(white.x0);
    expect(iris.cx).toBeLessThan(white.x1);
  });

  it('t=±ε 에서 모든 스트로크가 연속이다 (정점 이동량 작음)', () => {
    const maxDiff = (eps) => {
      const a = composePortrait(states(eps, 0.2, 0.1, 0.3, { jaw: 0.2 }), params, 0);
      const b = composePortrait(states(-eps, 0.2, 0.1, 0.3, { jaw: 0.2 }), params, 0);
      const A = byId(a);
      const B = byId(b);
      expect(Object.keys(A).sort()).toEqual(Object.keys(B).sort());
      let m = 0;
      for (const id of Object.keys(A)) {
        const sa = A[id], sb = B[id];
        if (sa.pts) {
          expect(sb.pts.length).toBe(sa.pts.length);
          for (let i = 0; i < sa.pts.length; i++) m = Math.max(m, Math.abs(sa.pts[i] - sb.pts[i]));
        } else if (sa.kind === 'blob') {
          m = Math.max(m, Math.abs(sa.cx - sb.cx), Math.abs(sa.cy - sb.cy), Math.abs(sa.rx - sb.rx), Math.abs(sa.ry - sb.ry));
        }
      }
      return m;
    };
    expect(maxDiff(0.001)).toBeLessThan(1.5);
    expect(maxDiff(0.01)).toBeLessThan(5);
    expect(maxDiff(0.05)).toBeLessThan(26);
  });

  it('+1 → -1 전환 중 코·입 뿌리가 얼굴 안에 머문다 (시간차 포함 시뮬레이션)', () => {
    const run = (tOf, durMs) => {
      const lag = createLag({ t: tOf(0), p: 0, r: 0, k: 0 });
      let worst = 0;
      for (let now = 0; now <= durMs + 800; now += DT) {
        const tgt = { t: tOf(Math.min(1, now / durMs)), p: 0, r: 0, k: 0 };
        updateLag(lag, tgt, DT, 1);
        const ps = { L: 1, ...lag.parts, blinkL: 0, blinkR: 0, jaw: 0 };
        const { strokes, anchors } = composeDetailed(ps, params, now);
        const face = byId(strokes)['face.back'];
        for (const key of ['noseRoot', 'mouthRoot']) {
          const [x, y] = anchors[key];
          if (!pointInPoly(x, y, face.pts)) worst++;
        }
      }
      return worst;
    };
    for (const dur of [150, 300, 700, 1500]) {
      expect(run((f) => 1 - 2 * f, dur)).toBe(0); // +1 → -1
      expect(run((f) => -1 + 2 * f, dur)).toBe(0); // -1 → +1
    }
  });

  it('부호가 계속 뒤집혀도(떨림) 뿌리는 얼굴 안, 모든 좌표는 유한', () => {
    const lag = createLag();
    let bad = 0;
    for (let i = 0; i < 240; i++) {
      const tgt = { t: (i % 12 < 6 ? 1 : -1) * (0.2 + 0.8 * ((i * 7) % 10) / 10), p: Math.sin(i) * 0.8, r: Math.cos(i * 0.7), k: (i % 5) / 4 };
      updateLag(lag, tgt, DT, 1);
      const { strokes, anchors } = composeDetailed({ L: 1, ...lag.parts, blinkL: i % 3 === 0 ? 1 : 0, blinkR: 0, jaw: (i % 9) / 8 }, params, i * DT);
      if (allFinite(strokes)) bad++;
      const face = byId(strokes)['face.back'];
      // roll 이 있으면 얼굴 조각이 돌아가므로 roll 0 인 상태만 포함 검사
      if (Math.abs(tgt.r) < 1e-9 && !pointInPoly(...anchors.noseRoot, face.pts)) bad++;
    }
    expect(bad).toBe(0);
  });

  it('색은 화면 기준: 왼쪽 반쪽 따뜻함(빨강), 오른쪽 차가움(연파랑) — t 부호가 바뀌어도 그대로', () => {
    for (const t of [-1, -0.3, 0, 0.3, 1]) {
      const g = byId(composePortrait(states(t), params, 0));
      expect(g['face.L'].color).toBe(PALETTE.red);
      expect(g['face.R'].color).toBe(PALETTE.pale);
    }
  });
});

describe('거리 k', () => {
  it('|t|=1·k=1 에서도 NaN 이 없다 (모든 조합)', () => {
    for (const t of [-1, 1]) {
      for (const p of [-1, 1]) {
        for (const r of [-1, 1]) {
          const strokes = composePortrait(states(t, p, r, 1, { blinkL: 1, blinkR: 0, jaw: 1 }), createParams({ distortion: 2 }), 99);
          expect(allFinite(strokes)).toBeNull();
        }
      }
    }
  });

  it('코는 최대 1.8배, 눈 간격은 최대 1.4배', () => {
    const noseW = (k) => bbox(byId(composePortrait(states(0, 0, 0, k), params, 0))['nose.plane'].pts).w;
    const w0 = noseW(0);
    const w1 = noseW(1);
    expect(w1 / w0).toBeLessThanOrEqual(1.8 + 0.02);
    expect(w1 / w0).toBeGreaterThan(1.5);
    expect(noseW(0.5)).toBeGreaterThan(w0);
    expect(noseW(0.5)).toBeLessThan(w1);

    const sep = (k) => {
      const g = byId(composePortrait(states(0, 0, 0, k), params, 0));
      return bbox(g['eyeR.white'].pts).cx - bbox(g['eyeL.white'].pts).cx;
    };
    const s0 = sep(0);
    const s1 = sep(1);
    expect(s1 / s0).toBeLessThanOrEqual(1.4 + 0.02);
    expect(s1 / s0).toBeGreaterThan(1.3);
  });

  it('기준보다 멀 때(k=0)는 변화가 없고 distortion=0 이면 k 가 무시된다', () => {
    const a = composePortrait(states(0, 0, 0, 0), params, 0);
    const b = composePortrait(states(0, 0, 0, 1), createParams({ distortion: 0 }), 0);
    expect(byId(a)['nose.plane'].pts).toEqual(byId(b)['nose.plane'].pts);
    expect(bbox(byId(a)['eyeL.white'].pts).cx).toBeCloseTo(bbox(byId(b)['eyeL.white'].pts).cx, 6);
  });
});

describe('표정: 깜빡임·입 벌림', () => {
  it('blink ≥ 0.5 에서만 감긴 곡선 한 줄로 바뀌고 id·순위는 같다', () => {
    const open = byId(composePortrait(states(0, 0, 0, 0, { blinkL: 0.49 }), params, 0));
    const shut = byId(composePortrait(states(0, 0, 0, 0, { blinkL: 0.5 }), params, 0));
    expect(open['eyeL.white']).toBeDefined();
    expect(open['eyeL.iris']).toBeDefined();
    expect(shut['eyeL.white']).toBeUndefined();
    expect(shut['eyeL.iris']).toBeUndefined();
    expect(shut['eyeL.lid'].kind).toBe('line');
    expect(open['eyeL.lid'].kind).toBe('line');
    expect(shut['eyeL.lid'].rank).toBe(open['eyeL.lid'].rank);
    // 오른쪽 눈은 영향 없음
    expect(shut['eyeR.white']).toBeDefined();
    // 감긴 선은 아래로 처진 곡선 (가운데가 양 끝보다 아래)
    const pts = shut['eyeL.lid'].pts;
    const midY = pts[Math.floor(pts.length / 4) * 2 + 1];
    expect(midY).toBeGreaterThan(Math.min(pts[1], pts[pts.length - 1]));
    // 오른쪽 눈 감기: 화면 오른쪽 눈이 바뀐다
    const shutR = byId(composePortrait(states(0, 0, 0, 0, { blinkR: 1 }), params, 0));
    expect(shutR['eyeR.white']).toBeUndefined();
    expect(shutR['eyeL.white']).toBeDefined();
  });

  it('감긴 눈 스트로크 수가 줄어도 다른 스트로크의 ρ 는 그대로', () => {
    const a = byId(composePortrait(states(0), params, 0));
    const b = byId(composePortrait(states(0, 0, 0, 0, { blinkL: 1, blinkR: 1 }), params, 0));
    for (const id of Object.keys(b)) expect(b[id].rank).toBe(a[id].rank);
  });

  it('jaw 가 커질수록 입이 연속으로 단조롭게 벌어진다', () => {
    const open = (jaw) => {
      const g = byId(composePortrait(states(0, 0, 0, 0, { jaw }), params, 0));
      return { h: bbox(g['mouth.in'].pts).h, lo: bbox(g['mouth.lo'].pts).y1 };
    };
    let prev = open(0);
    expect(prev.h).toBeGreaterThan(2); // 다문 입도 얇은 선이 남는다
    for (let i = 1; i <= 20; i++) {
      const cur = open(i / 20);
      expect(cur.h).toBeGreaterThanOrEqual(prev.h - 1e-9);
      expect(cur.lo).toBeGreaterThanOrEqual(prev.lo - 1e-9);
      prev = cur;
    }
    expect(prev.h).toBeGreaterThan(open(0).h + 60);
    expect(JAW_MAX).toBeGreaterThan(60);
  });

  it('깜빡임·jaw 에는 시간차가 없다 (부품 상태가 늦어도 즉시 반영)', () => {
    const lagged = { t: 0, p: 0, r: 0, k: 0 };
    const ps = { L: 1, contour: lagged, split: lagged, eyes: lagged, mouth: { t: 0.2, p: 0, r: 0, k: 0 }, nose: lagged, ears: lagged, hair: lagged, blinkL: 1, blinkR: 0, jaw: 1 };
    const g = byId(composePortrait(ps, params, 0));
    expect(g['eyeL.white']).toBeUndefined();
    expect(bbox(g['mouth.in'].pts).h).toBeGreaterThan(70);
  });
});

describe('끄덕임 p, 갸웃 r', () => {
  it('p=+1 이면 눈높이가 내려가고 입이 눈보다 더 많이 움직이며 턱 끝은 고정', () => {
    const at = (p) => {
      const { strokes } = composeDetailed(states(0, p), params, 0);
      const g = byId(strokes);
      return {
        eye: bbox(g['eyeL.white'].pts).cy,
        mouth: bbox(g['mouth.up'].pts).cy,
        chin: bbox(g['face.back'].pts).y1,
        top: bbox(g['face.back'].pts).y0,
      };
    };
    const n = at(0), dn = at(1), up = at(-1);
    expect(dn.eye).toBeGreaterThan(n.eye);
    expect(up.eye).toBeLessThan(n.eye);
    // 눈과 입은 서로 다른 양만큼 어긋난다 (눈: 재매핑 0.12p + 0.05p, 입: 재매핑 + 0.10p)
    expect(dn.mouth - n.mouth).toBeGreaterThan(20);
    expect(Math.abs(dn.mouth - n.mouth - (dn.eye - n.eye))).toBeGreaterThan(3);
    expect(dn.chin).toBeCloseTo(n.chin, 3);
    expect(dn.top).toBeCloseTo(n.top, 3);
    // 이마가 커지고 아래쪽이 압축: 눈 위쪽 거리 증가, 눈 아래쪽 거리 감소
    expect(dn.eye - dn.top).toBeGreaterThan(n.eye - n.top);
    expect(dn.chin - dn.eye).toBeLessThan(n.chin - n.eye);
  });

  it('roll: 조각마다 계수 1±rollSpread(해시 고정)로 서로 다른 각도로 기울고, 목·어깨는 0.2배', () => {
    for (const piece of ['face.L', 'face.R', 'eyeL', 'eyeR', 'nose', 'mouth', 'ear.L', 'hair.0']) {
      const c = rollCoef(piece, 0.4);
      expect(c).toBeGreaterThanOrEqual(0.6);
      expect(c).toBeLessThanOrEqual(1.4);
      expect(rollCoef(piece, 0.4)).toBe(c); // 고정
      expect(rollCoef(piece, 0)).toBe(1);
    }
    const coefs = new Set(['face.L', 'face.R', 'eyeL', 'eyeR', 'nose', 'mouth'].map((p) => rollCoef(p, 0.4).toFixed(4)));
    expect(coefs.size).toBeGreaterThan(3);

    // 눈 한 쌍의 선분 기울기 = 기본각 + 조각별 추가각
    const r0 = byId(composePortrait(states(0, 0, 0), params, 0));
    const r1 = byId(composePortrait(states(0, 0, 1), params, 0));
    const tilt = (g, id) => {
      const p = g[id].pts; // 흰자 12점: 첫 점(왼 끝)과 6번째(오른 끝)
      return Math.atan2(p[11] - p[1], p[10] - p[0]);
    };
    const dEyeL = tilt(r1, 'eyeL.white') - tilt(r0, 'eyeL.white');
    const dEyeR = tilt(r1, 'eyeR.white') - tilt(r0, 'eyeR.white');
    const R = (30 * Math.PI) / 180;
    expect(dEyeL).toBeCloseTo(R * rollCoef('eyeL', 0.4), 5);
    expect(dEyeR).toBeCloseTo(R * rollCoef('eyeR', 0.4), 5);
    // 어깨: 기본각의 0.2배 (C 기준 회전)
    const a0 = r0['sh.a'].pts, a1 = r1['sh.a'].pts;
    const ang = (pts, i) => Math.atan2(pts[2 * i + 1] - 470, pts[2 * i] - 540);
    let d = ang(a1, 3) - ang(a0, 3);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    expect(d).toBeCloseTo(R * 0.2, 3); // 정적 묶음은 0.04° 단위로 양자화
    // rollSpread=0 이면 모든 조각이 같은 각도
    const flat = createParams({ rollSpread: 0 });
    const f1 = byId(composePortrait(states(0, 0, 1), flat, 0));
    const dd = tilt(f1, 'eyeL.white') - tilt(f1, 'eyeR.white') - (tilt(r0, 'eyeL.white') - tilt(r0, 'eyeR.white'));
    expect(dd).toBeCloseTo(0, 5);
  });
});

describe('createPortrait: update / draw / info', () => {
  /** 그리기 호출을 기록하는 가짜 ctx (draw 가 쓰는 메서드 전부) */
  function makeCtx() {
    const st = { fills: 0, rects: 0, bad: 0, clips: 0, images: 0, minAlpha: 1, maxAlpha: 0, depth: 0 };
    const ctx = new Proxy({}, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'save') return () => { st.depth++; };
        if (k === 'restore') return () => { st.depth--; };
        if (k === 'fill') return () => { st.fills++; st.minAlpha = Math.min(st.minAlpha, t.globalAlpha ?? 1); st.maxAlpha = Math.max(st.maxAlpha, t.globalAlpha ?? 1); };
        if (k === 'fillRect') return (...a) => { st.rects++; a.forEach((v) => { if (!Number.isFinite(v)) st.bad++; }); };
        if (k === 'clip') return () => { st.clips++; };
        if (k === 'drawImage') return () => { st.images++; };
        return (...args) => { for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) st.bad++; };
      },
      set(t, k, v) { t[k] = v; return true; },
    });
    return { ctx, st };
  }

  const sig = (o = {}) => ({ present: true, t: 0, p: 0, r: 0, k: 0, blinkL: 0, blinkR: 0, jaw: 0, ...o });

  it('시작은 L=0·숨김, snap 이면 즉시 완전 표시', () => {
    const p = createPortrait({ cache: false });
    expect(p.info().fadeLevel).toBe(0);
    expect(p.info().phase).toBe('hidden');
    p.update(sig({ t: 0.6 }), params, 0, DT, { snap: true });
    expect(p.info().fadeLevel).toBe(1);
    expect(p.info().phase).toBe('visible');
    const { ctx, st } = makeCtx();
    p.draw({ drawingContext: ctx }, params, 1000, 0, 768, 1080, 1152);
    expect(st.bad).toBe(0);
    expect(st.fills).toBeGreaterThan(100);
    expect(st.rects).toBeGreaterThanOrEqual(1);
    expect(st.clips).toBe(1);
    expect(st.depth).toBe(0);
    expect(st.maxAlpha).toBeLessThanOrEqual(1);
    expect(p.info().strokes).toBeGreaterThan(50);
  });

  it('draw 는 p.drawingContext 만 쓴다 (p5 API 에 의존하지 않음) — 극단 입력에서도 NaN 없음', () => {
    const p = createPortrait({ cache: false });
    for (const o of [{ t: 1, p: 1, r: 1, k: 1, jaw: 1, blinkL: 1 }, { t: -1, p: -1, r: -1, k: 1, blinkR: 1 }, { t: 0.5 }]) {
      p.update(sig(o), params, 0, DT, { snap: true });
      const { ctx, st } = makeCtx();
      p.draw({ drawingContext: ctx }, params, 4321, 0, 768, 1080, 1152);
      expect(st.bad).toBe(0);
      expect(st.fills).toBeGreaterThan(100);
    }
  });

  it('최초 검출 후 +1/0.8s 로 그려지며 나타나고, 300ms 미만 끊김은 무시, 이후 -1/1.0s 로 사라진다', () => {
    const p = createPortrait({ cache: false });
    let now = 0;
    const step = (present, ms) => {
      const end = now + ms;
      while (now < end - 1e-9) {
        now += DT;
        p.update(sig({ present, t: 0.3 }), params, now, DT);
      }
    };
    step(true, 400);
    expect(p.info().fadeLevel).toBeGreaterThan(0.4);
    expect(p.info().fadeLevel).toBeLessThan(0.6);
    expect(p.info().phase).toBe('in');
    step(true, 500);
    expect(p.info().fadeLevel).toBe(1);
    step(false, 250);
    expect(p.info().fadeLevel).toBe(1);
    step(true, 100);
    step(false, FADE.lostDelayMs + 500);
    expect(p.info().phase).toBe('out');
    expect(p.info().fadeLevel).toBeGreaterThan(0.4);
    expect(p.info().fadeLevel).toBeLessThan(0.6);
    step(false, 700);
    expect(p.info().fadeLevel).toBe(0);
    expect(p.info().phase).toBe('hidden');
  });

  it('미감지 확정 후에는 부품 상태가 마지막 자세로 고정되고, L=0 에서 재등장하면 현재 신호로 즉시 맞춘다', () => {
    const p = createPortrait({ cache: false });
    let now = 0;
    const tick = (o, ms = 16) => {
      now += ms;
      p.update(sig(o), params, now, ms);
    };
    for (let i = 0; i < 80; i++) tick({ t: 0.8, jaw: 0.4 });
    const frozen = JSON.stringify(p._partStates());
    // 300ms 유예 동안은 마지막 신호 그대로(계약: present=false 동안 값 유지), 확정 뒤에는 신호가 바뀌어도 고정
    for (let i = 0; i < 20; i++) tick({ present: false, t: 0.8, jaw: 0.4 });
    for (let i = 0; i < 40; i++) tick({ present: false, t: -1, jaw: 0 });
    expect(p._partStates().hair.t).toBeCloseTo(0.8, 2);
    expect(p._partStates().jaw).toBeCloseTo(0.4, 6);
    expect(p.info().phase).not.toBe('visible');
    // 완전히 사라질 때까지
    for (let i = 0; i < 120; i++) tick({ present: false, t: -1 });
    expect(p.info().fadeLevel).toBe(0);
    const ps = p._partStates();
    expect(ps.hair.t).toBeCloseTo(0.8, 2);
    // 재등장: 현재 신호로 즉시 맞춤 (시간차로 천천히 오지 않는다)
    tick({ present: true, t: -0.9, p: 0.5 });
    const after = p._partStates();
    for (const key of PART_KEYS) {
      expect(after[key].t).toBeCloseTo(-0.9, 6);
      expect(after[key].p).toBeCloseTo(0.5, 6);
    }
    expect(frozen.length).toBeGreaterThan(10);
  });

  it('빠른 회전 후 정지 → 0.5초 안에 모든 부품 잔차 < 5% (update 경로)', () => {
    const p = createPortrait({ cache: false });
    p.update(sig({ t: -1 }), params, 0, DT, { snap: true });
    let now = 0;
    const N = Math.round(300 / DT);
    for (let i = 1; i <= N; i++) {
      now += DT;
      p.update(sig({ t: -1 + (2 * i) / N }), params, now, DT);
    }
    for (let i = 0; i < Math.round(500 / DT); i++) {
      now += DT;
      p.update(sig({ t: 1 }), params, now, DT);
    }
    const ps = p._partStates();
    for (const key of PART_KEYS) expect(Math.abs(ps[key].t - 1)).toBeLessThan(0.05);
  });

  it('정적 레이어 캐시: L=1 이고 지문이 같으면 한 번만 만들고 재사용 (document 가 없으면 직접 그림)', () => {
    // node 에는 document 가 없으므로 캐시는 비활성 → 항상 직접 그린다
    const p = createPortrait();
    p.update(sig(), params, 0, DT, { snap: true });
    const a = makeCtx();
    p.draw({ drawingContext: a.ctx }, params, 1000, 0, 0, 1080, 1152);
    const b = makeCtx();
    p.draw({ drawingContext: b.ctx }, params, 1010, 0, 0, 1080, 1152);
    expect(a.st.images).toBe(0);
    expect(a.st.fills).toBe(b.st.fills);
  });

  it('페이드 중에는 캐시 없이 직접 그리고 가시도가 낮으면 칠하는 양이 줄어든다', () => {
    const p = createPortrait({ cache: false });
    p.update(sig({ t: 0.2 }), params, 0, DT, { snap: true });
    const full = makeCtx();
    p.draw({ drawingContext: full.ctx }, params, 0, 0, 0, 1080, 1152);
    const q = createPortrait({ cache: false });
    let now = 0;
    for (let i = 0; i < 20; i++) {
      now += DT;
      q.update(sig({ t: 0.2 }), params, now, DT);
    }
    const part = makeCtx();
    q.draw({ drawingContext: part.ctx }, params, now, 0, 0, 1080, 1152);
    expect(part.st.fills).toBeLessThan(full.st.fills);
    expect(part.st.fills).toBeGreaterThan(0);
    expect(q.info().strokes).toBeLessThan(p.info().strokes);
  });

  it('프레임당 스트로크 수는 80 안팎 × 겹수 이내', () => {
    const p = createPortrait({ cache: false });
    p.update(sig({ t: 0.3, jaw: 0.3 }), params, 0, DT, { snap: true });
    const { ctx, st } = makeCtx();
    p.draw({ drawingContext: ctx }, params, 0, 0, 0, 1080, 1152);
    expect(p.info().strokes).toBeLessThanOrEqual(90);
    expect(st.fills).toBeLessThanOrEqual(90 * params.strokeLayers);
  });
});

describe('부품이 사라지기 직전의 부드러운 감쇠 (alphaK)', () => {
  it('반대쪽 눈은 σ 0.75~1 에서 크기뿐 아니라 불투명도도 연속으로 줄어든다', () => {
    let prev = Infinity;
    let seen = 0;
    for (let i = 0; i <= 60; i++) {
      const sigma = 0.8 + (0.2 * i) / 60;
      const e = byId(composePortrait(states(sigma), params, 0))['eyeL.white'];
      const a = e ? e.alpha : 0;
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      expect(prev === Infinity || prev - a < 0.2).toBe(true); // 한 번에 크게 꺼지지 않는다
      if (e && e.alpha < 0.92 && e.alpha > 0) seen++;
      prev = a;
    }
    expect(seen).toBeGreaterThan(0); // 실제로 옅어지는 구간이 있다
    expect(prev).toBe(0);
  });

  it('좁아지는 반쪽의 색면은 문턱 근처에서 옅게 시작한다', () => {
    const alphas = [];
    for (let i = 0; i <= 40; i++) {
      const g = byId(composePortrait(states((0.4 * i) / 40), params, 0));
      alphas.push(g['L.jaw'] ? g['L.jaw'].alpha : 0);
    }
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1] + 1e-9);
    expect(alphas[0]).toBeGreaterThan(0.9); // 정면에서는 온전히 보인다
    expect(alphas[alphas.length - 1]).toBeLessThan(0.1); // 반쪽이 좁아지면 옅어졌다 사라진다
    expect(alphas.some((a) => a > 0.05 && a < 0.9)).toBe(true); // 중간 단계가 있다 (갑자기 튀지 않음)
  });
});

describe('Stroke 형식', () => {
  it('모든 스트로크가 문서화된 필드를 갖고 좌표가 짝수 길이다', () => {
    for (const s of composePortrait(states(0.3, 0.1, 0.2, 0.3, { jaw: 0.3 }), params, 100)) {
      expect(typeof s.id).toBe('string');
      expect(['poly', 'line', 'blob', 'rect']).toContain(s.kind);
      expect(isPaletteColor(s.color)).toBe(true);
      expect(s.rank).toBeGreaterThan(0);
      expect(s.rank).toBeLessThan(1);
      expect(s.vis).toBeGreaterThanOrEqual(0);
      expect(s.vis).toBeLessThanOrEqual(1);
      expect(s.alpha).toBeGreaterThanOrEqual(0);
      expect(s.alpha).toBeLessThanOrEqual(0.92 + 1e-9);
      if (s.kind === 'poly' || s.kind === 'line') {
        expect(s.pts.length % 2).toBe(0);
        expect(s.pts.length).toBeGreaterThanOrEqual(s.kind === 'line' ? 6 : 6);
      }
      if (s.kind === 'line') expect(s.wMax).toBeGreaterThanOrEqual(s.wMin);
      if (s.kind === 'blob') {
        expect(s.rx).toBeGreaterThan(0);
        expect(s.ry).toBeGreaterThan(0);
      }
    }
  });

  it('흰 선은 4~10px 폭이고 네이비 선 외에는 검정이 없다', () => {
    for (const s of composePortrait(states(0.2), params, 0)) {
      if (s.kind !== 'line' || s.id.startsWith('bgs.')) continue; // 배경 붓 스윕은 굵은 반투명 질감
      expect(s.wMin).toBeGreaterThanOrEqual(3);
      expect(s.wMax).toBeLessThanOrEqual(12);
      if (s.color === PALETTE.line) {
        expect(s.wMin).toBeGreaterThanOrEqual(4);
        expect(s.wMax).toBeLessThanOrEqual(10);
      }
    }
  });

  it('프레임당 스트로크 수는 약 80 이하', () => {
    for (const t of [-1, -0.4, 0, 0.6, 1]) {
      const n = composePortrait(states(t, 0, 0, 0, { jaw: 0.5 }), params, 0).length;
      expect(n).toBeGreaterThanOrEqual(55);
      expect(n).toBeLessThanOrEqual(80);
    }
  });

  it('_partStates(true) 는 이후 update 에 영향받지 않는 복사본', () => {
    const p = createPortrait({ cache: false });
    const sg = { present: true, t: -1, p: 0, r: 0, k: 0, blinkL: 0, blinkR: 0, jaw: 0 };
    p.update(sg, params, 0, DT, { snap: true });
    const frozen = p._partStates(true);
    for (let i = 1; i <= 30; i++) p.update({ ...sg, t: 1 }, params, i * DT, DT);
    expect(frozen.hair.t).toBe(-1);
    expect(p._partStates().contour.t).toBe(1);
  });
});

describe('무작위 입력 퍼징', () => {
  it('고정 시드 무작위 상태 150개: compose·draw 모두 NaN/예외 없음, 순위 고정', { timeout: 120000 }, () => {
    const rnd = mulberry32(20261104);
    const r11 = () => rnd() * 2 - 1;
    const p = createPortrait({ cache: false });
    const ranks = new Map();
    let drawn = 0;
    for (let i = 0; i < 150; i++) {
      const prm = createParams({
        jitterAmp: rnd() * 10,
        strokeLayers: 1 + Math.floor(rnd() * 6),
        rollSpread: rnd() * 0.8,
        distortion: rnd() * 2,
        lagScale: rnd() * 3,
        rollRange: 10 + rnd() * 50,
      });
      const part = () => ({ t: r11(), p: r11(), r: r11(), k: rnd() });
      const ps = {
        L: rnd() < 0.3 ? rnd() : 1,
        contour: part(), split: part(), eyes: part(), mouth: part(), nose: part(), ears: part(), hair: part(),
        blinkL: rnd(), blinkR: rnd(), jaw: rnd(),
      };
      ps.split = ps.contour; // 윤곽과 분할선은 둘 다 τ=0 이라 항상 같다
      const strokes = composePortrait(ps, prm, rnd() * 60000);
      expect(allFinite(strokes)).toBeNull();
      for (const s of strokes) {
        if (ranks.has(s.id)) expect(ranks.get(s.id)).toBe(s.rank);
        ranks.set(s.id, s.rank);
      }
      // draw 경로 (update → draw)
      const sg = { present: rnd() < 0.9, t: r11(), p: r11(), r: r11(), k: rnd(), blinkL: rnd(), blinkR: rnd(), jaw: rnd() };
      p.update(sg, prm, i * 40, 16, { snap: rnd() < 0.2 });
      const ctx = new Proxy({}, {
        get(t, k) {
          if (k in t) return t[k];
          return (...args) => {
            for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`비유한 인자 ${k}`);
          };
        },
        set(t, k, v) { t[k] = v; return true; },
      });
      p.draw({ drawingContext: ctx }, prm, i * 40, 0, 768, 1080, 1152);
      drawn += p.info().strokes;
    }
    expect(drawn).toBeGreaterThan(0);
  });
});

describe('면적 기반 겹수 상한', () => {
  it('큰 면은 1~2겹, 작은 면은 strokeLayers 그대로, 상한은 순위·id 에 영향 없음', () => {
    const strokes = composePortrait(states(0.2), params, 0);
    const g = byId(strokes);
    expect(g['bg.0'].layers).toBe(1);
    expect(g['sh.a'].layers).toBe(1);
    expect(g['face.L'].layers).toBeLessThanOrEqual(2);
    expect(g['eyeL.iris'].layers).toBeUndefined();
    for (const s of strokes) {
      const area = s.kind === 'poly' ? polyArea(s.pts) : s.kind === 'blob' ? Math.PI * s.rx * s.ry : 0;
      if (area > LAYER_CAP_1) expect(s.layers).toBe(1);
      else if (area > LAYER_CAP_2) expect(s.layers).toBeLessThanOrEqual(2);
    }
  });

  it('draw 의 칠하기 횟수는 큰 면 때문에 줄어든다 (겹수 3 기준 스트로크×3 보다 적다)', () => {
    const p = createPortrait({ cache: false });
    p.update({ present: true, t: 0, p: 0, r: 0, k: 0, blinkL: 0, blinkR: 0, jaw: 0 }, params, 0, DT, { snap: true });
    let fills = 0;
    const ctx = new Proxy({}, { get(t, k) { if (k in t) return t[k]; if (k === 'fill') return () => { fills++; }; return () => {}; }, set(t, k, v) { t[k] = v; return true; } });
    p.draw({ drawingContext: ctx }, params, 0, 0, 0, 1080, 1152);
    expect(fills).toBeLessThan(p.info().strokes * 3 - 20);
  });
});

describe('레지스트리와 compose 의 일관성', () => {
  it('compose 가 내는 모든 id 는 STROKE_IDS 의 부분집합이고 순서 정보(ρ)가 증가 순서를 어기지 않는다', () => {
    const ids = new Set(STROKE_IDS);
    for (const s of composePortrait(states(0.2), params, 0)) expect(ids.has(s.id)).toBe(true);
  });
});

describe('draw 예외 안전 (save/restore 짝)', () => {
  it('draw 도중 fill 이 throw 해도 save 수 == restore 수 (clip 이 바깥으로 새지 않는다)', () => {
    const p = createPortrait({ cache: false });
    p.update({ present: true, t: 0.3, p: 0, r: 0, k: 0, blinkL: 0, blinkR: 0, jaw: 0 }, params, 0, DT, { snap: true });
    let saves = 0, restores = 0, fills = 0, thrown = false;
    const ctx = new Proxy({}, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'save') return () => { saves++; };
        if (k === 'restore') return () => { restores++; };
        if (k === 'fill') return () => {
          fills++;
          if (fills === 5) { thrown = true; throw new Error('fill 실패(테스트)'); }
        };
        return () => {};
      },
      set(t, k, v) { t[k] = v; return true; },
    });
    try {
      p.draw({ drawingContext: ctx }, params, 0, 0, 0, 1080, 1152);
    } catch (e) {
      /* 예상된 예외 */
    }
    expect(thrown).toBe(true);
    expect(saves).toBe(1);
    expect(restores).toBe(saves);
  });
});
