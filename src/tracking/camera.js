// 카메라 열기·선택. 저장된 cameraId 우선, 없으면 기본 카메라로 권한을 얻은 뒤
// 이름이 TRACKING.cameraExclude(IR·가상 카메라 등)에 걸리면 다른 후보로 바꾼다.
// 이름 판정·후보 선택은 순수 함수라 DOM 없이 테스트한다.

import { TRACKING } from '../config/params.js';

/** 자동 선택에서 피할 카메라인가 (IR·가상·Mirametrix·OBS) */
export function isExcludedCamera(label, exclude = TRACKING.cameraExclude) {
  return !!label && exclude.test(label);
}

/**
 * 제외 대상이 아닌 대체 카메라. 이름에 "cam"이 들어간 웹캠다운 후보를 먼저, 없으면 목록 순서대로 첫 후보.
 * @param {{id:string,label:string}[]} devices
 */
export function chooseCamera(devices, currentId = '', exclude = TRACKING.cameraExclude) {
  const candidates = devices.filter((d) => d.id && d.id !== currentId && !isExcludedCamera(d.label, exclude));
  return candidates.find((d) => /cam/i.test(d.label)) ?? candidates[0] ?? null;
}

/** 카메라 열기 오류 → 화면에 보일 한 줄 안내 (캔버스 폭에 맞게 짧게) */
export function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return '카메라 권한이 거부되었습니다';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return '카메라를 찾을 수 없습니다';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return '카메라를 열 수 없습니다. 다른 앱이 쓰는 중인지 확인하세요';
    case 'unsupported':
      return '이 환경에서는 카메라를 쓸 수 없습니다 (localhost로 접속하세요)';
    case 'timeout':
      return '카메라 영상이 들어오지 않습니다';
    case 'RequestTimeout':
      return '카메라가 응답하지 않습니다. 패널에서 다른 카메라를 고르세요';
    default:
      return '카메라를 시작하지 못했습니다';
  }
}

/** 권한이 이미 허용된 경우의 getUserMedia 제한 시간. 가상 카메라처럼 응답 없이 멈추는 장치를 실패로 본다 */
export const REQUEST_TIMEOUT_MS = 8000;
/** 권한 팝업이 떠 있을 수 있을 때(허용 전·확인 불가)의 제한 시간 */
export const PROMPT_TIMEOUT_MS = 60000;

/** 카메라 권한이 허용돼 있으면 짧은 제한 시간, 아니면(팝업 대기 가능) 긴 제한 시간 */
async function pickTimeout() {
  try {
    const st = await globalThis.navigator?.permissions?.query({ name: 'camera' });
    if (st?.state === 'granted') return REQUEST_TIMEOUT_MS;
  } catch {
    /* Permissions API 없음 */
  }
  return PROMPT_TIMEOUT_MS;
}

/**
 * getUserMedia 에 제한 시간을 건다. 시간이 지나면 RequestTimeout 으로 실패시키고,
 * 그 뒤 늦게 도착한 스트림은 즉시 멈춘다.
 */
export function requestStream(md, constraints, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(makeError('RequestTimeout', `getUserMedia ${timeoutMs}ms 무응답`));
    }, timeoutMs);
    md.getUserMedia(constraints).then(
      (stream) => {
        clearTimeout(timer);
        if (settled) stopStream(stream); // 늦게 도착
        else {
          settled = true;
          resolve(stream);
        }
      },
      (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      },
    );
  });
}

const isPermissionError = (err) => ['NotAllowedError', 'PermissionDeniedError', 'SecurityError', 'unsupported'].includes(err?.name);

