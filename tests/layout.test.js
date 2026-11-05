import { describe, it, expect, vi } from 'vitest';
import { coverCrop, fitCanvas, drawWebcam, applyCanvasLayout, installLayout } from '../src/render/layout.js';
import { CANVAS_W, CANVAS_H, CAM_H } from '../src/contracts.js';

describe('coverCrop (웹캠 → 1080×768 cover)', () => {
  it('16:9 1280×720 → 좌우를 가운데 기준으로 자른다', () => {
    const c = coverCrop(1280, 720, CANVAS_W, CAM_H);
    expect(c.sh).toBeCloseTo(720, 8);
    expect(c.sw).toBeCloseTo(720 * (1080 / 768), 8); // 1012.5
    expect(c.sx).toBeCloseTo((1280 - 1012.5) / 2, 8); // 133.75
    expect(c.sy).toBe(0);
  });

  it('4:3 640×480 → 위아래를 자른다', () => {
    const c = coverCrop(640, 480, CANVAS_W, CAM_H);
    expect(c.sw).toBe(640);
    expect(c.sh).toBeCloseTo(640 / (1080 / 768), 8); // 455.11
    expect(c.sx).toBe(0);
    expect(c.sy).toBeCloseTo((480 - c.sh) / 2, 8);
  });

  it('세로 영상 720×1280 도 cover', () => {
    const c = coverCrop(720, 1280, CANVAS_W, CAM_H);
    expect(c.sw).toBe(720);
    expect(c.sh).toBeCloseTo(512, 8);
    expect(c.sy).toBeCloseTo(384, 8);
  });

  it('비율이 같으면 전체', () => {
    expect(coverCrop(540, 384, CANVAS_W, CAM_H)).toEqual({ sx: 0, sy: 0, sw: 540, sh: 384 });
  });

  it('항상 목적지 비율, 원본 안쪽, 가운데 정렬', () => {
    for (const [w, h] of [[1280, 720], [1920, 1080], [640, 480], [800, 800], [352, 288], [720, 1280], [1000, 3000]]) {
      const c = coverCrop(w, h, CANVAS_W, CAM_H);
      expect(c.sw / c.sh).toBeCloseTo(CANVAS_W / CAM_H, 8);
      expect(c.sx).toBeGreaterThanOrEqual(-1e-9);
      expect(c.sy).toBeGreaterThanOrEqual(-1e-9);
      expect(c.sx + c.sw).toBeLessThanOrEqual(w + 1e-9);
      expect(c.sy + c.sh).toBeLessThanOrEqual(h + 1e-9);
      expect(c.sx * 2 + c.sw).toBeCloseTo(w, 8);
      expect(c.sy * 2 + c.sh).toBeCloseTo(h, 8);
    }
  });

  it('잘못된 크기는 null', () => {
    expect(coverCrop(0, 720, 1080, 768)).toBeNull();
    expect(coverCrop(1280, 0, 1080, 768)).toBeNull();
    expect(coverCrop(1280, 720, 0, 768)).toBeNull();
    expect(coverCrop(NaN, 720, 1080, 768)).toBeNull();
  });
});

describe('fitCanvas (창 크기에 맞춘 CSS 크기)', () => {
  it('가로로 넓은 창: 높이에 맞추고 좌우 가운데', () => {
    const m = fitCanvas(1920, 1080);
    expect(m.scale).toBeCloseTo(1080 / 1920, 10);
    expect(m.height).toBe(1080);
    expect(m.width).toBe(607); // floor(1080 × 0.5625)
    expect(m.left).toBe(Math.floor((1920 - 607) / 2));
    expect(m.top).toBe(0);
  });

  it('세로로 긴 창: 너비에 맞추고 위아래 가운데', () => {
    const m = fitCanvas(600, 1200);
    expect(m.scale).toBeCloseTo(600 / 1080, 10);
    expect(m.width).toBe(600);
    expect(m.height).toBe(Math.floor(1920 * (600 / 1080)));
    expect(m.left).toBe(0);
    expect(m.top).toBe(Math.floor((1200 - m.height) / 2));
  });

  it('정확히 1080×1920 이면 배율 1', () => {
    expect(fitCanvas(1080, 1920)).toEqual({ scale: 1, width: 1080, height: 1920, left: 0, top: 0 });
  });

  it('scale = min(innerW/1080, innerH/1920) 이고 화면을 넘지 않는다', () => {
    for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440], [390, 844], [1080, 1080], [333, 777]]) {
      const m = fitCanvas(w, h);
      expect(m.scale).toBeCloseTo(Math.min(w / CANVAS_W, h / CANVAS_H), 10);
      expect(m.width).toBeLessThanOrEqual(w);
      expect(m.height).toBeLessThanOrEqual(h);
      expect(m.width / m.height).toBeCloseTo(CANVAS_W / CANVAS_H, 1);
      expect(Math.abs(m.left * 2 + m.width - w)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.top * 2 + m.height - h)).toBeLessThanOrEqual(1);
    }
  });

  it('크기가 0이거나 이상하면 0×0', () => {
    for (const [w, h] of [[0, 0], [-5, 100], [NaN, NaN], [undefined, 100]]) {
      const m = fitCanvas(w, h);
      expect(m.width).toBe(0);
      expect(m.height).toBe(0);
    }
  });
});

