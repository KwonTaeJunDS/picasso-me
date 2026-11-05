# Picasso Me — 구현 계획 v2

- 작성: 2026-11-04, 오케스트레이터(Claude Opus 5.5)
- 근거: PRD.md 초안 v1
- 상태: 구현 완료(2026-11-05), 사용자 실기 확인 대기. Codex 1차(계획 12건)·2차(코드 11건) 검토 반영.
- 구현 중 추가된 결정: 검출은 Web Worker(실패 시 메인 스레드 폴백, `?detector=main`), 렌더는 면적 기반 겹수 상한 + 정적 레이어 분할 선그리기, 워커 안에도 외부 요청 차단(`src/tracking/netGuard.js`). 실행·점검 방법은 README.md.

---

## 0. 역할과 진행 방식

| 역할 | 담당 | 하는 일 |
|---|---|---|
| 오케스트레이터 | Claude Opus 5.5 | 요구사항 분석, 계획, 공유 계약 작성, 통합, 시각 검증, 최종 판단 |
| 독립 검토자 | Codex (astra 6, `astra_ask.sh`) | 계획 검토 1회(완료) + 코드 리뷰 1회. **읽기·분석만, 파일 수정 금지** |
| 개발자 | Claude Sonnet 5.5 ×2 (병렬) | Dev A: 앱·추적·패널 / Dev B: 초상 렌더러. 파일 소유권이 겹치지 않음 |
| 서브 개발자 | Claude Haiku 5.5 | 반복 테스트(유닛·빌드·브라우저 mock 점검), 리뷰 후 단순 수정 |

진행 단계

1. **P0 (완료)** 환경 확인, 의존성 설치, 오프라인 자산 준비(크기·SHA-256 검증).
2. **P1 (완료)** Codex 계획 검토 → v2 확정, 공유 계약 갱신.
3. **P2** Dev A ∥ Dev B 병렬 구현 + 각자 유닛 테스트.
4. **P3** 통합 + 브라우저 시각 검증(mock 모드, 갤러리) → Dev B에 시각 피드백 (최대 2회).
5. **P4** Haiku 반복 테스트 (npm test, build, mock 페이지 콘솔 오류·FPS).
6. **P5** Codex 코드 리뷰 → 수정(Sonnet/Haiku) → Haiku 재검증.
7. **P6** 최종 보고 + 사용자 실기 체크리스트.

## 1. 기술 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| 의존성 | `@mediapipe/tasks-vision 1.1.1`, `p5 2.3.4`, `lil-gui 0.21.0`, `vite 8.3.5`, `vitest 5.0.5` (정확 버전 고정) | 공개 2주 이상 지난 안정 버전만 사용 |
| 오프라인 자산 | `scripts/setup-assets.mjs` 가 `predev`/`prebuild` 에서 실행. wasm은 패키지 버전 마커로, 모델은 크기+SHA-256으로 검증하고 손상 시에만 임시파일→교체 다운로드 | 이후 인터넷 없이 `npm run dev` |
| 모델 | `public/models/face_landmarker.task` (float16/1, 3,758,596 B, SHA-256 `64184e22…0bc9ff`) | PRD 4장 |
| p5 사용 범위 | 인스턴스 모드, `createCanvas(1080,1920)`, `pixelDensity(1)`, `frameRate(60)`, `drawingContext` | 도형은 Canvas2D 경로를 직접 호출 → p5 2.x API 변화 위험·오버헤드 최소화 |
| 난수 | 렌더 경로에서 `Math.random`/p5 `random` 금지. 해시 PRNG + 값 노이즈 자체 구현 | 시드 고정·스톱모션 재현성, 테스트 가능 |
| 테스트 | vitest(node), 순수 함수 중심. 렌더러는 `composePortrait()`(순수 기하) / `draw()`(캔버스) 분리 | 카메라 없이 검증 |
| 카메라 없는 검증 | `?mock` 타임라인, `?mock=static&…`, `dev/gallery.html`, `dev/selftest.html`(모델·wasm 로딩과 검출 시간) | 화면 글자 없음 유지 |
| 촬영 PC 특이점 | 이 PC는 Intel Arc 내장 GPU + RTX 3050, 카메라 4개(LGE Camera, **LGE IR-FHD**, **Mirametrix Virtual**, 프린터 스캐너) | IR/가상 카메라 자동 회피 + 패널 카메라 선택 필요 |

