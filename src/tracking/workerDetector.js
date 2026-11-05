// 검출 워커의 메인 쪽 클라이언트. 한 번에 요청 하나만 보낸다(바쁘면 detect() 가 null 을 돌려 그 프레임은 건너뜀).
//
//   const wd = createWorkerDetector({ wasmPath, modelPath, numFaces })
//   await wd.start()                       // 워커 생성 + 모델 로딩. 실패·무응답(10초)이면 reject → 호출한 쪽이 메인 스레드 검출로 전환
//   const p = wd.detect(video)             // createImageBitmap(video) → postMessage(transfer). 바쁘면 null
//   p?.then(({ sample, detectMs, delegate, mainMs }) => …)
//
// 시각: sample.at 은 비트맵을 만든 시점(촬영 시각)이다. 결과가 staleMs 보다 늦게 도착하면 버리고 null 로 끝낸다.
// 요청이 없을 때 워커가 죽어도 cfg.onFatal(err) 로 알려 준다(호출한 쪽이 메인 스레드 검출로 전환).
// 워커 안에서 잰 detectMs 와, 메인 스레드가 쓴 시간(mainMs = 비트맵 요청 + postMessage + 결과 처리)을 따로 돌려준다.

import { TRACKING } from '../config/params.js';

export const INIT_TIMEOUT_MS = 10000;
export const DETECT_TIMEOUT_MS = 5000;

/** 실제 워커 생성 (Vite 가 이 리터럴 패턴을 보고 워커를 번들한다) */
function defaultCreateWorker() {
  return new Worker(new URL('./detector.worker.js', import.meta.url), { type: 'module' });
}

const fatal = (message) => Object.assign(new Error(message), { fatal: true });

/**
 * @param {object} cfg
 * @param {string} cfg.wasmPath
 * @param {string} cfg.modelPath
 * @param {number} [cfg.numFaces]
 * @param {string[]} [cfg.delegates] 기본 ['GPU','CPU']
 * @param {number} [cfg.initTimeoutMs]
 * @param {number} [cfg.detectTimeoutMs]
 * @param {() => Worker} [cfg.createWorker] 테스트용 주입
 * @param {(src:any) => Promise<ImageBitmap>} [cfg.createBitmap]
 * @param {() => number} [cfg.now]
 * @param {number} [cfg.staleMs] 이보다 늦게 도착한 결과는 버린다 (기본 TRACKING.staleMs)
 * @param {(err:Error) => void} [cfg.onFatal] 초기화 이후 워커가 죽었을 때(요청 유무와 무관)
 */
