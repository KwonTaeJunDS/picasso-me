// 9:16 분할 레이아웃 보조: 웹캠 cover 크롭·거울 그리기, 캔버스 CSS 크기 맞춤. 계산은 순수 함수라 DOM 없이 테스트한다.

import { CANVAS_W, CANVAS_H } from '../contracts.js';

/**
 * 원본 srcW×srcH 영상을 dstW×dstH 영역에 꽉 채우도록(cover) 가운데 기준으로 자를 원본 사각형.
 * 잘못된 크기면 null.
 */
export function coverCrop(srcW, srcH, dstW, dstH) {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return null;
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  let sw = srcW;
  let sh = srcH;
  if (srcAspect > dstAspect) sw = srcH * dstAspect; // 원본이 더 넓음 → 좌우를 자름
  else sh = srcW / dstAspect; // 원본이 더 좁음 → 위아래를 자름
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

/**
 * 창(innerW×innerH)에 캔버스를 비율 유지로 맞추는 CSS 크기·위치.
 * scale = min(innerW/cw, innerH/ch), 가운데 정렬(남는 여백은 검정 배경).
 */
export function fitCanvas(innerW, innerH, cw = CANVAS_W, ch = CANVAS_H) {
  const w = Math.max(0, innerW || 0);
  const h = Math.max(0, innerH || 0);
  const scale = Math.min(w / cw, h / ch);
  const width = Math.floor(cw * scale + 1e-6); // 부동소수점 오차로 1px 줄어드는 것 방지
  const height = Math.floor(ch * scale + 1e-6);
  return { scale, width, height, left: Math.floor((w - width) / 2), top: Math.floor((h - height) / 2) };
}

/** 웹캠 프레임을 (x,y,w,h)에 cover 크롭 + 좌우 반전으로 그린다. 그릴 수 없으면 false */
export function drawWebcam(ctx, video, x, y, w, h) {
  if (!video || video.readyState < 2) return false;
  const crop = coverCrop(video.videoWidth, video.videoHeight, w, h);
  if (!crop) return false;
  ctx.save();
  ctx.translate(x + w, y); // 거울: 오른쪽 끝에서 왼쪽으로 뒤집어 그린다
  ctx.scale(-1, 1);
  ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
  ctx.restore();
  return true;
}

/** 캔버스 CSS 크기를 창에 맞춘다 */
export function applyCanvasLayout(canvas, win = window) {
  const m = fitCanvas(win.innerWidth, win.innerHeight);
  const s = canvas.style;
  s.position = 'absolute';
  s.width = `${m.width}px`;
  s.height = `${m.height}px`;
  s.left = `${m.left}px`;
  s.top = `${m.top}px`;
  return m;
}

/**
 * resize/fullscreenchange 때 다시 계산한다. 전체화면 전환 직후에는 innerWidth/Height 가 늦게 바뀌므로
 * 다음 프레임과 잠시 뒤에도 한 번 더 맞춘다. 반환값은 해제 함수.
 */
export function installLayout(canvas, { win = window, doc = document } = {}) {
  const apply = () => applyCanvasLayout(canvas, win);
  const applyLater = () => {
    apply();
    win.requestAnimationFrame?.(apply);
    win.setTimeout(apply, 150);
  };
  apply();
  win.addEventListener('resize', applyLater);
  doc.addEventListener('fullscreenchange', applyLater);
  return () => {
    win.removeEventListener('resize', applyLater);
    doc.removeEventListener('fullscreenchange', applyLater);
  };
}
