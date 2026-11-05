// 실제 추적기: 카메라 → MediaPipe FaceLandmarker(VIDEO 모드) → 신호. 인터페이스는 contracts.js 의 추적기 계약을 따른다.
//
//  - 기본은 Web Worker 검출(workerDetector.js / detector.worker.js): 새 비디오 프레임이고 진행 중인 요청이 없을 때만
//    createImageBitmap(video) 를 워커로 보내고, 바쁘면 그 프레임은 건너뛴다(최신 프레임 1개만 처리).
//    워커를 못 만들거나 10초 안에 준비되지 않거나 실행 중 치명적 오류가 나면 메인 스레드 검출로 자동 전환한다(console.warn 1회).
//    ?detector=main 이면 메인 스레드 검출을 강제한다(비교용).
//  - 메인 스레드 검출(detectForVideo)은 동기 호출이라 rAF 콜백 밖의 별도 태스크(MessageChannel)에서 실행한다.
//    새 비디오 프레임이고 진행 중인 검출이 없을 때만 예약하며, 태스크가 돌 때는 항상 가장 최신 프레임을 쓴다.
//  - 원본(비반전) 영상을 넣는다. 거울 처리는 그릴 때만. (blendshape 의 Left/Right 는 피사체 기준)
//  - ?debugpose 를 붙이면 1초마다 원시 행렬·각도·랜드마크 부호를 콘솔에 JSON 한 줄로 출력한다(실기 fixture 수집용).
//  - @mediapipe/tasks-vision 은 동적 import 라서 mock 모드나 단위 테스트에서는 로딩되지 않는다.

import { TRACKING } from '../config/params.js';
import { openCamera, attachStream, stopStream, listVideoInputs, describeCameraError } from './camera.js';
import { createSignalProcessor } from './signals.js';
import { eulerFromMatrix, toScreenAngles, normalizeAngles } from './pose.js';
import { extractSample } from './extract.js';
import { createWorkerDetector } from './workerDetector.js';

// 결과 해석은 extract.js 로 옮겼다(워커와 공유). 기존 import 경로 호환을 위해 다시 내보낸다.
export { landmarkBoxArea, selectLargestFace, extractSample } from './extract.js';

const BASE = (import.meta.env && import.meta.env.BASE_URL) || '/';
export const WASM_PATH = `${BASE}wasm`;
export const MODEL_PATH = `${BASE}models/face_landmarker.task`;

const GPU_FAIL_LIMIT = 3; // GPU 검출이 연속으로 이만큼 실패하면 CPU 로 다시 만든다
const WORKER_FAIL_LIMIT = 5; // 워커 검출이 연속으로 이만큼 실패하면 메인 스레드 검출로 전환
const CPU_FAIL_LIMIT = 30; // CPU 도 이만큼 연속 실패하면 오류 상태
const RVFC_FRESH_MS = 1000; // rVFC 콜백이 이 시간 넘게 없으면 currentTime 으로 대체

// ---- 모델 -------------------------------------------------------------------------------

/**
 * FaceLandmarker 를 만든다. delegates 순서대로 시도(기본 GPU → CPU).
 * @returns {Promise<{landmarker: any, delegate: 'GPU'|'CPU'}>}
 */
export async function createLandmarker({ wasmPath = WASM_PATH, modelPath = MODEL_PATH, numFaces = TRACKING.numFaces, delegates = ['GPU', 'CPU'] } = {}) {
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(wasmPath);
  let lastError = null;
  for (const delegate of delegates) {
    try {
      const landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath, delegate },
        runningMode: 'VIDEO',
        numFaces,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
      return { landmarker, delegate };
    } catch (err) {
      lastError = err;
      console.warn(`[tracker] ${delegate} delegate 생성 실패`, err);
    }
  }
  throw lastError ?? new Error('FaceLandmarker 생성 실패');
}

// ---- 디버그 -----------------------------------------------------------------------------

