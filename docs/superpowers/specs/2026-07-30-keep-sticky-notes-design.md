# Google Keep 연동 바탕화면 포스트잇 — 설계 (Phase 1)

작성일: 2026-07-30
상태: 승인됨

## 1. 목적

개인 Google 계정(`@gmail.com`)의 Google Keep 메모를 Windows 바탕화면에 포스트잇으로 띄우고, 양방향으로 동기화하는 데스크톱 앱. Windows 우선, 기능 확정 후 macOS 이식.

## 2. 사전 검증 결과 (완료)

| 항목 | 결과 | 근거 |
|---|---|---|
| 공식 Google Keep API | **개인 계정 사용 불가** | `keep.googleapis.com`은 Workspace 전용. 인증이 도메인 전체 위임 서비스 계정 또는 관리자 승인 OAuth 클라이언트만 지원 |
| 비공식 `gkeepapi` 0.17.1 | **동작 확인** | 실계정에서 메모 71건 조회 성공 |
| 앱 비밀번호 → master token | **차단됨** | 2FA 활성 + 정상 16자 앱 비밀번호로도 `BadAuthentication`. 이 계정에 대해 구글이 `perform_master_login`을 막음 |
| `EmbeddedSetup` 쿠키 → master token | **동작 확인** | `gpsoauth.exchange_token`으로 교환 성공. 이것이 **유일하게 동작하는 인증 경로** |

인증 경로는 `EmbeddedSetup` 쿠키 교환으로 확정한다. 앱 비밀번호 경로는 폐기한다.

## 3. Keep 데이터 모델 제약 (gkeepapi 0.17.1 소스 직접 확인)

| 요구사항 | Keep 지원 | 근거 |
|---|---|---|
| 배경 색상 | **12색 고정** | `ColorValue` = White, Red, Orange, Yellow, Green, Teal, Blue, DarkBlue, Purple, Pink, Brown, Gray |
| 체크리스트 | 지원 | `NodeType.List` + `ListItem`, checked 상태 동기화됨 |
| 항상 고정 | 지원 | `pinned` |
| 본문 | **플레인 텍스트만** | `TopLevelNode.text` |
| 폰트 종류·크기·색상·굵게·취소선 | **불가** | gkeepapi 소스 전체에 `bold` / `italic` / `strikethrough` / `fontSize` / `textStyle` 심볼 0건. Keep 노드 모델에 서식 개념이 없음 |
| 이미지 업로드 | **비공식** | `__UNSTABLE_API_uploadMedia` — private + UNSTABLE 명시. 읽기(`getMediaLink`)는 정상 |
| 메모지 위치·크기·접힘 상태 | **불가** | Keep에 해당 필드 없음 |
| 실시간 push | **불가** | Keep에 webhook 없음. 주기적 폴링만 가능 |

추가 제약: 노트는 `Note` **또는** `List`이며 한 노트 안에서 텍스트와 체크리스트를 섞을 수 없다.

## 4. 확정된 설계 결정

### D1. 서식은 로컬 전용
Keep에는 순수 텍스트만 저장한다. 폰트·굵기·글자색·취소선·위치·크기·접힘 상태는 로컬에만 보관한다.

**근거:** Keep 노드 모델에 서식 필드가 없다. 마크다운 기호로 인코딩하는 대안은 폰 Keep 앱에서 `**` 기호가 그대로 보이고, 거기서 편집하면 서식이 깨지며 복구 경로가 없다.

**결과:** 다른 기기의 Keep 앱에서는 서식 없는 순수 텍스트로 보인다. 배경색만 12색 범위에서 동기화된다.

### D2. Phase 1은 얇은 수직 슬라이스
메모 한 개를 로그인 → 목록 → 포스트잇 표시 → 편집 → Keep 저장까지 전 구간 관통한다. 꾸미기 기능은 이후 단계로 미룬다.

**근거:** 미검증 위험 3개(§7)가 남아 있고, 그중 하나라도 막히면 설계가 통째로 바뀐다. 특히 내장 로그인이 막히면 먼저 만든 UI를 상당 부분 다시 짜야 한다.

### D3. Electron(UI) + Python 사이드카(Keep 통신)
Keep 통신 계층은 Python `gkeepapi`로 고정. UI는 Electron.

