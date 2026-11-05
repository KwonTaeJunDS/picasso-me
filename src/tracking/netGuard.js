// 외부 네트워크 차단 가드. PRD 8.1(오프라인 동작)·8.5(영상·데이터 전송 금지)를 지키기 위해,
// index.html 의 인라인 가드가 메인 스레드에서 막지 못하는 워커 안의 fetch 도 같은 규칙으로 막는다.

// index.html 인라인 가드와 같은 규칙을 유지할 것 (두 곳을 함께 고친다)
export const BLOCKED_URL = /^https:\/\/(cdn\.jsdelivr\.net\/npm\/p5@|odml\.pa\.googleapis\.com\/)/;

const MARK = '__netGuard';

/**
 * scope.fetch 를 감싸서 BLOCKED_URL 에 해당하는 요청을 거부한다.
 * 이미 설치됐거나 fetch 가 없으면 아무것도 하지 않는다.
 * @param {{fetch?: Function}} [scope=globalThis]
 */
export function installNetGuard(scope = globalThis) {
  const realFetch = scope.fetch;
  if (typeof realFetch !== 'function' || realFetch[MARK]) return;

  const guarded = function (input, init) {
    const url = typeof input === 'string' ? input : input && (input.url || String(input));
    if (BLOCKED_URL.test(url || '')) return Promise.reject(new TypeError('blocked external request'));
    return realFetch.call(scope, input, init); // Illegal invocation 방지를 위해 scope 로 호출
  };
  guarded[MARK] = true;
  scope.fetch = guarded;
}