export function createWorkerDetector(cfg) {
  const {
    wasmPath,
    modelPath,
    numFaces = TRACKING.numFaces,
    delegates = ['GPU', 'CPU'],
    initTimeoutMs = INIT_TIMEOUT_MS,
    detectTimeoutMs = DETECT_TIMEOUT_MS,
    createWorker = defaultCreateWorker,
    createBitmap = (src) => createImageBitmap(src),
    now = () => performance.now(),
    staleMs = TRACKING.staleMs,
    onFatal,
  } = cfg;

  let worker = null;
  let startPromise = null;
  let ready = false;
  let dead = false;
  let delegate = '';
  let seq = 0;
  let pending = null; // { id, resolve, reject, timer, mainMs }
  let initCtl = null; // { resolve, reject, timer }
  const mainTimes = [];
  let mainAvg = 0;

  function recordMain(ms) {
    mainTimes.push(ms);
    if (mainTimes.length > 30) mainTimes.shift();
    mainAvg = mainTimes.reduce((s, v) => s + v, 0) / mainTimes.length;
  }

  function settleInit(err, value) {
    if (!initCtl) return;
    const c = initCtl;
    initCtl = null;
    clearTimeout(c.timer);
    if (err) c.reject(err);
    else c.resolve(value);
  }

  function failPending(err) {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  /** 워커가 죽었거나 응답이 없을 때: 이후 모든 요청 실패 */
  function kill(err) {
    const wasInit = !!initCtl;
    const already = dead;
    dead = true;
    ready = false;
    settleInit(err);
    failPending(err);
    try {
      worker?.terminate();
    } catch {
      /* 무시 */
    }
    if (!wasInit && !already) onFatal?.(err); // 초기화 중 실패는 start() 의 reject 로 전달된다
  }

  function onMessage(e) {
    const t = now();
    const msg = e.data;
    switch (msg?.type) {
      case 'ready':
        ready = true;
        delegate = msg.delegate;
        settleInit(null, { delegate });
        break;
      case 'initError':
        kill(fatal(`워커 초기화 실패: ${msg.message}`));
        break;
      case 'delegate':
        delegate = msg.delegate;
        break;
      case 'result': {
        if (!pending || pending.id !== msg.id) break; // 늦게 온 이전 요청
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        if (msg.delegate) delegate = msg.delegate;
        const sample = msg.sample;
        sample.at = p.capturedAt; // 촬영 시각 (도착 시각이 아님)
        const mainMs = p.mainMs + (now() - t);
        recordMain(mainMs);
        if (t - p.capturedAt > staleMs) p.resolve(null); // 너무 늦게 도착: 이미 떠난 얼굴을 새로 본 것처럼 쓰지 않는다
        else p.resolve({ sample, detectMs: msg.detectMs, delegate, mainMs });
        break;
      }
      case 'detectError':
        if (pending && pending.id === msg.id) failPending(new Error(msg.message));
        break;
      default:
    }
  }

  return {
    /** 워커를 만들고 모델 로딩이 끝날 때까지 기다린다. 한 번만 실행 */
    start() {
      startPromise ??= new Promise((resolve, reject) => {
        initCtl = { resolve, reject, timer: setTimeout(() => kill(fatal(`워커 초기화 무응답 (${initTimeoutMs}ms)`)), initTimeoutMs) };
        try {
          worker = createWorker();
          worker.onmessage = onMessage;
          worker.onerror = (e) => kill(fatal(`워커 오류: ${e?.message ?? e}`));
          worker.onmessageerror = () => kill(fatal('워커 메시지 오류'));
          worker.postMessage({ type: 'init', wasmPath, modelPath, numFaces, delegates });
        } catch (err) {
          kill(fatal(`워커 생성 실패: ${err?.message ?? err}`));
        }
      });
      return startPromise;
    },

    /**
     * source(video 등)의 현재 프레임 검출을 요청한다. 준비 안 됐거나 진행 중인 요청이 있으면 null(건너뜀).
     * @returns {Promise<{sample:object, detectMs:number, delegate:string, mainMs:number}|null>|null} 결과가 null 이면 너무 늦게 도착해 버린 것
     */
    detect(source) {
      if (!ready || dead || pending) return null;
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const t0 = now();
        const entry = { id, resolve, reject, capturedAt: t0, mainMs: 0, timer: setTimeout(() => kill(fatal(`검출 무응답 (${detectTimeoutMs}ms)`)), detectTimeoutMs) };
        pending = entry;
        let bitmapPromise;
        try {
          bitmapPromise = Promise.resolve(createBitmap(source));
        } catch (err) {
          failPending(err);
          return;
        }
        entry.mainMs += now() - t0;
        bitmapPromise.then(
          (bitmap) => {
            if (pending !== entry) {
              bitmap?.close?.(); // 그 사이 취소·실패
              return;
            }
            const t2 = now();
            try {
              worker.postMessage({ type: 'detect', id, bitmap }, [bitmap]);
            } catch (err) {
              bitmap?.close?.();
              failPending(err);
              return;
            }
            entry.mainMs += now() - t2;
          },
          (err) => {
            if (pending === entry) failPending(err);
          },
        );
      });
    },

    get busy() {
      return !!pending;
    },
    get ready() {
      return ready;
    },
    get dead() {
      return dead;
    },
    get delegate() {
      return delegate;
    },
    /** 요청 하나당 메인 스레드가 쓴 시간의 이동 평균(ms) */
    get mainMs() {
      return mainAvg;
    },

    terminate() {
      dead = true;
      ready = false;
      settleInit(new Error('terminated'));
      failPending(new Error('terminated'));
      try {
        worker?.postMessage({ type: 'close' });
        worker?.terminate();
      } catch {
        /* 무시 */
      }
    },
  };
}
