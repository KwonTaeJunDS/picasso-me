import { describe, it, expect } from 'vitest';
import { createFade, updateFade, visibility, fadePhase, REVEAL_W } from '../src/render/fade.js';
import { FADE } from '../src/config/params.js';
import {
  STROKE_IDS, STROKE_COUNT, rankOf, categoryOf, CATEGORY, isRegistered,
} from '../src/render/strokes.js';

const DT = 1000 / 60;

/** 프레임 루프: presentFn(now) 로 얼굴 유무를 정해 durMs 동안 진행하고 마지막 now 를 돌려준다 */
function run(f, startMs, durMs, presentFn, dt = DT) {
  let now = startMs;
  const end = startMs + durMs;
  while (now < end - 1e-9) {
    now += dt;
    updateFade(f, presentFn(now), now, dt);
  }
  return now;
}

describe('fade 레벨', () => {
  it('시작은 L=0, 숨김 상태', () => {
    const f = createFade();
    expect(f.L).toBe(0);
    expect(fadePhase(f)).toBe('hidden');
    updateFade(f, false, 0, DT);
    expect(f.L).toBe(0);
  });

  it('검출되면 +1/0.8s 로 올라간다', () => {
    const f = createFade();
    let now = run(f, 0, 400, () => true);
    expect(f.L).toBeGreaterThan(0.45);
    expect(f.L).toBeLessThan(0.55);
    expect(fadePhase(f)).toBe('in');
    now = run(f, now, 450, () => true);
    expect(f.L).toBe(1);
    expect(fadePhase(f)).toBe('visible');
  });

  it('300ms 미만 미검출은 무시한다 (L 이 내려가지 않음)', () => {
    const f = createFade();
    let now = run(f, 0, 1000, () => true);
    expect(f.L).toBe(1);
    const seen = now;
    // 마지막으로 본 뒤 280ms 동안 없음
    now = run(f, now, FADE.lostDelayMs - 20, () => false);
    expect(now - seen).toBeLessThan(FADE.lostDelayMs);
    expect(f.L).toBe(1);
    expect(fadePhase(f)).toBe('visible');
  });

  it('300ms 이상 미검출이면 -1/1.0s 로 내려간다', () => {
    const f = createFade();
    let now = run(f, 0, 1000, () => true);
    const seen = now;
    now = run(f, now, FADE.lostDelayMs + 500, () => false);
    // 미감지 확정 후 500ms 지났으므로 L ≈ 0.5
    expect(f.L).toBeGreaterThan(0.45);
    expect(f.L).toBeLessThan(0.57);
    expect(fadePhase(f)).toBe('out');
    now = run(f, now, 600, () => false);
    expect(f.L).toBe(0);
    expect(fadePhase(f)).toBe('hidden');
    expect(now - seen).toBeGreaterThan(FADE.lostDelayMs + FADE.outMs);
  });

  it('진행 중 반전은 현재 L 에서 연속으로 이어진다', () => {
    const f = createFade();
    let now = run(f, 0, 1000, () => true);
    now = run(f, now, FADE.lostDelayMs + 400, () => false); // L ≈ 0.6
    const Lmid = f.L;
    expect(Lmid).toBeGreaterThan(0.5);
    expect(Lmid).toBeLessThan(0.7);
    updateFade(f, true, now + DT, DT);
    // 한 프레임 사이의 변화는 dt/inMs 이하 (점프 없음)
    expect(Math.abs(f.L - Lmid)).toBeLessThan(0.03);
    now = run(f, now + DT, 100, () => true);
    expect(f.L).toBeGreaterThan(Lmid);
    now = run(f, now, 400, () => true);
    expect(f.L).toBe(1);
  });

  it('페이드 인 도중 다시 사라지면 미감지 확정 뒤 현재 L 에서 내려간다', () => {
    const f = createFade();
    let now = run(f, 0, 300, () => true); // L ≈ 0.375
    const L0 = f.L;
    // 300ms 유예 동안은 '있음'으로 간주해 계속 오르고(≈0.75), 확정 후 내려간다
    now = run(f, now, FADE.lostDelayMs + 200, () => false);
    expect(f.L).toBeGreaterThan(L0);
    expect(f.L).toBeLessThan(0.75);
    const Lhigh = f.L;
    now = run(f, now, 100, () => false);
    expect(f.L).toBeLessThan(Lhigh);
    expect(f.L).toBeGreaterThan(0);
  });

  it('snap 은 즉시 L=1', () => {
    const f = createFade();
    updateFade(f, true, 0, 0, FADE, { snap: true });
    expect(f.L).toBe(1);
    expect(f.effective).toBe(true);
  });
});

