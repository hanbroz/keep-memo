# Keep Sticky Phase 1 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개인 Google 계정의 Keep 메모 하나를 로그인부터 바탕화면 포스트잇 표시·편집·Keep 저장까지 전 구간 관통시킨다.

**Architecture:** Electron 메인 프로세스가 UI와 창을 담당하고, Python 사이드카가 `gkeepapi`로 Keep과 통신한다. 둘은 stdio 위의 줄 단위 JSON-RPC로 대화한다. 로컬 HTTP 서버를 쓰지 않는 이유는 계정 전체 권한 토큰이 걸린 채널을 같은 PC의 다른 프로세스에 노출하지 않기 위해서다.

**Tech Stack:** Electron, Node.js 내장 테스트 러너(`node --test`), Python 3.14, `gkeepapi` 0.17.1, `gpsoauth` 2.0.0, `keyring`, `pytest`, PyInstaller, electron-builder

**설계 문서:** `docs/superpowers/specs/2026-07-30-keep-sticky-notes-design.md`

## Global Constraints

이 절의 제약은 모든 태스크에 암묵적으로 포함된다.

- **삭제는 `node.trash()`만 사용한다. `node.delete()`는 어떤 경로로도 호출하지 않는다.** `trash()`는 Keep 휴지통으로 보내 7일간 복구가 가능하고 `delete()`는 영구 삭제다.
- **master token은 keyring에만 존재한다.** 파일·로그·저장소·RPC 응답 어디에도 토큰 값을 쓰지 않는다.
- **`DEVICE_ID = "0123456789abcdef"` 고정.** 계정당 하나로 유지해야 구글이 매 실행을 새 기기 로그인으로 보고 차단하지 않는다.
- **keyring 서비스 이름은 `"keep_probe"`.** 기존 `keep_probe.py`가 이미 이 이름으로 토큰을 저장해 두었으므로 그대로 쓰면 재로그인 없이 개발할 수 있다.
- **Keep에 저장하는 본문은 플레인 텍스트뿐이다.** 서식·위치·크기는 로컬에만 둔다.
- **모든 Electron 창은 `contextIsolation: true`, `nodeIntegration: false`로 생성한다.** 렌더러는 `preload.js`가 `contextBridge`로 노출한 함수만 호출한다.
- **앱 이름은 `keep-sticky`.** 로컬 상태 경로는 `%APPDATA%/keep-sticky/state.json`.
- **RPC 메서드는 화이트리스트로만 디스패치한다.** `getattr(service, method)`를 화이트리스트 검사 없이 호출하면 임의 속성 접근이 열린다.

## File Structure

| 파일 | 책임 |
|---|---|
| `keep_probe.py` (기존) | 개발용 CLI. 사이드카 없이 Keep을 직접 찔러보는 디버깅 경로 |
| `keep_service.py` | JSON-RPC 서버. Keep 도메인 로직 전부 |
| `tests/test_keep_service.py` | 사이드카 RPC 계약 테스트 (gkeepapi 스텁) |
| `app/main.js` | 앱 수명주기, 창 생성, 사이드카 감독 |
| `app/sidecar.js` | Python spawn + RPC 클라이언트. Keep 도메인을 모른다 |
| `app/login.js` | 토큰 획득만. 노트를 모른다 |
| `app/store.js` | 로컬 상태 영속화 |
| `app/preload.js` | 렌더러에 노출할 IPC 표면 |
| `app/renderer/list.html` | 메모 목록 창 |
| `app/renderer/note.html` | 포스트잇 한 장 |
| `app/test/*.test.js` | Node 내장 러너 테스트 |

---

### Task 1: 실계정 왕복 스모크 (위험 R3 검증)

설계 문서 §7의 R3 — "쓰기가 Keep에 실제로 반영되는가"가 미검증이다. 이게 막히면 이후 모든 작업이 헛돈다. 그래서 첫 태스크다.

**Files:**
- Modify: `keep_probe.py` (서브커맨드 추가)

**Interfaces:**
- Consumes: 기존 `keep_probe.py`의 `SERVICE`, `DEVICE_ID`, `fmt_note`
- Produces: `python keep_probe.py roundtrip <email>` — 성공 시 exit 0

- [ ] **Step 1: `roundtrip` 명령 구현**

`keep_probe.py`의 `cmd_selfcheck` 아래에 추가한다.

```python
def cmd_roundtrip(email: str) -> int:
    """실계정 왕복 검증: 생성 -> 읽기 -> 수정 -> 확인 -> 휴지통.

    설계 문서 §7 R3(쓰기가 Keep에 반영되는가)를 사람 개입 없이 확인한다.
    """
    token = keyring.get_password(SERVICE, email)
    if not token:
        print(f"[실패] 저장된 토큰 없음. 먼저 `python keep_probe.py cookie {email}` 실행.",
              file=sys.stderr)
        return 1

    keep = gkeepapi.Keep()
    keep.authenticate(email, token, device_id=DEVICE_ID)

    marker = "keep-sticky roundtrip 검증용 - 자동 삭제됨"
    note = keep.createNote("[TEST] keep-sticky", marker)
    keep.sync()
    note_id = note.id
    print(f"  1. 생성 완료 id={note_id}")

    keep.sync(resync=True)
    fetched = keep.get(note_id)
    assert fetched is not None, "생성한 노트를 다시 읽지 못함"
    assert fetched.text == marker, f"본문 불일치: {fetched.text!r}"
    print("  2. 읽기 확인")

    edited = marker + " / 수정됨"
    fetched.text = edited
    keep.sync()
    keep.sync(resync=True)
    again = keep.get(note_id)
    assert again.text == edited, f"수정이 반영되지 않음: {again.text!r}"
    print("  3. 수정 확인")

    again.trash()
    keep.sync()
    print("  4. 휴지통 이동 완료 (Keep 휴지통에서 7일간 복구 가능)")
    print("[성공] 왕복 검증 통과 - 쓰기가 Keep에 반영됨 (R3 해소)")
    return 0
```

- [ ] **Step 2: 서브커맨드 등록**

`main()`의 파서에 추가한다.

```python
    rt = sub.add_parser("roundtrip", help="실계정 왕복 검증 (생성/수정/삭제)")
    rt.add_argument("email")
```

디스패치에도 추가한다.

```python
    if a.cmd == "roundtrip":
        return cmd_roundtrip(a.email)
```

- [ ] **Step 3: 기존 자동 테스트가 깨지지 않았는지 확인**

Run: `python keep_probe.py selfcheck`
Expected: `[성공] selfcheck 통과 (gkeepapi 0.17.1)`

- [ ] **Step 4: 실계정으로 왕복 검증**

Run: `python keep_probe.py roundtrip you@gmail.com`
Expected: 4단계가 모두 출력되고 `[성공] 왕복 검증 통과`. exit 0.

**실패하면 여기서 멈추고 보고한다.** R3가 살아있으면 이후 태스크의 전제가 무너진다. `AssertionError`가 나면 어느 단계인지, `LoginException`이 나면 토큰 만료인지 구분해 보고한다.

- [ ] **Step 5: 커밋**

```bash
git add keep_probe.py
git commit -m "test: 실계정 왕복 스모크 추가 (R3 검증)"
```

---

### Task 2: keep_service.py — JSON-RPC 뼈대와 인증

**Files:**
- Create: `keep_service.py`
- Create: `tests/test_keep_service.py`
- Create: `requirements-dev.txt`

**Interfaces:**
- Produces:
  - `handle(service, line: str) -> dict` — 한 줄 요청을 처리해 응답 dict 반환
  - `serve(service, stdin, stdout) -> None` — 줄 단위 루프
  - `KeepService(keep_factory=gkeepapi.Keep)` — `keep_factory`는 테스트 주입용
  - `KeepService.auth_status(email: str) -> {"authenticated": bool}`
  - `KeepService.exchange_cookie(email: str, oauth_token: str) -> {"ok": True}`
  - 에러 코드: `BAD_REQUEST`, `UNKNOWN_METHOD`, `AUTH_REQUIRED`, `NOT_FOUND`, `INTERNAL`

