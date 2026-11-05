// 머리 자세: MediaPipe 변환 행렬 → yaw/pitch/roll(도) → 화면(거울) 기준 정규화 [-1,1].
//
// 좌표계 가정(PLAN 3.3): 카메라 공간 +X = 원본(비반전) 영상 오른쪽, +Y = 위, 얼굴 정면 방향 = +Z(카메라 쪽).
// 행렬 data 는 column-major 4×4: R[row][col] = d[col*4 + row], 이동량은 d[12..14].
// R = Ry(yaw)·Rx(pitch)·Rz(roll) (YXZ) 로 분해한다.
//   yaw   > 0 : 코가 원본 영상 오른쪽으로 → 거울 화면에서는 왼쪽  → t = −yaw/yawRange
//   pitch > 0 : 고개 숙임(코가 아래로)                           → p = +pitch/pitchRange
//   roll  > 0 : 원본 영상에서 반시계 → 거울 화면에서는 시계방향    → r = +roll/rollRange

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 랜드마크 인덱스 (MediaPipe Face Mesh 478점) */
export const LM = Object.freeze({
  NOSE_TIP: 1,
  CHEEK_R: 234, // 피사체 오른쪽 볼 가장자리(원본 영상 왼쪽)
  CHEEK_L: 454, // 피사체 왼쪽 볼 가장자리(원본 영상 오른쪽)
  EYE_OUTER_R: 33,
  EYE_OUTER_L: 263,
});

/** column-major 4×4 data 에서 3×3 회전을 꺼내 열벡터를 정규화한다(스케일 제거). 이상한 입력이면 null */
export function rotationFromMatrix(d) {
  if (!d || d.length < 16) return null;
  const R = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let c = 0; c < 3; c++) {
    const x = d[c * 4];
    const y = d[c * 4 + 1];
    const z = d[c * 4 + 2];
    const n = Math.hypot(x, y, z);
    if (!(n > 1e-9) || !Number.isFinite(n)) return null;
    R[0][c] = x / n;
    R[1][c] = y / n;
    R[2][c] = z / n;
  }
  return R;
}

/** YXZ 오일러각(도). 특이점(|R12| > 0.9999, pitch ≈ ±90°)에서는 roll = 0 으로 두고 yaw 에 합친다 */
export function eulerFromRotation(R) {
  const r12 = R[1][2];
  const pitch = Math.asin(clamp(-r12, -1, 1));
  let yaw;
  let roll;
  if (Math.abs(r12) > 0.9999) {
    yaw = Math.atan2(-R[2][0], R[0][0]);
    roll = 0;
  } else {
    yaw = Math.atan2(R[0][2], R[2][2]);
    roll = Math.atan2(R[1][0], R[1][1]);
  }
  return { yaw: yaw * RAD2DEG, pitch: pitch * RAD2DEG, roll: roll * RAD2DEG };
}

/** 변환 행렬 data → 카메라 공간 오일러각(도). 사용할 수 없는 행렬이면 null */
export function eulerFromMatrix(d) {
  const R = rotationFromMatrix(d);
  return R ? eulerFromRotation(R) : null;
}

/** 이동량 (d[12], d[13], d[14]) */
export function translationOf(d) {
  if (!d || d.length < 16) return null;
  return { x: d[12], y: d[13], z: d[14] };
}

/** 오일러각(도) → column-major 4×4 data (R = Ry·Rx·Rz). 테스트·디버그용 */
export function matrixFromEuler(yawDeg, pitchDeg, rollDeg, { x = 0, y = 0, z = -40, scale = 1 } = {}) {
  const sy = Math.sin(yawDeg * DEG2RAD);
  const cy = Math.cos(yawDeg * DEG2RAD);
  const sp = Math.sin(pitchDeg * DEG2RAD);
  const cp = Math.cos(pitchDeg * DEG2RAD);
  const sr = Math.sin(rollDeg * DEG2RAD);
  const cr = Math.cos(rollDeg * DEG2RAD);
  const R = [
    [cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp],
    [cp * sr, cp * cr, -sp],
    [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp],
  ];
  const d = new Array(16).fill(0);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) d[c * 4 + r] = scale * R[r][c];
  d[12] = x;
  d[13] = y;
  d[14] = z;
  d[15] = 1;
  return d;
}

/** 카메라 공간 각도(도) → 화면(거울) 기준 각도(도). 패널 반전 토글 적용. t = yaw/yawRange 가 되는 부호 */
export function toScreenAngles({ yaw, pitch, roll }, params) {
  return {
    yaw: (params.invertYaw ? 1 : -1) * yaw + 0, // + 0: -0 을 +0 으로
    pitch: (params.invertPitch ? -1 : 1) * pitch + 0,
    roll: (params.invertRoll ? -1 : 1) * roll + 0,
  };
}

/** 화면 기준 각도(도) → 정규화 {t,p,r} ∈ [-1,1] (범위 밖은 clamp) */
export function normalizeAngles(screen, params) {
  const norm = (deg, range) => clamp(deg / Math.max(range, 1e-3), -1, 1) + 0;
  return {
    t: norm(screen.yaw, params.yawRange),
    p: norm(screen.pitch, params.pitchRange),
    r: norm(screen.roll, params.rollRange),
  };
}

/** 랜드마크 기반 yaw 방향 지표: 코끝 x − 양 볼 중점 x (정규화 영상 좌표). 코가 영상 오른쪽이면 양수 */
export function landmarkYaw(lm) {
  const nose = lm?.[LM.NOSE_TIP];
  const a = lm?.[LM.CHEEK_R];
  const b = lm?.[LM.CHEEK_L];
  if (!nose || !a || !b) return null;
  return nose.x - (a.x + b.x) / 2;
}

/** 눈꼬리(33–263) 사이 픽셀 거리 (영상 가로·세로 크기로 종횡비 보정) */
export function eyeDistancePx(lm, width, height) {
  const a = lm?.[LM.EYE_OUTER_R];
  const b = lm?.[LM.EYE_OUTER_L];
  if (!a || !b) return null;
  return Math.hypot((b.x - a.x) * width, (b.y - a.y) * height);
}

/**
 * 행렬 yaw 부호와 랜드마크 yaw 방향이 어긋나는지 점검한다(PLAN R1).
 * |yaw| > minAngle 인 표본이 minSamples 개 이상 쌓였고 그중 ratio 를 넘게 부호가 다르면 warn 을 한 번만 호출.
 */
export function createSignChecker({ minAngle = 15, minSamples = 20, ratio = 0.8, minOffset = 0.004, warn = console.warn } = {}) {
  let n = 0;
  let mismatch = 0;
  let warned = false;
  return {
    /** yawDeg: 행렬에서 얻은 카메라 공간 yaw(도), lmYaw: landmarkYaw() 값 */
    push(yawDeg, lmYaw) {
      if (warned || !Number.isFinite(yawDeg) || !Number.isFinite(lmYaw)) return;
      if (Math.abs(yawDeg) <= minAngle || Math.abs(lmYaw) < minOffset) return;
      n++;
      if (yawDeg > 0 !== lmYaw > 0) mismatch++;
      if (n >= minSamples && mismatch / n > ratio) {
        warned = true;
        warn(
          `[pose] 변환 행렬의 yaw 부호가 랜드마크(코끝-볼 중점) 방향과 반대로 보입니다 (${mismatch}/${n}). ` +
            '패널의 "yaw 반전"을 켜 보세요. ?debugpose 로 원시값을 확인할 수 있습니다.',
        );
      }
    },
    get warned() {
      return warned;
    },
    get stats() {
      return { n, mismatch };
    },
  };
}