describe('가시도와 고정 순위', () => {
  it('L=0 이면 전부 0, L=1 이면 전부 1', () => {
    for (const id of STROKE_IDS) {
      expect(visibility(0, rankOf(id))).toBe(0);
      expect(visibility(1, rankOf(id))).toBe(1);
    }
  });

  it('L 이 오르면 순위 낮은 스트로크부터 보이고, 내려가면 높은 것부터 사라진다', () => {
    const low = rankOf('bg.0');
    const high = rankOf('mouth.hl');
    expect(low).toBeLessThan(high);
    let lowFirst = false;
    for (let L = 0; L <= 1.0001; L += 0.01) {
      const a = visibility(L, low);
      const b = visibility(L, high);
      expect(a).toBeGreaterThanOrEqual(b - 1e-12);
      if (a > 0 && b === 0) lowFirst = true;
    }
    expect(lowFirst).toBe(true);
    // 내려갈 때: 같은 L 에서 높은 순위 쪽이 먼저 0 이 된다
    expect(visibility(0.5, high)).toBeLessThanOrEqual(visibility(0.5, low));
  });

  it('L 에 대해 단조 증가', () => {
    for (const id of STROKE_IDS) {
      let prev = -1;
      for (let L = 0; L <= 1.0001; L += 0.02) {
        const v = visibility(L, rankOf(id));
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = v;
      }
    }
  });

  it('레지스트리: id 중복 없음, ρ 는 (0,1) 에서 순서대로 증가', () => {
    expect(new Set(STROKE_IDS).size).toBe(STROKE_COUNT);
    let prev = 0;
    for (const id of STROKE_IDS) {
      const r = rankOf(id);
      expect(r).toBeGreaterThan(prev);
      expect(r).toBeLessThan(1);
      prev = r;
      expect(isRegistered(id)).toBe(true);
    }
  });

  it('카테고리 순서: 배경 < 윤곽 < 색면 < 이목구비', () => {
    const maxOf = (cat) => Math.max(...STROKE_IDS.filter((i) => categoryOf(i) === cat).map(rankOf));
    const minOf = (cat) => Math.min(...STROKE_IDS.filter((i) => categoryOf(i) === cat).map(rankOf));
    expect(maxOf(CATEGORY.BG)).toBeLessThan(minOf(CATEGORY.CONTOUR));
    expect(maxOf(CATEGORY.CONTOUR)).toBeLessThan(minOf(CATEGORY.PLANE));
    expect(maxOf(CATEGORY.PLANE)).toBeLessThan(minOf(CATEGORY.FEATURE));
  });

  it('생략 부품도 순위를 예약한다 (머리카락 9칸, 흘러내림 12칸, 양쪽 눈)', () => {
    for (let i = 0; i < 9; i++) expect(isRegistered(`hair.${i}`)).toBe(true);
    for (let i = 0; i < 12; i++) expect(isRegistered(`drip.${i}`)).toBe(true);
    expect(isRegistered('eyeL.white')).toBe(true);
    expect(isRegistered('eyeR.white')).toBe(true);
  });

  it('순위는 호출 횟수·붓터치 겹수와 무관한 고정값', () => {
    const a = STROKE_IDS.map(rankOf);
    const b = STROKE_IDS.map(rankOf);
    expect(a).toEqual(b);
    expect(REVEAL_W).toBeGreaterThan(0);
    expect(REVEAL_W).toBeLessThan(0.3);
  });
});