## 2. 공유 계약 (오케스트레이터 소유 — 개발자는 수정 금지, 변경 필요 시 보고)

- `src/contracts.js`: 화면 상수, `FaceSignals`, 추적기 인터페이스(`TrackerFrame`, `TrackerMetrics`).
- `src/config/params.js`: `DEFAULTS`·`META`(패널), `LAG_TAU_MS`, `LAG_SETTLE`, `BLINK`, `FADE`, `TRACKING`.
- 렌더러/추적기는 `params` 객체를 **읽기만**(패널이 같은 객체 수정 → 즉시 반영).

### 2.1 FaceSignals (모두 화면=거울 기준)

| 필드 | 범위 | 의미 |
|---|---|---|
| `present` | bool | 최근 표본(≤`staleMs` 250ms)에 얼굴 있음. 300ms 미감지 판정은 렌더러 fade |
| `t` | [-1,1] | yaw, **+ = 화면에서 코가 오른쪽** |
| `p` | [-1,1] | pitch, **+ = 고개 숙임** |
| `r` | [-1,1] | roll, **+ = 화면에서 시계방향** |
| `k` | [0,1] | 거리 왜곡량 |
| `blinkL/R` | [0,1] | **화면 왼쪽/오른쪽 눈**. 값 ≥ 0.5 ⇔ 감김 (히스테리시스·최소 유지는 추적기가 보장) |
| `jaw` | [0,1] | 입 벌림 |

- `present=false` 동안 나머지 값은 마지막 값 유지.

### 2.2 추적기 (`createTracker(params)` / `createMockTracker(params, search)`)
- `start()`, `poll(nowMs) → TrackerFrame{signals,status,error,sampledAt,metrics}`, `calibrate() → bool`, `video`.
- 같은 인터페이스라 `main.js`는 실카메라/mock을 구분하지 않는다.

### 2.3 렌더러 (`src/render/portrait.js`, Dev B)
```js
const portrait = createPortrait();
portrait.update(signals, params, nowMs, dtMs, { snap = false } = {}); // 시간차 + 페이드. snap=true → 즉시 수렴·완전 표시
portrait.draw(p, params, nowMs, x, y, w, h);  // 설계 공간 1080×1152를 (x,y,w,h)에 그림
portrait.info();                             // { fadeLevel, phase, strokes }
export function composePortrait(partStates, params, nowMs) // 순수 함수 → Stroke[] (테스트용, 구조는 Dev B가 portrait.js에 문서화)
```
- 현재 `portrait.js`는 오케스트레이터 스텁. Dev B가 전체 교체.

### 2.4 앱 루프 (`src/main.js`, Dev A)
```
draw():   // rAF
  frame = tracker.poll(now)               // 내부에서 새 비디오 프레임이면 검출을 별도 태스크로 예약
  drawWebcam(tracker.video) → (0,0,1080,768), cover 크롭·거울 / mock이면 짙은 회색
  portrait.update(frame.signals, params, now, dt); portrait.draw(p, params, now, 0, 768, 1080, 1152)
  status loading/error 일 때만 그림 영역 중앙에 작은 글자 1줄
```

## 3. 추적·신호 설계 (Dev A)

### 3.1 카메라
- `getUserMedia({ video:{ width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30}, deviceId? }, audio:false })`.
- **카메라 선택**: 저장된 `params.cameraId`가 있으면 `{deviceId:{exact}}`(실패 시 기본). 없으면 기본 카메라로 권한을 얻은 뒤 `enumerateDevices()`로 이름을 보고, 현재 트랙이 `TRACKING.cameraExclude`(IR·Virtual·Mirametrix·OBS)에 걸리고 다른 후보가 있으면 그 카메라로 전환. 패널 '카메라' 드롭다운으로 수동 선택, 선택값 저장.
- 실제 `video.videoWidth/videoHeight` 사용(요청값을 가정하지 않음).

