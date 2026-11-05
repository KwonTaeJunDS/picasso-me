// 피카소풍 입체파 초상 렌더러 (Dev B).
//
//   const portrait = createPortrait();
//   portrait.update(signals, params, nowMs, dtMs, { snap });   // 시간차(lag) + 미감지 페이드
//   portrait.draw(p, params, nowMs, x, y, w, h);               // 설계 공간 1080×1152 를 (x,y,w,h) 에 그림
//   portrait.info();                                           // { fadeLevel, phase, strokes }
//   composePortrait(partStates, params, nowMs) → Stroke[]      // 순수 함수 (기하·색·id·순위·가시도)
//
// ── partStates (composePortrait 입력) ─────────────────────────────────────────────
// {
//   L:      0..1  페이드 레벨 (생략 시 1)
//   contour, split, eyes, mouth, nose, ears, hair: { t, p, r, k }   부품별 시간차 사본 (lag.js)
//       t yaw[-1,1] (+ = 코가 화면 오른쪽), p pitch (+ = 숙임), r roll (+ = 시계방향), k 거리 왜곡 [0,1]
//   blinkL, blinkR: 0..1   화면 왼쪽/오른쪽 눈 감김 (≥ 0.5 이면 곡선 한 줄). 시간차 없음
//   jaw:    0..1   입 벌림. 시간차 없음
// }
//
// ── Stroke (composePortrait 출력, 그리는 순서 = 배열 순서) ───────────────────────
// {
//   id      영구 id (strokes.js 의 고정 레지스트리에 있는 값)
//   rank    고정 공개 순위 ρ ∈ (0,1)  — id 에만 의존, 프레임마다 몇 개가 그려지든 변하지 않음
//   vis     가시도 0..1 = clamp((L - ρ(1-w))/w, 0, 1), w=0.15 (fade.js). bg.base 는 항상 1(불투명)
//   kind    'poly' | 'line' | 'blob' | 'rect'
//   color   팔레트 10색 중 하나
//   pts     poly/line: [x0,y0,x1,y1,...] 설계 공간(1080×1152) 좌표 — roll 까지 적용된 최종 위치
//   cx,cy,rx,ry,rot,lump   blob
//   wMin,wMax              line 폭(px)
//   x,y,w,h                rect
//   seed    스톱모션 시드 = hash(epoch, id)  (epoch = floor(now/1000·jitterFps))
//   alpha   누적 불투명도 목표 = 0.92 × alphaK (alphaK: 사라지기 직전의 부품을 옅게 해 튀어나오지 않게 하는 0..1 배율)
//   ampK    떨림 진폭 배율, spacing 둘레 재샘플 간격, layers 겹수 상한(선택 — 바탕 면 등 한 겹이면 충분한 것)
//   static  정적 레이어 여부 (배경 색면·붓 질감: 오프스크린 캐시 대상), opaque 항상 불투명(bg.base)
//   part,piece,rollW,pivot  roll 적용에 쓴 메타데이터
// }
// 렌더 경로에서 Math.random 을 쓰지 않는다 (noise.js 의 해시 PRNG·값 노이즈).

import { ART_W, ART_H } from '../contracts.js';
import { FADE } from '../config/params.js';
import { createFade, updateFade, fadePhase, visibility } from './fade.js';
import { createLag, updateLag, snapLag, PART_KEYS } from './lag.js';
import { rankOf, idHashOf } from './strokes.js';
import { epochOf, hashStr, rand01 } from './noise.js';
import { brushPoly, brushLine, brushBlob, strokeSeed, BRUSH } from './brush.js';
import { CX, CY, clamp, polyArea } from './parts/geom.js';
import { buildModel, profileFraction } from './parts/model.js';
import { emitBackground } from './parts/background.js';
import { emitShoulders, emitNeck } from './parts/neck.js';
import { emitDrips } from './parts/drips.js';
import { emitHairBack, emitHairFront, emitHairHighlights } from './parts/hair.js';
import { emitFaceBase, emitFacePlanes, emitFaceOutline, emitFaceLines } from './parts/face.js';
import { emitEars } from './parts/ear.js';
import { emitNose } from './parts/nose.js';
import { emitMouth } from './parts/mouth.js';
import { emitEyes } from './parts/eyes.js';

