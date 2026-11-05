// 조절 패널(lil-gui)과 단축키·커서 숨김. 패널은 공유 params 객체를 직접 수정한다(렌더러·추적기가 매 프레임 읽음).
// 시작 시 숨김, H 로 토글. 촬영 화면에는 글자를 두지 않으므로 FPS 등 수치는 패널 안에만 표시한다.

import GUI from 'lil-gui';
import { DEFAULTS, META } from '../config/params.js';

const GROUP_ORDER = ['각도', '거리', '반응', '붓터치', '카메라'];
const KEY_ACTIONS = { KeyH: 'panel', KeyC: 'calibrate', KeyF: 'fullscreen' };

/** 정보 폴더 행: [키, 라벨, 소수 자리(숫자만)] */
const INFO_ROWS = [
  ['fps', 'FPS', 0],
  ['drawMs', '그리기 ms', 1],
  ['detectMs', '검출 ms', 1],
  ['yaw', 'yaw (°)', 1],
  ['pitch', 'pitch (°)', 1],
  ['roll', 'roll (°)', 1],
  ['proximity', 'proximity', 2],
  ['faces', '얼굴 수', 0],
  ['strokes', '스트로크 수', 0],
  ['mainMs', '메인 점유 ms', 1],
  ['delegate', '추론 장치'],
  ['detector', '검출 위치'],
  ['camera', '카메라'],
];

// ---- 단축키 -------------------------------------------------------------------------------

