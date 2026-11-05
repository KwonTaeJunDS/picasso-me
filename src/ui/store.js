// 파라미터 저장소(localStorage). 기본값과 다른 값만 저장해서, 이후 기본값을 조정해도 예전 기본값이 고정되지 않는다.
// 저장소가 없거나(SecurityError 등) 값이 손상돼도 throw 하지 않는다.

import { DEFAULTS, META } from '../config/params.js';

export const STORAGE_KEY = 'picasso-me/params/v1';

/** 브라우저 localStorage. 접근 자체가 막혀 있으면 null */
export function getBrowserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 값 하나를 기본값의 타입·META 범위·옵션에 맞게 검증. 쓸 수 없으면 undefined */
function sanitizeValue(key, value, defaults, meta) {
  const def = defaults[key];
  const m = meta[key];
  if (typeof def === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (typeof def === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    let v = value;
    if (m && Number.isInteger(m.step)) v = Math.round(v);
    if (m && typeof m.min === 'number') v = Math.max(m.min, v);
    if (m && typeof m.max === 'number') v = Math.min(m.max, v);
    return v;
  }
  if (typeof def === 'string') {
    if (typeof value !== 'string') return undefined;
    if (m?.options && !Object.values(m.options).includes(value)) return undefined;
    return value.length > 1024 ? undefined : value;
  }
  return undefined;
}

/**
 * 저장된 객체 → 완전한 params 사본. 알 수 없는 키는 버리고, 잘못된 값은 기본값으로 대체한다.
 * 숫자는 META 범위로 clamp 한다.
 */
export function sanitizeParams(raw, defaults = DEFAULTS, meta = META) {
  const out = { ...defaults };
  if (!isPlainObject(raw)) return out;
  for (const key of Object.keys(defaults)) {
    if (!Object.hasOwn(raw, key)) continue;
    const v = sanitizeValue(key, raw[key], defaults, meta);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** 기본값과 다른 항목만 골라낸다 */
export function diffFromDefaults(params, defaults = DEFAULTS, meta = META) {
  const diff = {};
  for (const key of Object.keys(defaults)) {
    const v = sanitizeValue(key, params[key], defaults, meta);
    if (v !== undefined && v !== defaults[key]) diff[key] = v;
  }
  return diff;
}

/**
 * @param {Storage|null} [storage] getItem/setItem/removeItem 를 가진 객체 (없으면 아무 일도 하지 않음)
 * @param {string} [key]
 */
export function createStore(storage = getBrowserStorage(), key = STORAGE_KEY) {
  return {
    /** 저장된 값을 기본값과 병합해 돌려준다 (항상 완전한 params 사본) */
    load() {
      try {
        const text = storage?.getItem(key);
        if (!text) return { ...DEFAULTS };
        return sanitizeParams(JSON.parse(text));
      } catch {
        return { ...DEFAULTS }; // 손상된 JSON, 접근 오류
      }
    },
    /** 기본값과 다른 항목만 저장. 모두 기본값이면 항목을 지운다 */
    save(params) {
      try {
        const diff = diffFromDefaults(params);
        if (Object.keys(diff).length === 0) storage?.removeItem(key);
        else storage?.setItem(key, JSON.stringify(diff));
        return true;
      } catch {
        return false; // 용량 초과, 접근 거부 등
      }
    },
    clear() {
      try {
        storage?.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}
