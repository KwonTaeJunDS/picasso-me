// 검출 표본 → FaceSignals. DOM·MediaPipe 없이 동작하는 순수 로직이라 단위 테스트가 가능하다.
//
// 표본(sample) 모양 — faceTracker.extractSample() 이 만든다:
//   { at, hasFace, faces, matrix, eyeDistPx, landmarkYaw, blinkLeft, blinkRight, jawOpen }
//   얼굴이 없는 표본은 { at, hasFace:false, faces:0 }.
//
// 규칙(PLAN 3.2~3.6)
//  - One Euro 는 새 표본에만 적용하고, 얼굴이 (다시) 나타나면 필터를 리셋한다.
//  - present = 최근 표본에 얼굴 있음 && now − at < staleMs. present=false 인 동안 나머지 값은 마지막 값 유지.
//  - 거리: 'matrix' = |z0|/|z|, 'eyes' = (눈꼬리 픽셀 거리 / cos|yaw|)/e0 (|yaw| > eyesModeMaxYaw 면 갱신 보류).
//  - 기준 거리: 연속 baselineStableMs 이상 검출되고 |yaw|,|pitch| < baselineMaxAngle 인 구간의 중앙값으로 자동 1회,
//    calibrate() 로 현재 필터값으로 갱신, 모드를 바꾸면 재설정.

import { TRACKING, BLINK } from '../config/params.js';
import { createOneEuro } from './oneEuro.js';
import { createBlink } from './blink.js';
import { eulerFromMatrix, toScreenAngles, normalizeAngles, createSignChecker } from './pose.js';

const DEG2RAD = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {object} params 공유 params (매 호출마다 읽음 — 패널 변경이 즉시 반영된다)
 * @param {{ tracking?: object, blink?: object, signChecker?: object }} [cfg] 테스트용 주입
 */