### 3.2 검출
- `FilesetResolver.forVisionTasks('/wasm')` → `FaceLandmarker.createFromOptions({ baseOptions:{ modelAssetPath:'/models/face_landmarker.task', delegate:'GPU' }, runningMode:'VIDEO', numFaces: TRACKING.numFaces, outputFaceBlendshapes:true, outputFacialTransformationMatrixes:true })`. GPU 실패 시 CPU 재시도.
- **원본(비반전) 영상**을 넣는다. 거울은 그릴 때만.
- `detectForVideo`는 동기 호출이므로 **rAF 콜백 밖**(MessageChannel/setTimeout 0 태스크)에서 실행 → 현재 프레임 표시를 막지 않음. 새 비디오 프레임(`currentTime` 변화 또는 rVFC)일 때만, 진행 중 검출이 없을 때만(최신 프레임 1개). 타임스탬프 단조 증가 보장.
- One Euro는 **새 표본에만** 적용. `present = 최근 표본에 얼굴 있음 && now − sampledAt < staleMs`.
- 여러 얼굴: 랜드마크 바운딩 박스 면적(픽셀, 종횡비 보정) 최대 1개, 같은 인덱스의 행렬·블렌드셰이프.
- 성능 측정값(`detectMs` 이동 평균)을 metrics로 노출. Worker 검출은 실측 후 필요할 때 추가(인터페이스로 격리).

### 3.3 자세 (pose.js)
- `data`는 column-major 4×4 (번들 확인: proto `packed_data` 그대로 복사, MatrixData 기본 COLUMN_MAJOR). `R[row][col] = d[col*4+row]`. 회전 열벡터를 정규화(스케일 제거).
- `R = Ry(y)·Rx(p)·Rz(r)` (YXZ): `y = atan2(R02, R22)`, `p = asin(clamp(−R12, −1, 1))`, `r = atan2(R10, R11)`. 특이점(|R12| > 0.9999): `y = atan2(−R20, R00)`, `r = 0`.
- 카메라 공간(+X 원본 영상 오른쪽, +Y 위, 얼굴은 +Z) → 거울 화면 정규화: **`t = −y/yawRange`, `p = +p/pitchRange`, `r = +r/rollRange`** (Codex 독립 유도와 일치), 이후 clamp.
- 안전장치: ① 패널 `invertYaw/Pitch/Roll`. ② 랜드마크 부호 점검 — 코끝(1)과 양 볼(234·454) 중점의 x 차이로 얻은 yaw 방향이 |yaw|>15° 표본 20개 이상에서 행렬 부호와 80% 넘게 어긋나면 `console.warn` 1회. ③ `?debugpose`: 1초마다 원시 행렬·각도·랜드마크 부호를 콘솔에 출력(실기 fixture 수집용).

### 3.4 거리 (signals.js)
- 기본 `distanceMode='matrix'`: 변환 행렬 translation `|z|`(= |d[14]|) 사용, `proximity = |z0|/|z|` — 회전에 강함.
- 대안 `'eyes'`(PRD 원안): 눈꼬리(33–263) 픽셀 거리 `e / cos(|yaw|)`, `proximity = e/e0`. |yaw| > `eyesModeMaxYaw`(30°)이면 갱신 보류(직전 값 유지). 기준값에도 같은 보정.
- 기준: 얼굴이 연속 `baselineStableMs`(0.5초) 이상 검출 + |yaw|,|pitch| < 15° 구간의 중앙값으로 자동 1회. `C`/패널 버튼 → 현재 필터값으로 갱신(얼굴 없으면 무시). 모드를 바꾸면 기준 재설정. 저장하지 않음.
- `k = clamp((proximity−1)/(maxProximity−1), 0, 1)`.
- 두 방식의 실기 비교(고정 거리에서 회전 시 proximity 변동)는 사용자 체크리스트로 남긴다.

### 3.5 필터 (oneEuro.js)
- 표준 One Euro (Casiez 2012), dt 초 단위, dCutoff 1.0. 원시값에 적용 후 정규화.
- 각도(°)·거리(z 또는 e): `angleMinCutoff 1.0 / angleBeta 0.05`. jaw: `exprMinCutoff 2.0 / exprBeta 0.1`. `filterEnabled=false`면 통과.
- 얼굴 재등장(직전 표본이 미검출) 시 필터 리셋.

