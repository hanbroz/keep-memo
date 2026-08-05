# Keep Sticky

Google Keep 메모를 Windows 바탕화면에 포스트잇으로 띄우는 앱.

트레이에 상주하고, 목록 창에서 체크한 메모가 바탕화면에 뜬다. 편집은 Keep 으로
자동 저장되고, 다른 기기(폰, keep.google.com)에서 생긴 변경은 [동기화] 로 가져온다.

## 무엇을 쓸 수 있나

- **포스트잇** — 제목·본문 편집, 12색 배경, 노트별 서체, 압정(항상 위), 되돌리기(Ctrl+Z)
- **체크리스트** — 본문 줄 앞에 `- [ ] ` / `- [x] ` 표식. [체크] 또는 Ctrl+L 로 토글
- **접기** — 화면 가장자리의 44px 책갈피로 접힌다. 눌러서 펼치고, 끌어서 옮긴다
- **목록 창** — 검색, 라벨 필터, 고정/보관 묶음 거르기, 라벨 관리
- **Keep 기능** — 고정(pinned), 보관(archived), 라벨, 휴지통
- **자동 업데이트** — GitHub 릴리즈를 시작 시 한 번, 이후 4시간마다 확인
- **윈도우 시작할 때 실행** — 기본으로 켜져 있다. 트레이 메뉴에서 끌 수 있다

## 구조

```
Electron 메인 프로세스  ──stdio JSON-RPC──▶  Python 사이드카 (gkeepapi)  ──▶  Keep
   창·트레이·상태 저장                          Keep 도메인 로직 전부
```

로컬 HTTP 서버가 아니라 stdio 를 쓴다. 이 채널 뒤에는 계정 전체 권한을 가진
master token 이 있고, stdio 파이프는 부모-자식 전용이라 같은 PC 의 다른 프로세스에
노출되지 않는다.

| 파일 | 책임 |
|---|---|
| `keep_service.py` | JSON-RPC 서버. Keep 도메인 로직 전부 |
| `app/main.js` | 앱 수명주기, 창 생성, 사이드카 감독, IPC 핸들러 |
| `app/sidecar.js` | Python spawn + RPC 클라이언트. Keep 을 모른다 |
| `app/store.js` | `state.json` 영속화 |
| `app/preload.js` | 렌더러에 노출하는 IPC 표면 — 여기 없는 것에는 렌더러가 닿지 못한다 |
| `app/renderer/` | 목록 창(`list.*`), 포스트잇(`note.*`), 순수 로직 모듈들 |
| `scripts/build.js` | 버전 스탬프 산정 + PyInstaller + electron-builder |

`app/renderer/` 의 로직 모듈(`line-model.js`, `note-filter.js`, `url-open.js`,
`font-settings.js` 등)은 `module.exports` 가드가 있어 렌더러의 `<script src>` 로도,
Node 의 `require()` 로도 동작한다 — 그래서 main 프로세스와 테스트가 렌더러와
**같은 한 벌**을 쓴다.

## 지켜야 하는 규칙

이 규칙들은 실제 사고에서 나왔다. 고치기 전에 해당 파일의 주석을 먼저 읽는다.

- **삭제는 `node.trash()` 뿐이다.** `node.delete()`(영구 삭제)로 가는 길은 앱
  어디에도 없다. trash 는 Keep 휴지통으로 보내는 것이라 7일간 복구할 수 있다.
- **master token 은 keyring(Windows 자격 증명 관리자)에만 있다.** 파일·로그·
  저장소·RPC 응답 어디에도 토큰 값을 쓰지 않는다. `state.json` 에 남는 개인정보는
  계정 이메일 하나뿐이다.
- **`DEVICE_ID` 는 계정당 고정이다.** 바꾸면 구글이 매 실행을 새 기기 로그인으로
  보고 차단한다.
- **Keep 에 저장하는 본문은 플레인 텍스트뿐이다.** 서식·위치·크기·접힘은 Keep 에
  해당 필드가 없어 `state.json` 에만 산다.
- **모든 창은 `contextIsolation: true`, `nodeIntegration: false`.** 렌더러는
  `preload.js` 가 노출한 함수만 부른다.