**근거:** JS/Node 진영에 성숙한 Keep 클라이언트가 없다(`gkeepapi-node`는 일부 함수만 구현). Python이 유일한 선택지다. UI로 Electron을 택한 이유는 세 가지다.
1. 이 프로젝트 최대 위험인 내장 로그인에서 `session.cookies.get()`과 User-Agent 조작을 모두 쓸 수 있다
2. 포스트잇의 시각 요구(둥근 모서리, 그림자, 반투명, 책갈피 슬라이드)는 CSS가 압도적으로 유리하다
3. 리치 텍스트 편집이 `contenteditable`로 대부분 해결된다

Tauri는 Windows에서 WebView2 쿠키 접근이 제한적이라 최대 위험 지점을 가장 어렵게 만들어 탈락. PySide6는 내장 로그인을 위해 QtWebEngine을 넣는 순간 결국 Chromium을 품게 되어 크기 이점이 사라지고, 리치 텍스트 툴바를 직접 구현해야 해서 탈락.

**비용:** 배포 크기 약 200MB, 두 언어, IPC 필요.

### D4. 닫기와 삭제를 분리
포스트잇의 `X`는 바탕화면에서 내리기만 한다. Keep 메모는 그대로 남는다. 삭제는 우클릭 메뉴 → 확인 대화상자 → `trash()`(Keep 휴지통, 7일 복구 가능)로만 가능하다. `delete()`(영구 삭제)는 호출하지 않는다.

**근거:** 요구사항의 "항목을 선택하지 않을 수 있다"가 성립하려면 내림이 삭제가 아니어야 한다. 되돌릴 수 없는 동작을 되돌릴 수 있는 동작과 같은 버튼에 두면 화면 정리하려다 폰의 메모까지 날린다.

## 5. Phase 1 범위

### 포함
- 최초 실행 시 내장 로그인 창 → master token 획득 → OS 자격증명 저장소(keyring) 보관
- 메모 목록 조회 (최근 수정순, 전체)
- 목록에서 선택 → 바탕화면 포스트잇 표시 (노란 배경, 테두리 없음, frameless, 항상 위, 드래그 이동)
- 포스트잇 본문 편집 → Keep 반영
- 새 메모 `+` → Keep에 노트 생성
- `X` = 내리기 / 우클릭 → 삭제(Keep 휴지통)
- 앱 재시작 시 띄워둔 포스트잇 복원 (위치 포함)

### 제외 (Phase 2 이후)
접기/책갈피, 서식 툴바, 체크리스트, 이미지 첨부, 색상 변경, 드래그 리사이즈, 트레이 아이콘, 시작 시 실행, 멀티모니터 설정, macOS.

## 6. 아키텍처

```
┌─ Electron 메인 프로세스 (Node) ───────────────┐
│  창 관리 · 로컬 상태 · 사이드카 감독            │
└──────────────┬────────────────────────────────┘
               │ JSON-RPC over stdio (줄 단위 JSON)
┌──────────────▼────────────────────────────────┐
│  Python 사이드카 keep_service.py               │
│  gkeepapi 인증/동기화 · keyring 토큰 보관       │
└───────────────────────────────────────────────┘
```

**stdio를 쓰는 이유:** 로컬 HTTP 서버는 포트 충돌이 생기고, 같은 PC의 다른 프로세스가 그 포트로 접근할 수 있다. 그 뒤에는 계정 전체 권한을 가진 master token이 있다. stdio 파이프는 부모-자식 전용이라 그 노출면 자체가 없다.

### 컴포넌트

**Python**
| 파일 | 책임 | 의존 |
|---|---|---|
| `keep_service.py` | JSON-RPC 루프. `auth_status` / `exchange_cookie` / `list_notes` / `create_note` / `update_note` / `trash_note` / `sync` | gkeepapi, gpsoauth, keyring |
| `keep_probe.py` (기존) | 개발용 CLI. 사이드카 없이 Keep을 직접 찔러보는 디버깅 경로로 유지 | 동일 |

**Electron**
| 파일 | 책임 |
|---|---|
| `main.js` | 앱 수명주기, 창 생성, 사이드카 감독 |
| `sidecar.js` | Python spawn + RPC 클라이언트 (요청/응답 매칭, 타임아웃) |
| `login.js` | EmbeddedSetup 창 + 쿠키 추출 + 수동 폴백 |
| `store.js` | 로컬 상태 영속화 |
| `preload.js` | 렌더러에 노출할 IPC 표면만 정의 (`contextBridge`) |
| `renderer/list.html` | 메모 목록 창 |
| `renderer/note.html` | 포스트잇 한 장 |

각 파일은 하나의 책임만 갖는다. `sidecar.js`는 RPC 배관만 알고 Keep 도메인을 모른다. `login.js`는 토큰 획득만 알고 노트를 모른다.

