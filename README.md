# Picasso Me

**English** · [한국어](#한국어)

A web app for filming yourself: it turns your face on the webcam into a live, Picasso-style cubist portrait. Turn your head and the frontal face and the profile merge into one face. Requirements are in [PRD.md](PRD.md) and the design is in [PLAN.md](PLAN.md) (both in Korean).

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 in Chrome and allow camera access.

- The face model is downloaded once from the internet (automatically by `npm run setup` or `npm run dev`). After that the app runs offline.
- Video is processed only inside the browser and is never saved or sent anywhere. Requests to the p5 translation CDN and MediaPipe usage statistics are blocked, both on the main thread and in the detection worker.

## Shortcuts

| Key | Action |
|---|---|
| `H` | Open/close the control panel (closed at start) |
| `C` | Save the current distance as the reference distance |
| `F` | Fullscreen |

Shortcuts also work while a Korean input method is active. The cursor hides after 2 seconds without mouse movement.

## URL options (development and checks)

| Address | Purpose |
|---|---|
| `/?mock` | Play a demo timeline without a camera. Add `&at=seconds` to start partway |
| `/?mock=static&t=0.8&p=0&r=0&k=0&bl=0&br=0&jaw=0&face=1` | Freeze a fixed pose |
| `/?detector=main` | Run face detection on the main thread instead of the worker (for comparison) |
| `/?debugpose` | Print raw pose values (matrix, angles, signs) to the console once per second |
| `/dev/gallery.html` | Grid preview of pose, distance, and expression combinations |
| `/dev/selftest.html` | Check model and WASM loading and detection time (main/worker, GPU/CPU) |

## First on-camera checklist

Check these once in front of the camera and fix anything wrong in the panel. Changed values persist across runs.

1. **Camera**: Is the webcam area at the top in color? If an IR (black-and-white) or virtual camera was picked, choose `LGE Camera` under Panel > 카메라 (Camera).
2. **Turn direction**: When you turn your head left, does the painting turn the same way (as in a mirror)? If not, enable `yaw 반전` (invert yaw) under Panel > 각도 (Angles). Use `pitch 반전` for nodding and `roll 반전` for tilting.
3. **Eyes**: When you close only your left eye, does the painting's left eye on screen close? If not, enable `눈 좌우 바꾸기` (swap eyes).
4. **Distance**: After pressing `C` while facing the camera, does moving closer exaggerate the nose and eye spacing? If just turning your head in place causes distortion, compare the options under Panel > 거리 (Distance) > `거리 계산 방식` (distance method).
5. **Performance**: Under Panel > 정보 (Info), check the FPS (target 60, minimum 30), that `검출 위치` (detector) shows worker, and the detection ms. Below 30 fps, lower 붓터치 (Brush) > `스트로크 겹수` (stroke layers) first.
6. **Clean screen**: With the panel closed (`H`), is there no text at all on the recording screen?
7. **Leave and return**: When you step out of frame, does the painting fade, and when you return, does it reappear as brushstrokes are painted in one by one?

The panel labels are in Korean; the English names above are given in parentheses.

## Tests

```bash
npm test
```

---

# 한국어

[English](#picasso-me) · **한국어**

웹캠에 비친 얼굴을 실시간 피카소풍 입체파 초상으로 그리는 촬영용 웹앱이다. 요구사항은 [PRD.md](PRD.md), 설계는 [PLAN.md](PLAN.md)에 있다.

## 실행

```bash
npm install
npm run dev
```

Chrome에서 http://localhost:5173 에 접속해 카메라를 허용한다.

- 모델 파일은 처음 한 번만 인터넷으로 받는다(`npm run setup`, `npm run dev` 때 자동). 그 뒤로는 오프라인으로 돈다.
- 영상은 브라우저 안에서만 처리하고 저장·전송하지 않는다. p5 번역 CDN과 MediaPipe 사용 통계 요청은 차단한다(메인 스레드와 검출 워커 모두).

## 단축키

| 키 | 동작 |
|---|---|
| `H` | 조절 패널 열기/닫기 (시작할 때는 닫혀 있음) |
| `C` | 지금 거리를 기준 거리로 저장 |
| `F` | 전체화면 |

한글 입력 상태에서도 동작한다. 마우스를 2초 움직이지 않으면 커서가 숨는다.

## URL 옵션 (개발·점검용)

| 주소 | 용도 |
|---|---|
| `/?mock` | 카메라 없이 시연 타임라인 재생. `&at=초`로 중간부터 |
| `/?mock=static&t=0.8&p=0&r=0&k=0&bl=0&br=0&jaw=0&face=1` | 고정 자세로 정지 화면 |
| `/?detector=main` | 워커 대신 메인 스레드에서 얼굴 검출(비교용) |
| `/?debugpose` | 자세 원시값(행렬·각도·부호)을 1초마다 콘솔에 출력 |
| `/dev/gallery.html` | 자세·거리·표정 조합 격자 미리보기 |
| `/dev/selftest.html` | 모델·WASM 로딩과 검출 시간(메인/워커, GPU/CPU) 점검 |

## 첫 실기 체크리스트

카메라 앞에서 한 번 확인하고, 틀린 항목은 패널에서 고친다. 바꾼 값은 다음 실행에도 유지된다.

1. **카메라**: 위쪽 웹캠 영역이 컬러인가? 흑백(IR)이나 가상 카메라가 잡혔다면 패널 > 카메라에서 `LGE Camera`를 고른다.
2. **회전 방향**: 고개를 왼쪽으로 돌리면 그림도 같은 쪽(거울 기준)으로 돌아가는가? 반대면 패널 > 각도 > `yaw 반전`. 끄덕임은 `pitch 반전`, 갸웃은 `roll 반전`으로 고친다.
3. **눈**: 왼쪽 눈만 감으면 그림의 화면 왼쪽 눈이 감기는가? 반대면 `눈 좌우 바꾸기`.
4. **거리**: 정면에서 `C`를 누른 뒤 얼굴을 가까이 대면 코와 눈 간격이 과장되는가? 같은 자리에서 고개만 돌렸을 때 왜곡이 생기면 패널 > 거리 > `거리 계산 방식`을 바꿔 비교한다.
5. **성능**: 패널 > 정보에서 FPS(목표 60, 최소 30), `검출 위치`가 worker인지, 검출 ms를 본다. 30fps 아래면 붓터치 > `스트로크 겹수`부터 줄인다.
6. **화면 정리**: `H`로 패널을 닫으면 촬영 화면에 글자가 하나도 없는가?
7. **이탈·재등장**: 화면 밖으로 나가면 그림이 흐려지고, 돌아오면 붓터치가 차례로 그려지며 나타나는가?

## 테스트

```bash
npm test
```
