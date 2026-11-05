import { describe, it, expect, vi } from 'vitest';
import { installNetGuard, BLOCKED_URL } from '../src/tracking/netGuard.js';

const BLOCKED = 'https://odml.pa.googleapis.com/v1/log';
const P5 = 'https://cdn.jsdelivr.net/npm/p5@2.3.4/lib/p5.min.js';
const OK = 'https://example.com/data.json';

function fakeScope() {
  return { fetch: vi.fn(async () => ({ ok: true })) };
}

describe('netGuard', () => {
  it('BLOCKED_URL 은 차단 대상 호스트만 맞춘다', () => {
    expect(BLOCKED_URL.test(BLOCKED)).toBe(true);
    expect(BLOCKED_URL.test(P5)).toBe(true);
    expect(BLOCKED_URL.test(OK)).toBe(false);
  });

  it('차단 URL(문자열·{url}·URL 객체)은 reject 되고 원래 fetch 는 호출되지 않는다', async () => {
    const scope = fakeScope();
    const real = scope.fetch;
    installNetGuard(scope);

    await expect(scope.fetch(BLOCKED)).rejects.toThrow('blocked external request');
    await expect(scope.fetch({ url: P5 })).rejects.toBeInstanceOf(TypeError);
    await expect(scope.fetch(new URL(BLOCKED))).rejects.toThrow('blocked external request');
    expect(real).not.toHaveBeenCalled();
  });

  it('일반 URL 은 원래 fetch 에 같은 인자로 전달되고 그 반환값을 돌려준다', async () => {
    const scope = fakeScope();
    const real = scope.fetch;
    const init = { method: 'GET' };
    installNetGuard(scope);

    const res = await scope.fetch(OK, init);
    expect(real).toHaveBeenCalledTimes(1);
    expect(real).toHaveBeenCalledWith(OK, init);
    expect(res).toEqual({ ok: true });
  });

  it('두 번 설치해도 한 번만 감싼다', async () => {
    const scope = fakeScope();
    const real = scope.fetch;
    installNetGuard(scope);
    const once = scope.fetch;
    installNetGuard(scope);

    expect(scope.fetch).toBe(once);
    await scope.fetch(OK);
    expect(real).toHaveBeenCalledTimes(1);
  });

  it('fetch 가 없는 scope 에서는 아무것도 하지 않는다', () => {
    const scope = {};
    installNetGuard(scope);
    expect(scope.fetch).toBeUndefined();
  });
});