/** 면적(px²) 기준 겹수 상한: 초과 시 1겹, 초과 시 2겹 */
export const LAYER_CAP_1 = 60000;
export const LAYER_CAP_2 = 18000;
const DEG = Math.PI / 180;
const ZERO = Object.freeze({ t: 0, p: 0, r: 0, k: 0 });
const CENTER = [CX, CY];

// ---------------------------------------------------------------------------
// roll (PLAN 4.3): 조각마다 θᵢ = r·rollRange·cᵢ, cᵢ = 1 + rollSpread·(2·hash(조각)−1).
// 모든 조각이 먼저 얼굴 중심 C 를 기준으로 같은 기본 각도로 돌아 한 몸으로 붙어 있고(목·어깨는 0.2배),
// 조각 고유의 차이(cᵢ−1)·기본각은 조각 자신의 축(pivot)에서 추가로 기울어진다.
// → 각 조각의 기울기는 정확히 θᵢ 이면서, 코·입 뿌리처럼 윤곽에 붙은 부품이 떨어져 나가지 않는다.
// ---------------------------------------------------------------------------
const COEF_HASH = new Map();
export function rollCoef(piece, spread) {
  let h = COEF_HASH.get(piece);
  if (h === undefined) {
    h = rand01(hashStr(`${piece}#roll`));
    COEF_HASH.set(piece, h);
  }
  return 1 + spread * (2 * h - 1);
}

// 정적 묶음(어깨·흘러내림 등 rollW<1)은 기본각을 0.04° 단위로 양자화해, 필터 후 남는 미세 떨림이
// 오프스크린 캐시를 매 프레임 무효화하지 않게 한다 (최대 어긋남 < 0.25px).
const STATIC_ROLL_STEP = (0.04 * Math.PI) / 180;

function applyRoll(s, ps, params) {
  const w = s.rollW;
  if (!w) return;
  const state = ps[s.part] || ps.contour;
  const R = clamp(state.r, -1, 1) * (params.rollRange ?? 30) * DEG;
  if (R === 0) return;
  let base = R * w;
  if (w < 1) base = Math.round(base / STATIC_ROLL_STEP) * STATIC_ROLL_STEP;
  const extra = w >= 1 ? (rollCoef(s.piece, params.rollSpread ?? 0.4) - 1) * R : 0;
  const cb = Math.cos(base), sb = Math.sin(base);
  const hasExtra = extra !== 0;
  // 조각 축도 기본 회전을 따라간다
  let px = 0, py = 0, ce = 1, se = 0;
  if (hasExtra) {
    const pv = s.pivot || CENTER;
    const dx = pv[0] - CX, dy = pv[1] - CY;
    px = CX + dx * cb - dy * sb;
    py = CY + dx * sb + dy * cb;
    ce = Math.cos(extra);
    se = Math.sin(extra);
  }
  if (s.kind === 'blob') {
    const ax = s.cx - CX, ay = s.cy - CY;
    let x = CX + ax * cb - ay * sb;
    let y = CY + ax * sb + ay * cb;
    if (hasExtra) {
      const bx = x - px, by = y - py;
      x = px + bx * ce - by * se;
      y = py + bx * se + by * ce;
    }
    s.cx = x;
    s.cy = y;
    s.rot += base + extra;
  } else if (s.pts) {
    // 정적으로 공유되는 배열을 건드리지 않도록 새 배열을 만든다
    const src = s.pts;
    const dst = new Array(src.length);
    for (let i = 0; i < src.length; i += 2) {
      const ax = src[i] - CX, ay = src[i + 1] - CY;
      let x = CX + ax * cb - ay * sb;
      let y = CY + ax * sb + ay * cb;
      if (hasExtra) {
        const bx = x - px, by = y - py;
        x = px + bx * ce - by * se;
        y = py + bx * se + by * ce;
      }
      dst[i] = x;
      dst[i + 1] = y;
    }
    s.pts = dst;
  }
}

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