### 3.6 표정
- `jawOpen` → One Euro(표정) → `jaw`.
- **깜빡임은 One Euro 대신** 원시 `eyeBlinkLeft/Right`에 히스테리시스(`BLINK.closeAt 0.5` 감김 / `openAt 0.4` 뜸) + 최소 유지 `minHoldMs 80` → 30Hz에서 1프레임 깜빡임도 보존. 출력: 감김이면 `max(raw, 0.5)`, 아니면 `min(raw, 0.49)`. (PRD 6.1 "모든 원시값에 필터"에서 의도적 이탈 — 이진 판정의 떨림은 히스테리시스가 더 잘 막고, 필터는 짧은 깜빡임을 삼킴. 보고서에 명시)
- 매핑: `blinkL(화면 왼쪽 눈) = eyeBlinkLeft`(피사체 왼눈 = 거울 화면 왼쪽). `swapEyes`로 교환.

### 3.7 mock (mock.js)
- `?mock`: 시나리오 B(15초: 정면 → 왼쪽 회전·유지 → 복귀 → 오른쪽 → 정면+깜빡임·입) + 얼굴 이탈 2초·재등장 + 끄덕임·갸웃·접근 + **빠른 회전 후 정지** 구간을 반복. 1프레임 깜빡임 포함.
- `?mock=static&t=0.8&p=0&r=0&k=0&bl=0&br=0&jaw=0&face=1`: 고정값.
- 웹캠 영역은 짙은 회색 단색(글자 없음). 모델은 로딩하지 않음.

### 3.8 레이아웃 (layout.js)
- 웹캠: 실제 영상 크기 → 1080×768 cover 크롭(가운데), 좌우 반전, `drawImage` 9인자.
- 표시: `scale = min(innerW/1080, innerH/1920)` 캔버스 CSS 크기, 가운데, 여백 검정. resize/fullscreenchange 재계산.

### 3.9 패널·단축키 (ui/panel.js, ui/store.js)
- lil-gui, 시작 시 숨김(오른쪽 위). 그룹: 각도(+반전 토글) / 거리(+방식, 기준 재설정 버튼) / 반응 / 붓터치 / 카메라 / 정보(FPS, 그리기 ms, 검출 ms, yaw·pitch·roll·proximity, 카메라 이름 — 읽기 전용) / "기본값으로 초기화".
- `localStorage` 키 `picasso-me/params/v1`: 기본값과 병합, 타입·범위·옵션 검증, 변경 시 저장. 손상된 JSON은 무시.
- 단축키는 `e.code`(KeyH/KeyC/KeyF) → **한글 IME에서도 동작**. 입력창 포커스·수정키·`e.repeat` 무시.
- 마우스 2초 정지 시 커서 숨김.

### 3.10 dev/selftest.html (Dev A)
- 카메라 없이 모델·wasm 로딩(GPU→CPU)과 빈 캔버스 `detectForVideo` 수십 회 시간을 측정해 페이지·콘솔에 표시. 오프라인 자산 경로 검증용.

## 4. 렌더링 설계 (Dev B)

### 4.1 좌표계·구도
- 설계 공간 = 그림 영역 1080×1152. 얼굴 중심 `C ≈ (540, 470)`, 얼굴 높이 `FH = 0.55×1152 ≈ 634` (b≈317), 반너비 a≈228.
- 얼굴 로컬 (u,v) ∈ [-1,1]² (u 화면 좌→우, v 이마 위→턱). 위치 = C + (u·a, v·b) → pitch 세로 재매핑 → 조각별 roll 회전(C 기준).
- 그림 속 얼굴은 항상 중앙. 각도·거리·표정만 반영.
- 레이어 순서: 배경 → 흘러내림 → 어깨 → 목 → 뒷머리 → 귀(뒤) → 얼굴 반쪽 바탕 → 얼굴 색면 → 코 → 입 → 눈·눈썹 → 앞머리 → 흰 선 → 강조 귀.