/** ?debugpose: 1초마다 원시 행렬·각도·랜드마크 부호를 콘솔에 한 줄 JSON 으로 */
function createPoseDebugger(params, log = console.log) {
  let last = -Infinity;
  const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
  return (sample, now) => {
    if (now - last < 1000) return;
    last = now;
    const eul = eulerFromMatrix(sample.matrix);
    const screen = eul ? toScreenAngles(eul, params) : null;
    const norm = screen ? normalizeAngles(screen, params) : null;
    const lmYaw = sample.landmarkYaw;
    log(
      '[debugpose]',
      JSON.stringify({
        matrixColumnMajor: sample.matrix ? Array.from(sample.matrix, r4) : null,
        eulerCameraDeg: eul && { yaw: r4(eul.yaw), pitch: r4(eul.pitch), roll: r4(eul.roll) },
        normalized: norm && { t: r4(norm.t), p: r4(norm.p), r: r4(norm.r) },
        landmarkYaw: r4(lmYaw), // 코끝 x − 볼 중점 x (원본 영상 기준, + = 코가 영상 오른쪽)
        signAgree: eul && Number.isFinite(lmYaw) ? eul.yaw > 0 === lmYaw > 0 : null,
        eyeDistPx: r4(sample.eyeDistPx),
        blink: { left: r4(sample.blinkLeft), right: r4(sample.blinkRight) },
        jawOpen: r4(sample.jawOpen),
        faces: sample.faces,
      }),
    );
  };
}

/** 기본 태스크 큐: MessageChannel 로 rAF 콜백이 끝난 직후 별도 태스크에서 실행 (setTimeout 0 의 4ms 지연이 없다) */
function createTaskQueue() {
  if (typeof MessageChannel === 'undefined') return (fn) => void setTimeout(fn, 0);
  const ch = new MessageChannel();
  const q = [];
  ch.port1.onmessage = () => q.shift()?.();
  return (fn) => {
    q.push(fn);
    ch.port2.postMessage(0);
  };
}

// ---- 추적기 -----------------------------------------------------------------------------

/**
 * @param {object} params 공유 params
 * @param {string|{search?:string, deps?:object}} [options] location.search 또는 { search, deps }.
 *   deps 는 테스트용 주입(createLandmarker, createWorkerDetector, detector('worker'|'main'), openCamera, attachStream,
 *   stopStream, listVideoInputs, now, queueTask, video, log)
 */
