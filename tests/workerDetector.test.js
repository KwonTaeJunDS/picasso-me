import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorkerDetector } from '../src/tracking/workerDetector.js';
import { createTracker } from '../src/tracking/faceTracker.js';
import { matrixFromEuler } from '../src/tracking/pose.js';
import { createParams } from '../src/config/params.js';

// ---- 워커 클라이언트 (가짜 Worker) ---------------------------------------------------------------

class FakeWorker {
  constructor() {
    this.sent = [];
    this.terminated = false;
  }
  postMessage(m, transfer) {
    this.sent.push({ m, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  emit(data) {
    this.onmessage?.({ data });
  }
  last(type) {
    return [...this.sent].reverse().find((s) => s.m.type === type);
  }
}

const sampleOf = (o = {}) => ({ at: 0, hasFace: true, faces: 1, matrix: matrixFromEuler(20, 0, 0), eyeDistPx: 100, landmarkYaw: 0.05, blinkLeft: 0, blinkRight: 0, jawOpen: 0, ...o });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('createWorkerDetector', () => {
  let worker;
  let clock;
  let bitmaps;
  const make = (over = {}) =>
    createWorkerDetector({
      wasmPath: '/wasm',
      modelPath: '/models/m.task',
      numFaces: 2,
      createWorker: () => (worker = new FakeWorker()),
      createBitmap: vi.fn(async (src) => {
        clock += 2; // createImageBitmap 요청 자체가 메인 스레드에서 쓰는 시간
        const b = { src, closed: false, close() { this.closed = true; } };
        bitmaps.push(b);
        return b;
      }),
      now: () => clock,
      ...over,
    });
  beforeEach(() => {
    clock = 1000;
    bitmaps = [];
  });
  afterEach(() => vi.useRealTimers());

  async function ready(wd) {
    const p = wd.start();
    worker.emit({ type: 'ready', delegate: 'GPU' });
    await p;
  }

  it('start: init 메시지를 보내고 ready 에서 delegate 와 함께 끝난다', async () => {
    const wd = make();
    const p = wd.start();
    expect(worker.sent[0].m).toEqual({ type: 'init', wasmPath: '/wasm', modelPath: '/models/m.task', numFaces: 2, delegates: ['GPU', 'CPU'] });
    expect(wd.ready).toBe(false);
    worker.emit({ type: 'ready', delegate: 'GPU' });
    await expect(p).resolves.toEqual({ delegate: 'GPU' });
    expect(wd.ready).toBe(true);
    expect(wd.delegate).toBe('GPU');
    expect(wd.start()).toBe(p); // 한 번만
  });

  it('초기화 실패 / 워커 오류 / 생성 실패는 치명적(fatal) 오류로 reject 하고 워커를 끝낸다', async () => {
    const a = make();
    const pa = a.start();
    worker.emit({ type: 'initError', message: 'wasm 404' });
    await expect(pa).rejects.toMatchObject({ fatal: true });
    expect(worker.terminated).toBe(true);
    expect(a.ready).toBe(false);

    const b = make();
    const pb = b.start();
    worker.onerror({ message: 'boom' });
    await expect(pb).rejects.toMatchObject({ fatal: true });

    const c = make({ createWorker: () => { throw new Error('no module worker'); } });
    await expect(c.start()).rejects.toMatchObject({ fatal: true });
  });

  it('init 무응답(기본 10초)이면 fatal 로 reject', async () => {
    vi.useFakeTimers();
    const wd = make();
    const p = wd.start();
    const assertion = expect(p).rejects.toMatchObject({ fatal: true, message: expect.stringContaining('10000') });
    await vi.advanceTimersByTimeAsync(10001);
    await assertion;
    expect(worker.terminated).toBe(true);
  });

  it('준비 전에는 detect 가 null (건너뜀)', () => {
    const wd = make();
    expect(wd.detect({})).toBeNull();
    wd.start();
    expect(wd.detect({})).toBeNull();
  });

  it('detect: createImageBitmap → postMessage(transfer), 결과에 도착 시각·detectMs·mainMs', async () => {
    const wd = make();
    await ready(wd);
    const video = { tag: 'video' };
    const p = wd.detect(video);
    expect(p).toBeInstanceOf(Promise);
    expect(wd.busy).toBe(true);
    await flush();
    const sent = worker.last('detect');
    expect(sent.m.id).toBe(1);
    expect(sent.m.bitmap).toBe(bitmaps[0]);
    expect(bitmaps[0].src).toBe(video);
    expect(sent.transfer).toEqual([bitmaps[0]]); // 복사 없이 넘긴다
    clock = 1030;
    worker.emit({ type: 'result', id: 1, sample: sampleOf(), detectMs: 12.5, delegate: 'GPU' });
    const r = await p;
    expect(r.sample.at).toBe(1000); // 촬영 시각 (도착 시각 1030 이 아님)
    expect(r.detectMs).toBe(12.5);
    expect(r.delegate).toBe('GPU');
    expect(r.mainMs).toBeCloseTo(2, 6); // createBitmap 요청 2ms (가짜 시계)
    expect(wd.mainMs).toBeCloseTo(2, 6);
    expect(wd.busy).toBe(false);
  });

  it('바쁠 때는 새 요청을 받지 않고 null — 최신 프레임 1개만 처리', async () => {
    const wd = make();
    await ready(wd);
    const p1 = wd.detect({});
    expect(wd.detect({})).toBeNull();
    expect(wd.detect({})).toBeNull();
    await flush();
    expect(worker.sent.filter((s) => s.m.type === 'detect')).toHaveLength(1);
    worker.emit({ type: 'result', id: 1, sample: sampleOf(), detectMs: 5, delegate: 'GPU' });
    await p1;
    const p2 = wd.detect({});
    expect(p2).not.toBeNull();
    await flush();
    expect(worker.last('detect').m.id).toBe(2);
    worker.emit({ type: 'result', id: 2, sample: sampleOf(), detectMs: 5, delegate: 'GPU' });
    await p2;
  });

  it('늦게 온 이전 요청 결과는 무시한다', async () => {
    const wd = make();
    await ready(wd);
    const p = wd.detect({});
    await flush();
    worker.emit({ type: 'result', id: 99, sample: sampleOf(), detectMs: 1, delegate: 'GPU' });
    expect(wd.busy).toBe(true);
    worker.emit({ type: 'result', id: 1, sample: sampleOf(), detectMs: 1, delegate: 'GPU' });
    await expect(p).resolves.toBeTruthy();
  });

  it('검출 오류(detectError)는 그 요청만 reject 하고 다음 요청은 가능', async () => {
    const wd = make();
    await ready(wd);
    const p = wd.detect({});
    await flush();
    worker.emit({ type: 'detectError', id: 1, message: 'gl lost' });
    await expect(p).rejects.toThrow('gl lost');
    expect(wd.busy).toBe(false);
    expect(wd.dead).toBe(false);
    expect(wd.detect({})).not.toBeNull();
  });

  it('워커의 delegate 변경(GPU→CPU 재생성)을 반영한다', async () => {
    const wd = make();
    await ready(wd);
    worker.emit({ type: 'delegate', delegate: 'CPU' });
    expect(wd.delegate).toBe('CPU');
  });

  it('createImageBitmap 이 실패하면 reject 하고 busy 가 풀린다', async () => {
    const wd = make({ createBitmap: vi.fn(async () => { throw new Error('InvalidStateError'); }) });
    await ready(wd);
    await expect(wd.detect({})).rejects.toThrow('InvalidStateError');
    expect(wd.busy).toBe(false);
    const sync = make({ createBitmap: vi.fn(() => { throw new Error('sync'); }) });
    await ready(sync);
    await expect(sync.detect({})).rejects.toThrow('sync');
  });

  it('검출 무응답(기본 5초)이면 fatal 로 reject 하고 워커를 끝낸다 — 이후 요청은 null', async () => {
    vi.useFakeTimers();
    const wd = make();
    const sp = wd.start();
    worker.emit({ type: 'ready', delegate: 'CPU' });
    await sp;
    const p = wd.detect({});
    const assertion = expect(p).rejects.toMatchObject({ fatal: true });
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(worker.terminated).toBe(true);
    expect(wd.dead).toBe(true);
    expect(wd.detect({})).toBeNull();
  });

  it('요청이 취소된 뒤 도착한 비트맵은 워커로 보내지 않고 닫는다', async () => {
    let resolveBitmap;
    const bitmap = { closed: false, close() { this.closed = true; } };
    const wd = make({ createBitmap: () => new Promise((res) => (resolveBitmap = res)) });
    await ready(wd);
    const p = wd.detect({});
    p.catch(() => {});
    wd.terminate();
    resolveBitmap(bitmap);
    await flush();
    expect(bitmap.closed).toBe(true);
    expect(worker.sent.filter((s) => s.m.type === 'detect')).toHaveLength(0);
    expect(wd.busy).toBe(false);
  });

  it('[3] 너무 늦게(>staleMs) 도착한 결과는 버린다 (null) — 이미 떠난 얼굴을 새로 본 것처럼 쓰지 않음', async () => {
    const wd = make();
    await ready(wd);
    const p = wd.detect({});
    await flush();
    clock += 400; // 검출·재생성 지연
    worker.emit({ type: 'result', id: 1, sample: sampleOf(), detectMs: 5, delegate: 'CPU' });
    await expect(p).resolves.toBeNull();
    expect(wd.busy).toBe(false);
    const sentAt = clock;
    const p2 = wd.detect({});
    await flush();
    clock += 100; // 250ms 이내면 사용, at 은 촬영 시각
    worker.emit({ type: 'result', id: 2, sample: sampleOf(), detectMs: 5, delegate: 'CPU' });
    expect((await p2).sample.at).toBe(sentAt);
  });

  it('[1] 요청이 없을 때 워커가 죽어도 onFatal 로 알린다 (초기화 중 실패는 start() reject 로만)', async () => {
    const onFatal = vi.fn();
    const wd = make({ onFatal });
    await ready(wd);
    worker.onerror({ message: 'crashed' });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][0]).toMatchObject({ fatal: true });
    expect(wd.dead).toBe(true);
    worker.onerror({ message: 'again' });
    expect(onFatal).toHaveBeenCalledTimes(1);

    const onFatal2 = vi.fn();
    const init = make({ onFatal: onFatal2 });
    const pi = init.start();
    worker.emit({ type: 'initError', message: 'x' });
    await expect(pi).rejects.toBeTruthy();
    expect(onFatal2).not.toHaveBeenCalled();
  });

  it('terminate: close 메시지를 보내고 워커를 끝낸다', async () => {
    const wd = make();
    await ready(wd);
    wd.terminate();
    expect(worker.last('close')).toBeTruthy();
    expect(worker.terminated).toBe(true);
    expect(wd.detect({})).toBeNull();
  });
});

// ---- 추적기의 워커 모드 / 폴백 ---------------------------------------------------------------

describe('createTracker: 워커 검출과 메인 스레드 폴백', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  /** 가짜 워커 검출기: detect() 가 반환한 Promise 를 test 가 직접 해결한다 */
  function fakeDetector({ startImpl } = {}) {
    const wd = {
      ready: false,
      busy: false,
      dead: false,
      delegate: 'GPU',
      mainMs: 1.5,
      calls: [],
      terminate: vi.fn(),
      start: vi.fn(startImpl ?? (async () => ((wd.ready = true), { delegate: 'GPU' }))),
      detect(src) {
        if (!wd.ready || wd.busy) return null;
        wd.busy = true;
        return new Promise((resolve, reject) => {
          wd.calls.push({ src, resolve: (r) => ((wd.busy = false), resolve(r)), reject: (e) => ((wd.busy = false), reject(e)) });
        });
      },
    };
    return wd;
  }

  function makeEnv(wdOpts, over = {}) {
    let clock = 1000;
    const wd = fakeDetector(wdOpts);
    const video = { readyState: 4, videoWidth: 1280, videoHeight: 720, currentTime: 0 };
    const landmarker = { detectForVideo: vi.fn(() => ({ faceLandmarks: [] })), close: vi.fn() };
    const tasks = [];
    const deps = {
      detector: 'worker',
      now: () => clock,
      queueTask: (fn) => tasks.push(fn),
      video,
      createWorkerDetector: vi.fn(() => wd),
      createLandmarker: vi.fn(async () => ({ landmarker, delegate: 'CPU' })),
      openCamera: vi.fn(async () => ({ stream: { getVideoTracks: () => [{ addEventListener() {}, label: 'cam' }], getTracks: () => [] }, deviceId: 'c', label: 'LGE Camera', devices: [] })),
      attachStream: vi.fn(async () => {}),
      stopStream: vi.fn(),
      listVideoInputs: vi.fn(async () => []),
      log: vi.fn(),
      ...over,
    };
    const params = createParams();
    const env = {
      wd,
      deps,
      params,
      video,
      tasks,
      landmarker,
      advance: (ms) => (clock += ms),
      result: (o = {}) => mkResult(clock, o),
      newFrame: (tracker) => {
        video.currentTime += 0.0333;
        clock += 33;
        return tracker.poll();
      },
      make: (search = '') => createTracker(params, { search, deps }),
    };
    return env;
  }

  const mkResult = (at, o = {}) => ({ sample: { at, hasFace: true, faces: 1, matrix: matrixFromEuler(20, 0, 0), eyeDistPx: 100, landmarkYaw: 0.05, blinkLeft: 0, blinkRight: 0, jawOpen: 0, ...o.sample }, detectMs: 11, delegate: 'GPU', mainMs: 1.5, ...o });

  it('worker 모드: start 후 running, 새 프레임마다 워커에 요청하고 결과가 신호가 된다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    expect(tracker.detector).toBe('worker');
    expect(env.deps.createWorkerDetector).toHaveBeenCalledWith(expect.objectContaining({ wasmPath: expect.stringContaining('wasm'), modelPath: expect.stringContaining('face_landmarker.task') }));
    expect(env.deps.createLandmarker).not.toHaveBeenCalled(); // 메인에서는 모델을 만들지 않는다
    expect(tracker.poll().status).toBe('running');

    expect(env.wd.calls).toHaveLength(1); // 첫 poll 에서 요청
    expect(env.wd.calls[0].src).toBe(env.video);
    env.wd.calls[0].resolve(env.result());
    await Promise.resolve();
    await Promise.resolve();
    const f = env.newFrame(tracker);
    expect(f.signals.present).toBe(true);
    expect(f.signals.t).toBeCloseTo(-20 / 45, 6);
    expect(f.metrics.detector).toBe('worker');
    expect(f.metrics.detectMs).toBe(11); // 워커 안에서 잰 시간
    expect(f.metrics.mainMs).toBe(1.5);
    expect(f.metrics.delegate).toBe('GPU');
    expect(env.tasks).toHaveLength(0); // 메인 스레드 검출 태스크는 쓰지 않는다
  });