- [ ] **Step 1: 개발 의존성 파일 생성**

`requirements-dev.txt`:

```
gkeepapi==0.17.1
gpsoauth==2.0.0
keyring
pytest
```

Run: `python -m pip install -r requirements-dev.txt`

- [ ] **Step 2: 실패하는 테스트 작성**

`tests/test_keep_service.py`:

```python
import json

import pytest

import keep_service as ks


class FakeKeep:
    """gkeepapi.Keep 대역. 실계정 없이 RPC 계약을 검증한다."""

    def __init__(self):
        self.authenticated = False
        self.synced = 0

    def authenticate(self, email, master_token, state=None, sync=True, device_id=None):
        if master_token != "good-token":
            raise RuntimeError("BadAuthentication")
        self.authenticated = True

    def sync(self, resync=False):
        self.synced += 1


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(ks.keyring, "get_password", lambda s, e: None)
    monkeypatch.setattr(ks.keyring, "set_password", lambda s, e, v: None)
    return ks.KeepService(keep_factory=FakeKeep)


def test_unknown_method_is_rejected(service):
    res = ks.handle(service, json.dumps({"id": 1, "method": "nope", "params": {}}))
    assert res["error"]["code"] == "UNKNOWN_METHOD"


def test_private_attribute_is_not_dispatchable(service):
    """화이트리스트가 없으면 임의 속성 접근이 열린다."""
    res = ks.handle(service, json.dumps({"id": 1, "method": "_keep_factory", "params": {}}))
    assert res["error"]["code"] == "UNKNOWN_METHOD"


def test_malformed_json_returns_bad_request(service):
    res = ks.handle(service, "{not json")
    assert res["error"]["code"] == "BAD_REQUEST"
    assert res["id"] is None


def test_auth_status_false_without_token(service):
    res = ks.handle(service, json.dumps({"id": 7, "method": "auth_status",
                                         "params": {"email": "a@b.com"}}))
    assert res["id"] == 7
    assert res["result"] == {"authenticated": False}


def test_auth_status_true_with_stored_token(service, monkeypatch):
    monkeypatch.setattr(ks.keyring, "get_password", lambda s, e: "good-token")
    res = ks.handle(service, json.dumps({"id": 8, "method": "auth_status",
                                         "params": {"email": "a@b.com"}}))
    assert res["result"] == {"authenticated": True}


def test_exchange_cookie_stores_token(service, monkeypatch):
    stored = {}
    monkeypatch.setattr(ks.keyring, "set_password",
                        lambda s, e, v: stored.update({"service": s, "email": e, "token": v}))
    monkeypatch.setattr(ks.gpsoauth, "exchange_token",
                        lambda email, token, device_id: {"Token": "aas_et/xyz"})
    res = ks.handle(service, json.dumps({"id": 9, "method": "exchange_cookie",
                                         "params": {"email": "a@b.com",
                                                    "oauth_token": "oauth2_4/abc"}}))
    assert res["result"] == {"ok": True}
    assert stored["token"] == "aas_et/xyz"
    assert stored["service"] == "keep_probe"


def test_exchange_cookie_failure_is_auth_required(service, monkeypatch):
    monkeypatch.setattr(ks.gpsoauth, "exchange_token",
                        lambda email, token, device_id: {"Error": "BadAuthentication"})
    res = ks.handle(service, json.dumps({"id": 10, "method": "exchange_cookie",
                                         "params": {"email": "a@b.com",
                                                    "oauth_token": "oauth2_4/expired"}}))
    assert res["error"]["code"] == "AUTH_REQUIRED"


def test_token_never_appears_in_response(service, monkeypatch):
    monkeypatch.setattr(ks.keyring, "get_password", lambda s, e: "aas_et/secret")
    res = ks.handle(service, json.dumps({"id": 11, "method": "auth_status",
                                         "params": {"email": "a@b.com"}}))
    assert "aas_et/secret" not in json.dumps(res)
```

- [ ] **Step 3: 테스트를 돌려 실패를 확인**

Run: `python -m pytest tests/test_keep_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'keep_service'`

- [ ] **Step 4: `keep_service.py` 구현**

```python
"""Electron 메인 프로세스와 stdio JSON-RPC 로 통신하는 Keep 서비스.

프로토콜: 한 줄에 JSON 객체 하나.
  요청  {"id": 1, "method": "list_notes", "params": {}}
  응답  {"id": 1, "result": {...}}
        {"id": 1, "error": {"code": "AUTH_REQUIRED", "message": "..."}}

로컬 HTTP 서버 대신 stdio 를 쓰는 이유: 이 채널 뒤에는 계정 전체 권한을 가진
master token 이 있다. stdio 파이프는 부모-자식 전용이라 같은 PC 의 다른
프로세스에 노출되지 않는다.
"""

import json
import sys

import gkeepapi
import gpsoauth
import keyring

SERVICE = "keep_probe"
DEVICE_ID = "0123456789abcdef"

# ponytail: 화이트리스트가 없으면 getattr 로 임의 속성에 접근할 수 있다.
ALLOWED_METHODS = frozenset({
    "auth_status",
    "exchange_cookie",
})


class AuthRequired(Exception):
    """토큰이 없거나 무효하다. Electron 측은 로그인 창을 다시 띄운다."""


class NotFound(Exception):
    """요청한 노트가 없다."""


class KeepService:
    def __init__(self, keep_factory=gkeepapi.Keep):
        self._keep_factory = keep_factory
        self._keep = None
        self._email = None

    # --- 인증 -------------------------------------------------------------

    def auth_status(self, email: str) -> dict:
        return {"authenticated": keyring.get_password(SERVICE, email) is not None}

    def exchange_cookie(self, email: str, oauth_token: str) -> dict:
        res = gpsoauth.exchange_token(email, oauth_token, DEVICE_ID)
        token = res.get("Token")
        if not token:
            raise AuthRequired(
                f"토큰 교환 실패: {res.get('Error')} "
                "(oauth_token 은 1회용이고 약 60초 만에 만료된다)"
            )
        keyring.set_password(SERVICE, email, token)
        self._keep = None  # 다음 호출에서 새 토큰으로 재인증
        return {"ok": True}

    # --- 내부 -------------------------------------------------------------

    def _require_keep(self):
        if self._keep is not None:
            return self._keep
        if self._email is None:
            raise AuthRequired("이메일이 설정되지 않았다. auth_status 를 먼저 호출한다.")
        token = keyring.get_password(SERVICE, self._email)
        if not token:
            raise AuthRequired("저장된 master token 이 없다.")
        keep = self._keep_factory()
        try:
            keep.authenticate(self._email, token, device_id=DEVICE_ID)
        except Exception as exc:
            raise AuthRequired(f"인증 실패: {exc}") from exc
        self._keep = keep
        return keep


def handle(service: KeepService, line: str) -> dict:
    """한 줄 요청을 처리해 응답 dict 를 만든다. 예외를 밖으로 흘리지 않는다."""
    try:
        req = json.loads(line)
    except json.JSONDecodeError as exc:
        return {"id": None, "error": {"code": "BAD_REQUEST", "message": str(exc)}}

    rid = req.get("id")
    method = req.get("method")
    params = req.get("params") or {}

    if method not in ALLOWED_METHODS:
        return {"id": rid, "error": {"code": "UNKNOWN_METHOD", "message": str(method)}}

    try:
        return {"id": rid, "result": getattr(service, method)(**params)}
    except AuthRequired as exc:
        return {"id": rid, "error": {"code": "AUTH_REQUIRED", "message": str(exc)}}
    except NotFound as exc:
        return {"id": rid, "error": {"code": "NOT_FOUND", "message": str(exc)}}
    except TypeError as exc:
        return {"id": rid, "error": {"code": "BAD_REQUEST", "message": str(exc)}}
    except Exception as exc:
        return {"id": rid,
                "error": {"code": "INTERNAL", "message": f"{type(exc).__name__}: {exc}"}}


def serve(service: KeepService, stdin=None, stdout=None) -> None:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        stdout.write(json.dumps(handle(service, line), ensure_ascii=False) + "\n")
        stdout.flush()


if __name__ == "__main__":
    serve(KeepService())
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `python -m pytest tests/test_keep_service.py -v`
Expected: 8개 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add keep_service.py tests/test_keep_service.py requirements-dev.txt
git commit -m "feat: Keep 사이드카 JSON-RPC 뼈대와 인증 메서드"
```