/** 일부만 채워진 partStates 를 보정 (없는 부품은 contour 사본, 없는 contour 는 0). */
function normalizeParts(partStates) {
  const ps = partStates || {};
  const contour = ps.contour || ZERO;
  const out = { L: ps.L === undefined ? 1 : ps.L, blinkL: ps.blinkL || 0, blinkR: ps.blinkR || 0, jaw: ps.jaw || 0 };
  for (const key of PART_KEYS) out[key] = ps[key] || contour;
  out.contour = contour;
  return out;
}

/**
 * composePortrait 의 상세 버전: 테스트·진단용으로 모델과 부착점도 돌려준다.
 * @returns {{strokes: object[], model: object, anchors: object}}
 */
export function composeDetailed(partStates, params, nowMs = 0) {
  const ps = normalizeParts(partStates);
  const model = buildModel(ps, params);
  const out = [];
  const anchors = {};

  // 정적 묶음(배경 → 어깨 → 흘러내림)이 맨 앞에 연속으로 온다 (캐시 대상)
  emitBackground(out);
  emitShoulders(out);
  emitDrips(out);
  // 레이어 순서: 목 → 뒷머리 → 얼굴 바탕·반쪽 → 색면 → 턱선 → 귀 → 코 → 입 → 눈·눈썹 → 흰 선 → 앞머리
  emitNeck(out, model);
  emitHairBack(out, ps.hair);
  emitFaceBase(out, model);
  emitFacePlanes(out, model);
  emitFaceOutline(out, model);
  emitEars(out, model, ps.ears);
  emitNose(out, model, ps, params, anchors);
  emitMouth(out, model, ps, params, anchors);
  emitEyes(out, model, ps, params);
  emitFaceLines(out, model);
  emitHairFront(out, ps.hair);
  emitHairHighlights(out, ps.hair);

  const epoch = epochOf(nowMs, params.jitterFps ?? 10);
  const L = ps.L;
  for (const s of out) {
    applyRoll(s, ps, params);
    s.rank = rankOf(s.id);
    s.idHash = idHashOf(s.id);
    s.vis = s.opaque ? 1 : visibility(L, s.rank);
    s.seed = strokeSeed(epoch, s.idHash);
    s.alpha = BRUSH.opacity * (s.alphaK === undefined ? 1 : s.alphaK);
    // 큰 면은 겹수를 줄인다 (비용 ∝ 칠한 면적 × 겹수, 붓터치 느낌은 주로 가장자리·작은 면에서 난다)
    const area = s.kind === 'poly' ? polyArea(s.pts) : s.kind === 'blob' ? Math.PI * s.rx * s.ry : 0;
    const cap = area > LAYER_CAP_1 ? 1 : area > LAYER_CAP_2 ? 2 : 0;
    if (cap && (s.layers === undefined || s.layers > cap)) s.layers = cap;
  }
  return { strokes: out, model, anchors };
}

/** 순수 함수 — 같은 입력이면 같은 Stroke[] */
export function composePortrait(partStates, params, nowMs = 0) {
  return composeDetailed(partStates, params, nowMs).strokes;
}

export { profileFraction };

// ---------------------------------------------------------------------------
// draw
// ---------------------------------------------------------------------------

const OPT = { seed: 0, idHash: 0, amp: 3, layers: 3, opacity: 0.92, spacing: undefined, lump: 0.1, shapeSeed: 0, frac: 1 };

function paintStroke(ctx, s, amp, layers) {
  if (s.vis <= 0.003 || s.alpha <= 0.003) return;
  if (s.kind === 'rect') {
    ctx.globalAlpha = 1;
    ctx.fillStyle = s.color;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    return;
  }
  OPT.seed = s.seed;
  OPT.idHash = s.idHash;
  OPT.amp = amp * (s.ampK === undefined ? 1 : s.ampK);
  OPT.layers = s.layers === undefined ? layers : Math.min(s.layers, layers);
  OPT.spacing = s.spacing;
  if (s.kind === 'poly') {
    OPT.opacity = s.alpha * s.vis;
    brushPoly(ctx, s.pts, s.color, OPT);
  } else if (s.kind === 'blob') {
    OPT.opacity = s.alpha * s.vis;
    OPT.lump = s.lump;
    OPT.shapeSeed = s.idHash;
    brushBlob(ctx, s.cx, s.cy, s.rx, s.ry, s.rot, s.color, OPT);
  } else if (s.kind === 'line') {
    // 그려지며 등장: 경로 앞부분만, 불투명도는 빨리 올라온다
    OPT.opacity = s.alpha * Math.min(1, s.vis * 3);
    OPT.frac = s.vis;
    brushLine(ctx, s.pts, s.color, s.wMin, s.wMax, OPT);
    OPT.frac = 1;
  }
}

