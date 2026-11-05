// 오프라인 실행용 로컬 자산 준비 (PRD 4장, 8.1)
// - public/wasm/   : node_modules/@mediapipe/tasks-vision/wasm 복사 (패키지 버전이 바뀌거나 파일이 다르면 다시 복사)
// - public/models/face_landmarker.task : 크기·SHA-256 검증, 없거나 손상됐을 때만 공식 MediaPipe 저장소에서 다운로드
// 자산이 이미 정상이면 아무것도 하지 않으므로 인터넷 없이도 통과한다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const wasmSrc = join(pkgDir, 'wasm');
const wasmDst = join(root, 'public', 'wasm');
const wasmMarker = join(wasmDst, '.tasks-vision-version');
const modelDst = join(root, 'public', 'models', 'face_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_SIZE = 3758596;
const MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function copyWasm() {
  if (!existsSync(wasmSrc)) {
    console.error('[setup] tasks-vision wasm 폴더가 없습니다. 먼저 npm install 을 실행하세요.');
    process.exit(1);
  }
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  const names = readdirSync(wasmSrc);
  const upToDate =
    existsSync(wasmMarker) &&
    readFileSync(wasmMarker, 'utf8').trim() === version &&
    names.every((n) => existsSync(join(wasmDst, n)) && statSync(join(wasmDst, n)).size === statSync(join(wasmSrc, n)).size);
  if (upToDate) return;
  mkdirSync(wasmDst, { recursive: true });
  for (const name of names) copyFileSync(join(wasmSrc, name), join(wasmDst, name));
  writeFileSync(wasmMarker, version + '\n');
  console.log(`[setup] wasm ${names.length}개 복사 (tasks-vision ${version}) → public/wasm`);
}

function modelIsValid() {
  if (!existsSync(modelDst) || statSync(modelDst).size !== MODEL_SIZE) return false;
  return sha256(readFileSync(modelDst)) === MODEL_SHA256;
}

async function fetchModel() {
  if (modelIsValid()) return;
  mkdirSync(dirname(modelDst), { recursive: true });
  const tmp = modelDst + '.download';
  console.log(`[setup] 모델 다운로드: ${MODEL_URL}`);
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== MODEL_SIZE || sha256(buf) !== MODEL_SHA256) {
      throw new Error(`검증 실패 (크기 ${buf.length}, 해시 불일치)`);
    }
    writeFileSync(tmp, buf);
    renameSync(tmp, modelDst);
    console.log(`[setup] 모델 저장·검증 완료 (${buf.length} bytes) → public/models/face_landmarker.task`);
  } catch (err) {
    if (existsSync(tmp)) rmSync(tmp);
    console.error(`[setup] 모델 준비 실패: ${err.message}`);
    console.error('[setup] 인터넷 연결 후 npm run setup 을 다시 실행하거나, 위 URL의 파일을 public/models/ 에 직접 넣으세요.');
    process.exit(1);
  }
}

copyWasm();
await fetchModel();