**렌더러 보안:** 모든 창은 `contextIsolation: true`, `nodeIntegration: false`로 생성하고, 렌더러는 `preload.js`가 `contextBridge`로 노출한 함수만 호출한다. 포스트잇 본문은 Keep에서 온 외부 데이터이고 Phase 3에서 리치 텍스트(HTML)를 다루게 되므로, 렌더러가 Node API에 닿는 경로를 처음부터 막아둔다.

**앱 이름:** 잠정 `keep-sticky`. 경로·패키지명에만 쓰이며 확정 시 일괄 변경한다.

**Python 번들링:** PyInstaller로 `keep_service.py`를 단일 실행파일로 만들어 `electron-builder`의 `extraResources`에 넣는다. 사용자 PC에 Python 설치를 요구하지 않는다.

## 7. 미검증 위험 (Phase 1이 답을 내야 할 것)

| # | 위험 | 막혔을 때의 영향 | 완화책 |
|---|---|---|---|
| R1 | 구글이 내장 웹뷰 로그인을 차단 (`disallowed_useragent`) | 로그인 UX 전면 재설계 | 수동 붙여넣기 폴백을 처음부터 함께 구현 |
| R2 | master token 수명이 짧음 | 재로그인이 앱의 상시 문제가 됨 | 토큰 무효 감지 → 편집분 로컬 보관 후 재로그인 유도 |
| R3 | 쓰기(생성/수정/삭제)가 Keep에 반영되지 않음 | 프로젝트 전제가 무너짐 | `keep_probe.py roundtrip`으로 **설계 승인 직후 최우선 검증** |

R1 보충: 구글은 2023-07-24부터 임베디드 웹뷰의 OAuth 2.0 인가 엔드포인트 요청을 차단한다. 다만 `EmbeddedSetup`은 안드로이드 기기 설정용 웹뷰 전용 페이지로 성격이 다르므로 차단 대상인지는 실측해야 한다.

R1 보충 2: 이 흐름은 "시스템 브라우저로 열기" 회피책을 쓸 수 없다. 일반 OAuth는 콜백 URL로 결과가 돌아오지만 `EmbeddedSetup`은 리다이렉트가 없고 결과가 쿠키로만 남는다. 사용자의 크롬에 심긴 쿠키를 앱이 읽을 방법은 없으므로, 반드시 앱이 띄운 창이어야 한다.

## 8. 데이터 흐름

### 8.1 로그인
1. keyring에 토큰 없음 → `login.js`가 `BrowserWindow`로 `https://accounts.google.com/EmbeddedSetup` 로드
2. 사용자가 로그인 후 "동의" 클릭 (페이지는 무한 로딩 상태가 되며 이것이 정상)
3. `session.cookies.get({name: 'oauth_token'})`을 폴링하여 감시
4. 값이 잡히면 **즉시** 사이드카에 `exchange_cookie` 요청 (토큰은 1회용, 약 60초 만료)
5. master token을 keyring에 저장하고 창을 닫는다

**폴백:** 3번에서 쿠키를 못 잡거나 2번이 구글에 차단되면 수동 붙여넣기 창으로 전환한다. 사용자가 직접 DevTools에서 쿠키를 복사해 넣는 형태로, UX는 나쁘지만 확실히 동작한다.

### 8.2 편집 저장
1. 포스트잇에서 텍스트 변경 → 1.5초 디바운스
2. 렌더러 → 메인 → 사이드카 `update_note(id, text)`
3. 사이드카: `node.text = text` → `keep.sync()`
4. **sync 후 서버가 돌려준 text를 응답에 포함**
5. 메인이 보낸 것과 다르면 → 포스트잇에 "다른 기기에서 수정됨" 배지 표시 + 내 버전을 `state.json`의 `conflictBackup`에 보관 (§8.3)

4~5번이 필요한 이유: `gkeepapi._sync_notes()`는 dirty 노드와 마지막으로 본 버전을 함께 서버에 올리고, 서버 판정 결과를 `node.load(raw)`로 **로컬에 통째로 덮어쓴다.** 라이브러리에 충돌 감지 훅이 없으므로 충돌은 우리 레이어에서 사후 비교로만 감지할 수 있다.

### 8.3 로컬 상태
`%APPDATA%/keep-sticky/state.json`
```json
{
  "notes": {
    "<keep_note_id>": {
      "x": 100, "y": 200, "w": 320, "h": 380,
      "visible": true,
      "conflictBackup": null
    }
  }
}
```

