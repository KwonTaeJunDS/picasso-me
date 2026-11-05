// 해시 PRNG와 값 노이즈. 렌더 경로에서는 Math.random 을 쓰지 않고 이 모듈만 쓴다.
// 같은 입력 → 항상 같은 출력이라 스톱모션 시드·테스트 재현이 가능하다.

/** 32비트 정수 믹서 (murmur3 finalizer). */
function mix(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 정수 4개 → uint32 해시. 소수는 내림이 아니라 |0 절단이므로 정수만 넣는다. */
export function hash32(a, b = 0, c = 0, d = 0) {
  let h = 0x9e3779b9 ^ (a | 0);
  h = mix(h ^ Math.imul(b | 0, 0x85ebca6b));
  h = mix(h ^ Math.imul(c | 0, 0xc2b2ae35));
  h = mix(h ^ Math.imul(d | 0, 0x27d4eb2f));
  return h >>> 0;
}

/** 문자열 → uint32 (FNV-1a + 믹서). */
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix(h >>> 0);
}

/** uint32 → [0,1) */
export function rand01(h) {
  return (h >>> 0) / 4294967296;
}

/** uint32 → [-1,1) */
export function rand11(h) {
  return rand01(h) * 2 - 1;
}

/** mulberry32 — 상태를 가진 PRNG. 고정 시드 배치(머리카락·흘러내림 등)에만 쓴다. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 스톱모션 epoch: 초당 fps 번 바뀌는 정수. */
export function epochOf(nowMs, fps) {
  return Math.floor((nowMs / 1000) * fps);
}

const fade5 = (f) => f * f * f * (f * (f * 6 - 15) + 10);

/** 격자 값 [-1,1] — 노이즈 안쪽 루프라 hash32 보다 가벼운 한 번짜리 믹서(murmur3 finalizer)를 쓴다. */
function lattice(i, seed) {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x9e3779b1) ^ 0x1f3d;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

/** 1D 값 노이즈, 범위 [-1,1], 격자 간격 1. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const a = lattice(i, seed);
  const b = lattice(i + 1, seed);
  return a + (b - a) * fade5(f);
}

/** 주기 노이즈: period(정수 ≥ 1) 격자마다 되감김. */
export function noise1Periodic(x, period, seed = 0) {
  const P = Math.max(1, period | 0);
  const i = Math.floor(x);
  const f = x - i;
  const i0 = ((i % P) + P) % P;
  const i1 = (i0 + 1) % P;
  const a = lattice(i0, seed);
  const b = lattice(i1, seed);
  return a + (b - a) * fade5(f);
}

function lattice2(ix, iy, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1) ^ 0x7a11;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

/** 2D 값 노이즈, 범위 [-1,1]. */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade5(x - ix);
  const fy = fade5(y - iy);
  const a = lattice2(ix, iy, seed);
  const b = lattice2(ix + 1, iy, seed);
  const c = lattice2(ix, iy + 1, seed);
  const d = lattice2(ix + 1, iy + 1, seed);
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}

/**
 * 원 위의 2D 노이즈 — 닫힌 둘레를 따라 부드럽고 이음매가 없다.
 * cosA/sinA = 둘레 비율 λ 의 각도(2πλ)의 코사인·사인, cycles = 둘레(px) / 파장(px).
 * 둘레가 연속으로 변해도 패턴이 연속으로 늘어난다(정수 주기 방식은 둘레가 변할 때 튄다).
 */
export function noiseLoopCS(cosA, sinA, cycles, seed = 0) {
  const R = Math.max(0.15, cycles / 6.283185307179586);
  return noise2(cosA * R + 17.3, sinA * R + 41.9, seed);
}

/** lam ∈ [0,1) 로 부르는 편의 버전. */
export function noiseLoop(lam, cycles, seed = 0) {
  const ang = lam * 6.283185307179586;
  return noiseLoopCS(Math.cos(ang), Math.sin(ang), cycles, seed);
}

/** 2옥타브 합성 (진폭 합 ≤ 1). */
export function fbm1(x, seed = 0) {
  return noise1(x, seed) * 0.68 + noise1(x * 2.17 + 11.7, seed + 977) * 0.32;
}
