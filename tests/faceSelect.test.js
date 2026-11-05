import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { landmarkBoxArea, selectLargestFace, extractSample, createTracker } from '../src/tracking/faceTracker.js';
import { isExcludedCamera, chooseCamera, describeCameraError, openCamera, attachStream } from '../src/tracking/camera.js';
import { LM, matrixFromEuler } from '../src/tracking/pose.js';
import { createParams } from '../src/config/params.js';

/**
 * 가짜 얼굴: 바운딩 박스가 정확히 w×h (정규화), 중심 (cx,cy).
 * 478개 랜드마크 중 박스 극점·코끝·눈꼬리만 의미 있게 둔다.
 */
function makeFace({ cx = 0.5, cy = 0.5, w = 0.2, h = 0.3, noseDx = 0 } = {}) {
  const pts = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  pts[LM.CHEEK_R] = { x: cx - w / 2, y: cy, z: 0 };
  pts[LM.CHEEK_L] = { x: cx + w / 2, y: cy, z: 0 };
  pts[10] = { x: cx, y: cy - h / 2, z: 0 };
  pts[152] = { x: cx, y: cy + h / 2, z: 0 };
  pts[LM.NOSE_TIP] = { x: cx + noseDx, y: cy, z: 0 };
  pts[LM.EYE_OUTER_R] = { x: cx - w * 0.3, y: cy - h * 0.1, z: 0 };
  pts[LM.EYE_OUTER_L] = { x: cx + w * 0.3, y: cy - h * 0.1, z: 0 };
  return pts;
}

const cat = (name, score) => ({ categoryName: name, score, index: 0, displayName: '' });
const blends = (left, right, jaw) => ({ categories: [cat('browDownLeft', 0.9), cat('eyeBlinkLeft', left), cat('eyeBlinkRight', right), cat('jawOpen', jaw)], headIndex: 0, headName: '' });
const matrix = (tag) => ({ rows: 4, columns: 4, data: Array.from({ length: 16 }, (_, i) => tag * 100 + i) });

describe('landmarkBoxArea', () => {
  it('픽셀 단위 바운딩 박스 면적 (종횡비 보정)', () => {
    const face = makeFace({ w: 0.2, h: 0.4 });
    expect(landmarkBoxArea(face, 1280, 720)).toBeCloseTo(0.2 * 1280 * (0.4 * 720), 6);
    expect(landmarkBoxArea(face)).toBeCloseTo(0.08, 10); // 크기를 안 주면 정규화 면적
  });
  it('비었거나 이상한 값이면 0', () => {
    expect(landmarkBoxArea([], 100, 100)).toBe(0);
    expect(landmarkBoxArea(null, 100, 100)).toBe(0);
    expect(landmarkBoxArea([{ x: NaN, y: 0 }, { x: 1, y: 1 }], 100, 100)).toBe(0);
  });
});

describe('selectLargestFace', () => {
  const small = makeFace({ cx: 0.3, w: 0.1, h: 0.15 });
  const big = makeFace({ cx: 0.7, w: 0.25, h: 0.4 });

  it('바운딩 박스가 가장 큰 얼굴 하나를 고른다', () => {
    const r = selectLargestFace({ faceLandmarks: [small, big] }, 1280, 720);
    expect(r.index).toBe(1);
    expect(r.landmarks).toBe(big);
    expect(r.faces).toBe(2);
    expect(r.area).toBeCloseTo(0.25 * 1280 * (0.4 * 720), 6);
  });

  it('순서가 바뀌어도 큰 얼굴을 고른다', () => {
    expect(selectLargestFace({ faceLandmarks: [big, small] }, 1280, 720).index).toBe(0);
  });

  it('같은 인덱스의 변환 행렬·blendshape 를 함께 돌려준다', () => {
    const r = selectLargestFace(
      {
        faceLandmarks: [small, big],
        facialTransformationMatrixes: [matrix(1), matrix(2)],
        faceBlendshapes: [blends(0.1, 0.1, 0.1), blends(0.9, 0.2, 0.7)],
      },
      1280,
      720,
    );
    expect(r.matrix[0]).toBe(200);
    expect(r.blendshapes.find((c) => c.categoryName === 'eyeBlinkLeft').score).toBe(0.9);
  });

  it('얼굴이 하나면 그것을 쓴다. 행렬·blendshape 가 없어도 동작', () => {
    const r = selectLargestFace({ faceLandmarks: [small] }, 640, 480);
    expect(r.index).toBe(0);
    expect(r.matrix).toBeNull();
    expect(r.blendshapes).toBeNull();
  });

  it('얼굴이 없으면 null', () => {
    expect(selectLargestFace({ faceLandmarks: [] })).toBeNull();
    expect(selectLargestFace({})).toBeNull();
    expect(selectLargestFace(null)).toBeNull();
    expect(selectLargestFace(undefined)).toBeNull();
  });

  it('랜드마크가 빈 얼굴은 건너뛴다', () => {
    const r = selectLargestFace({ faceLandmarks: [[], small] }, 100, 100);
    expect(r.index).toBe(1);
    expect(selectLargestFace({ faceLandmarks: [[], []] })).toBeNull();
  });

  it('면적이 같으면 먼저 나온 얼굴', () => {
    const a = makeFace({ cx: 0.3, w: 0.2, h: 0.2 });
    const b = makeFace({ cx: 0.7, w: 0.2, h: 0.2 });
    expect(selectLargestFace({ faceLandmarks: [a, b] }, 100, 100).index).toBe(0);
  });

  it('좌표가 망가진 얼굴(NaN)보다 정상 얼굴을 고른다', () => {
    const broken = makeFace().map((p) => ({ ...p, x: NaN }));
    expect(selectLargestFace({ faceLandmarks: [broken, small] }, 100, 100).index).toBe(1);
  });
});