  it('요청이 진행 중이면 새 프레임이 와도 보내지 않고, 끝난 뒤 최신 프레임으로 다시 보낸다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    tracker.poll();
    expect(env.wd.calls).toHaveLength(1);
    env.newFrame(tracker);
    env.newFrame(tracker);
    expect(env.wd.calls).toHaveLength(1); // 바쁨 → 건너뜀
    env.wd.calls[0].resolve(env.result());
    await Promise.resolve();
    await Promise.resolve();
    env.newFrame(tracker);
    expect(env.wd.calls).toHaveLength(2);
  });

  it('같은 비디오 프레임은 다시 보내지 않는다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    tracker.poll();
    env.wd.calls[0].resolve(env.result());
    await Promise.resolve();
    await Promise.resolve();
    tracker.poll();
    tracker.poll();
    expect(env.wd.calls).toHaveLength(1);
  });

  it('워커가 아직 준비되지 않았으면(loading) 요청하지 않는다', async () => {
    let finish;
    const env = makeEnv({ startImpl: () => new Promise((r) => (finish = () => ((env.wd.ready = true), r({ delegate: 'GPU' })))) });
    const tracker = env.make();
    const started = tracker.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.poll().status).toBe('loading');
    expect(env.wd.calls).toHaveLength(0);
    finish();
    await started;
    expect(tracker.poll().status).toBe('running');
  });

  it('워커 초기화 실패 → console.warn 1회 후 메인 스레드 검출로 전환', async () => {
    const env = makeEnv({ startImpl: async () => { throw Object.assign(new Error('init 10s'), { fatal: true }); } });
    const tracker = env.make();
    await tracker.start();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(env.wd.terminate).toHaveBeenCalled();
    expect(env.deps.createLandmarker).toHaveBeenCalledTimes(1);
    expect(tracker.detector).toBe('main');
    const f = tracker.poll();
    expect(f.status).toBe('running');
    expect(f.metrics.detector).toBe('main');
    expect(env.tasks).toHaveLength(1); // 메인 스레드 태스크로 검출
  });

  it('createWorkerDetector 자체가 throw 해도 메인 스레드로 전환', async () => {
    const env = makeEnv({}, { createWorkerDetector: vi.fn(() => { throw new Error('Worker is not defined'); }) });
    const tracker = env.make();
    await tracker.start();
    expect(tracker.detector).toBe('main');
    expect(tracker.poll().status).toBe('running');
  });

  it('실행 중 치명적 오류(fatal)면 메인 스레드로 전환하고 경고는 1회', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    tracker.poll();
    env.wd.calls[0].reject(Object.assign(new Error('검출 무응답'), { fatal: true }));
    await flush();
    expect(tracker.detector).toBe('main');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(env.deps.createLandmarker).toHaveBeenCalledTimes(1);
    expect(tracker.poll().status).toBe('running');
    // 이후 워커는 더 이상 쓰지 않는다
    env.newFrame(tracker);
    expect(env.wd.calls).toHaveLength(1);
  });

  it('치명적이지 않은 오류가 연속 5번이면 전환, 중간에 성공하면 카운트 초기화', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    const fail = async () => {
      env.newFrame(tracker);
      env.wd.calls.at(-1).reject(new Error('gl'));
      await flush();
    };
    for (let i = 0; i < 4; i++) await fail();
    expect(tracker.detector).toBe('worker');
    env.newFrame(tracker);
    env.wd.calls.at(-1).resolve(env.result());
    await flush();
    for (let i = 0; i < 4; i++) await fail();
    expect(tracker.detector).toBe('worker'); // 성공 뒤 다시 센다
    await fail();
    expect(tracker.detector).toBe('main');
  });

  it('?detector=main 이면 워커를 만들지 않고 메인 스레드 검출', async () => {
    const env = makeEnv();
    const tracker = env.make('?detector=main');
    await tracker.start();
    expect(env.deps.createWorkerDetector).not.toHaveBeenCalled();
    expect(tracker.detector).toBe('main');
    expect(tracker.poll().metrics.detector).toBe('main');
  });

  it('Worker 가 없는 환경(Node)에서 기본값은 메인 스레드', async () => {
    const env = makeEnv({}, { detector: null });
    const tracker = env.make();
    await tracker.start();
    expect(tracker.detector).toBe('main');
    expect(env.deps.createWorkerDetector).not.toHaveBeenCalled();
  });

  it('카메라를 바꾸기 전에 보낸 요청의 결과는 버린다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    tracker.poll();
    const old = env.wd.calls[0];
    await tracker.restartCamera();
    old.resolve(env.result());
    await flush();
    expect(tracker.poll().signals.present).toBe(false);
  });

  it('?debugpose 도 워커 표본으로 동작한다', async () => {
    const env = makeEnv();
    const tracker = env.make('?debugpose');
    await tracker.start();
    tracker.poll();
    env.wd.calls[0].resolve(env.result());
    await flush();
    expect(env.deps.log).toHaveBeenCalledTimes(1);
    const o = JSON.parse(env.deps.log.mock.calls[0][1]);
    expect(o.matrixColumnMajor).toHaveLength(16);
    expect(o.eulerCameraDeg.yaw).toBeCloseTo(20, 3);
  });

  it('[1] 대기 중인 요청이 없을 때 워커가 죽으면(onFatal / dead) 메인 스레드 검출로 전환', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    const cfg = env.deps.createWorkerDetector.mock.calls[0][0];
    expect(cfg.onFatal).toBeTypeOf('function');
    cfg.onFatal(Object.assign(new Error('worker crashed'), { fatal: true }));
    await flush();
    expect(tracker.detector).toBe('main');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(tracker.poll().status).toBe('running');
  });

  it('[1] 카메라 전환 직후 죽은 워커도 poll 에서 dead 를 보고 전환 (오류 통지가 camGen 에 걸려 무시돼도)', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    env.wd.dead = true;
    env.wd.ready = false;
    tracker.poll();
    await flush();
    expect(tracker.detector).toBe('main');
    expect(env.deps.createLandmarker).toHaveBeenCalledTimes(1);
  });

  it('[3] 촬영 시각이 오래된 표본은 present 가 되지 않고, 도착 시각으로 덮어쓰지 않는다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    tracker.poll();
    env.advance(500);
    env.wd.calls[0].resolve(mkResult(1000)); // 촬영은 500ms 전
    await flush();
    const f = tracker.poll();
    expect(f.signals.present).toBe(false);
    expect(f.sampledAt).toBe(1000);
    env.wd.calls[1]?.resolve?.(null); // null(버려진 결과)도 안전
    await flush();
  });

  it('stop(): 워커를 끝낸다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    tracker.stop();
    expect(env.wd.terminate).toHaveBeenCalled();
  });
});

