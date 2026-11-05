// FaceLandmarker 결과 해석 (순수 함수). 메인 스레드와 검출 워커가 같이 쓴다.
// 워커는 여기서 만든 작은 표본({matrix, eyeDistPx, …})만 메인으로 보낸다 — 랜드마크 전체는 보내지 않는다.

import { eyeDistancePx, landmarkYaw } from './pose.js';

/** 랜드마크 바운딩 박스 면적(픽셀). 영상 가로·세로 크기로 종횡비를 보정한다 */
export function landmarkBoxArea(landmarks, width = 1, height = 1) {
  if (!landmarks?.length) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const a = (maxX - minX) * width * ((maxY - minY) * height);
  return Number.isFinite(a) ? a : 0;
}

/**
 * 가장 큰 얼굴 1개를 고른다. 같은 인덱스의 변환 행렬·blendshape 를 함께 돌려준다. 얼굴이 없으면 null.
 * @param {{faceLandmarks?:any[][], faceBlendshapes?:any[], facialTransformationMatrixes?:any[]}} result
 */
export function selectLargestFace(result, width = 1, height = 1) {
  const all = result?.faceLandmarks;
  if (!all?.length) return null;
  let best = -1;
  let bestArea = -1;
  for (let i = 0; i < all.length; i++) {
    if (!all[i]?.length) continue;
    const a = landmarkBoxArea(all[i], width, height);
    if (a > bestArea) {
      bestArea = a;
      best = i;
    }
  }
  if (best < 0) return null;
  return {
    index: best,
    faces: all.length,
    area: bestArea,
    landmarks: all[best],
    matrix: result.facialTransformationMatrixes?.[best]?.data ?? null,
    blendshapes: result.faceBlendshapes?.[best]?.categories ?? null,
  };
}

export function blendScore(categories, name) {
  if (!categories) return 0;
  for (const c of categories) if (c.categoryName === name) return c.score;
  return 0;
}

/** FaceLandmarkerResult → signals.js 가 받는 표본(구조화 복제 가능한 작은 객체). 얼굴이 없으면 hasFace:false */
export function extractSample(result, width, height, at) {
  const face = selectLargestFace(result, width, height);
  if (!face) return { at, hasFace: false, faces: 0 };
  return {
    at,
    hasFace: true,
    faces: face.faces,
    matrix: face.matrix ? Array.from(face.matrix) : null,
    eyeDistPx: eyeDistancePx(face.landmarks, width, height),
    landmarkYaw: landmarkYaw(face.landmarks),
    blinkLeft: blendScore(face.blendshapes, 'eyeBlinkLeft'),
    blinkRight: blendScore(face.blendshapes, 'eyeBlinkRight'),
    jawOpen: blendScore(face.blendshapes, 'jawOpen'),
  };
}
