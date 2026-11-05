// 카메라·모델 없이 렌더러를 확인하는 mock 추적기. 실제 추적기(faceTracker.js)와 같은 인터페이스(contracts.js).
//
//   ?mock                      반복 타임라인(36초): 시나리오 B(PRD 2.3, 15초) → 얼굴 이탈 2초·재등장(고개 돌린 채)
//                              → 끄덕임·갸웃·접근 → 빠른 회전 후 정지 → 1프레임 깜빡임
//   ?mock&at=초                타임라인 중간(초)부터 시작
//   ?mock=static&t=0.8&p=0&r=0&k=0&bl=0&br=0&jaw=0&face=1   고정값 (모델·카메라 로딩 없음)
//
// 신호는 실제 추적기처럼 30Hz 표본으로만 갱신하고, 깜빡임은 blink.js 상태기계를 그대로 통과시킨다.

import { BLINK, TRACKING } from '../config/params.js';
import { createBlink, blinkOutput } from './blink.js';

export const MOCK_HZ = 30;
export const TICK_MS = 1000 / MOCK_HZ;
export const CYCLE_SEC = 36;
export const CYCLE_TICKS = CYCLE_SEC * MOCK_HZ; // 1080

const MAX_CATCHUP = 6; // 프레임이 오래 멈췄을 때 한 번에 처리할 최대 틱 수
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (x) => x * x * (3 - 2 * x);