---

### Task 3: keep_service.py — 노트 CRUD와 충돌 감지

**Files:**
- Modify: `keep_service.py`
- Modify: `tests/test_keep_service.py`

**Interfaces:**
- Consumes: Task 2의 `KeepService`, `handle`, `AuthRequired`, `NotFound`, `ALLOWED_METHODS`
- Produces:
  - `set_account(email: str) -> {"ok": True}`
  - `list_notes() -> {"notes": [NoteDTO]}`
  - `create_note(title: str, text: str) -> {"note": NoteDTO}`
  - `update_note(id: str, title=None, text=None) -> {"note": NoteDTO, "conflict": bool, "sentText": str}`
  - `trash_note(id: str) -> {"ok": True}`
  - `NoteDTO = {"id": str, "title": str, "text": str, "color": str, "pinned": bool, "archived": bool, "updated": str}` — `updated`는 ISO 8601 문자열

`conflict`가 `true`면 sync 후 서버가 돌려준 본문이 우리가 보낸 것과 다르다는 뜻이다. `gkeepapi._sync_notes()`는 서버 판정 결과를 `node.load(raw)`로 로컬에 덮어쓰고 충돌 감지 훅을 제공하지 않으므로, 사후 비교가 유일한 감지 수단이다.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/test_keep_service.py` 끝에 추가한다.

```python
class FakeTimestamps:
    def __init__(self):
        import datetime
        self.updated = datetime.datetime(2026, 7, 30, 9, 0, 0)


class FakeColor:
    name = "Yellow"


class FakeNode:
    def __init__(self, node_id="n1", title="", text=""):
        self.id = node_id
        self.title = title
        self.text = text
        self.color = FakeColor()
        self.pinned = False
        self.archived = False
        self.trashed = False
        self.timestamps = FakeTimestamps()

    def trash(self):
        self.trashed = True


class FakeKeepWithNodes(FakeKeep):
    """sync 시 서버가 본문을 덮어쓰는 상황까지 흉내낸다."""

    def __init__(self):
        super().__init__()
        self.nodes = {}
        self.server_override = None

    def createNote(self, title=None, text=None):  # noqa: N802 - gkeepapi 명명 규칙
        node = FakeNode(f"n{len(self.nodes) + 1}", title or "", text or "")
        self.nodes[node.id] = node
        return node

    def get(self, node_id):
        return self.nodes.get(node_id)

    def find(self, **kwargs):
        return iter([n for n in self.nodes.values() if not n.trashed])

    def sync(self, resync=False):
        super().sync(resync)
        if self.server_override is not None:
            for node in self.nodes.values():
                node.text = self.server_override


@pytest.fixture
def account(monkeypatch):
    monkeypatch.setattr(ks.keyring, "get_password", lambda s, e: "good-token")
    svc = ks.KeepService(keep_factory=FakeKeepWithNodes)
    ks.handle(svc, json.dumps({"id": 0, "method": "set_account",
                               "params": {"email": "a@b.com"}}))
    return svc


def _call(svc, method, **params):
    return ks.handle(svc, json.dumps({"id": 1, "method": method, "params": params}))


def test_create_then_list(account):
    _call(account, "create_note", title="제목", text="본문")
    res = _call(account, "list_notes")
    notes = res["result"]["notes"]
    assert len(notes) == 1
    assert notes[0]["title"] == "제목"
    assert notes[0]["text"] == "본문"
    assert notes[0]["color"] == "Yellow"
    assert notes[0]["updated"] == "2026-07-30T09:00:00"


def test_update_without_conflict(account):
    created = _call(account, "create_note", title="t", text="원본")["result"]["note"]
    res = _call(account, "update_note", id=created["id"], text="수정본")["result"]
    assert res["conflict"] is False
    assert res["note"]["text"] == "수정본"


def test_update_detects_conflict_when_server_overrides(account):
    created = _call(account, "create_note", title="t", text="원본")["result"]["note"]
    account._keep.server_override = "폰에서 고친 내용"
    res = _call(account, "update_note", id=created["id"], text="PC에서 고친 내용")["result"]
    assert res["conflict"] is True
    assert res["sentText"] == "PC에서 고친 내용"
    assert res["note"]["text"] == "폰에서 고친 내용"


def test_update_missing_note_is_not_found(account):
    res = _call(account, "update_note", id="없는id", text="x")
    assert res["error"]["code"] == "NOT_FOUND"


def test_trash_removes_from_list(account):
    created = _call(account, "create_note", title="t", text="x")["result"]["note"]
    assert _call(account, "trash_note", id=created["id"])["result"] == {"ok": True}
    assert _call(account, "list_notes")["result"]["notes"] == []


def test_trash_missing_note_is_not_found(account):
    assert _call(account, "trash_note", id="없는id")["error"]["code"] == "NOT_FOUND"
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

Run: `python -m pytest tests/test_keep_service.py -v`
Expected: 새 테스트 6개가 `UNKNOWN_METHOD` 또는 `KeyError`로 FAIL

- [ ] **Step 3: 화이트리스트 확장**

`keep_service.py`의 `ALLOWED_METHODS`를 교체한다.

```python
ALLOWED_METHODS = frozenset({
    "auth_status",
    "exchange_cookie",
    "set_account",
    "list_notes",
    "create_note",
    "update_note",
    "trash_note",
})
```

- [ ] **Step 4: 직렬화 함수 추가**

`keep_service.py`의 `class KeepService` 위에 넣는다.

```python
def _serialize(node) -> dict:
    """Keep 노드를 RPC 로 넘길 수 있는 평평한 dict 로 변환한다.

    서식 정보는 Keep 에 존재하지 않으므로 여기에도 없다. 위치/크기/서식은
    Electron 쪽 state.json 이 노트 id 를 키로 따로 들고 있다.
    """
    return {
        "id": node.id,
        "title": node.title or "",
        "text": node.text or "",
        "color": node.color.name,
        "pinned": bool(node.pinned),
        "archived": bool(node.archived),
        "updated": node.timestamps.updated.isoformat(),
    }
```

- [ ] **Step 5: CRUD 메서드 구현**

`KeepService`의 `exchange_cookie` 아래, `_require_keep` 위에 넣는다.