describe('extractSample', () => {
  it('가장 큰 얼굴에서 신호 원료를 뽑는다', () => {
    const small = makeFace({ cx: 0.3, w: 0.1, h: 0.15 });
    const big = makeFace({ cx: 0.7, w: 0.25, h: 0.4, noseDx: 0.03 });
    const s = extractSample(
      {
        faceLandmarks: [small, big],
        facialTransformationMatrixes: [matrix(1), matrix(2)],
        faceBlendshapes: [blends(0, 0, 0), blends(0.8, 0.3, 0.6)],
      },
      1280,
      720,
      1234.5,
    );
    expect(s.hasFace).toBe(true);
    expect(s.at).toBe(1234.5);
    expect(s.faces).toBe(2);
    expect(s.matrix[0]).toBe(200); // 큰 얼굴(인덱스 1)의 행렬
    expect(s.blinkLeft).toBe(0.8);
    expect(s.blinkRight).toBe(0.3);
    expect(s.jawOpen).toBe(0.6);
    expect(s.eyeDistPx).toBeCloseTo(0.25 * 0.6 * 1280, 6); // 눈꼬리 간격 = 0.6w
    expect(s.landmarkYaw).toBeCloseTo(0.03, 10); // 코가 영상 오른쪽
  });

  it('얼굴이 없으면 hasFace:false', () => {
    expect(extractSample({ faceLandmarks: [] }, 1280, 720, 5)).toEqual({ at: 5, hasFace: false, faces: 0 });
    expect(extractSample(undefined, 1280, 720, 6)).toEqual({ at: 6, hasFace: false, faces: 0 });
  });

  it('blendshape 에 해당 이름이 없으면 0', () => {
    const s = extractSample({ faceLandmarks: [makeFace()], faceBlendshapes: [{ categories: [cat('mouthSmileLeft', 0.5)] }] }, 100, 100, 0);
    expect(s.blinkLeft).toBe(0);
    expect(s.blinkRight).toBe(0);
    expect(s.jawOpen).toBe(0);
    const none = extractSample({ faceLandmarks: [makeFace()] }, 100, 100, 0);
    expect(none.hasFace).toBe(true);
    expect(none.matrix).toBeNull();
    expect(none.blinkLeft).toBe(0);
  });
});

describe('카메라 선택 (camera.js)', () => {
  const dev = (id, label) => ({ id, label });

  it('IR·가상·Mirametrix·OBS 카메라는 자동 선택에서 제외, 일반 웹캠은 아님', () => {
    expect(isExcludedCamera('LGE IR-FHD Camera (0408:5365)')).toBe(true);
    expect(isExcludedCamera('Mirametrix Virtual Camera')).toBe(true);
    expect(isExcludedCamera('OBS Virtual Camera')).toBe(true);
    expect(isExcludedCamera('Infrared Camera')).toBe(true);
    expect(isExcludedCamera('LGE Camera (0408:5364)')).toBe(false);
    expect(isExcludedCamera('Integrated Webcam')).toBe(false);
    expect(isExcludedCamera('')).toBe(false);
    expect(isExcludedCamera(undefined)).toBe(false);
  });

  it('이 PC 구성: 기본이 IR 이면 LGE Camera 로 바꾼다', () => {
    const devices = [dev('ir', 'LGE IR-FHD Camera'), dev('mm', 'Mirametrix Virtual Camera'), dev('lge', 'LGE Camera'), dev('scan', 'Printer Scan')];
    expect(chooseCamera(devices, 'ir').id).toBe('lge');
  });

  it('"cam" 이 들어간 웹캠다운 이름을 먼저 고르고, 없으면 목록 순서대로 첫 후보', () => {
    expect(chooseCamera([dev('a', 'Printer Scan'), dev('b', 'USB Webcam')], '').id).toBe('b');
    expect(chooseCamera([dev('a', 'Printer Scan'), dev('b', 'Capture Device')], '').id).toBe('a');
  });

  it('후보가 없거나 모두 제외 대상이면 null', () => {
    expect(chooseCamera([], '')).toBeNull();
    expect(chooseCamera([dev('ir', 'IR Camera'), dev('v', 'Virtual Camera')], 'ir')).toBeNull();
    expect(chooseCamera([dev('', 'No Id Camera')], '')).toBeNull();
  });

  it('현재 카메라는 후보에서 뺀다', () => {
    expect(chooseCamera([dev('a', 'Cam A'), dev('b', 'Cam B')], 'a').id).toBe('b');
  });

  it('오류 안내는 한 줄이고 종류별로 다르다', () => {
    const msgs = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'unsupported', 'timeout', 'Whatever'].map((name) => describeCameraError({ name }));
    for (const m of msgs) {
      expect(m.length).toBeGreaterThan(0);
      expect(m).not.toContain('\n');
    }
    expect(new Set(msgs).size).toBe(msgs.length);
    expect(describeCameraError(null)).toBe(describeCameraError({ name: 'Whatever' }));
  });
});

// ---- createTracker: 검출 스케줄·상태 (가짜 카메라·모델 주입) -------------------------------------