/** 키프레임 [[초, 값], ...] 사이를 smoothstep 으로 보간 (각 키에서 속도 0) */
export function keyframes(u, keys) {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (u < keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      return v0 + (v1 - v0) * smoothstep((u - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

// t: + = 화면에서 코가 오른쪽. 시나리오 B의 "왼쪽으로 회전"은 거울 화면에서 코가 왼쪽 → 음수.
const T_KEYS = [
  [0, 0], [2, 0], [5, -1], [7, -1], [9, 0], // B: 왼쪽 회전(3초) → 유지(2초) → 정면 복귀(2초)
  [10.8, 1], [11.5, 1], [12.5, 0], // B: 오른쪽 회전 → 복귀
  [14.9, 0], [15.1, 0.5], [17, 0.5], [18.4, 0], // 이탈 중(15~17초)에 자세가 바뀌어 고개 돌린 채 재등장
  [26, 0], [26.5, 0], [26.75, -1], [28, -1], [28.25, 1], [29.5, 1], [29.75, 0], // 빠른 회전(0.25초) 후 정지
  [CYCLE_SEC, 0],
];
const P_KEYS = [[0, 0], [18.5, 0], [19.3, 1], [20.1, -1], [20.9, 0], [CYCLE_SEC, 0]]; // 끄덕임
const R_KEYS = [[0, 0], [14.9, 0], [15.1, -0.35], [17, -0.35], [18.4, 0], [21, 0], [21.8, 1], [22.6, -1], [23.4, 0], [CYCLE_SEC, 0]]; // 갸웃
const K_KEYS = [[0, 0], [23.5, 0], [24.6, 1], [25.4, 1], [26, 0], [CYCLE_SEC, 0]]; // 카메라에 접근
const JAW_KEYS = [[0, 0], [13.2, 0], [13.8, 0.85], [14.4, 0.85], [14.9, 0], [33.2, 0], [33.7, 0.9], [34.3, 0.9], [34.8, 0], [CYCLE_SEC, 0]];

/** 깜빡임 이벤트: n = 시작 틱, len = 틱 수(30Hz에서 1틱 = 1프레임), eyes: L=화면 왼쪽 눈, R=오른쪽 눈 */
const BLINKS = [
  { n: 27, len: 4, eyes: 'LR' }, // 0.9초
  { n: 387, len: 5, eyes: 'LR' }, // 12.9초 (시나리오 B 마무리 표정)
  { n: 417, len: 5, eyes: 'L' }, // 13.9초 한쪽 눈만
  { n: 960, len: 1, eyes: 'LR' }, // 32.0초 1프레임
  { n: 990, len: 1, eyes: 'L' }, // 33.0초 1프레임, 한쪽
  { n: 1020, len: 1, eyes: 'R' }, // 34.0초 1프레임, 반대쪽
  { n: 1050, len: 2, eyes: 'LR' }, // 35.0초 2프레임
];

/**
 * 타임라인의 틱 하나(30Hz)에서의 원시 표본. 틱 번호만의 함수라 결정적이다.
 * @returns {{present:boolean,t:number,p:number,r:number,k:number,jaw:number,blinkL:number,blinkR:number}}
 */
export function mockSample(tick) {
  const n = ((tick % CYCLE_TICKS) + CYCLE_TICKS) % CYCLE_TICKS;
  const u = n / MOCK_HZ;
  let blinkL = 0;
  let blinkR = 0;
  for (const ev of BLINKS) {
    if (n >= ev.n && n < ev.n + ev.len) {
      if (ev.eyes.includes('L')) blinkL = 1;
      if (ev.eyes.includes('R')) blinkR = 1;
    }
  }
  return {
    present: u < 15 || u >= 17,
    // 숨 쉬는 듯한 아주 작은 흔들림
    t: clamp(keyframes(u, T_KEYS) + 0.012 * Math.sin(u * 2.0), -1, 1),
    p: clamp(keyframes(u, P_KEYS) + 0.02 * Math.sin(u * 2.7 + 1), -1, 1),
    r: clamp(keyframes(u, R_KEYS) + 0.015 * Math.sin(u * 1.46 + 2), -1, 1),
    k: clamp(keyframes(u, K_KEYS), 0, 1),
    jaw: clamp(keyframes(u, JAW_KEYS), 0, 1),
    blinkL,
    blinkR,
  };
}

/** ?mock 쿼리 해석. mock 이 아니면 null */
export function parseMockOptions(search = '') {
  const q = new URLSearchParams(search);
  if (!q.has('mock')) return null;
  const v = (q.get('mock') ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(v)) return null;
  const num = (key, def, lo, hi) => {
    const raw = q.get(key);
    if (raw === null || raw.trim() === '') return def;
    const x = Number(raw);
    return Number.isFinite(x) ? clamp(x, lo, hi) : def;
  };
  const face = (q.get('face') ?? '1').trim().toLowerCase();
  return {
    mode: v === 'static' ? 'static' : 'timeline',
    at: num('at', 0, 0, 86400),
    t: num('t', 0, -1, 1),
    p: num('p', 0, -1, 1),
    r: num('r', 0, -1, 1),
    k: num('k', 0, 0, 1),
    bl: num('bl', 0, 0, 1),
    br: num('br', 0, 0, 1),
    jaw: num('jaw', 0, 0, 1),
    face: !['0', 'false', 'off', 'no'].includes(face),
  };
}

export function isMockRequested(search = '') {
  return parseMockOptions(search) !== null;
}

/**
 * @param {object} params 공유 params (metrics 의 각도 환산에만 사용)
 * @param {string} [search] location.search
 */
export function createMockTracker(params, search = '') {
  const opts = parseMockOptions(search) ?? parseMockOptions('?mock');
  const isStatic = opts.mode === 'static';
  const startTick = Math.round(opts.at * MOCK_HZ);
  const eyeL = createBlink();
  const eyeR = createBlink();

  let t0 = null;
  let lastTick = -1;
  let held = { t: 0, p: 0, r: 0, k: 0, jaw: 0 };
  let hadFace = false;
  let sampledAt = null;

  function applyTick(n, at) {
    const s = mockSample(startTick + n);
    sampledAt = at;
    if (!s.present) {
      hadFace = false; // 값은 마지막 값 유지
      return;
    }
    if (!hadFace) {
      eyeL.reset();
      eyeR.reset();
    }
    hadFace = true;
    held = { t: s.t, p: s.p, r: s.r, k: s.k, jaw: s.jaw };
    eyeL.push(s.blinkL, at);
    eyeR.push(s.blinkR, at);
  }

  return {
    mock: opts,
    video: null,
    cameras: [],
    cameraLabel: 'mock',
    status: 'running',

    async start() {},
    async restartCamera() {},

    poll(nowMs = performance.now()) {
      if (t0 === null) t0 = nowMs;
      let signals;
      if (isStatic) {
        sampledAt = nowMs;
        signals = {
          present: opts.face,
          t: opts.t,
          p: opts.p,
          r: opts.r,
          k: opts.k,
          blinkL: blinkOutput(opts.bl, opts.bl >= BLINK.closeAt),
          blinkR: blinkOutput(opts.br, opts.br >= BLINK.closeAt),
          jaw: opts.jaw,
        };
      } else {
        const due = Math.floor((nowMs - t0) / TICK_MS);
        if (due - lastTick > MAX_CATCHUP) lastTick = due - MAX_CATCHUP;
        for (let n = lastTick + 1; n <= due; n++) applyTick(n, t0 + n * TICK_MS);
        lastTick = Math.max(lastTick, due);
        signals = {
          present: hadFace && nowMs - sampledAt < TRACKING.staleMs,
          t: held.t,
          p: held.p,
          r: held.r,
          k: held.k,
          blinkL: eyeL.value(nowMs),
          blinkR: eyeR.value(nowMs),
          jaw: held.jaw,
        };
      }
      return {
        signals,
        status: 'running',
        sampledAt,
        metrics: {
          yawDeg: signals.t * params.yawRange,
          pitchDeg: signals.p * params.pitchRange,
          rollDeg: signals.r * params.rollRange,
          proximity: 1 + signals.k * (params.maxProximity - 1),
          detectMs: 0,
          faces: signals.present ? 1 : 0,
          camera: 'mock',
          delegate: '-',
          detector: '-',
          mainMs: 0,
        },
      };
    },

    /** 얼굴이 있으면 true (mock 의 k 는 타임라인이 정하므로 기준 거리는 바뀌지 않는다) */
    calibrate() {
      return isStatic ? opts.face : hadFace;
    },
  };
}