```python
    # --- 노트 -------------------------------------------------------------

    def set_account(self, email: str) -> dict:
        self._email = email
        self._keep = None
        return {"ok": True}

    def list_notes(self) -> dict:
        keep = self._require_keep()
        notes = [_serialize(n) for n in keep.find()]
        notes.sort(key=lambda n: n["updated"], reverse=True)
        return {"notes": notes}

    def create_note(self, title: str = "", text: str = "") -> dict:
        keep = self._require_keep()
        node = keep.createNote(title, text)
        keep.sync()
        return {"note": _serialize(node)}

    def update_note(self, id: str, title=None, text=None) -> dict:  # noqa: A002
        keep = self._require_keep()
        node = keep.get(id)
        if node is None:
            raise NotFound(id)
        if title is not None:
            node.title = title
        if text is not None:
            node.text = text
        sent_text = node.text or ""

        keep.sync()

        # sync 는 서버 판정 결과를 로컬 노드에 덮어쓴다. 우리가 보낸 것과
        # 다르면 다른 기기의 편집이 이겼다는 뜻이다.
        after = keep.get(id)
        if after is None:
            raise NotFound(id)
        return {
            "note": _serialize(after),
            "conflict": (after.text or "") != sent_text,
            "sentText": sent_text,
        }

    def trash_note(self, id: str) -> dict:  # noqa: A002
        keep = self._require_keep()
        node = keep.get(id)
        if node is None:
            raise NotFound(id)
        node.trash()  # delete() 가 아니다. Keep 휴지통에서 7일간 복구 가능.
        keep.sync()
        return {"ok": True}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `python -m pytest tests/test_keep_service.py -v`
Expected: 14개 전부 PASS

- [ ] **Step 7: 커밋**

```bash
git add keep_service.py tests/test_keep_service.py
git commit -m "feat: 노트 CRUD 와 sync 후 충돌 감지"
```

---

### Task 4: Electron 뼈대와 사이드카 클라이언트

**Files:**
- Create: `package.json`
- Create: `app/sidecar.js`
- Create: `app/test/sidecar.test.js`
- Create: `app/test/fake-sidecar.js`

**Interfaces:**
- Consumes: Task 2~3의 RPC 프로토콜(줄 단위 JSON, `id`/`method`/`params` → `id`/`result`/`error`)
- Produces:
  - `class Sidecar { constructor(command, args, {timeoutMs}) ; start() ; call(method, params) : Promise ; stop() }`
  - 거부되는 Error에는 `code` 속성이 붙는다: 서버 에러 코드 그대로, 또는 `TIMEOUT` / `SIDECAR_DEAD`

- [ ] **Step 1: package.json 생성**

```json
{
  "name": "keep-sticky",
  "version": "0.1.0",
  "description": "Google Keep 연동 바탕화면 포스트잇",
  "main": "app/main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test app/test/"
  },
  "devDependencies": {
    "electron": "^33.0.0"
  }
}
```

Run: `npm install`

- [ ] **Step 2: 가짜 사이드카 작성**

`app/test/fake-sidecar.js` — 실제 Python 없이 프로토콜만 흉내낸다.

```js
'use strict'
// 테스트용 가짜 사이드카. stdin 의 각 줄을 읽어 약속된 응답을 낸다.
const readline = require('node:readline')

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  if (req.method === 'echo') {
    process.stdout.write(JSON.stringify({ id: req.id, result: req.params }) + '\n')
  } else if (req.method === 'boom') {
    process.stdout.write(JSON.stringify({
      id: req.id, error: { code: 'AUTH_REQUIRED', message: '토큰 없음' }
    }) + '\n')
  } else if (req.method === 'silent') {
    // 일부러 응답하지 않는다 -> 타임아웃 경로 검증
  } else if (req.method === 'die') {
    process.exit(3)
  }
})
```

- [ ] **Step 3: 실패하는 테스트 작성**

`app/test/sidecar.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { Sidecar } = require('../sidecar')

const FAKE = path.join(__dirname, 'fake-sidecar.js')

function spawnFake (opts) {
  return new Sidecar(process.execPath, [FAKE], opts).start()
}

test('요청과 응답이 id 로 짝지어진다', async () => {
  const s = spawnFake()
  const [a, b] = await Promise.all([
    s.call('echo', { n: 1 }),
    s.call('echo', { n: 2 })
  ])
  assert.deepStrictEqual([a.n, b.n], [1, 2])
  s.stop()
})

test('서버 에러는 code 가 붙은 Error 로 거부된다', async () => {
  const s = spawnFake()
  await assert.rejects(s.call('boom'), (err) => {
    assert.strictEqual(err.code, 'AUTH_REQUIRED')
    assert.strictEqual(err.message, '토큰 없음')
    return true
  })
  s.stop()
})

test('응답이 없으면 TIMEOUT 으로 거부된다', async () => {
  const s = spawnFake({ timeoutMs: 200 })
  await assert.rejects(s.call('silent'), (err) => err.code === 'TIMEOUT')
  s.stop()
})

test('사이드카가 죽으면 대기 중인 요청이 전부 거부된다', async () => {
  const s = spawnFake({ timeoutMs: 5000 })
  const pending = s.call('silent')
  s.call('die').catch(() => {})
  await assert.rejects(pending, (err) => err.code === 'SIDECAR_DEAD')
})

test('사이드카가 죽으면 최대 3회까지 자동 재시작한다', async () => {
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 3 })
  for (let i = 0; i < 3; i++) {
    s.call('die').catch(() => {})
    await new Promise((r) => setTimeout(r, 120))
  }
  assert.strictEqual(s.restarts, 3)
  // 재시작된 프로세스가 살아 있어야 한다
  assert.deepStrictEqual(await s.call('echo', { ok: 1 }), { ok: 1 })
  s.stop()
})

test('재시작 한도를 넘으면 포기하고 onDead 를 호출한다', async () => {
  let deadCalled = false
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 1, onDead: () => { deadCalled = true } })
  for (let i = 0; i < 2; i++) {
    s.call('die').catch(() => {})
    await new Promise((r) => setTimeout(r, 120))
  }
  assert.strictEqual(deadCalled, true)
})
```

- [ ] **Step 4: 테스트를 돌려 실패를 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../sidecar'`

- [ ] **Step 5: sidecar.js 구현**

```js
'use strict'
const { spawn } = require('node:child_process')
const readline = require('node:readline')

/**
 * Python 사이드카와 줄 단위 JSON-RPC 로 대화한다.
 * 이 클래스는 배관만 안다. Keep 도메인(노트, 라벨, 색상)은 모른다.
 */
class Sidecar {
  constructor (command, args = [], { timeoutMs = 30000, maxRestarts = 3, onDead = null } = {}) {
    this.command = command
    this.args = args
    this.timeoutMs = timeoutMs
    this.maxRestarts = maxRestarts
    this.onDead = onDead
    this.restarts = 0
    this.stopped = false
    this.pending = new Map()
    this.nextId = 1
    this.proc = null
  }

  start () {
    this.proc = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    readline.createInterface({ input: this.proc.stdout })
      .on('line', (line) => this._onLine(line))
    this.proc.on('exit', (code) => this._onExit(`사이드카 종료: ${code}`))
    this.proc.on('error', (err) => this._onExit(err.message))
    return this
  }

  _onExit (message) {
    this._rejectAll('SIDECAR_DEAD', message)
    if (this.stopped) return
    if (this.restarts >= this.maxRestarts) {
      // 계속 죽는다면 재시작해봐야 같은 결과다. 사용자에게 알리고 멈춘다.
      if (this.onDead) this.onDead(message)
      return
    }
    this.restarts++
    this.start()
  }

  _onLine (line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return // 사이드카가 찍은 비-JSON 출력은 무시한다
    }
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) {
      const err = new Error(msg.error.message)
      err.code = msg.error.code
      entry.reject(err)
    } else {
      entry.resolve(msg.result)
    }
  }

  _rejectAll (code, message) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      const err = new Error(message)
      err.code = code
      entry.reject(err)
    }
    this.pending.clear()
  }

  call (method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const err = new Error(`응답 없음: ${method}`)
        err.code = 'TIMEOUT'
        reject(err)
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  stop () {
    this.stopped = true // 의도적 종료는 재시작하지 않는다
    this._rejectAll('SIDECAR_DEAD', '사이드카 정지 요청')
    if (this.proc) this.proc.kill()
  }
}

module.exports = { Sidecar }
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npm test`
Expected: 6개 전부 PASS