// ---- 워커 스크립트 (MediaPipe 대역으로 메시지 처리 확인) -------------------------------------------

describe('detector.worker.js 메시지 처리', () => {
  let posted;
  let fake;
  let calls;

  async function loadWorker({ gpuFails = false, detect } = {}) {
    vi.resetModules();
    posted = [];
    calls = { fileset: [], create: [] };
    const landmarkers = [];
    vi.doMock('@mediapipe/tasks-vision', () => ({
      FilesetResolver: { forVisionTasks: vi.fn(async (...a) => (calls.fileset.push(a), { fileset: true })) },
      FaceLandmarker: {
        createFromOptions: vi.fn(async (fs, opts) => {
          calls.create.push(opts.baseOptions.delegate);
          if (gpuFails && opts.baseOptions.delegate === 'GPU') throw new Error('no webgl2');
          const lm = { delegate: opts.baseOptions.delegate, close: vi.fn(), detectForVideo: vi.fn(detect ?? (() => ({ faceLandmarks: [] }))) };
          landmarkers.push(lm);
          return lm;
        }),
      },
    }));
    fake = { postMessage: (m) => posted.push(m), close: vi.fn(), location: { href: 'http://localhost/' } };
    vi.stubGlobal('self', fake);
    await import('../src/tracking/detector.worker.js');
    return { send: (data) => fake.onmessage({ data }), landmarkers, tick: flush };
  }
  afterEach(() => {
    vi.doUnmock('@mediapipe/tasks-vision');
    vi.unstubAllGlobals();
  });

  const init = { type: 'init', wasmPath: '/wasm', modelPath: '/m.task', numFaces: 2, delegates: ['GPU', 'CPU'] };
  const bmp = () => ({ width: 1280, height: 720, close: vi.fn() });

  it('init: 모듈 로더(useModule=true)로 fileset 을 만들고 GPU 로 생성, ready 응답', async () => {
    const w = await loadWorker();
    w.send(init);
    await w.tick();
    expect(calls.fileset[0]).toEqual(['http://localhost/wasm', true]);
    expect(calls.create).toEqual(['GPU']);
    expect(posted).toEqual([{ type: 'ready', delegate: 'GPU' }]);
  });

  it('GPU 생성이 실패하면 CPU 로', async () => {
    const w = await loadWorker({ gpuFails: true });
    w.send(init);
    await w.tick();
    expect(calls.create).toEqual(['GPU', 'CPU']);
    expect(posted.at(-1)).toEqual({ type: 'ready', delegate: 'CPU' });
  });

  it('둘 다 실패하면 initError', async () => {
    const w = await loadWorker({ gpuFails: true });
    w.send({ ...init, delegates: ['GPU'] });
    await w.tick();
    expect(posted.at(-1)).toMatchObject({ type: 'initError', message: 'no webgl2' });
  });

  it('detect: 결과는 작은 표본만 보내고(랜드마크 전체 없음) 비트맵을 닫으며 타임스탬프는 단조 증가', async () => {
    const lms = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    const w = await loadWorker({
      detect: () => ({
        faceLandmarks: [lms],
        facialTransformationMatrixes: [{ data: matrixFromEuler(10, 0, 0) }],
        faceBlendshapes: [{ categories: [{ categoryName: 'jawOpen', score: 0.4 }] }],
      }),
    });
    w.send(init);
    await w.tick();
    const b1 = bmp();
    const b2 = bmp();
    w.send({ type: 'detect', id: 1, bitmap: b1 });
    w.send({ type: 'detect', id: 2, bitmap: b2 });
    await w.tick();
    const results = posted.filter((m) => m.type === 'result');
    expect(results.map((r) => r.id)).toEqual([1, 2]);
    expect(results[0].sample.hasFace).toBe(true);
    expect(results[0].sample.jawOpen).toBe(0.4);
    expect(results[0].sample.matrix).toHaveLength(16);
    expect(JSON.stringify(results[0]).length).toBeLessThan(2000); // 랜드마크(478점)는 없다
    expect(results[0].detectMs).toBeGreaterThanOrEqual(0);
    expect(b1.close).toHaveBeenCalled();
    expect(b2.close).toHaveBeenCalled();
    const ts = w.landmarkers[0].detectForVideo.mock.calls.map((c) => c[1]);
    expect(ts[1]).toBeGreaterThan(ts[0]);
    expect(w.landmarkers[0].detectForVideo.mock.calls[0][0]).toBe(b1);
  });

  it('검출 예외는 detectError 로 알리고 비트맵을 닫는다. GPU 연속 3회 실패하면 CPU 로 재생성', async () => {
    const w = await loadWorker({
      detect: () => {
        throw new Error('GL lost');
      },
    });
    w.send(init);
    await w.tick();
    for (let id = 1; id <= 3; id++) {
      const b = bmp();
      w.send({ type: 'detect', id, bitmap: b });
      await w.tick();
      expect(b.close).toHaveBeenCalled();
    }
    expect(posted.filter((m) => m.type === 'detectError').map((m) => m.id).slice(0, 3)).toEqual([1, 2, 3]);
    await w.tick();
    expect(calls.create).toEqual(['GPU', 'CPU']);
    expect(posted.some((m) => m.type === 'delegate' && m.delegate === 'CPU')).toBe(true);
    expect(w.landmarkers[0].close).toHaveBeenCalled();
  });

  it('close: 모델을 닫고 워커를 끝낸다', async () => {
    const w = await loadWorker();
    w.send(init);
    await w.tick();
    w.send({ type: 'close' });
    expect(w.landmarkers[0].close).toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalled();
  });
});