### 4.2 다시점 변형 (t) — 연속성 규칙
- **공통 정면 기하 `G0`**(비대칭 허용)에서 σ=|t|에 따라 `t>0`이면 오른쪽 옆모습 목표 `G+`로, `t<0`이면 왼쪽 옆모습 목표 `G−`(= `G+`의 좌우 거울)로 보간: `G(t) = lerp(G0, G±, ease(σ))`. 정면 도형 자체는 뒤집지 않으므로 t=±ε에서 튀지 않는다.
- **분할선 위치는 면적 기준**: 옆모습 쪽 목표 면적 비율 `f = 0.5 + 0.45·σ`(정면 0.5 → 완전 옆모습 0.95), 기본 얼굴 타원의 면적 역함수(이분법 또는 LUT)로 분할선 u를 구함. 회전 반대쪽으로 이동. 흰 선, 코 높이에서 약간 꺾임.
- 옆모습 반쪽 바깥 윤곽은 σ에 따라 타원 반쪽 → 옆얼굴 실루엣(이마 경사, 눈썹뼈, 턱)으로 보간. **코·입술은 윤곽과 별도 부품**.
- **부착 규칙(코·입)**: 뿌리(부착점)는 **현재 윤곽(τ=0)** 기하에서 계산해 항상 얼굴에 붙어 있고, 돌출 길이·모양·방향은 부품 자신의 지연된 t로 계산. 추가로 지연 위치와 현재 위치의 차이를 ±0.12a로 제한한 상대 변위를 더해 "늦게 따라오는 어긋남"을 보이게 한다. 뿌리 쪽은 얼굴 안으로 10~15px 겹쳐 틈이 생기지 않게.
- 코(τ150): 정면 = 세로 쐐기 + 흰 콧대 + 네이비 콧구멍 → σ→1 = 윤곽 밖으로 튀어나온 삼각 실루엣(돌출 ∝ σ·noseScale).
- 입(τ100): 정면 입술 → σ→1 옆에서 본 입술(가장자리로 튀어나온 두 겹). 세로 크기 ∝ jaw(시간차 없이 즉시), 안쪽 네이비.
- 눈(τ40, 위치에만): **화면 고정 ID `eyeL`/`eyeR`**. 옆모습 쪽 눈은 끝까지 정면 아몬드(홍채 포함) → |t|=1에서 정면 눈 1개(피카소 시그니처). 반대쪽(정면 반쪽) 눈은 σ ∈ [0.75, 1]에서 **연속적으로** 축소·소거.
- 귀(τ250, 주황): σ≈0 양옆 작게 → 회전 시 뒤통수 쪽 귀가 분할선 근처 안쪽으로 이동하며 최대 1.6배, 반대쪽 귀는 줄어 숨음.
- 색: 이동하는 분할선 기준 **화면 왼쪽 영역 = 따뜻한 계열(빨강 바탕 + 분홍 뺨 + 주황 관자놀이)**, **오른쪽 영역 = 차가운 계열(연파랑 바탕 + 네이비 그림자, 작은 분홍 포인트 허용)**. t 부호가 바뀌어도 색이 튀지 않음. 차가운 반쪽 뒤 배경은 코발트로 대비, 흰 윤곽선으로 분리.

### 4.3 끄덕임(p)·갸웃(r)·거리(k)·표정
- p: 세로 재매핑 — 눈높이 기준선 m=0.12·p 이동(숙이면 이마 커지고 아래쪽 압축, 반대도 동일). 추가로 눈 +0.05·p, 입 +0.10·p.
- r: 조각마다 θᵢ = r·rollRange·cᵢ, cᵢ = 1 + rollSpread·(2·hash(id)−1) ∈ [0.6,1.4]. 피벗 C. 목·어깨 0.2배.
- k: noseScale = 1 + 0.8·k·distortion (≤1.8), eyeSpacing = 1 + 0.4·k·distortion (≤1.4).
- 깜빡임: `blinkL/R ≥ 0.5` → 그 화면 눈은 곡선 한 줄. **깜빡임·jaw에는 부품 시간차를 걸지 않는다**(즉시).

### 4.4 부품별 시간차 (lag.js)
- 부품마다 (t,p,r,k)의 지수 평활 사본: `x += (target−x)·(1−exp(−dt/τ_eff))`, τ=0 → 즉시.
- τ: 윤곽·분할선 0 / 눈 40 / 입 100 / 코 150 / 귀·머리카락 250 ms (× lagScale).
- **정지 후 가속 수렴**(`LAG_SETTLE`): τ=0 목표의 속도 `max(|Δt|,|Δp|,|Δr|,|Δk|)/s` < 0.5 이면 정지. 정지 경과에 따라 `τ_eff = τ·lagScale·lerp(1, 0.3, smoothstep(0,120ms,stillMs))`. 움직이는 동안은 PRD τ 그대로 어긋나고, 멈추면 0.5초 안에 잔차 < 5%.
- 미감지 확정 시 부품 상태 고정(마지막 자세 그대로 사라짐). L=0에서 재등장하면 부품 상태를 현재 신호로 즉시 맞춤.