- [ ] **Step 7: node_modules 가 커밋되지 않는지 확인 후 커밋**

Run: `git status --short`
Expected: `node_modules/`가 목록에 없다 (`.gitignore`에 이미 있음)

```bash
git add package.json package-lock.json app/sidecar.js app/test/
git commit -m "feat: Electron 사이드카 RPC 클라이언트"
```

---

### Task 5: 내장 로그인과 수동 폴백 (위험 R1 검증)

설계 문서 §7의 R1 — "구글이 내장 웹뷰 로그인을 차단하는가"를 여기서 확인한다.

**Files:**
- Create: `app/login.js`
- Create: `app/test/login.test.js`

**Interfaces:**
- Consumes: 없음 (Electron `session` 객체를 인자로 받는다)
- Produces:
  - `pollCookie(session, {intervalMs, timeoutMs}) -> Promise<string|null>` — `oauth2_4/`로 시작하는 `oauth_token` 쿠키 값, 없으면 `null`
  - `SETUP_URL` — `'https://accounts.google.com/EmbeddedSetup'`
  - `createLoginWindow(BrowserWindow) -> BrowserWindow`

`pollCookie`가 `session`을 인자로 받는 이유는 Electron 없이 테스트하기 위해서다.

- [ ] **Step 1: 실패하는 테스트 작성**

`app/test/login.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { pollCookie } = require('../login')

function fakeSession (sequence) {
  let i = 0
  return { cookies: { get: async () => sequence[Math.min(i++, sequence.length - 1)] } }
}

test('oauth_token 쿠키를 잡으면 값을 반환한다', async () => {
  const session = fakeSession([[], [{ name: 'oauth_token', value: 'oauth2_4/abc' }]])
  const value = await pollCookie(session, { intervalMs: 1, timeoutMs: 1000 })
  assert.strictEqual(value, 'oauth2_4/abc')
})

test('접두사가 다른 쿠키는 무시한다', async () => {
  const session = fakeSession([[{ name: 'oauth_token', value: 'garbage' }]])
  const value = await pollCookie(session, { intervalMs: 1, timeoutMs: 50 })
  assert.strictEqual(value, null)
})

test('시간이 다 되면 null 을 반환한다', async () => {
  const session = fakeSession([[]])
  const value = await pollCookie(session, { intervalMs: 1, timeoutMs: 30 })
  assert.strictEqual(value, null)
})
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../login'`

- [ ] **Step 3: login.js 구현**

```js
'use strict'

const SETUP_URL = 'https://accounts.google.com/EmbeddedSetup'
const COOKIE_NAME = 'oauth_token'
const COOKIE_PREFIX = 'oauth2_4/'

/**
 * EmbeddedSetup 창의 세션에서 oauth_token 쿠키를 감시한다.
 *
 * 이 흐름은 "시스템 브라우저로 열기" 회피책을 쓸 수 없다. 일반 OAuth 는 콜백
 * URL 로 결과가 돌아오지만 EmbeddedSetup 은 리다이렉트가 없고 결과가 쿠키로만
 * 남는다. 사용자의 크롬에 심긴 쿠키를 우리가 읽을 방법은 없으므로 반드시
 * 우리가 띄운 창이어야 한다.
 *
 * 얻은 토큰은 1회용이고 약 60초 만에 만료된다. 호출자는 즉시 교환해야 한다.
 */
async function pollCookie (session, { intervalMs = 500, timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const cookies = await session.cookies.get({ name: COOKIE_NAME })
    const hit = cookies.find((c) => c.value && c.value.startsWith(COOKIE_PREFIX))
    if (hit) return hit.value
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

function createLoginWindow (BrowserWindow) {
  const win = new BrowserWindow({
    width: 520,
    height: 680,
    title: 'Google 계정 연결',
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:login' }
  })
  win.loadURL(SETUP_URL)
  return win
}

module.exports = { pollCookie, createLoginWindow, SETUP_URL, COOKIE_NAME, COOKIE_PREFIX }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: 9개 전부 PASS (Task 4의 6개 + 이번 3개)

- [ ] **Step 5: 수동 폴백 창 추가**

`app/renderer/manual-login.html` — 내장 로그인이 차단됐을 때 쓴다.

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'">
  <title>수동 로그인</title>
  <style>
    body { font-family: 'Malgun Gothic', sans-serif; padding: 24px; word-break: keep-all; }
    ol { line-height: 1.9; padding-left: 20px; }
    input { width: 100%; padding: 8px; font-family: Consolas, monospace; }
    .warn { color: #b45309; font-weight: bold; }
  </style>
</head>
<body>
  <h2>Google 계정 연결 (수동)</h2>
  <p class="warn">oauth_token 은 1회용이고 약 60초 만에 만료됩니다. 5번까지 끝낸 뒤 바로 붙여넣으세요.</p>
  <ol>
    <li>시크릿 창에서 <code>https://accounts.google.com/EmbeddedSetup</code> 접속 후 로그인</li>
    <li>F12 를 눌러 개발자도구를 연다</li>
    <li>"동의" 클릭. 화면이 계속 로딩되는 것은 정상이며 무시한다</li>
    <li>Application → Cookies → https://accounts.google.com</li>
    <li><code>oauth_token</code> 행의 Value 복사 (<code>oauth2_4/</code> 로 시작)</li>
  </ol>
  <input id="token" placeholder="oauth2_4/..." autocomplete="off">
  <p><button id="submit">연결</button> <span id="status"></span></p>
  <script src="manual-login.js"></script>
</body>
</html>
```

`app/renderer/manual-login.js`:

```js
'use strict'
document.getElementById('submit').addEventListener('click', async () => {
  const status = document.getElementById('status')
  const value = document.getElementById('token').value.trim()
  if (!value.startsWith('oauth2_4/')) {
    status.textContent = 'oauth2_4/ 로 시작해야 합니다. 다른 쿠키를 복사했을 수 있습니다.'
    return
  }
  status.textContent = '교환 중...'
  const res = await window.keepSticky.exchangeCookie(value)
  status.textContent = res.ok ? '연결됨' : `실패: ${res.message}`
})
```

- [ ] **Step 6: 실제 구글 차단 여부 확인 (R1 검증)**

`app/main.js`를 임시로 작성해 로그인 창만 띄운다.

```js
'use strict'
const { app, BrowserWindow, session } = require('electron')
const { createLoginWindow, pollCookie } = require('./login')

app.whenReady().then(async () => {
  const win = createLoginWindow(BrowserWindow)
  const value = await pollCookie(session.fromPartition('persist:login'),
                                 { intervalMs: 1000, timeoutMs: 300000 })
  console.log(value ? `쿠키 획득: ${value.slice(0, 16)}...` : '쿠키 획득 실패')
  win.close()
})
```

Run: `npm start`
Expected: 구글 로그인 화면이 뜨고, 로그인 + 동의 후 콘솔에 `쿠키 획득: oauth2_4/...` 출력

**`disallowed_useragent` 또는 "이 브라우저는 안전하지 않을 수 있습니다"가 뜨면 R1이 현실화된 것이다.** 이 경우 멈추고 보고한다. 대응은 두 갈래다: ① `win.webContents.setUserAgent()`로 안드로이드 기기 User-Agent 위장 ② 수동 폴백을 기본 경로로 승격. 어느 쪽을 택할지는 사용자 결정이 필요하다.

- [ ] **Step 7: 커밋**

```bash
git add app/login.js app/test/login.test.js app/renderer/manual-login.html app/renderer/manual-login.js app/main.js
git commit -m "feat: EmbeddedSetup 내장 로그인과 수동 폴백 (R1 검증)"
```

---

### Task 6: 로컬 상태 저장소와 목록 창

