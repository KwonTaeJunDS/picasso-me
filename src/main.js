// Picasso Me — 앱 진입점. 1080×1920 캔버스(p5 인스턴스 모드)에 위 40% 웹캠 + 아래 60% 초상을 그린다.
//
// URL 옵션
//   ?mock                       카메라·모델 없이 반복 타임라인 신호 (&at=초 로 중간부터)
//   ?mock=static&t=0.8&k=0.5    고정값 (t p r k bl br jaw face)
//   ?debugpose                  원시 행렬·각도·랜드마크 부호를 1초마다 콘솔에 출력
// 단축키: H 패널, C 기준 거리, F 전체화면.   디버그 핸들: window.__picasso

import p5 from 'p5';
import { CANVAS_W, CANVAS_H, CAM_H, ART_Y, ART_W, ART_H } from './contracts.js';
import { createParams } from './config/params.js';
import { createPortrait } from './render/portrait.js';
import { installLayout, drawWebcam } from './render/layout.js';
import { createTracker } from './tracking/faceTracker.js';
import { createMockTracker, isMockRequested } from './tracking/mock.js';
import { createStore } from './ui/store.js';
import { createPanel, installShortcuts, installCursorAutoHide, toggleFullscreen } from './ui/panel.js';

const CAM_PLACEHOLDER = '#262626'; // mock·로딩 중 웹캠 영역
const ART_BASE = '#4A8FF0'; // 그림 영역 바탕(렌더러가 덮어쓰지 못한 곳 대비)

const search = location.search;
const store = createStore();
const params = createParams(store.load());
const mock = isMockRequested(search);
const tracker = mock ? createMockTracker(params, search) : createTracker(params, { search });
const portrait = createPortrait();
const snapPortrait = mock && tracker.mock?.mode === 'static'; // 고정값 확인용: 페이드·시간차 없이 즉시 표시

function calibrate() {
  const ok = tracker.calibrate();
  console.info(ok ? '[기준 거리] 현재 거리로 저장했습니다.' : '[기준 거리] 얼굴이 감지되지 않아 무시했습니다.');
}

function restartCamera() {
  Promise.resolve(tracker.restartCamera?.())
    .then(() => panel.setCameras())
    .catch((err) => console.error('[camera] 재시작 실패', err));
}

const panel = createPanel({
  params,
  store,
  onCalibrate: calibrate,
  onCameraChange: restartCamera,
  getCameras: () => tracker.cameras ?? [],
  getCameraLabel: () => tracker.cameraLabel ?? '',
  isCameraError: () => tracker.status === 'error',
});
installShortcuts({ panel: () => panel.toggle(), calibrate, fullscreen: () => toggleFullscreen() });
installCursorAutoHide({ isBlocked: () => panel.visible });

// ---- 측정·보호 ----------------------------------------------------------------------------
const stats = { fps: 0, drawMs: 0, frames: 0, since: performance.now(), lastPanel: 0 };
const lastLogged = new Map();

/** 렌더러 오류가 루프를 죽이지 않게 한다 (p5 는 draw 가 throw 하면 다음 프레임을 예약하지 않는다) */
function guard(label, fn) {
  try {
    fn();
  } catch (err) {
    const now = performance.now();
    if (now - (lastLogged.get(label) ?? -Infinity) > 2000) {
      lastLogged.set(label, now);
      console.error(`[${label}]`, err);
    }
  }
}

/** loading/error 상태에서만 그림 영역 가운데에 작은 글자 한 줄 */
function drawStatusText(ctx, text) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 30;
  const setFont = () => (ctx.font = `${size}px "Segoe UI", "Malgun Gothic", sans-serif`);
  setFont();
  while (size > 16 && ctx.measureText(text).width > ART_W - 120) {
    size -= 2;
    setFont();
  }
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#F4F1EA';
  ctx.fillText(text, ART_W / 2, ART_Y + ART_H / 2);
  ctx.restore();
}

/** 한 프레임을 그린다 (p.draw 가 guard 로 감싸 호출) */
function drawFrame(p, t0, dt) {
  const frame = tracker.poll(t0);
  const ctx = p.drawingContext;

  // 위: 웹캠 (cover 크롭·거울). 카메라가 없거나 mock 이면 짙은 회색 단색
  const showedCam = frame.status !== 'error' && drawWebcam(ctx, tracker.video, 0, 0, CANVAS_W, CAM_H);
  if (!showedCam) {
    ctx.fillStyle = CAM_PLACEHOLDER;
    ctx.fillRect(0, 0, CANVAS_W, CAM_H);
  }

  // 아래: 초상. 그림 영역 밖으로 번지지 않게 잘라낸다. 예외가 나도 restore 는 보장한다
  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(0, ART_Y, ART_W, ART_H);
    ctx.clip();
    ctx.fillStyle = ART_BASE;
    ctx.fillRect(0, ART_Y, ART_W, ART_H);
    guard('portrait', () => {
      portrait.update(frame.signals, params, t0, dt, { snap: snapPortrait && frame.signals.present });
      portrait.draw(p, params, t0, 0, ART_Y, ART_W, ART_H);
    });
  } finally {
    ctx.restore();
  }

  if (frame.status === 'loading') drawStatusText(ctx, 'Loading…');
  else if (frame.status === 'error') drawStatusText(ctx, frame.error || '오류가 발생했습니다');

  // 측정 → 패널 정보
  const t1 = performance.now();
  stats.drawMs += (t1 - t0 - stats.drawMs) * 0.1;
  stats.frames++;
  if (t1 - stats.since >= 500) {
    stats.fps = (stats.frames * 1000) / (t1 - stats.since);
    stats.frames = 0;
    stats.since = t1;
  }
  if (panel.visible && t1 - stats.lastPanel >= 250) {
    stats.lastPanel = t1;
    const m = frame.metrics;
    let strokes = 0;
    guard('portrait.info', () => (strokes = portrait.info?.().strokes ?? 0));
    panel.update({
      fps: stats.fps,
      drawMs: stats.drawMs,
      detectMs: m.detectMs,
      yaw: m.yawDeg,
      pitch: m.pitchDeg,
      roll: m.rollDeg,
      proximity: m.proximity,
      faces: m.faces,
      strokes,
      mainMs: m.mainMs ?? 0,
      delegate: m.delegate ?? '-',
      detector: m.detector ?? '-',
      camera: m.camera,
    });
  }
}

p5.disableFriendlyErrors = true;

// 카메라 권한·모델 로딩은 p5 초기화(load 이벤트 대기)와 병렬로 먼저 시작한다. 실패해도 throw 하지 않고 status='error'.
tracker
  .start()
  .then(() => panel.setCameras())
  .catch((err) => console.error('[tracker] 시작 실패', err));

new p5((p) => {
  let lastNow = 0;

  p.setup = () => {
    p.createCanvas(CANVAS_W, CANVAS_H);
    p.pixelDensity(1); // 내부 해상도는 화면 배율과 무관하게 1080×1920 고정
    p.frameRate(60);
    installLayout(p.canvas); // pixelDensity 가 CSS 크기를 건드리므로 그 뒤에 맞춘다
  };

  p.draw = () => {
    const t0 = performance.now();
    const dt = lastNow ? Math.min(t0 - lastNow, 100) : 1000 / 60;
    lastNow = t0;
    guard('draw', () => drawFrame(p, t0, dt));
  };
}, document.getElementById('stage'));

window.__picasso = { params, tracker, portrait, panel, stats };
