import { describe, it, expect, vi } from 'vitest';
import { brushPoly, brushLine, brushBlob, layerAlpha, strokeSeed, BRUSH } from '../src/render/brush.js';
import { epochOf, hashStr } from '../src/render/noise.js';

/** 그리기 호출을 기록하는 가짜 ctx */
function makeCtx() {
  const fills = [];
  let path = [];
  const ctx = {
    fillStyle: '#000',
    globalAlpha: 1,
    beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    closePath() {},
    fill() { fills.push({ color: this.fillStyle, alpha: this.globalAlpha, pts: path }); },
  };
  return { ctx, fills };
}

const SQUARE = [100, 100, 400, 100, 400, 300, 100, 300];

function distToPolygon(x, y, poly) {
  let best = Infinity;
  const m = poly.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = poly[2 * i], ay = poly[2 * i + 1], bx = poly[2 * j], by = poly[2 * j + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

const finite = (pts) => pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

describe('layerAlpha', () => {
  it('겹 누적 불투명도 ≈ 0.92', () => {
    for (const L of [1, 2, 3, 4, 6]) {
      const a = layerAlpha(0.92, L);
      expect(1 - Math.pow(1 - a, L)).toBeCloseTo(0.92, 6);
    }
    expect(layerAlpha(0, 3)).toBeCloseTo(0, 9);
  });
});

describe('brushPoly', () => {
  it('strokeLayers 만큼 칠하고 누적 불투명도가 0.92', () => {
    for (const layers of [1, 3, 5]) {
      const { ctx, fills } = makeCtx();
      brushPoly(ctx, SQUARE, '#E5402E', { seed: 1, amp: 3, layers, opacity: BRUSH.opacity });
      expect(fills.length).toBe(layers);
      let transmit = 1;
      for (const f of fills) {
        expect(f.color).toBe('#E5402E');
        transmit *= 1 - f.alpha;
      }
      expect(1 - transmit).toBeCloseTo(0.92, 5);
    }
  });

  it('같은 시드면 완전히 같고, 시드(epoch)가 다르면 모양이 다르다', () => {
    const run = (seed) => {
      const { ctx, fills } = makeCtx();
      brushPoly(ctx, SQUARE, '#12A3AE', { seed, amp: 3, layers: 3 });
      return fills.map((f) => f.pts);
    };
    const a = run(strokeSeed(5, hashStr('hair.0')));
    const b = run(strokeSeed(5, hashStr('hair.0')));
    const c = run(strokeSeed(6, hashStr('hair.0')));
    const d = run(strokeSeed(5, hashStr('hair.1')));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).not.toEqual(d);
    // 겹마다 모양이 다르다 (붓 자국 층)
    expect(a[0]).not.toEqual(a[1]);
  });

  it('epoch 는 초당 jitterFps 번만 바뀌므로 100ms 안의 프레임은 같은 모양', () => {
    const idHash = hashStr('face.L');
    const shape = (now) => {
      const { ctx, fills } = makeCtx();
      brushPoly(ctx, SQUARE, '#E5402E', { seed: strokeSeed(epochOf(now, 10), idHash), amp: 3, layers: 2 });
      return fills.map((f) => f.pts);
    };
    expect(shape(1010)).toEqual(shape(1090));
    expect(shape(1010)).not.toEqual(shape(1110));
  });

  it('평행 이동해도 같은 시드면 같은 일렁임 — 매 프레임 위치만 갱신', () => {
    const run = (pts) => {
      const { ctx, fills } = makeCtx();
      brushPoly(ctx, pts, '#E5402E', { seed: 77, amp: 3, layers: 1 });
      return fills[0].pts;
    };
    const base = run(SQUARE);
    const moved = run(SQUARE.map((v, i) => v + (i % 2 === 0 ? 13 : -7)));
    expect(moved.length).toBe(base.length);
    for (let i = 0; i < base.length; i++) {
      expect(moved[i][0] - base[i][0]).toBeCloseTo(13, 6);
      expect(moved[i][1] - base[i][1]).toBeCloseTo(-7, 6);
    }
  });

  it('원래 꼭짓점을 보존하고(각진 면), 변위는 amp 규모로 제한된다', () => {
    const { ctx, fills } = makeCtx();
    brushPoly(ctx, SQUARE, '#E5402E', { seed: 3, amp: 0, layers: 1 });
    const p0 = fills[0].pts;
    const hasCorner = (cx, cy) => p0.some(([x, y]) => Math.hypot(x - cx, y - cy) < 1e-9);
    expect(hasCorner(100, 100)).toBe(true);
    expect(hasCorner(400, 100)).toBe(true);
    expect(hasCorner(400, 300)).toBe(true);
    expect(hasCorner(100, 300)).toBe(true);
    // 간격 ≤ spacing
    for (let i = 0; i < p0.length; i++) {
      const q = p0[(i + 1) % p0.length];
      expect(Math.hypot(p0[i][0] - q[0], p0[i][1] - q[1])).toBeLessThanOrEqual(BRUSH.spacing + 1e-6);
    }
    for (const amp of [1, 3, 6, 10]) {
      const c = makeCtx();
      brushPoly(c.ctx, SQUARE, '#E5402E', { seed: 9, amp, layers: 3 });
      let maxD = 0;
      for (const f of c.fills) for (const [x, y] of f.pts) maxD = Math.max(maxD, distToPolygon(x, y, SQUARE));
      expect(maxD).toBeLessThan(amp * 1.6 + 0.01);
      if (amp >= 3) expect(maxD).toBeGreaterThan(amp * 0.3); // 실제로 흔들린다
    }
  });

  it('NaN 이 없다 (겹친 점·2점·0점·큰 좌표)', () => {
    const cases = [
      [0, 0, 0, 0, 0, 0],
      [0, 0, 10, 0],
      [],
      [5, 5, 5, 5, 100, 5, 100, 5, 50, 80],
      [1e5, 1e5, 1e5 + 50, 1e5, 1e5 + 50, 1e5 + 50],
    ];
    for (const pts of cases) {
      const { ctx, fills } = makeCtx();
      brushPoly(ctx, pts, '#E5402E', { seed: 1, amp: 5, layers: 3 });
      for (const f of fills) expect(finite(f.pts)).toBe(true);
    }
  });

  it('Math.random 을 쓰지 않는다', () => {
    const spy = vi.spyOn(Math, 'random');
    const { ctx } = makeCtx();
    brushPoly(ctx, SQUARE, '#E5402E', { seed: 1, amp: 3, layers: 3 });
    brushLine(ctx, [0, 0, 50, 20, 120, 10, 200, 40], '#F4F1EA', 4, 9, { seed: 1, amp: 3, layers: 3 });
    brushBlob(ctx, 100, 100, 50, 40, 0.3, '#12A3AE', { seed: 1, amp: 3, layers: 3, shapeSeed: 5 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('brushLine (테이퍼 선)', () => {
  const PTS = [100, 300, 200, 250, 320, 255, 450, 300];

  it('양 끝이 가늘고 가운데는 wMin~wMax 범위', () => {
    const { ctx, fills } = makeCtx();
    brushLine(ctx, PTS, '#F4F1EA', 4, 10, { seed: 1, amp: 0, layers: 1 });
    expect(fills.length).toBe(1);
    const p = fills[0].pts;
    const n = p.length / 2;
    const width = (i) => Math.hypot(p[i][0] - p[p.length - 1 - i][0], p[i][1] - p[p.length - 1 - i][1]);
    expect(finite(p)).toBe(true);
    const mid = width(Math.floor(n / 2));
    expect(mid).toBeGreaterThan(3);
    expect(mid).toBeLessThan(10 * 1.4);
    expect(width(0)).toBeLessThan(mid * 0.35);
    expect(width(n - 1)).toBeLessThan(mid * 0.35);
  });

  it('frac 로 앞부분만 그린다', () => {
    const full = makeCtx();
    brushLine(full.ctx, PTS, '#F4F1EA', 4, 10, { seed: 1, amp: 0, layers: 1 });
    const half = makeCtx();
    brushLine(half.ctx, PTS, '#F4F1EA', 4, 10, { seed: 1, amp: 0, layers: 1, frac: 0.5 });
    const maxX = (f) => Math.max(...f.fills[0].pts.map((q) => q[0]));
    expect(maxX(half)).toBeLessThan(maxX(full) - 60);
    const none = makeCtx();
    brushLine(none.ctx, PTS, '#F4F1EA', 4, 10, { seed: 1, amp: 0, layers: 1, frac: 0 });
    expect(none.fills.length).toBe(0);
  });

  it('겹수만큼 칠하고 시드 결정성', () => {
    const run = (seed) => {
      const c = makeCtx();
      brushLine(c.ctx, PTS, '#F4F1EA', 4, 10, { seed, amp: 3, layers: 3 });
      return c.fills;
    };
    const a = run(5), b = run(5), c = run(6);
    expect(a.length).toBe(3);
    expect(a.map((f) => f.pts)).toEqual(b.map((f) => f.pts));
    expect(a.map((f) => f.pts)).not.toEqual(c.map((f) => f.pts));
  });

  it('너무 짧거나 점 1개면 아무것도 그리지 않고 NaN 도 없다', () => {
    for (const pts of [[], [1, 1], [1, 1, 1, 1], [0, 0, 1, 1]]) {
      const c = makeCtx();
      brushLine(c.ctx, pts, '#F4F1EA', 4, 10, { seed: 1, amp: 3, layers: 3 });
      for (const f of c.fills) expect(finite(f.pts)).toBe(true);
    }
  });
});

describe('brushBlob', () => {
  it('완벽한 원이 아니다 (lump 가 있으면 반지름이 변함)', () => {
    const radii = (lump) => {
      const c = makeCtx();
      brushBlob(c.ctx, 200, 200, 80, 80, 0, '#12A3AE', { seed: 1, amp: 0, layers: 1, lump, shapeSeed: 11 });
      return c.fills[0].pts.map(([x, y]) => Math.hypot(x - 200, y - 200));
    };
    const spread = (r) => Math.max(...r) - Math.min(...r);
    expect(spread(radii(0))).toBeLessThan(0.5);
    expect(spread(radii(0.12))).toBeGreaterThan(3);
  });

  it('회전·타원 반지름이 반영되고 NaN 이 없다', () => {
    const c = makeCtx();
    brushBlob(c.ctx, 100, 100, 120, 30, Math.PI / 2, '#12A3AE', { seed: 2, amp: 3, layers: 3, lump: 0.1 });
    const pts = c.fills[0].pts;
    expect(finite(pts)).toBe(true);
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    // 90° 회전 → 세로로 긴 타원
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(Math.max(...xs) - Math.min(...xs));
    const z = makeCtx();
    brushBlob(z.ctx, 0, 0, 0, 0, 0, '#12A3AE', { seed: 2, amp: 3, layers: 3 });
    for (const f of z.fills) expect(finite(f.pts)).toBe(true);
  });
});

describe('jitterAmp 에 따른 에포크 변화 (스톱모션 진폭 0 이면 정지)', () => {
  const idHash = hashStr('hair.0');
  const LINE = [100, 300, 200, 250, 320, 255, 450, 300];
  const BLOB = [200, 200];

  it('brushLine: amp=0 이면 다른 epoch 시드에서도 좌표가 같고, amp>0 이면 달라진다', () => {
    const run = (seed, amp) => {
      const c = makeCtx();
      brushLine(c.ctx, LINE, '#F4F1EA', 4, 10, { seed, idHash, amp, layers: 3 });
      return c.fills.map((f) => f.pts);
    };
    const s1 = strokeSeed(epochOf(1010, 10), idHash);
    const s2 = strokeSeed(epochOf(1110, 10), idHash);
    expect(run(s1, 0)).toEqual(run(s2, 0));
    expect(run(s1, 3)).not.toEqual(run(s2, 3));
  });

  it('brushPoly: amp=0 이면 다른 epoch 시드에서도 좌표가 같고, amp>0 이면 달라진다', () => {
    const run = (seed, amp) => {
      const c = makeCtx();
      brushPoly(c.ctx, SQUARE, '#E5402E', { seed, idHash, amp, layers: 3 });
      return c.fills.map((f) => f.pts);
    };
    const s1 = strokeSeed(epochOf(1010, 10), idHash);
    const s2 = strokeSeed(epochOf(1110, 10), idHash);
    expect(run(s1, 0)).toEqual(run(s2, 0));
    expect(run(s1, 3)).not.toEqual(run(s2, 3));
  });

  it('brushBlob: amp=0 이면 다른 epoch 시드에서도 좌표가 같고, amp>0 이면 달라진다', () => {
    const run = (seed, amp) => {
      const c = makeCtx();
      brushBlob(c.ctx, BLOB[0], BLOB[1], 60, 45, 0.2, '#12A3AE', { seed, shapeSeed: idHash, amp, layers: 3 });
      return c.fills.map((f) => f.pts);
    };
    const s1 = strokeSeed(epochOf(1010, 10), idHash);
    const s2 = strokeSeed(epochOf(1110, 10), idHash);
    expect(run(s1, 0)).toEqual(run(s2, 0));
    expect(run(s1, 3)).not.toEqual(run(s2, 3));
  });
});