**Files:**
- Create: `app/store.js`
- Create: `app/test/store.test.js`
- Create: `app/preload.js`
- Create: `app/renderer/list.html`
- Create: `app/renderer/list.js`
- Modify: `app/main.js`

**Interfaces:**
- Consumes: Task 4의 `Sidecar`, Task 5의 `pollCookie` / `createLoginWindow`
- Produces:
  - `class Store { constructor(filePath) ; load() ; save() ; getNote(id) ; setNote(id, patch) ; visibleIds() }`
  - `NoteState = {x: number, y: number, w: number, h: number, visible: boolean, conflictBackup: string|null}`
  - `preload.js`가 렌더러에 노출하는 표면: `window.keepSticky = { listNotes, createNote, updateNote, trashNote, openNote, closeNote, exchangeCookie }`

- [ ] **Step 1: 실패하는 테스트 작성**

`app/test/store.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Store, DEFAULT_NOTE_STATE } = require('../store')

function tmpFile () {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ks-')), 'state.json')
}

test('파일이 없으면 빈 상태로 시작한다', () => {
  const s = new Store(tmpFile())
  s.load()
  assert.deepStrictEqual(s.visibleIds(), [])
})

test('저장한 뒤 다시 읽으면 값이 유지된다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  a.setNote('n1', { x: 10, y: 20, visible: true })
  a.save()

  const b = new Store(file)
  b.load()
  assert.strictEqual(b.getNote('n1').x, 10)
  assert.deepStrictEqual(b.visibleIds(), ['n1'])
})

test('새 노트는 기본값으로 채워진다', () => {
  const s = new Store(tmpFile())
  s.load()
  s.setNote('n1', { visible: true })
  assert.strictEqual(s.getNote('n1').w, DEFAULT_NOTE_STATE.w)
  assert.strictEqual(s.getNote('n1').conflictBackup, null)
})

test('손상된 JSON 이어도 앱이 죽지 않고 빈 상태로 시작한다', () => {
  const file = tmpFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{깨진 JSON', 'utf8')
  const s = new Store(file)
  s.load()
  assert.deepStrictEqual(s.visibleIds(), [])
})

test('visible 이 false 인 노트는 목록에서 빠진다', () => {
  const s = new Store(tmpFile())
  s.load()
  s.setNote('n1', { visible: true })
  s.setNote('n2', { visible: false })
  assert.deepStrictEqual(s.visibleIds(), ['n1'])
})
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../store'`

- [ ] **Step 3: store.js 구현**

```js
'use strict'
const fs = require('node:fs')
const path = require('node:path')

// 포스트잇 기본 크기. Phase 1 에서는 고정이고, Phase 2 의 드래그 리사이즈가
// 같은 필드를 그대로 쓴다.
const DEFAULT_NOTE_STATE = { x: 120, y: 120, w: 320, h: 380, visible: false, conflictBackup: null }

class Store {
  constructor (filePath) {
    this.filePath = filePath
    this.data = { notes: {} }
  }

  load () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      this.data = { notes: parsed.notes || {} }
    } catch {
      // 파일이 없거나 손상됐다. 상태 파일 하나 때문에 앱이 못 뜨면 안 된다.
      this.data = { notes: {} }
    }
    return this.data
  }

  save () {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    // 임시 파일에 쓰고 원자적으로 교체한다. 쓰는 도중 죽어도 기존 파일이 남는다.
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }

  getNote (id) {
    return this.data.notes[id] || null
  }

  setNote (id, patch) {
    this.data.notes[id] = { ...DEFAULT_NOTE_STATE, ...(this.data.notes[id] || {}), ...patch }
    return this.data.notes[id]
  }

  visibleIds () {
    return Object.keys(this.data.notes).filter((id) => this.data.notes[id].visible)
  }
}

module.exports = { Store, DEFAULT_NOTE_STATE }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: 14개 전부 PASS

- [ ] **Step 5: preload.js 작성**

```js
'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// 렌더러가 닿을 수 있는 표면은 이 목록이 전부다. Keep 본문은 외부 데이터이고
// Phase 3 에서 리치 텍스트를 다루게 되므로, Node API 경로를 처음부터 막는다.
contextBridge.exposeInMainWorld('keepSticky', {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (title, text) => ipcRenderer.invoke('notes:create', title, text),
  updateNote: (id, patch) => ipcRenderer.invoke('notes:update', id, patch),
  trashNote: (id) => ipcRenderer.invoke('notes:trash', id),
  openNote: (id) => ipcRenderer.invoke('notes:open', id),
  closeNote: (id) => ipcRenderer.invoke('notes:close', id),
  exchangeCookie: (token) => ipcRenderer.invoke('auth:exchange', token),
  noteId: () => ipcRenderer.invoke('notes:currentId')
})
```

- [ ] **Step 6: 목록 창 작성**

`app/renderer/list.html`:

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'">
  <title>Keep 메모</title>
  <style>
    body { font-family: 'Malgun Gothic', sans-serif; margin: 0; padding: 12px; word-break: keep-all; }
    h1 { font-size: 15px; margin: 0 0 10px; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid #eee; }
    .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .date { color: #888; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Keep 메모 <button id="new">+ 새 메모</button></h1>
  <ul id="list"></ul>
  <script src="list.js"></script>
</body>
</html>
```

`app/renderer/list.js`:

```js
'use strict'

function render (notes) {
  const ul = document.getElementById('list')
  ul.textContent = ''
  for (const note of notes) {
    const li = document.createElement('li')

    const title = document.createElement('span')
    title.className = 'title'
    // textContent 를 쓴다. Keep 본문은 외부 데이터이므로 innerHTML 은 쓰지 않는다.
    title.textContent = note.title || note.text.split('\n')[0] || '(제목없음)'

    const date = document.createElement('span')
    date.className = 'date'
    date.textContent = note.updated.slice(0, 10)

    const open = document.createElement('button')
    open.textContent = '바탕화면에'
    open.addEventListener('click', () => window.keepSticky.openNote(note.id))

    li.append(title, date, open)
    ul.append(li)
  }
}

document.getElementById('new').addEventListener('click', async () => {
  const note = await window.keepSticky.createNote('', '')
  await window.keepSticky.openNote(note.id)
  render((await window.keepSticky.listNotes()).notes)
})

window.keepSticky.listNotes().then((res) => render(res.notes))
```

- [ ] **Step 7: main.js 를 목록 창까지 확장**

`app/main.js` 전체를 아래로 교체한다.

```js
'use strict'
const path = require('node:path')
const { app, BrowserWindow, ipcMain, session } = require('electron')
const { Sidecar } = require('./sidecar')
const { Store } = require('./store')
const { createLoginWindow, pollCookie } = require('./login')

const EMAIL_KEY = 'you@gmail.com' // Phase 2 에서 설정 화면으로 옮긴다
const PRELOAD = path.join(__dirname, 'preload.js')

let sidecar = null
let store = null
const noteWindows = new Map() // noteId -> BrowserWindow

function startSidecar () {
  // 개발 중에는 시스템 python 을, 배포본에서는 PyInstaller 산출물을 쓴다 (Task 8).
  sidecar = new Sidecar('python', [path.join(__dirname, '..', 'keep_service.py')]).start()
  return sidecar
}

async function ensureAuth () {
  const { authenticated } = await sidecar.call('auth_status', { email: EMAIL_KEY })
  if (authenticated) return true

  const win = createLoginWindow(BrowserWindow)
  const token = await pollCookie(session.fromPartition('persist:login'),
                                 { intervalMs: 1000, timeoutMs: 300000 })
  win.close()
  if (!token) return false
  await sidecar.call('exchange_cookie', { email: EMAIL_KEY, oauth_token: token })
  return true
}

function createListWindow () {
  const win = new BrowserWindow({
    width: 420,
    height: 560,
    title: 'Keep 메모',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'list.html'))
  return win
}

app.whenReady().then(async () => {
  store = new Store(path.join(app.getPath('userData'), 'state.json'))
  store.load()
  startSidecar()

  ipcMain.handle('notes:list', () => sidecar.call('list_notes'))
  ipcMain.handle('notes:create', async (_e, title, text) => {
    const res = await sidecar.call('create_note', { title, text })
    return res.note
  })
  ipcMain.handle('auth:exchange', async (_e, token) => {
    try {
      await sidecar.call('exchange_cookie', { email: EMAIL_KEY, oauth_token: token })
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  if (!(await ensureAuth())) {
    console.error('인증 실패. 수동 로그인 창이 필요하다.')
    return
  }
  await sidecar.call('set_account', { email: EMAIL_KEY })
  createListWindow()
})

app.on('window-all-closed', () => {
  if (sidecar) sidecar.stop()
  app.quit()
})

module.exports = { noteWindows }
```