### 4.5 붓터치 (brush.js, noise.js)
- `brushPoly(ctx, pts, color, o)`: 둘레 18~30px 간격 재샘플 → 법선 방향 값 노이즈 변위(둘레 따라 부드럽게) → `strokeLayers`겹 반투명, 누적 불투명도 ≈ 0.92 (겹당 α = 1−0.08^(1/L)).
- `brushLine(ctx, pts, color, wMin, wMax, o)`: Chaikin 평활 → 리본 폴리곤, 폭 4~10px, 양 끝 테이퍼.
- `brushBlob(ctx, cx, cy, rx, ry, rot, color, o)`: 반지름 노이즈 타원.
- 스톱모션: `epoch = floor(now/1000·jitterFps)`, 시드 = hash(epoch, strokeId). 시드가 바뀔 때만 모양 변화, 위치·크기·변형은 매 프레임. 진폭 `jitterAmp` px.
- 금지: 매끈한 그라데이션, 완벽한 원, 자로 그은 직선, 검정 윤곽선.

### 4.6 배경·머리카락·목·어깨·흘러내림
- 배경: **항상 불투명 평면 바탕 `#4A8FF0`** + 큰 붓터치 색면 3~5개(코발트·연파랑·하늘). 고정 시드 + 떨림만.
- 머리카락: 둥근 블롭 7개(5~9) 청록·초록·네이비, 머리 위·옆. yaw 시 뒤통수 쪽으로 −t·0.2a(τ250).
- 목: 좁은 세로 색면(피부 + 네이비 그림자). 어깨: 하단을 가로지르는 넓은 2톤 색면.
- 흘러내림: 6~12개(기본 9), 목·어깨 하단에서 아래로, 길이 60~260px·폭 8~22px 테이퍼 + 끝 방울. 고정 시드, 떨림만.

### 4.7 미감지 페이드 (fade.js)
- 연속 레벨 L ∈ [0,1], **시작 L=0**. `effectivePresent = now − lastSeenAt < lostDelayMs(300)` → 짧은 미검출은 무시(페이드 시작 안 함).
- 미감지 확정: L을 −1/1.0s로 하강 + 부품 상태 고정. 검출: +1/0.8s로 상승. 진행 중 반전은 현재 L에서 이어감.
- **고정 스트로크 레지스트리**: 논리 스트로크마다 영구 `id`와 고정 공개 순위 ρ(카테고리 배경 0 → 윤곽 1 → 색면 2 → 이목구비 3, 카테고리 내 고정 순서). 이번 프레임에 생략된 부품도 순위를 예약. 붓터치 겹수는 순위에서 제외. 열린 눈·감긴 눈은 같은 id·ρ.
- 가시도 `vis = clamp((L − ρ·(1−w))/w, 0, 1)`, w≈0.15 → 인은 배경부터, 아웃은 이목구비부터 하나씩. vis는 알파 배수(선 스트로크는 경로 앞부분만 그려 "그려지며 등장" 가능).

### 4.8 성능
- 목표 스트로크 ~80개 × 3겹. 경로는 `drawingContext` 직접 호출, 프레임당 할당 최소화.
- **정적 레이어(배경·흘러내림·어깨) 오프스크린 캐시**: L=1이고 epoch·관련 파라미터가 같으면 재사용, 페이드 중엔 직접 그림.
- `info().strokes`, 그리기 시간은 main.js가 측정해 패널에 표시.

### 4.9 갤러리 (`dev/gallery.html`, Dev B)
- t ∈ {−1, −0.5, 0, 0.5, 1} × 행 {중립, p=+1, p=−1, r=+1, k=1, 깜빡임(L만)+입 벌림} 격자, `snap:true`. 개발 서버 전용.

## 5. 파일 소유권

| 소유 | 파일 |
|---|---|
| 오케스트레이터 | `package.json`, `vite.config.js`, `vitest.config.js`, `scripts/setup-assets.mjs`, `src/contracts.js`, `src/config/params.js`, `PLAN.md`, `.claude/launch.json` |
| Dev A | `index.html`, `src/main.js`, `src/style.css`, `src/tracking/{faceTracker,camera,pose,oneEuro,signals,blink,mock}.js`, `src/render/layout.js`, `src/ui/{panel,store}.js`, `dev/selftest.html`, `dev/selftest.js`, `tests/{pose,oneEuro,signals,blink,faceSelect,layout,store,mock}.test.js` |
| Dev B | `src/render/{portrait,brush,noise,fade,lag,palette,strokes}.js`, `src/render/parts/*.js`, `dev/gallery.html`, `dev/gallery.js`, `tests/{brush,noise,lag,fade,portrait}.test.js` |

