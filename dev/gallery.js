// 초상 갤러리 (개발 서버 전용). 글자 라벨 없이 격자만 그린다.
//   열: t ∈ {-1, -0.5, 0, 0.5, 1}
//   행: 중립 / p=+1 / p=-1 / r=+1 / k=1 / 왼쪽 눈 깜빡임 + 입 벌림
// 쿼리: ?scale=0.2        셀 배율 (기본 0.2)
//       ?rows=0,2         일부 행만
//       ?single&t=0.6&p=0&r=0&k=0&bl=0&br=0&jaw=0&scale=0.8   한 장만 크게
//       ?anim             초당 jitterFps 번 다시 그려 꿈틀거림 확인 (기본: 한 번만)
//       ?seq              빠른 회전(0.3초) 후 정지 시퀀스 — 부품 시간차가 어긋났다 맞춰지는 8프레임
//       ?<params 키>=값   예) ?jitterAmp=6&strokeLayers=2&lagScale=2
// 모든 셀은 snap:true 로 맞춘 독립 인스턴스를 쓴다 (정적 레이어 캐시 끔).

import { createPortrait, composePortrait, drawStrokes } from '../src/render/portrait.js';
import { createParams } from '../src/config/params.js';
import { ART_W, ART_H } from '../src/contracts.js';

const q = new URLSearchParams(location.search);
const params = createParams();
for (const [k, v] of q) {
  if (k in params && typeof params[k] === 'number' && v !== '' && !Number.isNaN(+v)) params[k] = +v;
}

const TS = [-1, -0.5, 0, 0.5, 1];
const ROWS = [
  {},
  { p: 1 },
  { p: -1 },
  { r: 1 },
  { k: 1 },
  { blinkL: 1, jaw: 1 },
];

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const num = (key, d) => (q.has(key) ? +q.get(key) : d);

function signalsFor(t, extra) {
  return { present: true, t, p: 0, r: 0, k: 0, blinkL: 0, blinkR: 0, jaw: 0, ...extra };
}

function makeCell(sig) {
  const portrait = createPortrait({ cache: false });
  portrait.update(sig, params, 0, 16, { snap: true });
  return portrait;
}

let cells = [];

function build() {
  cells = [];
  if (q.has('single')) {
    const sc = num('scale', 0.8);
    const w = Math.round(ART_W * sc);
    const h = Math.round(ART_H * sc);
    canvas.width = w;
    canvas.height = h;
    const sig = signalsFor(num('t', 0), {
      p: num('p', 0),
      r: num('r', 0),
      k: num('k', 0),
      blinkL: num('bl', 0),
      blinkR: num('br', 0),
      jaw: num('jaw', 0),
    });
    cells.push({ portrait: makeCell(sig), x: 0, y: 0, w, h });
    return;
  }
  if (q.has('seq')) {
    buildSequence();
    return;
  }
  const sc = num('scale', 0.2);
  const cw = Math.round(ART_W * sc);
  const ch = Math.round(ART_H * sc);
  const gap = 6;
  const rows = q.has('rows') ? q.get('rows').split(',').map((s) => +s) : ROWS.map((_, i) => i);
  canvas.width = TS.length * cw + (TS.length + 1) * gap;
  canvas.height = rows.length * ch + (rows.length + 1) * gap;
  rows.forEach((ri, r) => {
    TS.forEach((t, c) => {
      cells.push({
        portrait: makeCell(signalsFor(t, ROWS[ri] || {})),
        x: gap + c * (cw + gap),
        y: gap + r * (ch + gap),
        w: cw,
        h: ch,
      });
    });
  });
}

/** 빠른 회전 → 정지 시퀀스: 시간차(코·입·귀·머리카락이 늦게 따라옴)를 한 장에 모아 본다. */
function buildSequence() {
  const sc = num('scale', 0.2);
  const cw = Math.round(ART_W * sc);
  const ch = Math.round(ART_H * sc);
  const gap = 6;
  const frames = [0, 100, 200, 300, 360, 450, 600, 900]; // ms (회전 0→0.3s, 이후 정지)
  const portrait = createPortrait({ cache: false });
  portrait.update(signalsFor(-1), params, 0, 16, { snap: true });
  canvas.width = 4 * cw + 5 * gap;
  canvas.height = 2 * ch + 3 * gap;
  const dt = 1000 / 60;
  let now = 0;
  frames.forEach((ms, i) => {
    while (now < ms) {
      now += dt;
      portrait.update(signalsFor(-1 + 2 * Math.min(1, now / 300)), params, now, dt);
    }
    cells.push({
      frozen: portrait._partStates(true), // 그 시점의 부품 상태를 복사해 둔다
      x: gap + (i % 4) * (cw + gap),
      y: gap + Math.floor(i / 4) * (ch + gap),
      w: cw,
      h: ch,
      at: now,
    });
  });
}

let lastEpoch = -1;
function render(now) {
  ctx.fillStyle = '#101114';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const t0 = performance.now();
  for (const c of cells) {
    if (c.portrait) c.portrait.draw({ drawingContext: ctx }, params, now, c.x, c.y, c.w, c.h);
    else drawStrokes(ctx, composePortrait(c.frozen, params, now), params, c.x, c.y, c.w, c.h);
  }
  window.__galleryStats = { ms: performance.now() - t0, cells: cells.length };
}

function loop(ts) {
  const epoch = Math.floor((ts / 1000) * params.jitterFps);
  if (epoch !== lastEpoch) {
    lastEpoch = epoch;
    render(ts);
  }
  requestAnimationFrame(loop);
}

build();
render(q.has('t0') ? num('t0', 0) : 1234);
if (q.has('anim')) requestAnimationFrame(loop);

window.__gallery = { rebuild: build, render, params };
