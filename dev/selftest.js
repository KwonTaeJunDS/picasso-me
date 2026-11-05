// 개발 서버 전용 자가 점검. 카메라 없이 로컬 자산(/wasm, /models)으로 FaceLandmarker 를 만들고
// 빈 캔버스에 detectForVideo 를 반복 실행해 생성 성공 여부·delegate·검출 시간을 잰다.
// 같은 빈 프레임으로 워커 검출 경로(createImageBitmap → postMessage → 워커 detectForVideo)도 측정한다:
// 워커 안 detectMs, 요청~결과 왕복 시간, 그리고 메인 스레드가 실제로 쓴 시간(mainMs).
// 결과는 페이지, 콘솔, window.__selftest 에 남긴다.

import { createLandmarker, WASM_PATH, MODEL_PATH } from '../src/tracking/faceTracker.js';
import { createWorkerDetector } from '../src/tracking/workerDetector.js';

const WARMUP = 5;
const RUNS = 60;

const out = document.getElementById('out');
const lines = [];
function log(msg) {
  lines.push(msg);
  out.textContent = lines.join('\n');
  console.log('[selftest]', msg);
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');

function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl?.getParameter(gl.RENDERER) ?? 'WebGL2 없음');
  } catch {
    return '확인 불가';
  }
}

async function headInfo(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return `${res.status} (${res.headers.get('content-length') ?? '?'} bytes)`;
  } catch (err) {
    return `실패: ${err.message}`;
  }
}

/** delegate 하나로 생성하고 빈 캔버스 검출 시간을 잰다 */
async function runDelegate(delegate) {
  const t0 = performance.now();
  try {
    const { landmarker } = await createLandmarker({ delegates: [delegate] });
    const createMs = performance.now() - t0;
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const g = canvas.getContext('2d');
    g.fillStyle = '#808080';
    g.fillRect(0, 0, canvas.width, canvas.height);

    let ts = 1000;
    for (let i = 0; i < WARMUP; i++) landmarker.detectForVideo(canvas, (ts += 34));
    const times = [];
    let faces = 0;
    for (let i = 0; i < RUNS; i++) {
      const a = performance.now();
      const r = landmarker.detectForVideo(canvas, (ts += 34));
      times.push(performance.now() - a);
      faces += r.faceLandmarks.length;
    }
    landmarker.close();
    const sorted = [...times].sort((x, y) => x - y);
    return {
      delegate,
      ok: true,
      createMs,
      runs: RUNS,
      avgMs: times.reduce((s, v) => s + v, 0) / times.length,
      medianMs: sorted[sorted.length >> 1],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      faces,
    };
  } catch (err) {
    return { delegate, ok: false, createMs: performance.now() - t0, error: String(err?.message ?? err) };
  }
}

const summarize = (times) => {
  const sorted = [...times].sort((x, y) => x - y);
  return {
    avg: times.reduce((s, v) => s + v, 0) / times.length,
    median: sorted[sorted.length >> 1],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
};

/** 워커 경로: delegate 하나로 워커를 만들고 빈 캔버스를 RUNS 번 보내 측정 */
async function runWorker(delegate) {
  const t0 = performance.now();
  const wd = createWorkerDetector({ wasmPath: WASM_PATH, modelPath: MODEL_PATH, delegates: [delegate] });
  try {
    const { delegate: used } = await wd.start();
    const createMs = performance.now() - t0;
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const g = canvas.getContext('2d');
    g.fillStyle = '#808080';
    g.fillRect(0, 0, canvas.width, canvas.height);
    const detect = [];
    const roundtrip = [];
    const main = [];
    let faces = 0;
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const a = performance.now();
      const r = await wd.detect(canvas);
      const rt = performance.now() - a;
      if (i < WARMUP) continue;
      detect.push(r.detectMs);
      roundtrip.push(rt);
      main.push(r.mainMs);
      faces += r.sample.hasFace ? 1 : 0;
    }
    wd.terminate();
    return { delegate: used, ok: true, createMs, runs: RUNS, detect: summarize(detect), roundtrip: summarize(roundtrip), mainMs: summarize(main), faces };
  } catch (err) {
    wd.terminate();
    return { delegate, ok: false, createMs: performance.now() - t0, error: String(err?.message ?? err) };
  }
}