export function createSignalProcessor(params, cfg = {}) {
  const tracking = { ...TRACKING, ...(cfg.tracking ?? {}) };
  const blinkCfg = cfg.blink ?? BLINK;
  const checker = cfg.signChecker ?? createSignChecker();

  const fYaw = createOneEuro();
  const fPitch = createOneEuro();
  const fRoll = createOneEuro();
  const fDist = createOneEuro();
  const fJaw = createOneEuro();
  const eyeA = createBlink(blinkCfg); // eyeBlinkLeft (피사체 왼눈 = 거울 화면 왼쪽)
  const eyeB = createBlink(blinkCfg); // eyeBlinkRight

  let hadFace = false; // 직전 표본에 얼굴이 있었나
  let lastAt = null; // 마지막 표본 시각 (얼굴 유무 무관)
  let lastFaceAt = null; // 얼굴이 있던 마지막 표본 시각
  let faces = 0;
  // 필터 후 값 (카메라 공간 각도(°), 거리 측정값, 입 벌림)
  let yaw = 0;
  let pitch = 0;
  let roll = 0;
  let jaw = 0;
  let measuredAt = null; // 거리를 마지막으로 실제 측정한 표본 시각 (보류된 표본은 갱신하지 않음)
  let dist = null; // 'matrix': 필터된 |z|, 'eyes': 필터된 e/cos|yaw|
  let baseline = null;
  let baselineMode = params.distanceMode;
  let auto = newAuto();

  function newAuto() {
    return { done: false, startAt: null, buf: [] };
  }

  /** 짧은 미검출 뒤 재등장이면 깜빡임 상태(최소 유지 시간)는 보존한다. 장기 이탈·카메라 전환이면 withBlink */
  function resetFilters(withBlink = true) {
    fYaw.reset();
    fPitch.reset();
    fRoll.reset();
    fDist.reset();
    fJaw.reset();
    if (withBlink) {
      eyeA.reset();
      eyeB.reset();
    }
  }

  /** 거리 계산 방식이 바뀌면 기준·측정값을 버린다 */
  function syncMode() {
    if (params.distanceMode === baselineMode) return;
    baselineMode = params.distanceMode;
    baseline = null;
    dist = null;
    measuredAt = null;
    auto = newAuto();
    fDist.reset();
  }

  const smooth = (f, v, dt, minCutoff, beta) => (params.filterEnabled ? f.filter(v, dt, minCutoff, beta) : f.pass(v));

  function currentProximity() {
    if (baseline === null || dist === null || !(dist > 0)) return 1;
    return baselineMode === 'eyes' ? dist / baseline : baseline / dist;
  }

  return {
    /**
     * 검출 표본 하나를 반영한다. 새 표본에서만 호출할 것.
     * @param {object|null} sample null 이면 얼굴 없는 표본
     * @param {number} nowMs 표본에 시각(at)이 없을 때 쓸 현재 시각
     */
    push(sample, nowMs) {
      syncMode();
      const at = sample?.at ?? nowMs;
      lastAt = at;
      // 마지막 얼굴 표본과의 간격이 staleMs 이상이면 "연속"이 끊긴 것: 필터·자동 기준 수집을 처음부터
      const longGap = lastFaceAt === null || at - lastFaceAt >= tracking.staleMs;
      if (!sample || !sample.hasFace) {
        hadFace = false;
        faces = 0;
        auto.startAt = null; // 연속 검출 구간이 끊김
        auto.buf.length = 0;
        return;
      }
      faces = sample.faces ?? 1;
      if (longGap) {
        resetFilters(true);
        auto.startAt = null;
        auto.buf.length = 0;
      } else if (!hadFace) {
        resetFilters(false); // 짧은 미검출 뒤 재등장: 필터만 리셋, 깜빡임 유지 시간은 보존
      }
      const dt = hadFace && !longGap ? (at - lastFaceAt) / 1000 : 0;
      hadFace = true;
      lastFaceAt = at;

      // 각도 (카메라 공간, 도)
      const eul = eulerFromMatrix(sample.matrix);
      if (eul) {
        yaw = smooth(fYaw, eul.yaw, dt, params.angleMinCutoff, params.angleBeta);
        pitch = smooth(fPitch, eul.pitch, dt, params.angleMinCutoff, params.angleBeta);
        roll = smooth(fRoll, eul.roll, dt, params.angleMinCutoff, params.angleBeta);
        checker.push(eul.yaw, sample.landmarkYaw);
      }

      // 거리 측정값
      let measure = null;
      if (params.distanceMode === 'eyes') {
        const e = sample.eyeDistPx;
        // 같은 표본의 원시 yaw 로 검사·보정한다 (지연된 필터 yaw 는 급회전 때 어긋남)
        if (e > 0 && eul && Math.abs(eul.yaw) <= tracking.eyesModeMaxYaw) {
          measure = e / Math.max(Math.cos(Math.abs(eul.yaw) * DEG2RAD), 0.5);
        }
      } else {
        const z = Math.abs(sample.matrix?.[14]);
        if (z > 1e-6 && Number.isFinite(z)) measure = z;
      }
      if (measure !== null) {
        dist = smooth(fDist, measure, dt, params.angleMinCutoff, params.angleBeta);
        measuredAt = at;
      }

      // 자동 기준 거리 (한 번)
      if (baseline === null && !auto.done) {
        const stable =
          measure !== null && Math.abs(yaw) < tracking.baselineMaxAngle && Math.abs(pitch) < tracking.baselineMaxAngle;
        if (stable) {
          if (auto.startAt === null) auto.startAt = at;
          auto.buf.push(dist);
          if (at - auto.startAt >= tracking.baselineStableMs) {
            baseline = median(auto.buf);
            auto.done = true;
            auto.buf.length = 0;
          }
        } else {
          auto.startAt = null;
          auto.buf.length = 0;
        }
      }

      // 표정
      jaw = clamp(smooth(fJaw, sample.jawOpen ?? 0, dt, params.exprMinCutoff, params.exprBeta), 0, 1);
      eyeA.push(sample.blinkLeft ?? 0, at);
      eyeB.push(sample.blinkRight ?? 0, at);
    },

    /** 현재 시각의 FaceSignals. 호출해도 필터 상태는 바뀌지 않는다 */
    signals(nowMs) {
      syncMode();
      const present = hadFace && lastAt !== null && nowMs - lastAt < tracking.staleMs;
      const { t, p, r } = normalizeAngles(toScreenAngles({ yaw, pitch, roll }, params), params);
      const prox = currentProximity();
      const k = clamp((prox - 1) / Math.max(params.maxProximity - 1, 1e-6), 0, 1);
      const a = eyeA.value(nowMs);
      const b = eyeB.value(nowMs);
      return {
        present,
        t,
        p,
        r,
        k,
        blinkL: params.swapEyes ? b : a,
        blinkR: params.swapEyes ? a : b,
        jaw,
      };
    },

    /** 패널 표시용 값 (화면 기준 각도, 필터 후) */
    metrics() {
      syncMode();
      const s = toScreenAngles({ yaw, pitch, roll }, params);
      return { yawDeg: s.yaw, pitchDeg: s.pitch, rollDeg: s.roll, proximity: currentProximity(), faces };
    },

    /** 현재 필터된 거리를 기준으로 저장(C 키). 최근 얼굴이 없으면 false */
    calibrate(nowMs) {
      syncMode();
      if (!hadFace || lastAt === null || !(nowMs - lastAt < tracking.staleMs)) return false;
      if (dist === null || !(dist > 0)) return false;
      // 현재 표본에서 거리를 실제로 측정했을 때만 (eyes 모드에서 옆으로 돌아 보류 중이면 거부)
      if (measuredAt === null || measuredAt !== lastFaceAt || !(nowMs - measuredAt < tracking.staleMs)) return false;
      baseline = dist;
      auto.done = true;
      auto.buf.length = 0;
      return true;
    },

    /** 모든 상태 초기화 (카메라 전환 등) */
    reset() {
      resetFilters();
      hadFace = false;
      lastAt = null;
      lastFaceAt = null;
      faces = 0;
      yaw = pitch = roll = jaw = 0;
      dist = null;
      measuredAt = null;
      baseline = null;
      baselineMode = params.distanceMode;
      auto = newAuto();
    },

    get sampledAt() {
      return lastAt;
    },
    get hasBaseline() {
      syncMode();
      return baseline !== null;
    },
  };
}