- `w`/`h`는 Phase 1에서 고정 기본값(메모지 크기)으로만 쓰인다. 사용자 리사이즈는 Phase 2에서 열리며, 그때 이 필드가 그대로 쓰인다.
- `conflictBackup`은 §8.2에서 내 편집이 서버에서 밀렸을 때 밀려난 내 텍스트를 담는다. 사용자가 배지를 눌러 확인·복사한 뒤 지우면 `null`로 돌아간다. 조용히 버리지 않기 위한 필드다.
- Phase 3의 서식 정보는 각 노트 객체에 필드를 추가하는 형태로 확장한다.

**보안:** master token은 이 파일에 절대 넣지 않는다. keyring(Windows 자격 증명 관리자 / macOS 키체인)에만 보관한다.

## 9. 에러 처리

| 상황 | 처리 |
|---|---|
| 토큰 만료·무효 | 사이드카가 `AUTH_REQUIRED` 반환 → 로그인 창 재표시. **편집 내용은 로컬에 보관하고 재로그인 후 재시도** |
| 네트워크 끊김 | 편집을 로컬에 저장하고 "대기 중" 표시. 연결 복구 시 자동 재시도 |
| 사이드카 프로세스 종료 | 메인이 감지 → 최대 3회 재시작 → 실패 시 사용자에게 알림 |
| 내 편집이 서버에서 밀림 | 배지 표시 + 로컬 백업 (§8.2) |
| `ResyncRequiredException` | 전체 재동기화 수행 |
| `oauth_token` 만료(60초 초과) | 로그인 창을 처음부터 다시 |

## 10. 테스트

| 대상 | 방식 |
|---|---|
| `keep_service.py` RPC 계약 | gkeepapi를 스텁으로 대체. 실계정 없이 요청/응답 형태와 에러 코드를 검증 |
| 실계정 왕복 | `keep_probe.py`에 `roundtrip` 서브커맨드 추가: 노트 생성 → 읽기 → 수정 → 확인 → `trash()`. **R3를 사람 개입 없이 확인하는 장치.** 설계 승인 직후 최우선으로 만든다 |
| Electron | 창 생성/복원 로직만 단위 테스트. UI 자동화는 Phase 1 제외 |

## 11. Phase 2 이후 백로그

- **Phase 2:** 접기/책갈피(최대 10자, 색상 유지), 펴기 시 기존 크기 복원, 드래그 리사이즈, 트레이 아이콘, 시작 시 실행
- **Phase 3:** 서식 툴바(굵게·취소선·글자색·크기·폰트), 체크리스트, 배경색 12색 선택
- **Phase 4:** 이미지 첨부(`__UNSTABLE_API_uploadMedia` 사용 — 언제든 깨질 수 있는 기능으로 취급), 멀티모니터 책갈피 위치 설정
- **Phase 5:** macOS 빌드

## 12. 운영상 주의

이 인증 방식은 안드로이드 기기가 계정에 등록되는 것과 동일한 흐름이다. 사용 시작 후 며칠 내에 구글에서 "새 기기 로그인 / 의심스러운 활동" 알림이 올 수 있으며, 계정 활동 목록에 낯선 기기가 하나 잡힌다. 정상 동작이다.

**이 기기를 계정에서 삭제하면 master token 이 즉시 무효가 되고 앱은 `BadAuthentication` 으로 실패한다.** 2026-07-30 에 실제로 발생했다. 오전에 정상 동작하던 토큰이 오후에 거부되어 토큰 수명 문제(R2)로 의심했으나, 원인은 사용자가 계정 보안에서 그 "낯선 기기"를 해제한 것이었다. 복구 방법은 §8.1 의 로그인 절차를 다시 수행하는 것뿐이다.

이 때문에 앱은 두 가지를 해야 한다. ① 최초 로그인 완료 시 "계정 기기 목록에 이 앱이 나타나며, 삭제하면 재로그인이 필요하다"고 사용자에게 한 번 알린다. ② `AUTH_REQUIRED` 를 만나면 만료와 해지를 구분하지 말고 동일하게 재로그인 흐름으로 안내한다 — 클라이언트에서 둘은 구분되지 않는다.

gkeepapi는 비공식 클라이언트이므로 구글이 내부 API를 바꾸면 언제든 깨질 수 있다. 깨졌을 때의 대안은 공식 API가 아니라 Google Takeout(개인 계정 지원, 메모별 JSON+HTML, 라벨 보존) 파싱이다.
