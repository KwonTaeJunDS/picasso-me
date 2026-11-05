// 파라미터 기본값과 메타데이터. 조절 패널(ui/panel.js)이 같은 객체를 직접 수정하고,
// 추적·렌더는 매 프레임 읽기만 한다. 오케스트레이터 소유 — 키 추가·변경은 보고 후 반영.

export const DEFAULTS = Object.freeze({
  // 각도
  yawRange: 45,
  pitchRange: 25,
  rollRange: 30,
  rollSpread: 0.4, // 조각별 roll 계수 = 1 ± rollSpread → 0.6~1.4
  invertYaw: false,
  invertPitch: false,
  invertRoll: false,
  swapEyes: false,
  // 거리
  distortion: 1.0, // 코 최대 1 + 0.8·distortion 배, 눈 간격 최대 1 + 0.4·distortion 배
  maxProximity: 1.6,
  distanceMode: 'matrix', // 'matrix' = 변환 행렬 translation z 비율(회전에 강함), 'eyes' = 눈꼬리 거리(PRD 원안)
  // 카메라 (IR·가상 카메라 회피용, 장치 목록은 실행 중에 채움)
  cameraId: '',
  // 반응
  filterEnabled: true,
  angleMinCutoff: 1.0,
  angleBeta: 0.05,
  exprMinCutoff: 2.0,
  exprBeta: 0.1,
  lagScale: 1.0, // 부품별 시간차 배율, 0 = 끔
  // 붓터치
  jitterAmp: 3, // px (1080 기준)
  jitterFps: 10,
  strokeLayers: 3,
});

/** 패널 구성용. 불리언은 min/max 없음. */
export const META = Object.freeze({
  yawRange: { group: '각도', label: 'yaw 범위(°)', min: 15, max: 90, step: 1 },
  pitchRange: { group: '각도', label: 'pitch 범위(°)', min: 10, max: 60, step: 1 },
  rollRange: { group: '각도', label: 'roll 범위(°)', min: 10, max: 60, step: 1 },
  rollSpread: { group: '각도', label: 'roll 조각 계수 폭', min: 0, max: 0.8, step: 0.01 },
  invertYaw: { group: '각도', label: 'yaw 반전' },
  invertPitch: { group: '각도', label: 'pitch 반전' },
  invertRoll: { group: '각도', label: 'roll 반전' },
  swapEyes: { group: '각도', label: '눈 좌우 바꾸기' },
  distortion: { group: '거리', label: '거리 왜곡 강도', min: 0, max: 2, step: 0.01 },
  maxProximity: { group: '거리', label: '최대 proximity', min: 1.1, max: 2.5, step: 0.01 },
  distanceMode: { group: '거리', label: '거리 계산 방식', options: { '변환 행렬 z': 'matrix', '눈꼬리 거리': 'eyes' } },
  cameraId: { group: '카메라', label: '카메라', dynamic: true }, // 옵션은 enumerateDevices 결과로 채움
  filterEnabled: { group: '반응', label: '필터 사용' },
  angleMinCutoff: { group: '반응', label: '각도 minCutoff', min: 0.05, max: 10, step: 0.05 },
  angleBeta: { group: '반응', label: '각도 beta', min: 0, max: 1, step: 0.005 },
  exprMinCutoff: { group: '반응', label: '표정 minCutoff', min: 0.05, max: 10, step: 0.05 },
  exprBeta: { group: '반응', label: '표정 beta', min: 0, max: 1, step: 0.005 },
  lagScale: { group: '반응', label: '시간차 배율', min: 0, max: 3, step: 0.05 },
  jitterAmp: { group: '붓터치', label: '떨림 진폭(px)', min: 0, max: 10, step: 0.1 },
  jitterFps: { group: '붓터치', label: '떨림 갱신 fps', min: 8, max: 12, step: 1 },
  strokeLayers: { group: '붓터치', label: '스트로크 겹수', min: 1, max: 6, step: 1 },
});

/** 부품별 시간상수 τ (ms). 실제 τ = 값 × lagScale. */
export const LAG_TAU_MS = Object.freeze({
  contour: 0,
  split: 0,
  eyes: 40,
  mouth: 100,
  nose: 150,
  ears: 250,
  hair: 250,
});

/**
 * 정지 후 가속 수렴. 움직이는 동안은 τ 그대로(어긋남), 목표가 멈추면 τ를 줄여
 * "0.5초 안에 제자리"(PRD 6.8)를 맞춘다. 속도 = max(|Δt|,|Δp|,|Δr|,|Δk|)/초.
 */
export const LAG_SETTLE = Object.freeze({
  stillSpeed: 0.5, // 이 속도(정규화 단위/초) 미만이면 정지로 본다 (yaw 22.5°/s)
  rampMs: 120, // 정지 후 이 시간에 걸쳐 τ 배수를 1 → minFactor 로 줄임
  minFactor: 0.3,
});

/** 깜빡임: One Euro 대신 원시값 히스테리시스 + 최소 유지(짧은 깜빡임 보존). 출력 ≥ 0.5 ⇔ 감김 */
export const BLINK = Object.freeze({
  closeAt: 0.5,
  openAt: 0.4,
  minHoldMs: 80,
});

export const FADE = Object.freeze({
  lostDelayMs: 300, // 연속 미검출 이 시간 이상 → 미감지
  outMs: 1000,
  inMs: 800,
});

export const TRACKING = Object.freeze({
  numFaces: 2, // 여러 명일 때 가장 큰 얼굴 선택용
  videoWidth: 1280,
  videoHeight: 720,
  videoFps: 30,
  baselineStableMs: 500, // 자동 기준 거리: 이 시간 이상 연속 검출된 정면 구간
  baselineMaxAngle: 15, // 자동 기준 거리 채택 각도 한계(°)
  staleMs: 250, // 마지막 검출 표본이 이보다 오래되면 present=false (영상 정지 대비)
  eyesModeMaxYaw: 30, // 'eyes' 모드에서 |yaw|가 이보다 크면 거리 갱신 보류
  cameraExclude: /\b(IR|infrared|virtual|mirametrix|obs)\b/i, // 자동 선택에서 피할 카메라 이름
});

/** 기본값 사본(가변). 패널·추적·렌더가 공유한다. */
export function createParams(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}
