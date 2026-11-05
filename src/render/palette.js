// PRD 7.2 팔레트 10색. 렌더러는 이 색만 쓴다 (그라데이션·검정 금지).

export const PALETTE = Object.freeze({
  sky: '#4A8FF0', // 배경 기본 (하늘 파랑) — 항상 불투명 바탕
  cobalt: '#1446E8', // 배경 진한
  pale: '#9DBAF2', // 배경 밝은 (연파랑) / 차가운 쪽 피부
  red: '#E5402E', // 피부 빨강 (따뜻한 쪽 바탕)
  orange: '#F28A2E', // 피부 주황 (귀·관자놀이·목)
  pink: '#F06BA8', // 피부 분홍 (뺨·입술)
  teal: '#12A3AE', // 머리카락 청록
  green: '#3CC79A', // 머리카락 강조
  navy: '#2B3352', // 그림자·어두운 면 (검정 대신)
  line: '#F4F1EA', // 흰 손그림 선
});

export const PALETTE_LIST = Object.freeze(Object.values(PALETTE));

const SET = new Set(PALETTE_LIST.map((c) => c.toUpperCase()));

/** 팔레트 색인지 검사 (대소문자 무시). */
export function isPaletteColor(hex) {
  return typeof hex === 'string' && SET.has(hex.toUpperCase());
}