async function main() {
  const result = { done: false, ok: false, usedDelegate: null, env: {}, assets: {}, delegates: {}, worker: {}, workerOk: false, usedWorkerDelegate: null };
  window.__selftest = result;

  result.env = { userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency, gpu: gpuName() };
  log(`UA   : ${result.env.userAgent}`);
  log(`GPU  : ${result.env.gpu}   (CPU 코어 ${result.env.cores})`);

  result.assets = {
    wasm: await headInfo(`${WASM_PATH}/vision_wasm_internal.wasm`),
    model: await headInfo(MODEL_PATH),
  };
  log(`자산 : ${WASM_PATH}/vision_wasm_internal.wasm → ${result.assets.wasm}`);
  log(`       ${MODEL_PATH} → ${result.assets.model}`);

  for (const delegate of ['GPU', 'CPU']) {
    log(`\n[${delegate}] 생성 중…`);
    const r = await runDelegate(delegate);
    result.delegates[delegate] = r;
    if (r.ok) {
      log(`[${delegate}] 생성 성공 ${fmt(r.createMs)} ms`);
      log(`[${delegate}] detectForVideo ${r.runs}회: 평균 ${fmt(r.avgMs)} ms, 중앙값 ${fmt(r.medianMs)}, p95 ${fmt(r.p95Ms)}, 최소 ${fmt(r.minMs)}, 최대 ${fmt(r.maxMs)} (얼굴 ${r.faces}개 — 빈 캔버스라 0이 정상)`);
    } else {
      log(`[${delegate}] 생성/실행 실패: ${r.error}`);
    }
  }

  // 워커 경로
  for (const delegate of ['GPU', 'CPU']) {
    log(`\n[워커 ${delegate}] 생성 중…`);
    const r = await runWorker(delegate);
    result.worker[delegate] = r;
    if (r.ok) {
      log(`[워커 ${delegate}] 생성 성공 ${fmt(r.createMs)} ms`);
      log(`[워커 ${delegate}] 워커 안 detectMs 평균 ${fmt(r.detect.avg)}, 중앙값 ${fmt(r.detect.median)}, p95 ${fmt(r.detect.p95)} / 요청~결과 왕복 평균 ${fmt(r.roundtrip.avg)} ms`);
      log(`[워커 ${delegate}] 메인 스레드 점유(createImageBitmap+postMessage+수신) 평균 ${fmt(r.mainMs.avg)} ms, 최대 ${fmt(r.mainMs.max)} ms`);
    } else {
      log(`[워커 ${delegate}] 생성/실행 실패: ${r.error}`);
    }
  }
  result.usedWorkerDelegate = ['GPU', 'CPU'].find((d) => result.worker[d]?.ok) ?? null;
  result.workerOk = result.usedWorkerDelegate !== null;

  // 앱(createLandmarker 기본값)은 GPU 를 먼저 시도하고 실패하면 CPU 를 쓴다
  const used = ['GPU', 'CPU'].find((d) => result.delegates[d]?.ok) ?? null;
  result.usedDelegate = used;
  result.ok = used !== null;
  result.done = true;
  log(`\n결과: 메인 스레드 ${result.ok ? `OK (${used})` : '실패'} / 워커 ${result.workerOk ? `OK (${result.usedWorkerDelegate})` : '실패 → 앱은 메인 스레드 검출로 전환'}`);
  document.getElementById('state').textContent = result.ok ? 'OK' : '실패';
  document.body.dataset.state = result.ok ? 'ok' : 'fail';
  document.title = `selftest ${result.ok ? 'OK' : 'FAIL'}`;
}

main().catch((err) => {
  log(`예기치 않은 오류: ${err?.stack ?? err}`);
  if (window.__selftest) Object.assign(window.__selftest, { done: true, ok: false, error: String(err?.message ?? err) });
  document.getElementById('state').textContent = '실패';
  document.body.dataset.state = 'fail';
  document.title = 'selftest FAIL';
});
