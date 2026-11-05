// 공유 계약 — 오케스트레이터 소유. 개발자는 수정하지 말고, 변경이 필요하면 보고한다.
// 추적(src/tracking) → 렌더(src/render) 사이의 데이터 형식과 화면 상수를 정의한다.

export const CANVAS_W = 1080;
export const CANVAS_H = 1920;
export const CAM_H = 768; // 위 40% 웹캠
export const ART_Y = 768; // 아래 60% 그림 영역 시작
export const ART_W = 1080;
export const ART_H = 1152;

/**
 * 추적기가 매 프레임 렌더러에 넘기는 값. 필터·정규화 완료, 모두 화면(거울) 기준.
 * present=false 인 동안 나머지 값은 마지막 값을 유지한다.
 *
 * @typedef {Object} FaceSignals
 * @property {boolean} present 이번 프레임 얼굴 검출 여부 (300ms 미감지 판정은 render/fade.js)
 * @property {number} t      yaw   [-1,1]  + = 화면에서 코가 오른쪽을 향함
 * @property {number} p      pitch [-1,1]  + = 고개 숙임 (턱이 아래로)
 * @property {number} r      roll  [-1,1]  + = 화면에서 머리가 시계방향으로 기울어짐
 * @property {number} k      거리 왜곡량 [0,1]  0 = 기준 거리 이상 멂, 1 = maxProximity 이상 가까움
 * @property {number} blinkL 화면 왼쪽 눈 감김 [0,1]
 * @property {number} blinkR 화면 오른쪽 눈 감김 [0,1]
 * @property {number} jaw    입 벌림 [0,1]
 */

/** @returns {FaceSignals} */
export function neutralSignals() {
  return { present: false, t: 0, p: 0, r: 0, k: 0, blinkL: 0, blinkR: 0, jaw: 0 };
}

/**
 * 추적기 인터페이스 — 실제 카메라(tracking/faceTracker.js)와 mock(tracking/mock.js)이 같은 모양을 따른다.
 *
 *   const tracker = createTracker(params, { search })  // 또는 createMockTracker(params, location.search)
 *   await tracker.start()                    // 카메라·모델 준비. 실패해도 throw 하지 않고 status='error'
 *   const frame = tracker.poll(nowMs)        // 매 렌더 프레임 호출. 새 비디오 프레임일 때만 검출 예약
 *   tracker.calibrate()                      // 현재 거리를 기준으로 저장(C 키). 얼굴 없으면 false
 *   tracker.video                            // 웹캠 영역에 그릴 HTMLVideoElement (mock이면 null)
 *   선택 멤버(mock은 빈 목록·no-op): tracker.cameras [{id,label}], tracker.cameraLabel,
 *                                    tracker.restartCamera(), tracker.stop()
 *
 * @typedef {Object} TrackerFrame
 * @property {FaceSignals} signals
 * @property {'loading'|'running'|'error'} status
 * @property {string} [error]          status='error'일 때 화면에 보일 안내 1줄
 * @property {number|null} sampledAt   마지막 검출 표본 시각(ms, performance.now 기준)
 * @property {TrackerMetrics} metrics  패널 '정보' 표시용
 *
 * @typedef {Object} TrackerMetrics
 * @property {number} yawDeg     화면 기준 yaw(°), 필터 후
 * @property {number} pitchDeg
 * @property {number} rollDeg
 * @property {number} proximity  기준 대비 거리 비율 (>1 = 가까움)
 * @property {number} detectMs   최근 detectForVideo 소요(ms, 이동 평균)
 * @property {number} faces      최근 표본의 얼굴 수
 * @property {string} camera     사용 중인 카메라 이름
 * @property {'GPU'|'CPU'|'-'} [delegate] 추론 장치
 */
