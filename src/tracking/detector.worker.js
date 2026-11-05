// 얼굴 검출 워커. FaceLandmarker 를 이 스레드에서 돌려 메인 스레드(렌더)를 비운다.
//
// 메시지 (메인 ↔ 워커)
//   → {type:'init', wasmPath, modelPath, numFaces, delegates}        ← {type:'ready', delegate} | {type:'initError', message}
//   → {type:'detect', id, bitmap}   (bitmap 은 transfer)             ← {type:'result', id, sample, detectMs, delegate} | {type:'detectError', id, message}
//   → {type:'close'}
// sample 은 extract.extractSample() 결과(작은 객체). 시각(at)은 메인이 도착 시점으로 채운다.
// 모듈 워커에는 importScripts 가 없으므로 wasm 로더는 ES 모듈 변형(useModule=true)을 쓴다.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { extractSample } from './extract.js';
import { installNetGuard } from './netGuard.js';

installNetGuard(self);

const GPU_FAIL_LIMIT = 3; // GPU 검출이 연속 실패하면 CPU 로 다시 만든다

// Vite 개발 서버는 '/'로 시작하는 동적 import 에 ?import 를 붙여 public 파일을 500 으로 만들므로 절대 URL로 바꾼다
const abs = (path) => new URL(path, self.location.href).href;

let cfg = null;
let fileset = null;
let landmarker = null;
let delegate = '';
let lastTs = 0;
let failStreak = 0;
let recreating = null;

const post = (msg) => self.postMessage(msg);
const errText = (err) => String(err?.message ?? err);

async function create(delegates) {
  fileset ??= await FilesetResolver.forVisionTasks(abs(cfg.wasmPath), true);
  let lastError = null;
  for (const d of delegates) {
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: abs(cfg.modelPath), delegate: d },
        runningMode: 'VIDEO',
        numFaces: cfg.numFaces,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
      delegate = d;
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[detector.worker] ${d} delegate 생성 실패`, err);
    }
  }
  throw lastError ?? new Error('FaceLandmarker 생성 실패');
}

async function init(msg) {
  cfg = msg;
  try {
    await create(msg.delegates?.length ? msg.delegates : ['GPU', 'CPU']);
    post({ type: 'ready', delegate });
  } catch (err) {
    post({ type: 'initError', message: errText(err) });
  }
}

/** 실행 중 GPU 검출이 계속 실패하면 CPU 로 다시 만든다 */
async function fallbackToCpu() {
  try {
    landmarker?.close();
  } catch {
    /* 이미 깨진 인스턴스 */
  }
  landmarker = null;
  await create(['CPU']);
  failStreak = 0;
  post({ type: 'delegate', delegate });
}

async function detect({ id, bitmap }) {
  try {
    if (recreating) await recreating;
    if (!landmarker) throw new Error('모델이 준비되지 않았습니다');
    const t0 = performance.now();
    lastTs = Math.max(Math.round(t0), lastTs + 1); // 타임스탬프는 단조 증가
    const result = landmarker.detectForVideo(bitmap, lastTs);
    const detectMs = performance.now() - t0;
    failStreak = 0;
    post({ type: 'result', id, sample: extractSample(result, bitmap.width, bitmap.height, 0), detectMs, delegate });
  } catch (err) {
    failStreak++;
    post({ type: 'detectError', id, message: errText(err) });
    if (delegate === 'GPU' && failStreak >= GPU_FAIL_LIMIT && !recreating) {
      recreating = fallbackToCpu()
        .catch((e) => post({ type: 'detectError', id: -1, message: `CPU 폴백 실패: ${errText(e)}` }))
        .finally(() => (recreating = null));
    }
  } finally {
    bitmap?.close?.();
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg?.type === 'init') init(msg);
  else if (msg?.type === 'detect') detect(msg);
  else if (msg?.type === 'close') {
    try {
      landmarker?.close();
    } catch {
      /* 무시 */
    }
    landmarker = null;
    self.close();
  }
};