## 6. 테스트 전략
- **Dev A 유닛**: pose 왕복(합성 YXZ 행렬, 스케일 포함, 특이점), 거울 부호 규약, clamp; One Euro 수렴·리셋·비활성; 거리(matrix/eyes, 자동 기준·C·멀어짐 0·eyes 각도 보류); 깜빡임 1·2·3프레임 보존과 히스테리시스; 가장 큰 얼굴; cover 크롭 수치; store 병합·검증·손상 JSON·초기화; mock 타임라인 범위.
- **Dev B 유닛**: brush 결정성(같은 epoch 동일, 다른 epoch 다름, NaN 없음); lag(τ=0 즉시, lagScale=0, **빠른 회전 후 정지 → 0.5초 내 모든 부품 잔차 < 5%**); fade(시작 L=0, 300ms 무시, 1.0s/0.8s, 중간 반전, 순서, 스트로크 수가 바뀌어도 ρ 고정); portrait 불변식(|t|↑ 옆모습 면적 단조 증가·f≈0.5+0.45σ, |t|=1 정면 눈 1개, t=±ε 연속(정점 이동량 작음), +1→−1 전환 중 코 뿌리가 얼굴 안, |t|=1·k=1 NaN 없음·코 ≤1.8·눈 간격 ≤1.4, 깜빡임 임계, jaw 단조).
- 빌드: `npm run build` 성공.
- 브라우저(내장, mock): 콘솔 오류 0, 갤러리·mock 스크린샷 시각 확인, FPS·그리기 ms 측정(참고치), selftest 로딩 성공.
- 실기(사용자): 카메라 선택, 부호, 깜빡임 좌우, 거리 방식 비교, 실제 FPS·검출 ms.

## 7. PRD 6.8 완료 기준 매핑

| 기준 | 검증 방법 |
|---|---|
| ±45° 회전 시 옆모습 반쪽 연속 증가, 완전 옆모습에서 정면 눈 1개 | portrait 불변식 + 갤러리 + 실기 |
| 빠른 회전 후 0.5초 내 수렴 | lag 테스트(정지 후 가속) + mock 빠른 회전 구간 |
| 끄덕임·갸웃 반응 | 갤러리 p/r 행 + 테스트 |
| C 후 접근 시 코·눈 간격 과장 | signals 테스트 + 갤러리 k행 + 실기 |
| 눈 감기·입 벌림 | blink·portrait 테스트 + 갤러리 + 실기 |
| 정지 상태에서 초당 ~10회 꿈틀 | brush epoch 테스트 + mock 관찰 |
| 이탈 시 흐려짐, 복귀 시 그려지며 등장 | fade 테스트 + mock 이탈 구간 |
| 패널 숨기면 글자 0 | 코드 점검 + 스크린샷 |
| 30fps 이상(목표 60) | 내장 브라우저 참고 측정 + 실기(검출 ms 포함) |

## 8. 위험과 대응 (Codex 1차 검토 반영)
- **R1 부호 규약**: 레이아웃·식은 독립 유도 2건 일치, 실얼굴 fixture는 없음 → 반전 토글 + 랜드마크 부호 경고 + `?debugpose` + 실기 체크.
- **R2 성능**: 동기 검출이 프레임을 막음 → rAF 밖 태스크 + 최신 프레임 1개 + 정적 레이어 캐시 + 검출/그리기 ms 표시. 부족하면 Worker 검출(후속). `numFaces=1`은 더 빠를 수 있으나 "가장 큰 얼굴" 보장 불가.
- **R3 거리**: 기본 행렬 z 비율, 눈꼬리 방식은 대안(각도 보류). 실기 비교 필요.
- **R4 시간차 vs 0.5초**: 정지 후 가속 수렴으로 PRD τ와 완료 기준을 함께 충족(테스트로 검증).
- **R5 시각 품질**: 스크린샷 기반 반복(최대 2회).
- **R6 블렌드셰이프 좌우**: `swapEyes` + 실기 체크.
- **R7 카메라 선택**: IR·가상 카메라 자동 회피 + 패널 선택.