- **렌더러의 검사는 검사가 아니다.** 렌더러는 신뢰 경계의 바깥쪽이다 — 밖으로
  나가는 주소(`sanitizeUrl`), 노트 patch(`note-patch.js`), 체크리스트 항목은
  전부 main 이 다시 검증하고, 사이드카가 한 번 더 본다.
- **Keep 을 건드리는 IPC 핸들러는 던지지 않고 `{ ok, message, code }` 로 돌려준다.**
  `ipcMain.handle` 이 던지면 `err.code` 가 IPC 경계를 못 건너와 렌더러가
  `AUTH_REQUIRED` 를 다른 실패와 구별할 수 없다.

## 개발

```bash
npm install
npm start                    # Electron 실행 (시스템 python 으로 사이드카 구동)
npm test                     # Node 테스트 (node --test)
python -m pytest tests/ -q   # 사이드카 테스트
```

최초 실행에는 계정 이메일을 묻고, 이어서 구글 로그인 창(`EmbeddedSetup`)이 뜬다.
이후에는 `state.json` 의 이메일과 keyring 의 토큰으로 조용히 시작한다.

내장 로그인이 토큰을 얻지 못하면 — 창을 닫았거나, 5분이 지났거나, 1회용 토큰이
교환 전에 만료됐거나, **구글이 `EmbeddedSetup` 을 막았거나** — 수동 붙여넣기
창으로 넘어간다(설계 문서 §8.1 의 폴백). 사용자가 개발자도구에서 직접 복사한
`oauth_token` 을 받는 창이고, UX 는 나쁘지만 확실히 동작한다. 구글은 2023-07-24
부터 임베디드 웹뷰의 OAuth 인가 요청을 차단하고 있어 `EmbeddedSetup` 도 언제든
같은 길을 갈 수 있는데, 그날 이 폴백이 없으면 모든 사용자가 "인증 실패 → 종료"
를 반복하며 빠져나올 길이 없다.

토큰 교환 통로(`auth:manualToken`)는 **그 창이 떠 있는 동안에만** 등록된다.
평소에는 어떤 렌더러도 토큰 교환을 부를 수 없다.

개발 실행에는 빌드 스탬프가 없다. 그래서 창 제목이 `Keep 메모 - 개발 중` 이고
업데이트 확인은 아무것도 하지 않는다 — 릴리즈본이 개발 중인 코드를 덮어쓰지
않게 하기 위해서다.

## 빌드와 릴리즈

```bash
npm run dist                 # dist/KeepSticky-yyyy.MM.dd.HH.mm.exe
run.bat                      # dist/ 에서 가장 최신 빌드를 실행
```

**버전은 손으로 올리지 않는다.** `scripts/build.js` 가 git 이 추적하는 소스
(`app/**`, `keep_service.py`, `keep_probe.py`, `package.json`, `keep_service.spec`)
중 가장 최근에 수정된 시각을 스탬프로 쓴다. 그 값이 파일명, Windows FileVersion,
`package.json` 의 `version` 과 `buildStamp` 로 한꺼번에 들어간다. 사이드카
(`dist-py/keep_service.exe`)가 소스보다 오래됐으면 PyInstaller 로 먼저 다시 굽는다.

릴리즈:

```bash
STAMP=2026.08.05.16.52       # 빌드 로그가 찍은 스탬프
gh release create "v$STAMP" "dist/KeepSticky-$STAMP.exe" --title "ver. $STAMP"
```

앱은 `app/update-check.js` 의 규칙으로 이 릴리즈를 찾는다: 태그는
`v` + `yyyy.MM.dd.HH.mm` 이어야 하고, 첨부 파일 이름은 `KeepSticky-*.exe` 여야
하며, draft/prerelease 는 무시된다. **셋 중 하나라도 어긋나면 사용자에게
업데이트가 영영 보이지 않는다.**

빌드는 조용히 실패할 수 있다(관측된 사례: `0xC0000142`). 반드시 포그라운드로
돌려 종료 코드를 확인하고, 산출물 안에 그 변경이 실제로 들어갔는지 본다:

```bash
# **반드시 임시 디렉터리에서.** extract-file 은 꺼낸 파일을 cwd 에 basename 으로
# 떨구므로, 저장소 루트에서 돌리면 진짜 package.json 을 덮어쓴다.
mkdir -p /tmp/asar-check && cd /tmp/asar-check
npx asar extract-file "$OLDPWD/dist/win-unpacked/resources/app.asar" package.json
grep buildStamp package.json
```

## 윈도우 시작할 때 실행

트레이에 상주하는 메모 앱이라 기본으로 켜져 있다. 끄는 길은 트레이 메뉴의
[윈도우 시작할 때 실행] 체크 상자이고, 그 뜻은 `state.json` 의 `autoLaunch` 에
남는다.

거는 경로가 이 기능의 전부다. **`process.execPath` 를 걸면 안 된다** — 포터블
exe 에서 그것은 `%TEMP%` 밑의 압축 해제본이라 다음 부팅에는 이미 지워져 있고,
오류 하나 없이 조용히 아무 일도 일어나지 않는다. 걸어야 하는 것은 사용자가 두 번
클릭한 원본 exe, 즉 `PORTABLE_EXECUTABLE_FILE` 이다.

**뜰 때마다 다시 건다.** exe 이름에 빌드 시각이 들어 있고 자동 업데이트는 새
exe 를 옆에 받아 그것으로 재시작하므로, 한 번 걸고 끝내면 업데이트한 뒤에도
재부팅 때마다 옛 버전이 뜬다 — 옛 파일이 남아 있어 실패조차 하지 않는다. 다시
거는 것이 곧 고치는 것이고, 레지스트리 값 이름은 빌드마다 같아서 항목이 쌓이지
않는다. (Electron 문서가 Squirrel 에 권하는 "버전 무관한 stub 경로" 해법은
포터블 빌드에 쓸 수 없다 — 이름이 고정된 실행 파일이 없다.)

개발 실행(`npm start`)에서는 **아무것도 건드리지 않는다.** 켜지도 않고 —
걸릴 경로가 `node_modules` 안의 `electron.exe` 라 재부팅마다 빈 창이 뜬다 —
끄지도 않는다. 개발 실행 한 번이 사용자가 켜 둔 설정을 지우면 안 된다.

판단은 `app/auto-launch.js` 의 순수 함수에 있고 테스트가 붙어 있다.

## 상태 파일

`%APPDATA%/keep-sticky/state.json` — 노트별 위치·크기·접힘·서체·압정·책갈피 자리,
목록 창의 마지막 자리, 전역 서체 설정, 시작 프로그램 등록 여부(`autoLaunch`),
계정 이메일. 지우면 초기 상태로 돌아가고
(메모 자체는 Keep 에 있으므로 잃지 않는다) 다음 실행에서 이메일을 다시 묻는다.

## 배경

- 공식 Keep API(`keep.googleapis.com`)는 **Workspace 전용**이라 개인 계정에서 쓸 수
  없다. 그래서 비공식 `gkeepapi` 를 쓴다. 이 결정을 다시 검토할 필요는 없다 —
  `docs/superpowers/specs/2026-07-30-keep-sticky-notes-design.md` 에 근거가 있다.
- 앱 비밀번호 → master token 경로는 구글이 막았다. `EmbeddedSetup` 쿠키를
  `gpsoauth.exchange_token` 으로 교환하는 것이 **유일하게 동작하는 인증 경로**다.
- Keep 의 노트는 `Note` **이거나** `List` 이고 둘 사이에 변환 경로가 없다. 그래서
  이 앱이 만드는 메모는 언제나 text 노트이고, 체크리스트는 본문 텍스트 안의
  규약이다(`app/renderer/line-model.js`). 폰에서 만든 진짜 List 노트도 열어서 쓸 수
  있지만 줄을 더하거나 지울 수는 없다.

설계 문서와 Phase 1 계획은 `docs/superpowers/` 에 있다. 둘 다 2026-07-30 시점의
기록이므로, 현재 동작의 근거는 언제나 코드와 그 주석이 우선이다.