describe('createTracker: 검출 스케줄과 상태', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const flushMicrotasks = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  /** 얼굴 하나짜리 검출 결과 */
  const faceResult = ({ yaw = 20, blinkLeft = 0, jaw = 0, z = -40, w = 0.2, h = 0.3 } = {}) => ({
    faceLandmarks: [makeFace({ w, h })],
    facialTransformationMatrixes: [{ rows: 4, columns: 4, data: matrixFromEuler(yaw, 0, 0, { z }) }],
    faceBlendshapes: [blends(blinkLeft, 0, jaw)],
  });

  const rejectWith = (name) =>
    vi.fn(async () => {
      throw Object.assign(new Error(name), { name });
    });

  function makeEnv(over = {}) {
    let clock = 1000;
    const tasks = [];
    let result = faceResult();
    const video = { readyState: 4, videoWidth: 1280, videoHeight: 720, currentTime: 0, srcObject: null };
    const detect = vi.fn(() => {
      clock += 10; // 검출에 10ms 걸린다고 가정
      if (result instanceof Error) throw result;
      return result;
    });
    const landmarker = { detectForVideo: detect, close: vi.fn() };
    const stream = () => ({ getVideoTracks: () => [{ addEventListener() {}, label: 'LGE Camera' }], getTracks: () => [] });
    const deps = {
      now: () => clock,
      queueTask: (fn) => tasks.push(fn),
      video,
      createLandmarker: vi.fn(async () => ({ landmarker, delegate: 'GPU' })),
      openCamera: vi.fn(async () => ({ stream: stream(), deviceId: 'cam1', label: 'LGE Camera', devices: [{ id: 'cam1', label: 'LGE Camera' }] })),
      attachStream: vi.fn(async () => {}),
      stopStream: vi.fn(),
      listVideoInputs: vi.fn(async () => []),
      log: vi.fn(),
      ...over,
    };
    const params = createParams();
    const env = {
      deps,
      params,
      video,
      tasks,
      detect,
      landmarker,
      setResult: (r) => (result = r),
      advance: (ms) => (clock += ms),
      flush: () => {
        while (tasks.length) tasks.shift()();
      },
      /** 새 비디오 프레임이 도착했다고 치고 poll → 검출 실행 → 결과 프레임 */
      frame(tracker, dtMs = 33.3) {
        video.currentTime += dtMs / 1000;
        clock += dtMs;
        tracker.poll();
        env.flush();
        return tracker.poll();
      },
      make: (search = '') => createTracker(params, { search, deps }),
    };
    return env;
  }

  it('준비되기 전에는 loading 이고 검출을 예약하지 않는다. start 후 running', async () => {
    const env = makeEnv();
    const tracker = env.make();
    expect(tracker.poll().status).toBe('loading');
    expect(env.tasks).toHaveLength(0);
    await tracker.start();
    expect(tracker.poll().status).toBe('running');
    expect(tracker.video).toBe(env.video);
    expect(tracker.cameras).toEqual([{ id: 'cam1', label: 'LGE Camera' }]);
    expect(tracker.cameraLabel).toBe('LGE Camera');
  });

  it('start() 는 한 번만 카메라·모델을 연다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await Promise.all([tracker.start(), tracker.start()]);
    await tracker.start();
    expect(env.deps.openCamera).toHaveBeenCalledTimes(1);
    expect(env.deps.createLandmarker).toHaveBeenCalledTimes(1);
  });

  it('새 비디오 프레임일 때만, 진행 중(예약됨)인 검출이 없을 때만 예약한다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    tracker.poll();
    tracker.poll();
    tracker.poll();
    expect(env.tasks).toHaveLength(1); // 예약 중에는 중복 예약 없음
    expect(env.detect).not.toHaveBeenCalled(); // poll() 안에서 검출하지 않는다 (별도 태스크)
    env.flush();
    expect(env.detect).toHaveBeenCalledTimes(1);
    tracker.poll();
    expect(env.tasks).toHaveLength(0); // 같은 프레임 — 다시 검출하지 않음
    env.video.currentTime += 0.033;
    tracker.poll();
    expect(env.tasks).toHaveLength(1); // 새 프레임
    env.flush();
    expect(env.detect).toHaveBeenCalledTimes(2);
  });

  it('원본(비반전) video 요소를 그대로 검출에 넣는다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    env.frame(tracker);
    expect(env.detect.mock.calls[0][0]).toBe(env.video);
  });

  it('타임스탬프는 시계가 멈추거나 거꾸로 가도 단조 증가', async () => {
    const env = makeEnv({ now: () => 5000 }); // 시계가 멈춘 경우
    const tracker = env.make();
    await tracker.start();
    for (let i = 0; i < 5; i++) {
      env.video.currentTime += 0.033;
      tracker.poll();
      env.flush();
    }
    expect(env.detect.mock.calls.map((c) => c[1])).toEqual([5000, 5001, 5002, 5003, 5004]);

    const env2 = makeEnv();
    const t2 = env2.make();
    await t2.start();
    env2.frame(t2);
    env2.advance(-500); // 시계가 뒤로 감
    env2.frame(t2);
    env2.frame(t2);
    const ts = env2.detect.mock.calls.map((c) => c[1]);
    expect(ts).toHaveLength(3);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });

  it('video 가 준비되지 않았으면(readyState<2) 예약하지 않고, 실행 시점에 크기가 0이면 건너뛴다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    env.video.readyState = 1;
    tracker.poll();
    expect(env.tasks).toHaveLength(0);
    env.video.readyState = 4;
    tracker.poll();
    expect(env.tasks).toHaveLength(1);
    env.video.videoWidth = 0; // 예약 뒤 실행 전에 사라진 경우
    env.flush();
    expect(env.detect).not.toHaveBeenCalled();
  });

  it('검출 결과가 신호가 되고, detectMs 는 이동 평균, metrics 에 카메라·delegate', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    const f = env.frame(tracker);
    expect(f.status).toBe('running');
    expect(f.signals.present).toBe(true);
    expect(f.signals.t).toBeCloseTo(-20 / 45, 6); // 카메라 yaw +20° → 거울 화면 −
    expect(f.metrics.detectMs).toBeCloseTo(10, 6);
    expect(f.metrics.faces).toBe(1);
    expect(f.metrics.camera).toBe('LGE Camera');
    expect(f.metrics.delegate).toBe('GPU');
    expect(f.sampledAt).not.toBeNull();
    expect(f.error).toBeUndefined();
  });

  it('얼굴이 없으면 present=false, 있다가 사라져도 값은 유지', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    env.frame(tracker);
    env.setResult({ faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] });
    const f = env.frame(tracker);
    expect(f.signals.present).toBe(false);
    expect(f.signals.t).toBeCloseTo(-20 / 45, 6);
    expect(f.metrics.faces).toBe(0);
  });

  it('여러 얼굴이면 가장 큰 얼굴의 행렬을 쓴다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    env.setResult({
      faceLandmarks: [makeFace({ cx: 0.3, w: 0.1, h: 0.15 }), makeFace({ cx: 0.7, w: 0.3, h: 0.45 })],
      facialTransformationMatrixes: [{ data: matrixFromEuler(-30, 0, 0) }, { data: matrixFromEuler(10, 0, 0) }],
      faceBlendshapes: [blends(0, 0, 0), blends(0, 0, 0)],
    });
    const f = env.frame(tracker);
    expect(f.signals.t).toBeCloseTo(-10 / 45, 6);
    expect(f.metrics.faces).toBe(2);
  });

  it('GPU 검출이 연속 3번 실패하면 CPU 로 다시 만들고 이어간다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    const cpuDetect = vi.fn(() => faceResult({ yaw: -10 }));
    env.deps.createLandmarker.mockImplementationOnce(async () => ({ landmarker: { detectForVideo: cpuDetect, close() {} }, delegate: 'CPU' }));
    env.setResult(new Error('GL context lost'));
    env.frame(tracker);
    env.frame(tracker);
    expect(env.deps.createLandmarker).toHaveBeenCalledTimes(1); // 아직 2번 실패
    env.frame(tracker);
    expect(env.landmarker.close).toHaveBeenCalled();
    expect(env.deps.createLandmarker).toHaveBeenLastCalledWith({ delegates: ['CPU'] });
    expect(tracker.poll().status).toBe('loading'); // 재생성 중
    await flushMicrotasks();
    expect(tracker.poll().status).toBe('running');
    const f = env.frame(tracker);
    expect(cpuDetect).toHaveBeenCalled();
    expect(f.metrics.delegate).toBe('CPU');
    expect(f.signals.t).toBeCloseTo(10 / 45, 6);
  });

  it('CPU 에서도 계속 실패하면 error 상태가 된다 (throw 하지 않음)', async () => {
    const bad = {
      detectForVideo: () => {
        throw new Error('boom');
      },
      close() {},
    };
    const env = makeEnv({ createLandmarker: vi.fn(async () => ({ landmarker: bad, delegate: 'CPU' })) });
    const tracker = env.make();
    await tracker.start();
    for (let i = 0; i < 30; i++) env.frame(tracker);
    const f = tracker.poll();
    expect(f.status).toBe('error');
    expect(f.error).toBeTruthy();
    expect(f.error).not.toContain('\n');
  });

  it('카메라 권한 거부: start() 는 throw 하지 않고 status=error + 한 줄 안내', async () => {
    const env = makeEnv({ openCamera: rejectWith('NotAllowedError') });
    const tracker = env.make();
    await expect(tracker.start()).resolves.toBeUndefined();
    const f = tracker.poll();
    expect(f.status).toBe('error');
    expect(f.error).toContain('권한');
    expect(f.signals.present).toBe(false);
    expect(env.tasks).toHaveLength(0);
  });

  it('카메라 없음 / 사용 중 안내', async () => {
    for (const [name, text] of [['NotFoundError', '찾을 수 없'], ['NotReadableError', '열 수 없']]) {
      const env = makeEnv({ openCamera: rejectWith(name) });
      const tracker = env.make();
      await tracker.start();
      expect(tracker.poll().error).toContain(text);
    }
  });

  it('모델 로딩 실패: status=error', async () => {
    const env = makeEnv({ createLandmarker: rejectWith('Error') });
    const tracker = env.make();
    await expect(tracker.start()).resolves.toBeUndefined();
    const f = tracker.poll();
    expect(f.status).toBe('error');
    expect(f.error).toContain('모델');
  });

  it('restartCamera: params.cameraId 로 다시 열고 이전 스트림을 멈추며 신호를 초기화한다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    env.frame(tracker);
    expect(tracker.poll().signals.present).toBe(true);
    env.params.cameraId = 'cam2';
    await tracker.restartCamera();
    expect(env.deps.openCamera).toHaveBeenLastCalledWith({ deviceId: 'cam2' });
    expect(env.deps.stopStream).toHaveBeenCalled();
    expect(tracker.poll().signals.present).toBe(false); // 이전 얼굴 정보 폐기
    env.frame(tracker);
    expect(tracker.poll().signals.present).toBe(true);
  });

  it('restartCamera 를 연달아 호출하면 마지막 요청만 반영한다', async () => {
    const resolvers = [];
    const mkRes = (id) => ({ stream: { id, getVideoTracks: () => [{ addEventListener() {}, label: id }], getTracks: () => [] }, deviceId: id, label: id, devices: [] });
    const env = makeEnv({ openCamera: vi.fn(() => new Promise((resolve) => resolvers.push(resolve))) });
    const tracker = env.make();
    const p1 = tracker.start();
    await flushMicrotasks();
    env.params.cameraId = 'second';
    const p2 = tracker.restartCamera();
    await flushMicrotasks();
    resolvers[1](mkRes('second'));
    await p2;
    resolvers[0](mkRes('first')); // 늦게 도착한 이전 요청
    await p1;
    expect(tracker.cameraLabel).toBe('second');
    expect(env.deps.stopStream).toHaveBeenCalledWith(expect.objectContaining({ id: 'first' }));
    expect(tracker.poll().status).toBe('running');
  });

  it('rVFC 가 있으면 표시 프레임 수로 새 프레임을 판단한다 (currentTime 만 변하면 재검출 없음)', async () => {
    let rvfc = null;
    const video = { readyState: 4, videoWidth: 1280, videoHeight: 720, currentTime: 0, requestVideoFrameCallback: (cb) => (rvfc = cb) };
    const env = makeEnv({ video });
    const tracker = env.make();
    await tracker.start();
    expect(rvfc).toBeTypeOf('function');
    rvfc(0, { presentedFrames: 1 });
    tracker.poll();
    env.flush();
    expect(env.detect).toHaveBeenCalledTimes(1);
    video.currentTime += 0.5; // currentTime 만 변함
    tracker.poll();
    expect(env.tasks).toHaveLength(0);
    rvfc(0, { presentedFrames: 2 }); // 새 프레임
    tracker.poll();
    expect(env.tasks).toHaveLength(1);
    env.flush();
    expect(env.detect).toHaveBeenCalledTimes(2);
  });

  it('rVFC 콜백이 1초 넘게 끊기면 currentTime 으로 대체한다', async () => {
    let rvfc = null;
    const video = { readyState: 4, videoWidth: 1280, videoHeight: 720, currentTime: 0, requestVideoFrameCallback: (cb) => (rvfc = cb) };
    const env = makeEnv({ video });
    const tracker = env.make();
    await tracker.start();
    rvfc(0, { presentedFrames: 1 });
    tracker.poll();
    env.flush();
    env.advance(1500);
    video.currentTime += 0.033;
    tracker.poll();
    expect(env.tasks).toHaveLength(1);
  });

  it('화면에 안 보이는 video: getVideoPlaybackQuality().totalVideoFrames 가 늘 때를 새 프레임으로 본다', async () => {
    let total = 5;
    const video = { readyState: 4, videoWidth: 1280, videoHeight: 720, currentTime: 0, getVideoPlaybackQuality: () => ({ totalVideoFrames: total }) };
    const env = makeEnv({ video });
    const tracker = env.make();
    await tracker.start();
    tracker.poll();
    env.flush();
    expect(env.detect).toHaveBeenCalledTimes(1);
    video.currentTime += 0.5; // currentTime 만 변함 → 같은 프레임
    tracker.poll();
    expect(env.tasks).toHaveLength(0);
    total++; // 새 프레임이 도착
    tracker.poll();
    expect(env.tasks).toHaveLength(1);
    env.flush();
    expect(env.detect).toHaveBeenCalledTimes(2);
  });

  it('C: 얼굴이 안정적으로 잡혀 있으면 기준 거리를 저장(true), 없으면 false', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    expect(tracker.calibrate()).toBe(false);
    for (let i = 0; i < 20; i++) env.frame(tracker);
    expect(tracker.calibrate()).toBe(true);
    env.setResult({ faceLandmarks: [] });
    env.frame(tracker);
    expect(tracker.calibrate()).toBe(false);
  });

  it('?debugpose: 1초마다 원시 행렬·각도·랜드마크 부호를 JSON 한 줄로 출력', async () => {
    const env = makeEnv();
    const tracker = env.make('?debugpose');
    await tracker.start();
    env.frame(tracker);
    env.frame(tracker);
    expect(env.deps.log).toHaveBeenCalledTimes(1); // 1초 안에는 한 번
    const [tag, json] = env.deps.log.mock.calls[0];
    expect(tag).toBe('[debugpose]');
    const o = JSON.parse(json);
    expect(o.matrixColumnMajor).toHaveLength(16);
    expect(o.eulerCameraDeg.yaw).toBeCloseTo(20, 3);
    expect(o.normalized.t).toBeCloseTo(-20 / 45, 3);
    expect(typeof o.landmarkYaw).toBe('number');
    expect(typeof o.signAgree).toBe('boolean');
    env.advance(1100);
    env.frame(tracker);
    expect(env.deps.log).toHaveBeenCalledTimes(2);

    const quiet = makeEnv();
    const t2 = quiet.make('');
    await t2.start();
    quiet.frame(t2);
    expect(quiet.deps.log).not.toHaveBeenCalled();
  });

  it('stop(): 스트림과 모델을 정리하고 더 이상 검출하지 않는다', async () => {
    const env = makeEnv();
    const tracker = env.make();
    await tracker.start();
    env.frame(tracker);
    tracker.stop();
    expect(env.landmarker.close).toHaveBeenCalled();
    env.video.currentTime += 1;
    tracker.poll();
    expect(env.tasks).toHaveLength(0);
  });
});