/** 정적 묶음의 지문: 좌표·시드가 같으면 같다 */
function staticSignature(strokes, n) {
  let h = 17;
  for (let i = 0; i < n; i++) {
    const s = strokes[i];
    h = (Math.imul(h, 31) + s.seed) | 0;
    const pts = s.pts;
    if (pts) {
      for (let k = 0; k < pts.length; k++) h = (Math.imul(h, 31) + Math.round(pts[k] * 4)) | 0;
    }
  }
  return h;
}

/**
 * 캐시 없이 Stroke[] 를 설계 공간 1080×1152 → (x,y,w,h) 에 그린다. 갤러리·진단용.
 * createPortrait().draw 도 같은 paintStroke 를 쓴다.
 */
export function drawStrokes(ctx, strokes, params, x, y, w, h) {
  const amp = params.jitterAmp ?? 3;
  const layers = params.strokeLayers ?? 3;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(w / ART_W, h / ART_H);
  ctx.beginPath();
  ctx.rect(0, 0, ART_W, ART_H);
  ctx.clip();
  ctx.globalAlpha = 1;
  for (let i = 0; i < strokes.length; i++) paintStroke(ctx, strokes[i], amp, layers);
  ctx.restore();
}

function makeLayerCanvas(w, h) {
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  } catch (e) {
    /* 캐시 없이 직접 그린다 */
  }
  return null;
}