/** 글자를 입력 중인 요소인가 (단축키를 무시해야 함) */
export function isTypingTarget(el) {
  if (!el || typeof el !== 'object') return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * keydown 이벤트 → 동작 이름('panel' | 'calibrate' | 'fullscreen') 또는 null.
 * e.code 로 판정하므로 한글 IME 상태에서도 H/C/F 가 동작한다. 입력창 포커스·Ctrl/Alt/Meta·키 반복은 무시.
 */
export function shortcutFor(e) {
  if (!e || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return null;
  if (isTypingTarget(e.target)) return null;
  return KEY_ACTIONS[e.code] ?? null;
}

/** handlers: { panel, calibrate, fullscreen }. 반환값은 해제 함수 */
export function installShortcuts(handlers, { target = window } = {}) {
  const onKey = (e) => {
    const action = shortcutFor(e);
    const fn = action && handlers[action];
    if (!fn) return;
    e.preventDefault();
    fn(e);
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}

/** 전체화면 토글 (documentElement 기준이라 패널도 함께 보인다). 거부돼도 조용히 무시 */
export function toggleFullscreen(doc = document) {
  try {
    const p = doc.fullscreenElement ? doc.exitFullscreen?.() : doc.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    p?.catch?.(() => {});
  } catch {
    /* 지원하지 않는 환경 */
  }
}

/** 마우스가 idleMs 동안 멈추면 커서를 숨긴다. isBlocked() 가 true 면(패널 열림 등) 숨기지 않는다. 반환값은 해제 함수 */
export function installCursorAutoHide({ doc = document, idleMs = 2000, isBlocked = () => false } = {}) {
  let timer = null;
  const hide = () => {
    timer = null;
    if (isBlocked()) return arm();
    doc.body.classList.add('hide-cursor');
  };
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(hide, idleMs);
  }
  const onMove = () => {
    doc.body.classList.remove('hide-cursor');
    arm();
  };
  doc.addEventListener('mousemove', onMove, { passive: true });
  doc.addEventListener('mousedown', onMove, { passive: true });
  arm();
  return () => {
    clearTimeout(timer);
    doc.removeEventListener('mousemove', onMove);
    doc.removeEventListener('mousedown', onMove);
    doc.body.classList.remove('hide-cursor');
  };
}

// ---- 패널 ---------------------------------------------------------------------------------

/**
 * 카메라 드롭다운 옵션 {라벨: deviceId}. ''(자동 선택)이 항상 첫 항목이고,
 * 저장된 카메라가 지금 연결돼 있지 않으면 선택 상태를 잃지 않도록 별도 항목으로 남긴다.
 */
export function buildCameraOptions(cameras = [], { autoLabel = '', savedId = '' } = {}) {
  const used = new Set();
  const uniq = (name) => {
    let n = name;
    for (let i = 2; used.has(n); i++) n = `${name} (${i})`;
    used.add(n);
    return n;
  };
  const options = {};
  options[uniq(autoLabel ? `자동 선택 · ${autoLabel}` : '자동 선택')] = '';
  cameras.forEach((c, i) => {
    options[uniq(c.label || `카메라 ${i + 1}`)] = c.id;
  });
  if (savedId && !cameras.some((c) => c.id === savedId)) options[uniq('저장된 카메라 (연결 안 됨)')] = savedId;
  return options;
}

/**
 * @param {object} cfg
 * @param {object} cfg.params 공유 params (직접 수정됨)
 * @param {{save:Function, clear:Function}} [cfg.store] 변경 시 저장
 * @param {() => any} [cfg.onCalibrate] '기준 거리 재설정'
 * @param {(id:string) => any} [cfg.onCameraChange] 카메라 선택이 바뀌었을 때(재시작은 호출한 쪽이 한다)
 * @param {() => {id:string,label:string}[]} [cfg.getCameras]
 * @param {() => string} [cfg.getCameraLabel] 지금 사용 중인 카메라 이름
 * @param {() => boolean} [cfg.isCameraError] 카메라 오류 상태인가 — 장치 목록이 비어도 선택창을 켜 둔다(다른 카메라를 골라 재시도)
 */
export function createPanel({ params, store, defaults = DEFAULTS, meta = META, onCalibrate, onCameraChange, getCameras, getCameraLabel, isCameraError, title = '조절 패널 (H)' }) {
  const gui = new GUI({ title, width: 300 });
  const folders = new Map();
  const folderOf = (name) => {
    if (!folders.has(name)) folders.set(name, gui.addFolder(name));
    return folders.get(name);
  };
  GROUP_ORDER.forEach(folderOf); // 폴더 순서 고정

  // META 에서 컨트롤 생성
  const controllers = {};
  for (const [key, m] of Object.entries(meta)) {
    if (!(key in params)) continue;
    const folder = folderOf(m.group);
    let c;
    if (m.dynamic) c = folder.add(params, key, buildCameraOptions([], { savedId: params[key] }));
    else if (m.options) c = folder.add(params, key, m.options);
    else if (typeof params[key] === 'number') c = folder.add(params, key, m.min, m.max, m.step);
    else c = folder.add(params, key);
    controllers[key] = c.name(m.label);
  }
  folderOf('카메라').add({ run: () => onCameraChange?.(params.cameraId) }, 'run').name('카메라 다시 시도');
  folderOf('거리').add({ run: () => onCalibrate?.() }, 'run').name('기준 거리 재설정');

  // 정보 (읽기 전용)
  const info = { fps: 0, drawMs: 0, detectMs: 0, yaw: 0, pitch: 0, roll: 0, proximity: 1, faces: 0, strokes: 0, mainMs: 0, delegate: '-', detector: '-', camera: '-' };
  const infoFolder = gui.addFolder('정보');
  const infoControllers = INFO_ROWS.map(([key, label, decimals]) => {
    const c = infoFolder.add(info, key).name(label).disable();
    if (typeof info[key] === 'number') c.decimals(decimals);
    return c;
  });

  let visible = false;
  const setListening = (on) => infoControllers.forEach((c) => c.listen(on));
  const refresh = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());

  function setCameras(cameras = getCameras?.() ?? [], label = getCameraLabel?.() ?? '') {
    const c = controllers.cameraId;
    if (!c) return;
    c.options(buildCameraOptions(cameras, { autoLabel: params.cameraId ? '' : label, savedId: params.cameraId }));
    c.disable(cameras.length === 0 && !isCameraError?.());
  }

  function resetAll() {
    const prev = params.cameraId;
    Object.assign(params, defaults);
    store?.clear();
    refresh();
    setCameras();
    if (params.cameraId !== prev) onCameraChange?.(params.cameraId);
  }
  gui.add({ run: resetAll }, 'run').name('기본값으로 초기화');

  gui.onChange(({ property }) => {
    if (!(property in defaults)) return; // 버튼
    store?.save(params);
    if (property === 'cameraId') onCameraChange?.(params.cameraId);
  });

  function show(v = true) {
    visible = !!v;
    gui.show(visible);
    setListening(visible);
    if (visible) {
      setCameras();
      refresh();
    }
  }
  show(false); // 시작 시 숨김

  return {
    gui,
    controllers,
    show,
    hide: () => show(false),
    toggle: () => show(!visible),
    get visible() {
      return visible;
    },
    /** 정보 값 갱신 (패널이 열려 있을 때만 반영). 숫자가 아닌 값은 0 으로 둬서 표시 갱신이 죽지 않게 한다 */
    update(values) {
      if (!visible) return;
      for (const [key] of INFO_ROWS) {
        if (!(key in values)) continue;
        info[key] = typeof info[key] === 'number' ? (Number.isFinite(values[key]) ? values[key] : 0) : String(values[key] ?? '-');
      }
    },
    setCameras,
    reset: resetAll,
    destroy: () => gui.destroy(),
  };
}