function makeError(name, message = name) {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** 카메라(videoinput) 목록. 권한 전에는 라벨이 비어 있을 수 있다 */
export async function listVideoInputs() {
  const md = globalThis.navigator?.mediaDevices;
  if (!md?.enumerateDevices) return [];
  const all = await md.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput' && d.deviceId).map((d) => ({ id: d.deviceId, label: d.label || '' }));
}

/**
 * 카메라 스트림을 연다.
 * @param {{ deviceId?: string, cfg?: object, requestTimeoutMs?: number }} [opts] deviceId 가 있으면 먼저 시도(없는 장치면 기본 카메라로).
 *   requestTimeoutMs: getUserMedia 한 번의 제한 시간(생략하면 권한 상태에 따라 8초/60초). 시간이 지나면 다른 후보를 시도한다
 * @returns {Promise<{ stream: MediaStream, deviceId: string, label: string, devices: {id:string,label:string}[] }>}
 */
export async function openCamera({ deviceId = '', cfg = TRACKING, requestTimeoutMs } = {}) {
  const md = globalThis.navigator?.mediaDevices;
  if (!md?.getUserMedia) throw makeError('unsupported');
  const timeoutMs = requestTimeoutMs ?? (await pickTimeout());
  const get = (id) =>
    requestStream(
      md,
      {
        video: {
          width: { ideal: cfg.videoWidth },
          height: { ideal: cfg.videoHeight },
          frameRate: { ideal: cfg.videoFps },
          ...(id ? { deviceId: { exact: id } } : {}),
        },
        audio: false,
      },
      timeoutMs,
    );

  let stream = null;
  if (deviceId) {
    try {
      stream = await get(deviceId);
    } catch (err) {
      if (isPermissionError(err)) throw err;
      stream = null; // 저장된 카메라가 없음 → 기본 카메라
    }
  }
  const auto = !stream; // 사용자가 명시한 카메라는 그대로 쓰고, 자동 선택일 때만 제외 정책을 적용한다

  if (!stream) {
    try {
      stream = await get('');
    } catch (err) {
      if (isPermissionError(err)) throw err;
      // 기본 카메라(가상 카메라 등)가 열리지 않으면 다른 후보를 차례로 시도
      const devices = await listVideoInputs().catch(() => []);
      const tried = new Set();
      for (let i = 0; i < 3 && !stream; i++) {
        const alt = chooseCamera(devices.filter((d) => !tried.has(d.id)));
        if (!alt) break;
        tried.add(alt.id);
        stream = await get(alt.id).catch(() => null);
      }
      if (!stream) throw err;
    }
  }

  let track = stream.getVideoTracks()[0];
  const devices = await listVideoInputs().catch(() => []);
  if (auto && track && isExcludedCamera(track.label, cfg.cameraExclude)) {
    const alt = chooseCamera(devices, track.getSettings?.().deviceId, cfg.cameraExclude);
    if (alt) {
      try {
        const next = await get(alt.id); // 대체 카메라를 먼저 연 뒤에 기존 것을 닫는다
        stream.getTracks().forEach((t) => t.stop());
        stream = next;
        track = stream.getVideoTracks()[0];
      } catch {
        /* 대체 카메라를 못 열면 기본 카메라를 그대로 쓴다 */
      }
    }
  }
  return { stream, deviceId: track?.getSettings?.().deviceId || '', label: track?.label || '', devices };
}

/**
 * video 요소에 스트림을 연결하고 첫 프레임(videoWidth>0)이 올 때까지 기다린다.
 * play() 대기와 첫 프레임 대기 전체에 제한 시간 하나를 건다(타이머는 play() 호출 전에 시작).
 * 스트림은 열렸지만 프레임을 안 주는 가상 카메라에서 play() 가 영원히 끝나지 않는 경우도 timeout 으로 실패한다.
 */
export function attachStream(video, stream, timeoutMs = 8000) {
  video.srcObject = stream;
  const ready = () => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  return new Promise((resolve, reject) => {
    const events = ['loadeddata', 'loadedmetadata', 'resize', 'playing'];
    let finished = false;
    const finish = (fn, arg) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      events.forEach((e) => video.removeEventListener(e, check));
      fn(arg);
    };
    const check = () => {
      if (ready()) finish(resolve);
    };
    const timer = setTimeout(() => finish(reject, makeError('timeout')), timeoutMs);
    events.forEach((e) => video.addEventListener(e, check));
    let playing;
    try {
      playing = Promise.resolve(video.play());
    } catch (err) {
      playing = Promise.reject(err);
    }
    playing.then(check, (err) => {
      if (err?.name === 'NotAllowedError') finish(reject, err);
      else check(); // AbortError 등: 영상이 준비되면 계속 진행, 아니면 제한 시간까지 대기
    });
    check();
  });
}

/** 스트림의 모든 트랙을 멈춘다 */
export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}
