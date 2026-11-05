import { describe, it, expect, vi } from 'vitest';
import { STORAGE_KEY, createStore, sanitizeParams, diffFromDefaults, getBrowserStorage } from '../src/ui/store.js';
import { shortcutFor, isTypingTarget, installShortcuts, buildCameraOptions, installCursorAutoHide } from '../src/ui/panel.js';
import { DEFAULTS, META } from '../src/config/params.js';

/** 메모리 저장소 (Storage 흉내) */
function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

const stored = (obj) => memStorage({ [STORAGE_KEY]: JSON.stringify(obj) });

describe('store: 불러오기', () => {
  it('키는 picasso-me/params/v1', () => {
    expect(STORAGE_KEY).toBe('picasso-me/params/v1');
  });

  it('저장된 값이 없으면 기본값 사본(수정 가능)을 준다', () => {
    const p = createStore(memStorage()).load();
    expect(p).toEqual(DEFAULTS);
    expect(p).not.toBe(DEFAULTS);
    expect(Object.isFrozen(p)).toBe(false);
    p.yawRange = 20; // 패널이 수정할 수 있어야 한다
    expect(DEFAULTS.yawRange).toBe(45);
  });

  it('일부만 저장돼 있으면 나머지는 기본값과 병합', () => {
    const p = createStore(stored({ yawRange: 60, invertYaw: true, distanceMode: 'eyes' })).load();
    expect(p).toEqual({ ...DEFAULTS, yawRange: 60, invertYaw: true, distanceMode: 'eyes' });
  });

  it('알 수 없는 키는 버린다', () => {
    const p = createStore(stored({ yawRange: 50, hacked: 1, __proto__: { x: 1 } })).load();
    expect(p.yawRange).toBe(50);
    expect('hacked' in p).toBe(false);
    expect(Object.keys(p).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });

  it('타입이 다르면 그 항목만 기본값', () => {
    const p = createStore(
      stored({ yawRange: '60', invertYaw: 1, filterEnabled: 'false', cameraId: 5, distanceMode: 3, jitterAmp: null, lagScale: [1], rollSpread: 0.5 }),
    ).load();
    expect(p.yawRange).toBe(DEFAULTS.yawRange);
    expect(p.invertYaw).toBe(DEFAULTS.invertYaw);
    expect(p.filterEnabled).toBe(DEFAULTS.filterEnabled);
    expect(p.cameraId).toBe(DEFAULTS.cameraId);
    expect(p.distanceMode).toBe(DEFAULTS.distanceMode);
    expect(p.jitterAmp).toBe(DEFAULTS.jitterAmp);
    expect(p.lagScale).toBe(DEFAULTS.lagScale);
    expect(p.rollSpread).toBe(0.5); // 올바른 항목은 유지
  });

  it('숫자는 META 범위로 clamp, NaN·Infinity 문자열은 기본값', () => {
    const p = createStore(stored({ yawRange: 999, pitchRange: -5, maxProximity: 99, rollSpread: -1, angleBeta: 2 })).load();
    expect(p.yawRange).toBe(META.yawRange.max);
    expect(p.pitchRange).toBe(META.pitchRange.min);
    expect(p.maxProximity).toBe(META.maxProximity.max);
    expect(p.rollSpread).toBe(META.rollSpread.min);
    expect(p.angleBeta).toBe(META.angleBeta.max);
    const q = createStore(memStorage({ [STORAGE_KEY]: '{"yawRange":"Infinity","pitchRange":1e999}' })).load();
    expect(q.yawRange).toBe(DEFAULTS.yawRange); // 문자열
    expect(q.pitchRange).toBe(DEFAULTS.pitchRange); // 1e999 → Infinity 로 파싱 → 거부
  });

  it('정수 step 항목은 반올림한다', () => {
    const p = createStore(stored({ strokeLayers: 3.7, jitterFps: 9.4, yawRange: 44.6 })).load();
    expect(p.strokeLayers).toBe(4);
    expect(p.jitterFps).toBe(9);
    expect(p.yawRange).toBe(45);
  });

  it('옵션 항목은 허용된 값만 받는다', () => {
    expect(createStore(stored({ distanceMode: 'eyes' })).load().distanceMode).toBe('eyes');
    expect(createStore(stored({ distanceMode: 'bogus' })).load().distanceMode).toBe('matrix');
  });

  it('카메라 ID(문자열)는 그대로 받는다', () => {
    expect(createStore(stored({ cameraId: 'abc123' })).load().cameraId).toBe('abc123');
  });

  it('손상된 JSON 이나 객체가 아닌 값은 무시하고 throw 하지 않는다', () => {
    for (const text of ['{not json', '', '[1,2,3]', '"str"', 'null', '123', 'true', '{"yawRange":']) {
      const s = createStore(memStorage({ [STORAGE_KEY]: text }));
      expect(() => s.load()).not.toThrow();
      expect(s.load()).toEqual(DEFAULTS);
    }
  });
});

describe('store: 저장·초기화', () => {
  it('기본값과 다른 항목만 저장한다', () => {
    const storage = memStorage();
    const s = createStore(storage);
    const p = s.load();
    p.yawRange = 60;
    p.invertPitch = true;
    expect(s.save(p)).toBe(true);
    expect(JSON.parse(storage.getItem(STORAGE_KEY))).toEqual({ yawRange: 60, invertPitch: true });
  });

  it('저장 → 불러오기 왕복', () => {
    const storage = memStorage();
    const s = createStore(storage);
    const p = s.load();
    Object.assign(p, { yawRange: 70, pitchRange: 30, jitterAmp: 4.5, distanceMode: 'eyes', cameraId: 'cam-1', swapEyes: true, filterEnabled: false });
    s.save(p);
    expect(createStore(storage).load()).toEqual(p);
  });

  it('모두 기본값이면 항목을 지운다', () => {
    const storage = stored({ yawRange: 60 });
    const s = createStore(storage);
    s.save({ ...DEFAULTS });
    expect(storage.map.has(STORAGE_KEY)).toBe(false);
  });

  it('범위 밖 값은 clamp 해서 저장한다', () => {
    const storage = memStorage();
    createStore(storage).save({ ...DEFAULTS, yawRange: 500 });
    expect(JSON.parse(storage.getItem(STORAGE_KEY))).toEqual({ yawRange: 90 });
  });

  it('clear 는 저장 항목을 지운다', () => {
    const storage = stored({ yawRange: 60 });
    expect(createStore(storage).clear()).toBe(true);
    expect(storage.map.has(STORAGE_KEY)).toBe(false);
    expect(createStore(storage).load()).toEqual(DEFAULTS);
  });

  it('diffFromDefaults / sanitizeParams 는 DEFAULTS 를 바꾸지 않는다', () => {
    const before = JSON.stringify(DEFAULTS);
    diffFromDefaults({ ...DEFAULTS, yawRange: 50 });
    sanitizeParams({ yawRange: 50, bad: 1 });
    expect(JSON.stringify(DEFAULTS)).toBe(before);
    expect(diffFromDefaults({ ...DEFAULTS })).toEqual({});
  });
});

describe('store: 저장소가 없거나 고장난 환경', () => {
  it('storage 가 null/undefined 여도 throw 하지 않는다', () => {
    for (const storage of [null, undefined]) {
      const s = createStore(storage, STORAGE_KEY);
      expect(() => s.load()).not.toThrow();
      expect(() => s.save({ ...DEFAULTS, yawRange: 60 })).not.toThrow();
      expect(() => s.clear()).not.toThrow();
    }
    expect(createStore(null).load()).toEqual(DEFAULTS);
  });

  it('getItem/setItem/removeItem 이 throw 해도 안전하다', () => {
    const boom = () => {
      throw new Error('SecurityError');
    };
    const s = createStore({ getItem: boom, setItem: boom, removeItem: boom });
    expect(s.load()).toEqual(DEFAULTS);
    expect(s.save({ ...DEFAULTS, yawRange: 60 })).toBe(false);
    expect(s.save({ ...DEFAULTS })).toBe(false);
    expect(s.clear()).toBe(false);
  });

  it('getBrowserStorage 는 throw 하지 않는다 (Node 에는 localStorage 가 없다)', () => {
    expect(() => getBrowserStorage()).not.toThrow();
  });
});

describe('단축키 판정 (ui/panel.js)', () => {
  const ev = (code, extra = {}) => ({ code, target: { tagName: 'BODY' }, ...extra });

  it('H/C/F 를 e.code 로 판정한다 (한글 IME 에서 key 가 ㅗ/ㅊ/ㄹ 이어도 동작)', () => {
    expect(shortcutFor(ev('KeyH', { key: 'ㅗ' }))).toBe('panel');
    expect(shortcutFor(ev('KeyC', { key: 'ㅊ' }))).toBe('calibrate');
    expect(shortcutFor(ev('KeyF', { key: 'ㄹ' }))).toBe('fullscreen');
    expect(shortcutFor(ev('KeyH', { key: 'Process', isComposing: true }))).toBe('panel');
    expect(shortcutFor(ev('KeyH', { key: 'H', shiftKey: true }))).toBe('panel');
  });

  it('다른 키는 무시', () => {
    expect(shortcutFor(ev('KeyG'))).toBeNull();
    expect(shortcutFor(ev('Space'))).toBeNull();
    expect(shortcutFor(ev('Digit1'))).toBeNull();
    expect(shortcutFor(null)).toBeNull();
  });

  it('Ctrl/Alt/Meta 조합과 키 반복(e.repeat)은 무시', () => {
    expect(shortcutFor(ev('KeyC', { ctrlKey: true }))).toBeNull(); // Ctrl+C 복사
    expect(shortcutFor(ev('KeyF', { ctrlKey: true }))).toBeNull(); // Ctrl+F 찾기
    expect(shortcutFor(ev('KeyH', { altKey: true }))).toBeNull();
    expect(shortcutFor(ev('KeyH', { metaKey: true }))).toBeNull();
    expect(shortcutFor(ev('KeyF', { repeat: true }))).toBeNull();
  });

  it('입력창(input/textarea/select/contenteditable)에 포커스가 있으면 무시', () => {
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'input' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
      expect(shortcutFor({ code: 'KeyH', target })).toBeNull();
      expect(isTypingTarget(target)).toBe(true);
    }
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });

  it('installShortcuts: 처리한 키만 preventDefault, 해제하면 더 이상 호출되지 않는다', () => {
    let listener = null;
    const target = {
      addEventListener: (type, fn) => {
        expect(type).toBe('keydown');
        listener = fn;
      },
      removeEventListener: (type, fn) => {
        if (fn === listener) listener = null;
      },
    };
    const handlers = { panel: vi.fn(), calibrate: vi.fn(), fullscreen: vi.fn() };
    const dispose = installShortcuts(handlers, { target });

    const press = (code, extra = {}) => {
      const e = { code, target: { tagName: 'BODY' }, preventDefault: vi.fn(), ...extra };
      listener?.(e);
      return e;
    };
    expect(press('KeyH').preventDefault).toHaveBeenCalled();
    expect(press('KeyC').preventDefault).toHaveBeenCalled();
    expect(press('KeyF').preventDefault).toHaveBeenCalled();
    expect(handlers.panel).toHaveBeenCalledTimes(1);
    expect(handlers.calibrate).toHaveBeenCalledTimes(1);
    expect(handlers.fullscreen).toHaveBeenCalledTimes(1);

    expect(press('KeyG').preventDefault).not.toHaveBeenCalled();
    expect(press('KeyC', { ctrlKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(press('KeyH', { repeat: true }).preventDefault).not.toHaveBeenCalled();
    expect(handlers.panel).toHaveBeenCalledTimes(1);

    dispose();
    expect(listener).toBeNull();
  });

  it('핸들러가 없는 동작은 조용히 무시', () => {
    let listener = null;
    installShortcuts({ panel: vi.fn() }, { target: { addEventListener: (t, fn) => (listener = fn), removeEventListener() {} } });
    const e = { code: 'KeyF', target: { tagName: 'BODY' }, preventDefault: vi.fn() };
    expect(() => listener(e)).not.toThrow();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('카메라 드롭다운 옵션 (ui/panel.js)', () => {
  it('자동 선택이 첫 항목(값 "")이고, 장치 목록이 뒤따른다', () => {
    const opts = buildCameraOptions([{ id: 'a', label: 'LGE Camera' }, { id: 'b', label: 'LGE IR-FHD Camera' }], { autoLabel: 'LGE Camera' });
    expect(Object.entries(opts)).toEqual([
      ['자동 선택 · LGE Camera', ''],
      ['LGE Camera', 'a'],
      ['LGE IR-FHD Camera', 'b'],
    ]);
  });

  it('장치를 아직 모르면 자동 선택만', () => {
    expect(buildCameraOptions([])).toEqual({ '자동 선택': '' });
  });

  it('저장된 카메라가 연결돼 있지 않으면 선택 상태를 잃지 않게 별도 항목으로 남긴다', () => {
    const opts = buildCameraOptions([{ id: 'a', label: 'LGE Camera' }], { savedId: 'gone' });
    expect(Object.values(opts)).toContain('gone');
    expect(Object.keys(opts).some((k) => k.includes('연결 안 됨'))).toBe(true);
    const connected = buildCameraOptions([{ id: 'a', label: 'LGE Camera' }], { savedId: 'a' });
    expect(Object.values(connected)).toEqual(['', 'a']);
  });

  it('이름이 같은 장치는 구분하고, 라벨이 비면 번호를 붙인다', () => {
    const opts = buildCameraOptions([{ id: 'a', label: 'Cam' }, { id: 'b', label: 'Cam' }, { id: 'c', label: '' }]);
    expect(Object.keys(opts)).toEqual(['자동 선택', 'Cam', 'Cam (2)', '카메라 3']);
    expect(Object.values(opts)).toEqual(['', 'a', 'b', 'c']);
  });
});

describe('커서 자동 숨김 (ui/panel.js)', () => {
  function fakeDoc() {
    const classes = new Set();
    const listeners = {};
    return {
      listeners,
      classes,
      body: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } },
      addEventListener: (t, fn) => (listeners[t] = fn),
      removeEventListener: (t) => delete listeners[t],
    };
  }

  it('2초 멈추면 숨기고, 움직이면 다시 보인다', () => {
    vi.useFakeTimers();
    try {
      const doc = fakeDoc();
      const dispose = installCursorAutoHide({ doc, idleMs: 2000 });
      vi.advanceTimersByTime(1999);
      expect(doc.classes.has('hide-cursor')).toBe(false);
      vi.advanceTimersByTime(2);
      expect(doc.classes.has('hide-cursor')).toBe(true);
      doc.listeners.mousemove();
      expect(doc.classes.has('hide-cursor')).toBe(false);
      vi.advanceTimersByTime(2001);
      expect(doc.classes.has('hide-cursor')).toBe(true);
      dispose();
      expect(doc.classes.has('hide-cursor')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('패널이 열려 있으면(isBlocked) 숨기지 않는다', () => {
    vi.useFakeTimers();
    try {
      const doc = fakeDoc();
      let blocked = true;
      installCursorAutoHide({ doc, idleMs: 1000, isBlocked: () => blocked });
      vi.advanceTimersByTime(5000);
      expect(doc.classes.has('hide-cursor')).toBe(false);
      blocked = false;
      vi.advanceTimersByTime(1100);
      expect(doc.classes.has('hide-cursor')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
