import io
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


@pytest.mark.parametrize("line", ["null", "42", "[1, 2]"])
def test_non_object_json_returns_bad_request(service, line):
    """유효한 JSON 이지만 객체가 아니면 .get() 이 AttributeError 를 던진다."""
    res = ks.handle(service, line)
    assert res["error"]["code"] == "BAD_REQUEST"
    assert res["id"] is None


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


def test_update_title_only_preserves_text(account):
    """text 없이 title 만 보내면 기존 본문이 유지되고, sentText 는 그 유지된 본문이어야 한다."""
    created = _call(account, "create_note", title="원래 제목", text="유지될 본문")["result"]["note"]
    res = _call(account, "update_note", id=created["id"], title="새 제목")["result"]
    assert res["note"]["title"] == "새 제목"
    assert res["note"]["text"] == "유지될 본문"
    assert res["conflict"] is False
    assert res["sentText"] == "유지될 본문"


def test_update_title_only_detects_conflict_when_server_overrides(account):
    """title 만 바꿔도 sync 후 서버가 본문을 덮어썼다면 여전히 충돌로 잡혀야 한다."""
    created = _call(account, "create_note", title="원래 제목", text="원본 본문")["result"]["note"]
    account._keep.server_override = "폰에서 고친 내용"
    res = _call(account, "update_note", id=created["id"], title="새 제목")["result"]
    assert res["conflict"] is True
    assert res["sentText"] == "원본 본문"
    assert res["note"]["text"] == "폰에서 고친 내용"


def test_serve_survives_cp949_stdout_with_emoji_note(account):
    """한국어 Windows 의 기본 콘솔 코드페이지는 cp949 이고, 이모지처럼 BMP 밖
    문자는 표현하지 못한다. 실사용자가 겪은 크래시: 노트 본문에 이모지가 있으면
    list_notes 응답을 cp949 스트림에 그대로 쓰다가 UnicodeEncodeError 로
    사이드카 전체가 죽었다 (ensure_ascii=False 였기 때문). serve() 는 응답을
    ensure_ascii=True 로 이스케이프해야 하고, 어떤 인코딩의 스트림을 받아도
    죽지 않아야 한다.
    """
    _call(account, "create_note", title="메모", text="생각 정리 \U0001f9e0")

    request_line = json.dumps({"id": 1, "method": "list_notes", "params": {}}) + "\n"
    stdin = io.StringIO(request_line)
    raw_out = io.BytesIO()
    stdout = io.TextIOWrapper(raw_out, encoding="cp949", newline="\n")

    ks.serve(account, stdin=stdin, stdout=stdout)
    stdout.flush()

    emitted = raw_out.getvalue().decode("cp949").strip()
    res = json.loads(emitted)
    assert res["result"]["notes"][0]["text"] == "생각 정리 \U0001f9e0"