// ---- openCamera / attachStream (가짜 mediaDevices 주입) -------------------------------------------

describe('openCamera: 저장된 카메라 우선, 자동 선택 시 IR·가상 카메라 회피', () => {
  afterEach(() => vi.unstubAllGlobals());

  const makeStream = (id, label) => {
    const track = { label, stop: vi.fn(), getSettings: () => ({ deviceId: id }) };
    return { id, track, getVideoTracks: () => [track], getTracks: () => [track] };
  };

  /**
   * devices: [{id,label,fail?}] — fail 이면 그 장치를 열 때 해당 이름의 오류. defaultId: deviceId 없이 열었을 때의 기본 장치.
   */
  function setup({ devices, defaultId = devices[0]?.id, noDevicesApi = false } = {}) {
    const opened = [];
    const media = {
      getUserMedia: vi.fn(async (constraints) => {
        const exact = constraints.video.deviceId?.exact;
        const dev = devices.find((d) => d.id === (exact ?? defaultId));
        if (!dev) throw Object.assign(new Error('x'), { name: exact ? 'OverconstrainedError' : 'NotFoundError' });
        if (dev.fail) throw Object.assign(new Error('x'), { name: dev.fail });
        const s = makeStream(dev.id, dev.label);
        opened.push(s);
        return s;
      }),
      enumerateDevices: vi.fn(async () => devices.map((d) => ({ kind: 'videoinput', deviceId: d.id, label: d.label }))),
    };
    vi.stubGlobal('navigator', noDevicesApi ? {} : { mediaDevices: media });
    return { media, opened };
  }

  const THIS_PC = [
    { id: 'ir', label: 'LGE IR-FHD Camera (0408:5366)' },
    { id: 'virt', label: 'Mirametrix Virtual Camera' },
    { id: 'lge', label: 'LGE Camera (0408:5365)' },
    { id: 'scan', label: 'Printer Scan' },
  ];

  it('mediaDevices 가 없으면 unsupported 오류', async () => {
    setup({ devices: [], noDevicesApi: true });
    await expect(openCamera()).rejects.toMatchObject({ name: 'unsupported' });
    expect(describeCameraError({ name: 'unsupported' })).toContain('카메라');
  });

  it('요청 해상도·프레임레이트는 1280×720 / 30fps ideal, 오디오 없음', async () => {
    const { media } = setup({ devices: [{ id: 'lge', label: 'LGE Camera' }] });
    await openCamera();
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(media.getUserMedia.mock.calls[0][0]).toEqual({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
  });

  it('기본 카메라가 일반 웹캠이면 그대로 쓴다 (장치 목록도 돌려줌)', async () => {
    const { media } = setup({ devices: THIS_PC, defaultId: 'lge' });
    const r = await openCamera();
    expect(r.label).toContain('LGE Camera');
    expect(r.deviceId).toBe('lge');
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(r.devices.map((d) => d.id)).toEqual(['ir', 'virt', 'lge', 'scan']);
  });

  it('기본 카메라가 IR 이면 LGE Camera 로 바꾸고 IR 스트림은 닫는다', async () => {
    const { media, opened } = setup({ devices: THIS_PC, defaultId: 'ir' });
    const r = await openCamera();
    expect(r.deviceId).toBe('lge');
    expect(media.getUserMedia).toHaveBeenCalledTimes(2);
    expect(media.getUserMedia.mock.calls[1][0].video.deviceId).toEqual({ exact: 'lge' });
    expect(opened[0].track.stop).toHaveBeenCalled(); // IR
    expect(opened[1].track.stop).not.toHaveBeenCalled();
  });

  it('기본 카메라가 가상 카메라(Mirametrix)여도 마찬가지', async () => {
    const { opened } = setup({ devices: THIS_PC, defaultId: 'virt' });
    const r = await openCamera();
    expect(r.deviceId).toBe('lge');
    expect(opened[0].track.stop).toHaveBeenCalled();
  });

  it('대체 카메라를 못 열면 기본(IR) 카메라를 그대로 쓴다', async () => {
    const devices = THIS_PC.map((d) => (d.id === 'lge' ? { ...d, fail: 'NotReadableError' } : d));
    const { opened } = setup({ devices, defaultId: 'ir' });
    const r = await openCamera();
    expect(r.deviceId).toBe('ir');
    expect(opened[0].track.stop).not.toHaveBeenCalled();
  });

  it('후보가 IR·가상뿐이면 기본 카메라 유지', async () => {
    const { media } = setup({ devices: [THIS_PC[0], THIS_PC[1]], defaultId: 'ir' });
    const r = await openCamera();
    expect(r.deviceId).toBe('ir');
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('저장된 cameraId 가 있으면 먼저 정확히 그 장치를 연다 (IR 이어도 사용자가 고른 것은 존중)', async () => {
    const { media } = setup({ devices: THIS_PC, defaultId: 'lge' });
    const r = await openCamera({ deviceId: 'ir' });
    expect(r.deviceId).toBe('ir');
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(media.getUserMedia.mock.calls[0][0].video.deviceId).toEqual({ exact: 'ir' });
  });

  it('저장된 cameraId 장치가 없으면 기본 카메라로, 이때는 IR 회피 정책을 적용한다', async () => {
    const { media } = setup({ devices: THIS_PC, defaultId: 'ir' });
    const r = await openCamera({ deviceId: 'unplugged-device' });
    expect(r.deviceId).toBe('lge');
    expect(media.getUserMedia).toHaveBeenCalledTimes(3); // 저장된 것(실패) → 기본(IR) → LGE
  });

  it('권한 거부는 다른 후보를 시도하지 않고 바로 오류', async () => {
    const devices = THIS_PC.map((d) => ({ ...d, fail: 'NotAllowedError' }));
    const { media } = setup({ devices, defaultId: 'ir' });
    await expect(openCamera()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    await expect(openCamera({ deviceId: 'lge' })).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('기본 카메라(가상)가 열리지 않으면 다른 후보를 차례로 시도한다', async () => {
    const devices = THIS_PC.map((d) => (d.id === 'virt' ? { ...d, fail: 'NotReadableError' } : d));
    const { opened } = setup({ devices, defaultId: 'virt' });
    const r = await openCamera();
    expect(r.deviceId).toBe('lge');
    expect(opened).toHaveLength(1);
  });

  it('열 수 있는 카메라가 하나도 없으면 처음 오류를 던진다', async () => {
    const devices = THIS_PC.map((d) => ({ ...d, fail: 'NotReadableError' }));
    setup({ devices, defaultId: 'ir' });
    await expect(openCamera()).rejects.toMatchObject({ name: 'NotReadableError' });
  });

  it('카메라가 없으면 NotFoundError', async () => {
    setup({ devices: [] });
    await expect(openCamera()).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(describeCameraError({ name: 'NotFoundError' })).toContain('찾을 수 없');
  });
});

describe('attachStream', () => {
  afterEach(() => vi.useRealTimers());

  function fakeVideo({ ready = false, play = async () => {} } = {}) {
    const listeners = new Map();
    const v = {
      readyState: ready ? 4 : 0,
      videoWidth: ready ? 1280 : 0,
      videoHeight: ready ? 720 : 0,
      srcObject: null,
      play: vi.fn(play),
      listeners,
      addEventListener: (t, f) => listeners.set(t, f),
      removeEventListener: (t) => listeners.delete(t),
      becomeReady() {
        v.readyState = 4;
        v.videoWidth = 1280;
        v.videoHeight = 720;
        listeners.get('loadeddata')?.();
      },
    };
    return v;
  }

  it('스트림을 연결하고 play() 후 이미 준비됐으면 바로 끝난다', async () => {
    const v = fakeVideo({ ready: true });
    const stream = {};
    await attachStream(v, stream);
    expect(v.srcObject).toBe(stream);
    expect(v.play).toHaveBeenCalled();
  });

  it('첫 프레임(videoWidth>0)이 올 때까지 기다린다', async () => {
    const v = fakeVideo({ ready: false });
    let done = false;
    const p = attachStream(v, {}).then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    v.becomeReady();
    await p;
    expect(done).toBe(true);
    expect(v.listeners.size).toBe(0); // 리스너 정리
  });

  it('끝내 영상이 안 오면 timeout 오류 → 한 줄 안내', async () => {
    vi.useFakeTimers();
    const v = fakeVideo({ ready: false });
    const p = attachStream(v, {}, 5000);
    const assertion = expect(p).rejects.toMatchObject({ name: 'timeout' });
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(describeCameraError({ name: 'timeout' })).toContain('영상');
  });

  it('play() 가 자동재생 정책으로 거부(NotAllowedError)되면 그대로 던진다', async () => {
    const v = fakeVideo({
      play: async () => {
        throw Object.assign(new Error('x'), { name: 'NotAllowedError' });
      },
    });
    await expect(attachStream(v, {})).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('play() 가 AbortError 등으로 실패해도 영상이 준비되면 계속 진행한다', async () => {
    const v = fakeVideo({
      ready: true,
      play: async () => {
        throw Object.assign(new Error('x'), { name: 'AbortError' });
      },
    });
    await expect(attachStream(v, {})).resolves.toBeUndefined();
  });
});

// ---- getUserMedia 타임아웃 (응답 없이 멈추는 가상 카메라) ------------------------------------------

describe('openCamera: getUserMedia 타임아웃', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const mkStream = (id, label) => {
    const track = { label, stop: vi.fn(), getSettings: () => ({ deviceId: id }) };
    return { id, track, getVideoTracks: () => [track], getTracks: () => [track] };
  };

  /** hang: true 인 장치는 열 때 응답하지 않는다. release(id) 로 나중에 늦게 응답시킬 수 있다 */
  function setup(devices, defaultId) {
    const late = new Map();
    const media = {
      getUserMedia: vi.fn((c) => {
        const id = c.video.deviceId?.exact ?? defaultId;
        const dev = devices.find((d) => d.id === id);
        if (!dev) return Promise.reject(Object.assign(new Error('x'), { name: 'OverconstrainedError' }));
        if (dev.hang) {
          return new Promise((resolve) => late.set(id, () => resolve(mkStream(id, dev.label))));
        }
        return Promise.resolve(mkStream(id, dev.label));
      }),
      enumerateDevices: vi.fn(async () => devices.map((d) => ({ kind: 'videoinput', deviceId: d.id, label: d.label }))),
    };
    vi.stubGlobal('navigator', { mediaDevices: media });
    return { media, release: (id) => late.get(id)() };
  }

  const PC = [
    { id: 'virt', label: 'Mirametrix Virtual Camera', hang: true },
    { id: 'lge', label: 'LGE Camera' },
  ];

  it('기본 카메라(가상)가 멈추면 제한 시간 뒤 다른 후보로 열고, 늦게 온 스트림은 즉시 멈춘다', async () => {
    const { media, release } = setup(PC, 'virt');
    const p = openCamera({ requestTimeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(2999);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1); // 아직 기다리는 중
    await vi.advanceTimersByTimeAsync(2);
    const r = await p;
    expect(r.deviceId).toBe('lge');
    release('virt'); // 시간 초과 뒤 늦게 응답해도 오류 없이 무시된다(트랙 정리는 다음 테스트에서 확인)
    await vi.advanceTimersByTimeAsync(0);
  });

  it('늦게 도착한 스트림의 트랙이 stop 된다', async () => {
    const streams = [];
    let resolveLate;
    const media = {
      getUserMedia: vi.fn((c) => {
        if (!c.video.deviceId) {
          return new Promise((resolve) => {
            resolveLate = () => {
              const s = mkStream('virt', 'Mirametrix Virtual Camera');
              streams.push(s);
              resolve(s);
            };
          });
        }
        return Promise.resolve(mkStream(c.video.deviceId.exact, 'LGE Camera'));
      }),
      enumerateDevices: vi.fn(async () => [
        { kind: 'videoinput', deviceId: 'virt', label: 'Mirametrix Virtual Camera' },
        { kind: 'videoinput', deviceId: 'lge', label: 'LGE Camera' },
      ]),
    };
    vi.stubGlobal('navigator', { mediaDevices: media });
    const p = openCamera({ requestTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    await p;
    resolveLate();
    await vi.advanceTimersByTimeAsync(0);
    expect(streams[0].track.stop).toHaveBeenCalled();
  });

  it('모든 후보가 멈추면 RequestTimeout 오류와 한 줄 안내', async () => {
    setup([{ id: 'a', label: 'Cam A', hang: true }, { id: 'b', label: 'Cam B', hang: true }], 'a');
    const p = openCamera({ requestTimeoutMs: 500 });
    const assertion = expect(p).rejects.toMatchObject({ name: 'RequestTimeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    const msg = describeCameraError({ name: 'RequestTimeout' });
    expect(msg).toContain('응답');
    expect(msg).not.toContain('\n');
  });

  it('저장된 cameraId 가 멈추면 기본 카메라로 넘어간다', async () => {
    setup([{ id: 'saved', label: 'External Cam', hang: true }, { id: 'lge', label: 'LGE Camera' }], 'lge');
    const p = openCamera({ deviceId: 'saved', requestTimeoutMs: 800 });
    await vi.advanceTimersByTimeAsync(801);
    const r = await p;
    expect(r.deviceId).toBe('lge');
  });

  it('IR 대신 고른 대체 카메라가 멈추면 기본(IR) 카메라를 유지한다', async () => {
    setup([{ id: 'ir', label: 'LGE IR-FHD Camera' }, { id: 'lge', label: 'LGE Camera', hang: true }], 'ir');
    const p = openCamera({ requestTimeoutMs: 800 });
    await vi.advanceTimersByTimeAsync(801);
    const r = await p;
    expect(r.deviceId).toBe('ir');
  });

  it('권한 팝업이 떠 있을 수 있을 때(허용 전·확인 불가) 기본 제한 시간은 길다. 허용돼 있으면 8초', async () => {
    const { media } = setup([{ id: 'lge', label: 'LGE Camera', hang: true }], 'lge');
    let settled = false;
    openCamera({}).then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(20000);
    expect(settled).toBe(false); // 팝업 대기 가능성 → 20초로는 포기하지 않는다
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);

    const granted = setup([{ id: 'v', label: 'Mirametrix Virtual Camera', hang: true }, { id: 'lge', label: 'LGE Camera' }], 'v');
    vi.stubGlobal('navigator', { mediaDevices: granted.media, permissions: { query: async () => ({ state: 'granted' }) } });
    const p = openCamera({});
    await vi.advanceTimersByTimeAsync(7900);
    expect(granted.media.getUserMedia).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect((await p).deviceId).toBe('lge');
  });
});

// ---- 코드 리뷰 2차 회귀: 카메라 시작 실패 처리 ----------------------------------------------------

describe('startCamera 실패 처리', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const stream = () => ({ id: 's', getVideoTracks: () => [{ addEventListener() {}, label: 'cam' }], getTracks: () => [] });
  function make(over = {}) {
    const video = { readyState: 0, videoWidth: 0, currentTime: 0, srcObject: 'x' };
    const s = stream();
    const deps = {
      detector: 'main',
      video,
      createLandmarker: vi.fn(async () => ({ landmarker: { detectForVideo() {}, close() {} }, delegate: 'CPU' })),
      openCamera: vi.fn(async () => ({ stream: s, deviceId: 'c', label: 'Virtual', devices: [{ id: 'c', label: 'Virtual' }] })),
      attachStream: vi.fn(async () => {
        throw Object.assign(new Error('x'), { name: 'timeout' });
      }),
      stopStream: vi.fn(),
      listVideoInputs: vi.fn(async () => [{ id: 'a', label: 'LGE Camera' }, { id: 'b', label: 'LGE IR-FHD Camera' }]),
      ...over,
    };
    return { s, video, deps, tracker: createTracker(createParams(), { deps }) };
  }

  it('[5] 재생 거부·첫 프레임 타임아웃으로 attachStream 이 실패하면 받은 스트림을 멈추고 srcObject 를 비운다', async () => {
    const { s, video, deps, tracker } = make();
    await tracker.start();
    expect(deps.stopStream).toHaveBeenCalledWith(s);
    expect(video.srcObject).toBeNull();
    const f = tracker.poll();
    expect(f.status).toBe('error');
    expect(f.error).toContain('영상');
  });

  it('[10] 카메라 열기가 실패해도 장치 목록을 갱신하고 status 는 error — 패널에서 다른 카메라를 고를 수 있다', async () => {
    const { deps, tracker } = make({ openCamera: vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'RequestTimeout' }); }) });
    await tracker.start();
    expect(deps.listVideoInputs).toHaveBeenCalled();
    expect(tracker.cameras.map((d) => d.id)).toEqual(['a', 'b']);
    expect(tracker.status).toBe('error');
    expect(tracker.poll().error).toContain('응답');
    // 다른 카메라를 골라 재시도
    deps.openCamera.mockImplementation(async () => ({ stream: stream(), deviceId: 'a', label: 'LGE Camera', devices: [{ id: 'a', label: 'LGE Camera' }] }));
    deps.attachStream.mockImplementation(async () => {});
    await tracker.restartCamera();
    expect(tracker.status).toBe('running');
    expect(tracker.cameraLabel).toBe('LGE Camera');
  });

  it('[2] play() 가 영원히 끝나지 않아도(프레임을 안 주는 가상 카메라) 제한 시간에 실패한다', async () => {
    vi.useFakeTimers();
    const video = {
      readyState: 0,
      videoWidth: 0,
      videoHeight: 0,
      srcObject: null,
      play: () => new Promise(() => {}),
      addEventListener() {},
      removeEventListener() {},
    };
    const p = attachStream(video, {}, 3000);
    const assertion = expect(p).rejects.toMatchObject({ name: 'timeout' });
    await vi.advanceTimersByTimeAsync(3001);
    await assertion;
  });
});
