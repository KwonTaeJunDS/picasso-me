// 정면 → 옆모습 꼭짓점 보간 도우미 (코·입 공통).
// F: 화면 기준 정면 꼭짓점(로컬 px), Q: 오른쪽 옆모습 목표(로컬 px, +x = 옆모습 방향).
// 옆모습이 왼쪽(sN<0)이면 목표를 좌우 거울로 뒤집되, 꼭짓점 순번도 거울쌍(MI)으로 바꿔 사용한다.
// → mu≈0 에서는 부호와 무관하게 정면 꼭짓점 그대로라 t=±ε 에서 정점이 튀지 않고, 보간 중 도형이 꼬이지 않는다.

/**
 * @param F [[x,y],...] 정면
 * @param Q [[x,y],...] 옆모습(오른쪽)
 * @param MI 거울쌍 인덱스 배열 (F 의 좌우 대칭 짝)
 * @param sN 옆모습 방향 (+1/-1)
 * @param mu 0..1 보간
 * @param rx,ry 뿌리 월드 좌표
 * @param shearX x += shearX·ly (정면의 기울임), skewY y += skewY·lx
 * @returns number[] 월드 좌표 flat
 */
export function morphPoly(F, Q, MI, sN, mu, rx, ry, shearX = 0, skewY = 0) {
  const out = new Array(F.length * 2);
  for (let i = 0; i < F.length; i++) {
    const qi = sN > 0 ? i : MI[i];
    const fx = F[i][0];
    const fy = F[i][1];
    const lx = fx + (sN * Q[qi][0] - fx) * mu;
    const ly = fy + (Q[qi][1] - fy) * mu;
    out[2 * i] = rx + lx + shearX * ly;
    out[2 * i + 1] = ry + ly + skewY * lx;
  }
  return out;
}

/** 단일 점 보간 (거울쌍 없이) */
export function morphPoint(fx, fy, qx, qy, sN, mu, rx, ry, shearX = 0, skewY = 0) {
  const lx = fx + (sN * qx - fx) * mu;
  const ly = fy + (qy - fy) * mu;
  return [rx + lx + shearX * ly, ry + ly + skewY * lx];
}
