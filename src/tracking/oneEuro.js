// One Euro 필터 (Casiez 외, CHI 2012). 느린 움직임의 떨림은 강하게 누르고, 빠른 움직임은 거의 지연 없이 통과시킨다.
// 시간은 초 단위. minCutoff/beta 는 호출마다 받아서 패널에서 바꾼 값이 곧바로 반영된다.

const TWO_PI = Math.PI * 2;

/** 차단 주파수 cutoff(Hz), 표본 간격 dt(초)에 대한 지수 평활 계수 α (0~1) */
export function smoothingFactor(cutoff, dt) {
  const tau = 1 / (TWO_PI * cutoff);
  return 1 / (1 + tau / dt);
}

/**
 * @param {{ dCutoff?: number }} [opts] 변화율 필터의 차단 주파수(Hz), 기본 1.0
 */
export function createOneEuro({ dCutoff = 1.0 } = {}) {
  let raw = null; // 직전 원시값
  let hat = null; // 직전 필터 출력
  let dHat = 0; // 직전 필터된 변화율(단위/초)

  return {
    /**
     * 새 표본 하나를 필터링한다. 새 표본에서만 호출해야 한다(같은 표본을 두 번 넣으면 안 됨).
     * @param {number} value 원시값
     * @param {number} dt 직전 표본과의 간격(초)
     * @param {number} minCutoff
     * @param {number} beta
     */
    filter(value, dt, minCutoff, beta) {
      if (!Number.isFinite(value)) return hat ?? 0;
      if (hat === null) {
        raw = hat = value;
        dHat = 0;
        return value;
      }
      if (!(dt > 0)) return hat; // 같은 시각(또는 시간 역행) 표본은 갱신하지 않는다
      const dx = (value - raw) / dt;
      const aD = smoothingFactor(dCutoff, dt);
      dHat = aD * dx + (1 - aD) * dHat;
      const cutoff = Math.max(minCutoff, 1e-3) + beta * Math.abs(dHat);
      const a = smoothingFactor(cutoff, dt);
      hat = a * value + (1 - a) * hat;
      raw = value;
      return hat;
    },
    /** 필터를 끈 상태: 값을 그대로 통과시키되 내부 상태는 따라가게 해서 다시 켤 때 튀지 않게 한다 */
    pass(value) {
      if (!Number.isFinite(value)) return hat ?? 0;
      raw = hat = value;
      dHat = 0;
      return value;
    },
    reset() {
      raw = hat = null;
      dHat = 0;
    },
    /** 마지막 필터 출력 (없으면 null) */
    get value() {
      return hat;
    },
  };
}