describe('drawWebcam', () => {
  function fakeCtx() {
    const calls = [];
    const rec = (name) => (...args) => calls.push([name, ...args]);
    return { calls, save: rec('save'), restore: rec('restore'), translate: rec('translate'), scale: rec('scale'), drawImage: rec('drawImage') };
  }

  it('cover 크롭한 9인자 drawImage 를 좌우 반전으로 그린다', () => {
    const ctx = fakeCtx();
    const video = { readyState: 4, videoWidth: 1280, videoHeight: 720 };
    expect(drawWebcam(ctx, video, 0, 0, 1080, 768)).toBe(true);
    const names = ctx.calls.map((c) => c[0]);
    expect(names).toEqual(['save', 'translate', 'scale', 'drawImage', 'restore']);
    expect(ctx.calls[1]).toEqual(['translate', 1080, 0]); // 오른쪽 끝에서
    expect(ctx.calls[2]).toEqual(['scale', -1, 1]); // 좌우 반전
    const [, v, sx, sy, sw, sh, dx, dy, dw, dh] = ctx.calls[3];
    expect(v).toBe(video);
    expect(sx).toBeCloseTo(133.75, 8);
    expect(sy).toBe(0);
    expect(sw).toBeCloseTo(1012.5, 8);
    expect(sh).toBeCloseTo(720, 8);
    expect([dx, dy, dw, dh]).toEqual([0, 0, 1080, 768]);
  });

  it('x, y 오프셋을 반영한다', () => {
    const ctx = fakeCtx();
    drawWebcam(ctx, { readyState: 4, videoWidth: 640, videoHeight: 480 }, 10, 20, 200, 100);
    expect(ctx.calls[1]).toEqual(['translate', 210, 20]);
  });

  it('비디오가 준비되지 않았으면 그리지 않고 false', () => {
    const ctx = fakeCtx();
    expect(drawWebcam(ctx, null, 0, 0, 1080, 768)).toBe(false);
    expect(drawWebcam(ctx, { readyState: 1, videoWidth: 1280, videoHeight: 720 }, 0, 0, 1080, 768)).toBe(false);
    expect(drawWebcam(ctx, { readyState: 4, videoWidth: 0, videoHeight: 0 }, 0, 0, 1080, 768)).toBe(false);
    expect(ctx.calls).toEqual([]);
  });
});

describe('applyCanvasLayout / installLayout', () => {
  function fakeEnv(w, h) {
    const win = {
      innerWidth: w,
      innerHeight: h,
      listeners: {},
      addEventListener(type, fn) {
        (this.listeners[type] ??= new Set()).add(fn);
      },
      removeEventListener(type, fn) {
        this.listeners[type]?.delete(fn);
      },
      requestAnimationFrame: vi.fn(),
      setTimeout: vi.fn(),
    };
    const doc = { listeners: {}, addEventListener: win.addEventListener, removeEventListener: win.removeEventListener };
    const canvas = { style: {} };
    return { win, doc, canvas };
  }

  it('캔버스 CSS 크기·위치를 창에 맞춘다', () => {
    const { win, canvas } = fakeEnv(1920, 1080);
    const m = applyCanvasLayout(canvas, win);
    expect(canvas.style.width).toBe(`${m.width}px`);
    expect(canvas.style.height).toBe('1080px');
    expect(canvas.style.left).toBe(`${m.left}px`);
    expect(canvas.style.top).toBe('0px');
    expect(canvas.style.position).toBe('absolute');
  });

  it('resize·fullscreenchange 때 다시 계산하고, 해제하면 리스너가 사라진다', () => {
    const { win, doc, canvas } = fakeEnv(1920, 1080);
    const dispose = installLayout(canvas, { win, doc });
    expect(canvas.style.height).toBe('1080px');
    expect(win.listeners.resize.size).toBe(1);
    expect(doc.listeners.fullscreenchange.size).toBe(1);

    win.innerWidth = 1080;
    win.innerHeight = 1920;
    [...win.listeners.resize][0]();
    expect(canvas.style.width).toBe('1080px');
    expect(canvas.style.height).toBe('1920px');
    // 전체화면 직후 늦게 바뀌는 크기를 위해 다음 프레임·잠시 뒤에도 재계산을 예약한다
    expect(win.requestAnimationFrame).toHaveBeenCalled();
    expect(win.setTimeout).toHaveBeenCalled();

    win.innerWidth = 540;
    win.innerHeight = 2000;
    [...doc.listeners.fullscreenchange][0]();
    expect(canvas.style.width).toBe('540px');

    dispose();
    expect(win.listeners.resize.size).toBe(0);
    expect(doc.listeners.fullscreenchange.size).toBe(0);
  });
});