- [ ] **Step 8: 목록이 실제로 뜨는지 확인**

Run: `npm start`
Expected: 목록 창에 Keep 메모가 최근순으로 표시된다 (실계정 기준 71건 내외)

이 시점에서 "바탕화면에" 버튼은 아직 동작하지 않는다. `notes:open` 핸들러는 Task 7에서 붙는다. 여기서 확인할 것은 목록이 뜨는지까지다.

- [ ] **Step 9: 커밋**

```bash
git add app/store.js app/test/store.test.js app/preload.js app/renderer/list.html app/renderer/list.js app/main.js
git commit -m "feat: 로컬 상태 저장소와 메모 목록 창"
```

---

### Task 7: 포스트잇 창과 편집 저장, 충돌 배지

**Files:**
- Create: `app/renderer/note.html`
- Create: `app/renderer/note.js`
- Modify: `app/main.js`

**Interfaces:**
- Consumes: Task 3의 `update_note` 응답(`{note, conflict, sentText}`), Task 6의 `Store`, `preload.js` 표면
- Produces:
  - IPC 핸들러 `notes:open` / `notes:close` / `notes:update` / `notes:trash` / `notes:currentId`
  - 포스트잇 창: frameless, 항상 위, 노란 배경, 테두리 없음, 드래그 이동

- [ ] **Step 1: 포스트잇 창 작성**

`app/renderer/note.html`:

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'">
  <title>메모</title>
  <style>
    html, body { margin: 0; height: 100%; }
    body {
      display: flex; flex-direction: column;
      background: #fdf6a9; font-family: 'Malgun Gothic', sans-serif;
      border-radius: 6px; overflow: hidden; word-break: keep-all;
    }
    /* 상단 바 전체가 드래그 핸들이다. 버튼은 no-drag 로 되돌린다. */
    #bar { -webkit-app-region: drag; display: flex; align-items: center;
           gap: 6px; padding: 6px 8px; font-size: 12px; color: #7a6a1f; }
    #bar button { -webkit-app-region: no-drag; border: 0; background: transparent;
                  cursor: pointer; font-size: 14px; color: #7a6a1f; }
    #spacer { flex: 1; }
    #body { flex: 1; border: 0; outline: 0; resize: none; padding: 10px 14px;
            background: transparent; font-size: 15px; line-height: 1.6; }
    #badge { display: none; padding: 6px 14px; background: #f59e0b; color: #fff; font-size: 12px; }
    #badge.show { display: block; }
  </style>
</head>
<body>
  <div id="bar">
    <span id="status"></span>
    <span id="spacer"></span>
    <button id="close" title="바탕화면에서 내리기 (Keep 메모는 유지됩니다)">✕</button>
  </div>
  <div id="badge"></div>
  <textarea id="body" spellcheck="false"></textarea>
  <script src="note.js"></script>
</body>
</html>
```

`app/renderer/note.js`:

```js
'use strict'

const DEBOUNCE_MS = 1500
let noteId = null
let timer = null

const body = document.getElementById('body')
const status = document.getElementById('status')
const badge = document.getElementById('badge')

function showConflict (sentText) {
  badge.textContent = '다른 기기에서 수정됨 — 내 편집본은 보관되어 있습니다'
  badge.classList.add('show')
  badge.title = sentText
}

async function flush () {
  status.textContent = '저장 중'
  try {
    const res = await window.keepSticky.updateNote(noteId, { text: body.value })
    if (res.conflict) {
      showConflict(res.sentText)
      body.value = res.note.text // 서버가 이긴 내용을 보여준다
    } else {
      badge.classList.remove('show')
    }
    status.textContent = '저장됨'
  } catch (err) {
    // 네트워크 끊김이나 토큰 만료. 사용자가 친 내용은 화면에 그대로 둔다.
    status.textContent = err.code === 'AUTH_REQUIRED' ? '재로그인 필요' : '대기 중'
  }
}

body.addEventListener('input', () => {
  status.textContent = ''
  clearTimeout(timer)
  timer = setTimeout(flush, DEBOUNCE_MS)
})

document.getElementById('close').addEventListener('click', () => {
  clearTimeout(timer)
  window.keepSticky.closeNote(noteId)
})

document.addEventListener('contextmenu', async (e) => {
  e.preventDefault()
  if (!confirm('이 메모를 Keep 휴지통으로 보낼까요? 7일간 복구할 수 있습니다.')) return
  await window.keepSticky.trashNote(noteId)
})

window.keepSticky.noteId().then(async (id) => {
  noteId = id
  const { notes } = await window.keepSticky.listNotes()
  const note = notes.find((n) => n.id === id)
  body.value = note ? note.text : ''
})
```

- [ ] **Step 2: main.js 에 포스트잇 창 관리 추가**

`app/main.js`의 `createListWindow` 아래에 넣는다.

```js
function createNoteWindow (noteId) {
  const state = store.setNote(noteId, { visible: true })
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.w,
    height: state.h,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'note.html'))
  noteWindows.set(noteId, win)

  const persistBounds = () => {
    const b = win.getBounds()
    store.setNote(noteId, { x: b.x, y: b.y, w: b.width, h: b.height })
    store.save()
  }
  win.on('moved', persistBounds)
  win.on('resized', persistBounds)
  win.on('closed', () => noteWindows.delete(noteId))

  store.save()
  return win
}

function windowIdOf (event) {
  const win = BrowserWindow.fromWebContents(event.sender)
  for (const [id, w] of noteWindows) if (w === win) return id
  return null
}
```

`app.whenReady()` 안의 기존 `ipcMain.handle` 블록 아래에 추가한다.

```js
  ipcMain.handle('notes:currentId', (event) => windowIdOf(event))

  ipcMain.handle('notes:open', (_e, id) => {
    const existing = noteWindows.get(id)
    if (existing) { existing.focus(); return { ok: true } }
    createNoteWindow(id)
    return { ok: true }
  })

  ipcMain.handle('notes:close', (_e, id) => {
    // 바탕화면에서 내리기만 한다. Keep 메모는 그대로 둔다.
    store.setNote(id, { visible: false })
    store.save()
    const win = noteWindows.get(id)
    if (win) win.close()
    return { ok: true }
  })

  ipcMain.handle('notes:update', async (_e, id, patch) => {
    const res = await sidecar.call('update_note', { id, text: patch.text })
    if (res.conflict) {
      store.setNote(id, { conflictBackup: res.sentText })
      store.save()
    }
    return res
  })

  ipcMain.handle('notes:trash', async (_e, id) => {
    await sidecar.call('trash_note', { id })
    store.setNote(id, { visible: false })
    store.save()
    const win = noteWindows.get(id)
    if (win) win.close()
    return { ok: true }
  })