export function createTracker(params, options = {}) {
  const opts = typeof options === 'string' ? { search: options } : options;
  const deps = {
    createLandmarker,
    createWorkerDetector,
    detector: null,
    openCamera,
    attachStream,
    stopStream,
    listVideoInputs,
    now: () => performance.now(),
    queueTask: null,
    video: null,
    log: console.log,
    ...(opts.deps ?? {}),
  };
  const debugPose = new URLSearchParams(opts.search ?? '').has('debugpose') ? createPoseDebugger(params, deps.log) : null;
  const processor = createSignalProcessor(params);

  // 검출 위치: 기본은 워커(Worker 가 있는 환경). ?detector=main 이면 메인 스레드 강제
  const forced = new URLSearchParams(opts.search ?? '').get('detector');
  let mode = forced === 'main' ? 'main' : (deps.detector ?? (typeof Worker !== 'undefined' ? 'worker' : 'main'));
  let wd = null; // 워커 클라이언트
  let switching = false;

  let video = null;
  let stream = null;
  let landmarker = null;
  let delegate = '';
  let cameraReady = false;
  let modelReady = false;
  let cameraError = '';
  let modelError = '';
  let camLabel = '';
  let camId = '';
  let devices = [];
  let camGen = 0;
  let startPromise = null;

  // 검출 스케줄
  let queueTask = deps.queueTask;
  let scheduled = false;
  let fallingBack = false;
  let failStreak = 0;
  let lastTs = 0;
  let presented = 0; // requestVideoFrameCallback 으로 센 표시 프레임 수
  let presentedAt = -Infinity; // 마지막 rVFC 콜백 시각
  let processedToken = null;
  const times = [];
  let detectMs = 0;

  function ensureVideo() {
    if (video) return;
    if (deps.video) video = deps.video;
    else if (typeof document !== 'undefined') {
      video = document.createElement('video');
      video.className = 'cam-video';
      video.muted = true; // 재생은 attachStream 이 play() 로 시작한다 (autoplay 속성은 화면 밖 자동 일시정지 정책을 받을 수 있어 쓰지 않음)
      video.playsInline = true;
      video.setAttribute('aria-hidden', 'true');
      document.body.appendChild(video);
    } else return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = (_t, meta) => {
        presented = meta?.presentedFrames ?? presented + 1;
        presentedAt = deps.now();
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
  }

  /**
   * 새 비디오 프레임 판별값. 화면에 안 보이는 video 에서도 동작하도록 세 가지를 순서대로 쓴다:
   * rVFC 표시 프레임 수(살아 있을 때) → getVideoPlaybackQuality().totalVideoFrames(증가할 때) → currentTime
   */
  const frameToken = () => {
    if (presented > 0 && deps.now() - presentedAt < RVFC_FRESH_MS) return presented;
    const total = video.getVideoPlaybackQuality?.().totalVideoFrames;
    if (total > 0) return `q${total}`;
    return video.currentTime;
  };

  async function startCamera() {
    const gen = ++camGen;
    cameraReady = false;
    cameraError = '';
    deps.stopStream(stream);
    stream = null;
    processor.reset();
    try {
      const res = await deps.openCamera({ deviceId: params.cameraId });
      if (gen !== camGen) return void deps.stopStream(res.stream);
      stream = res.stream;
      devices = res.devices;
      camId = res.deviceId;
      camLabel = res.label;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (gen !== camGen) return;
        cameraReady = false;
        cameraError = '카메라 연결이 끊어졌습니다';
        processor.reset();
      });
      await deps.attachStream(video, stream);
      if (gen !== camGen) return;
      processedToken = null;
      cameraReady = true;
    } catch (err) {
      if (gen !== camGen) return;
      console.warn('[tracker] 카메라 오류', err);
      cameraError = describeCameraError(err);
      // 재생 거부·첫 프레임 타임아웃 등으로 실패해도 열린 스트림을 닫는다 (카메라 표시등이 계속 켜지지 않게)
      deps.stopStream(stream);
      stream = null;
      if (video) video.srcObject = null;
      // 실패한 경우에도 장치 목록을 갱신해 패널에서 다른 카메라를 고를 수 있게 한다
      try {
        const list = await deps.listVideoInputs();
        if (gen === camGen) devices = list;
      } catch {
        /* 목록을 못 얻어도 오류 안내는 유지 */
      }
    }
  }

  /** 워커 검출을 포기하고 메인 스레드 검출로 전환 (경고 1회) */
  async function switchToMain(err) {
    if (mode === 'main' || switching) return;
    switching = true;
    console.warn('[tracker] 워커 검출을 쓸 수 없어 메인 스레드 검출로 전환합니다:', err?.message ?? err);
    try {
      wd?.terminate();
    } catch {
      /* 무시 */
    }
    wd = null;
    mode = 'main';
    modelReady = false;
    failStreak = 0;
    processedToken = null;
    await loadModel();
    switching = false;
  }

  async function startDetector() {
    if (mode === 'worker') {
      try {
        wd = deps.createWorkerDetector({ wasmPath: WASM_PATH, modelPath: MODEL_PATH, numFaces: TRACKING.numFaces, onFatal: (err) => switchToMain(err) });
        const r = await wd.start();
        delegate = r.delegate;
        modelReady = true;
        return;
      } catch (err) {
        await switchToMain(err);
        return;
      }
    }
    await loadModel();
  }

  function onWorkerResult(r, gen) {
    if (gen !== camGen || mode !== 'worker') return; // 카메라가 바뀌었거나 이미 메인으로 전환
    if (!r) return; // 너무 늦게 도착해 버려진 결과
    failStreak = 0;
    delegate = r.delegate;
    recordDetectTime(r.detectMs);
    const sample = r.sample; // sample.at = 촬영 시각 (workerDetector 가 채움)
    processor.push(sample, sample.at);
    if (debugPose && sample.hasFace) debugPose(sample, sample.at);
  }

  function onWorkerError(err, gen) {
    if (gen !== camGen || mode !== 'worker') return;
    failStreak++;
    if (err?.fatal || failStreak >= WORKER_FAIL_LIMIT) switchToMain(err);
    else if (failStreak === 1) console.warn('[tracker] 워커 검출 오류', err);
  }

  async function loadModel() {
    try {
      const res = await deps.createLandmarker();
      landmarker = res.landmarker;
      delegate = res.delegate;
      modelReady = true;
    } catch (err) {
      console.error('[tracker] 모델 로딩 실패', err);
      modelError = '얼굴 인식 모델을 불러오지 못했습니다';
    }
  }

  /** 실행 중 GPU 검출이 계속 실패하면 CPU 로 다시 만든다 */
  async function fallbackToCpu() {
    fallingBack = true;
    modelReady = false;
    try {
      landmarker?.close();
    } catch {
      /* 이미 깨진 인스턴스 */
    }
    landmarker = null;
    try {
      const res = await deps.createLandmarker({ delegates: ['CPU'] });
      landmarker = res.landmarker;
      delegate = res.delegate;
      failStreak = 0;
      modelReady = true;
    } catch (err) {
      console.error('[tracker] CPU 폴백 실패', err);
      modelError = '얼굴 인식 모델을 실행하지 못했습니다';
    }
    fallingBack = false;
  }

  function onDetectError(err) {
    failStreak++;
    if (failStreak === 1) console.warn('[tracker] detectForVideo 오류', err);
    if (delegate === 'GPU') {
      if (failStreak >= GPU_FAIL_LIMIT && !fallingBack) fallbackToCpu();
    } else if (failStreak >= CPU_FAIL_LIMIT && !modelError) {
      modelError = '얼굴 인식 중 오류가 발생했습니다';
    }
  }

  function recordDetectTime(ms) {
    times.push(ms);
    if (times.length > 30) times.shift();
    let sum = 0;
    for (const v of times) sum += v;
    detectMs = sum / times.length;
  }

  /** 별도 태스크에서 실행: 가장 최신 프레임으로 검출 1회 */
  function runDetect() {
    scheduled = false;
    if (!landmarker || !cameraReady || !video || video.readyState < 2 || !video.videoWidth) return;
    const t0 = deps.now();
    let result;
    try {
      lastTs = Math.max(Math.round(t0), lastTs + 1); // 타임스탬프는 단조 증가
      result = landmarker.detectForVideo(video, lastTs);
      failStreak = 0;
    } catch (err) {
      onDetectError(err);
      return;
    }
    const t1 = deps.now();
    recordDetectTime(t1 - t0);
    processedToken = frameToken();
    const sample = extractSample(result, video.videoWidth, video.videoHeight, t1);
    processor.push(sample, t1);
    if (debugPose && sample.hasFace) debugPose(sample, t1);
  }

  function maybeSchedule() {
    if (mode === 'worker') {
      if (wd?.dead) return void switchToMain(new Error('워커가 종료되었습니다')); // 요청이 없을 때 죽은 워커도 감지
      if (!wd?.ready || wd.busy || !cameraReady || !video || video.readyState < 2) return;
      const token = frameToken();
      if (token === processedToken) return;
      const gen = camGen;
      const p = wd.detect(video);
      if (!p) return;
      processedToken = token;
      p.then(
        (r) => onWorkerResult(r, gen),
        (err) => onWorkerError(err, gen),
      );
      return;
    }
    if (scheduled || !landmarker || !cameraReady || !video || video.readyState < 2) return;
    if (frameToken() === processedToken) return; // 같은 프레임은 다시 검출하지 않는다
    scheduled = true;
    queueTask ??= createTaskQueue();
    queueTask(runDetect);
  }

  function currentStatus() {
    if (cameraError || modelError) return 'error';
    return cameraReady && modelReady ? 'running' : 'loading';
  }

  ensureVideo();

  return {
    get video() {
      return video;
    },
    /** 사용할 수 있는 카메라 목록 [{id,label}] */
    get cameras() {
      return devices;
    },
    get cameraLabel() {
      return camLabel;
    },
    get cameraId() {
      return camId;
    },
    get delegate() {
      return delegate;
    },
    /** 'loading' | 'running' | 'error' */
    get status() {
      return currentStatus();
    },
    /** 'worker' | 'main' */
    get detector() {
      return mode;
    },

    /** 카메라·모델 준비. 실패해도 throw 하지 않고 status='error' */
    start() {
      startPromise ??= (async () => {
        ensureVideo();
        globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', () =>
          deps
            .listVideoInputs()
            .then((d) => (devices = d))
            .catch(() => {}),
        );
        await Promise.all([startDetector(), startCamera()]);
      })();
      return startPromise;
    },

    /** params.cameraId 로 카메라를 다시 연다 (패널에서 카메라를 바꿨을 때) */
    async restartCamera() {
      await startCamera();
    },

    /** 매 렌더 프레임 호출 */
    poll(nowMs = deps.now()) {
      maybeSchedule();
      const status = currentStatus();
      const m = processor.metrics();
      return {
        signals: processor.signals(nowMs),
        status,
        error: status === 'error' ? cameraError || modelError : undefined,
        sampledAt: processor.sampledAt,
        metrics: {
          ...m,
          detectMs, // 검출 자체의 시간(워커 모드면 워커 안에서 잰 값)
          mainMs: mode === 'worker' ? (wd?.mainMs ?? 0) : detectMs, // 검출 때문에 메인 스레드가 쓴 시간
          camera: camLabel || '-',
          delegate: delegate || '-',
          detector: mode,
        },
      };
    },

    /** 현재 거리를 기준으로 저장 (C 키). 얼굴이 없으면 false */
    calibrate() {
      return processor.calibrate(deps.now());
    },

    stop() {
      camGen++;
      deps.stopStream(stream);
      stream = null;
      cameraReady = false;
      try {
        wd?.terminate();
        landmarker?.close();
      } catch {
        /* 무시 */
      }
      landmarker = null;
    },
  };
}