export function createPortrait(options = {}) {
  const useCache = options.cache !== false;
  const fade = createFade();
  const lag = createLag();
  const sig = { blinkL: 0, blinkR: 0, jaw: 0 };
  let strokeCount = 0;

  // 정적 레이어 캐시: 현재(A)와 다음 epoch 용 백 버퍼(B). B 는 현재 epoch 동안 여러 프레임에 나눠 미리 그린다.
  const bufs = [null, null].map(() => ({ canvas: null, ctx: null, key: '', done: 0 }));
  let cur = 0; // 현재 버퍼 인덱스
  let cacheFailed = false;

  function ensureBuf(b) {
    if (b.canvas) return true;
    b.canvas = makeLayerCanvas(ART_W, ART_H);
    b.ctx = b.canvas ? b.canvas.getContext('2d') : null;
    return !!b.ctx;
  }
  function clearBuf(b) {
    b.ctx.setTransform(1, 0, 0, 1, 0, 0);
    b.ctx.globalAlpha = 1;
    b.ctx.clearRect(0, 0, ART_W, ART_H);
    b.done = 0;
  }

  function update(signals, params, nowMs, dtMs, opts = {}) {
    const snap = !!opts.snap;
    const present = !!signals.present;
    const wasEffective = fade.effective;
    const L0 = fade.L;
    updateFade(fade, present, nowMs, dtMs, FADE, { snap });
    const target = {
      t: clamp(+signals.t || 0, -1, 1),
      p: clamp(+signals.p || 0, -1, 1),
      r: clamp(+signals.r || 0, -1, 1),
      k: clamp(+signals.k || 0, 0, 1),
    };
    if (snap) {
      snapLag(lag, target);
    } else if (fade.effective) {
      // L=0 에서 재등장(또는 최초 등장) → 현재 신호로 즉시 맞춤. 그 외에는 시간차로 따라간다.
      if (!wasEffective && L0 <= 1e-6) snapLag(lag, target);
      else updateLag(lag, target, dtMs, params.lagScale ?? 1);
    } else {
      return; // 미감지 확정: 부품·표정 상태 고정(마지막 자세 그대로 사라짐)
    }
    sig.blinkL = signals.blinkL || 0;
    sig.blinkR = signals.blinkR || 0;
    sig.jaw = clamp(+signals.jaw || 0, 0, 1);
  }

  /** 현재 부품 상태. copy=true 면 값을 복사해(시퀀스 캡처용) 이후 update 에 영향받지 않는다. */
  function partStates(copy = false) {
    const out = { L: fade.L, blinkL: sig.blinkL, blinkR: sig.blinkR, jaw: sig.jaw };
    for (const key of PART_KEYS) {
      const st = lag.parts[key];
      out[key] = copy ? { t: st.t, p: st.p, r: st.r, k: st.k } : st;
    }
    return out;
  }

  function draw(p, params, nowMs, x, y, w, h) {
    const ctx = p.drawingContext;
    const strokes = composePortrait(partStates(), params, nowMs);
    const amp = params.jitterAmp ?? 3;
    const layers = params.strokeLayers ?? 3;
    let drawn = 0;

    ctx.save();
    try {
      ctx.translate(x, y);
      ctx.scale(w / ART_W, h / ART_H);
      ctx.beginPath();
      ctx.rect(0, 0, ART_W, ART_H);
      ctx.clip(); // 그림 영역 밖(웹캠 영역)으로 번지지 않게
      ctx.globalAlpha = 1;

      let i = 0;
      let nStatic = 0;
      while (nStatic < strokes.length && strokes[nStatic].static) nStatic++;

      // 정적 묶음: L=1 이고 지문(시드·좌표)·진폭·겹수가 같으면 캐시를 재사용, 아니면 직접 그림.
      // 다음 epoch 의 정적 레이어는 백 버퍼에 프레임당 몇 개씩 미리 그려 두었다가 경계에서 교체한다.
      let cached = false;
      if (useCache && !cacheFailed && fade.L >= 1) {
        if (!ensureBuf(bufs[0]) || !ensureBuf(bufs[1])) cacheFailed = true;
        else {
          const tail = `|${amp}|${layers}`;
          const key = `${staticSignature(strokes, nStatic)}${tail}`;
          let A = bufs[cur];
          if (A.key !== key || A.done < nStatic) {
            const B = bufs[1 - cur];
            if (B.key === key && B.done >= nStatic) {
              cur = 1 - cur; // 미리 그려 둔 버퍼로 교체
              A = B;
            } else {
              clearBuf(A);
              for (let k = 0; k < nStatic; k++) paintStroke(A.ctx, strokes[k], amp, layers);
              A.done = nStatic;
              A.key = key;
            }
          }
          // 다음 epoch 미리 그리기
          const fps = params.jitterFps ?? 10;
          const nextNow = ((epochOf(nowMs, fps) + 1) * 1000) / fps + 0.5;
          const nextStrokes = composePortrait(partStates(), params, nextNow);
          const nextKey = `${staticSignature(nextStrokes, nStatic)}${tail}`;
          const B = bufs[1 - cur];
          if (B.key !== nextKey) {
            clearBuf(B);
            B.key = nextKey;
          }
          const stepN = Math.max(1, Math.ceil(nStatic / 4));
          for (let k = 0; k < stepN && B.done < nStatic; k++) paintStroke(B.ctx, nextStrokes[B.done++], amp, layers);
          ctx.drawImage(bufs[cur].canvas, 0, 0);
          cached = true;
        }
      }
      if (cached) {
        for (let k = 0; k < nStatic; k++) if (strokes[k].vis > 0.003) drawn++;
        i = nStatic;
      }
      for (; i < strokes.length; i++) {
        const s = strokes[i];
        if (s.vis > 0.003 && s.alpha > 0.003) drawn++;
        paintStroke(ctx, s, amp, layers);
      }
    } finally {
      ctx.restore(); // 예외가 나도 clip·변환 상태를 바깥(main.js)에 남기지 않는다
    }
    strokeCount = drawn;
  }

  function info() {
    return { fadeLevel: fade.L, phase: fadePhase(fade), strokes: strokeCount };
  }

  return { update, draw, info, _partStates: partStates };
}