```

- [ ] **Step 3: 관통 확인 — 표시**

Run: `npm start`
목록에서 아무 메모의 "바탕화면에"를 누른다.
Expected: 노란 포스트잇이 테두리 없이 뜨고, 항상 위에 있으며, 상단 바를 끌면 이동한다.

- [ ] **Step 4: 관통 확인 — 편집이 Keep 에 반영**

포스트잇 본문을 고치고 2초 기다린다 → 상단에 "저장됨" 표시 확인.
Run: `python keep_probe.py list you@gmail.com`
Expected: 수정한 내용이 반영되어 있다. 폰의 Keep 앱에서도 동일하게 보인다.

- [ ] **Step 5: 관통 확인 — 닫기는 삭제가 아니다**

포스트잇의 ✕ 를 누른 뒤 목록 창을 다시 본다.
Expected: 메모가 목록에 그대로 남아 있다. Keep 에서도 사라지지 않았다.

- [ ] **Step 6: 커밋**

```bash
git add app/renderer/note.html app/renderer/note.js app/main.js
git commit -m "feat: 포스트잇 창, 디바운스 저장, 충돌 배지"
```

---

### Task 8: 재시작 복원과 배포 패키징

**Files:**
- Create: `app/test/restore.test.js`
- Modify: `app/main.js`
- Modify: `package.json`
- Create: `keep_service.spec` (PyInstaller)

**Interfaces:**
- Consumes: Task 6의 `Store.visibleIds()`, Task 7의 `createNoteWindow`
- Produces: `resolveSidecarCommand(isPackaged, resourcesPath, dirname) -> {command, args}`

- [ ] **Step 1: 실패하는 테스트 작성**

`app/test/restore.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { resolveSidecarCommand } = require('../sidecar-path')

test('개발 중에는 시스템 python 으로 스크립트를 실행한다', () => {
  const r = resolveSidecarCommand(false, '/ignored', '/proj/app')
  assert.strictEqual(r.command, 'python')
  assert.strictEqual(r.args[0], path.join('/proj', 'keep_service.py'))
})

test('배포본에서는 번들된 실행파일을 인자 없이 실행한다', () => {
  const r = resolveSidecarCommand(true, '/app/resources', '/ignored')
  assert.strictEqual(r.command, path.join('/app/resources', 'keep_service.exe'))
  assert.deepStrictEqual(r.args, [])
})
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../sidecar-path'`

- [ ] **Step 3: sidecar-path.js 구현**

```js
'use strict'
const path = require('node:path')

/**
 * 개발 중에는 시스템 python 으로 소스를 돌리고, 배포본에서는 PyInstaller 로
 * 만든 단일 실행파일을 쓴다. 사용자 PC 에 Python 설치를 요구하지 않는다.
 */
function resolveSidecarCommand (isPackaged, resourcesPath, dirname) {
  if (isPackaged) {
    const exe = process.platform === 'win32' ? 'keep_service.exe' : 'keep_service'
    return { command: path.join(resourcesPath, exe), args: [] }
  }
  return { command: 'python', args: [path.join(dirname, '..', 'keep_service.py')] }
}

module.exports = { resolveSidecarCommand }
```

- [ ] **Step 4: main.js 가 이 함수를 쓰도록 수정**

`startSidecar`를 교체한다.

```js
function startSidecar () {
  const { command, args } = resolveSidecarCommand(app.isPackaged, process.resourcesPath, __dirname)
  sidecar = new Sidecar(command, args, {
    maxRestarts: 3,
    onDead: (message) => {
      dialog.showErrorBox('Keep 연결 끊김',
        `백그라운드 서비스가 반복해서 종료되었습니다.\n\n${message}\n\n` +
        '앱을 다시 시작해 주세요. 편집 중이던 내용은 저장되지 않았을 수 있습니다.')
    }
  }).start()
  return sidecar
}
```

`app/main.js` 상단의 electron require 에 `dialog` 를 추가한다.

```js
const { app, BrowserWindow, ipcMain, session, dialog } = require('electron')
```

`app/main.js` 상단 require 목록에 추가한다.

```js
const { resolveSidecarCommand } = require('./sidecar-path')
```

- [ ] **Step 5: 재시작 복원 구현**

`app.whenReady()`의 `createListWindow()` 호출 직전에 넣는다.

```js
  // 지난 세션에 띄워둔 포스트잇을 위치까지 복원한다.
  for (const id of store.visibleIds()) createNoteWindow(id)
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npm test`
Expected: 16개 전부 PASS

- [ ] **Step 7: 복원 동작 확인**

Run: `npm start` → 포스트잇 2개를 띄우고 위치를 옮긴 뒤 앱을 종료 → 다시 `npm start`
Expected: 포스트잇 2개가 같은 위치에 다시 뜬다

- [ ] **Step 8: PyInstaller 로 사이드카 번들**

`keep_service.spec`:

```python
# PyInstaller 스펙. 사용자 PC 에 Python 설치를 요구하지 않기 위해 단일 실행파일로 만든다.
a = Analysis(
    ["keep_service.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=["keyring.backends.Windows", "keyring.backends.macOS"],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas,
    name="keep_service",
    console=False,
    upx=False,
)
```

`hiddenimports`에 keyring 백엔드를 명시하는 이유: keyring은 백엔드를 런타임에 동적으로 찾기 때문에 PyInstaller의 정적 분석이 놓친다. 빠뜨리면 배포본에서만 "저장된 토큰 없음"이 뜬다.

Run: `python -m pip install pyinstaller` 후 `python -m PyInstaller keep_service.spec --clean --distpath dist-py`
Expected: `dist-py/keep_service.exe` 생성

- [ ] **Step 9: 번들된 사이드카가 실제로 동작하는지 확인**

Run: `echo {"id":1,"method":"auth_status","params":{"email":"you@gmail.com"}} | dist-py\keep_service.exe`
Expected: `{"id": 1, "result": {"authenticated": true}}`

이 확인을 건너뛰면 keyring 백엔드 누락을 배포 후에야 발견한다.

- [ ] **Step 10: electron-builder 설정**

`package.json`에 추가한다.

```json
  "build": {
    "appId": "com.keepsticky.app",
    "productName": "Keep Sticky",
    "files": ["app/**/*", "package.json"],
    "extraResources": [{ "from": "dist-py/keep_service.exe", "to": "keep_service.exe" }],
    "win": { "target": "nsis" }
  }
```

`devDependencies`에 `"electron-builder": "^25.0.0"`, `scripts`에 `"dist": "electron-builder"`를 추가한다.

Run: `npm install` 후 `npm run dist`
Expected: `dist/` 아래 설치 파일 생성

- [ ] **Step 11: 설치본으로 전 구간 확인**

설치 후 실행 → 로그인 → 목록 → 포스트잇 → 편집 → `keep_probe.py list`로 Keep 반영 확인.

- [ ] **Step 12: 커밋**

```bash
git add app/sidecar-path.js app/test/restore.test.js app/main.js package.json keep_service.spec
git commit -m "feat: 재시작 복원과 Windows 배포 패키징"
```

---

## 완료 기준

Phase 1은 아래가 모두 참일 때 끝난다.

- [ ] `python -m pytest tests/ -v` 전부 통과
- [ ] `npm test` 전부 통과
- [ ] `python keep_probe.py roundtrip <email>` 통과 (R3 해소)
- [ ] 설치본에서 로그인 → 목록 → 포스트잇 → 편집 → Keep 반영이 관통 (R1 해소)
- [ ] 앱 재시작 후 포스트잇이 위치까지 복원
- [ ] ✕ 를 눌러도 Keep 메모가 남아 있음
- [ ] 우클릭 삭제가 `trash()`로만 동작하며 Keep 휴지통에서 복구 가능
- [ ] `git log`에 토큰 값이 들어간 커밋이 없음

R2(master token 수명)는 Phase 1 완료 후 며칠간 사용하며 관찰한다. 재로그인이 며칠 주기로 필요하면 Phase 2 착수 전에 대응 방안을 다시 논의한다.
