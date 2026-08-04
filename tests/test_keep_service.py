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
    """노드의 시각 대역.

    created 를 노드마다 1분씩 뒤로 밀어 준다. 목록이 **작성일** 순으로 서는지
    보려면 노드들의 created 가 서로 달라야 하고, 실제 Keep 도 나중에 만든 노트가
    더 늦은 created 를 갖는다. 갓 만든 노트의 updated 는 created 와 같다 —
    편집이 일어나야 갈라진다.
    """

    _sequence = 0

    def __init__(self):
        import datetime
        FakeTimestamps._sequence += 1
        self.created = (datetime.datetime(2026, 7, 30, 9, 0, 0)
                        + datetime.timedelta(minutes=FakeTimestamps._sequence))
        self.updated = self.created


class FakeLabel:
    """gkeepapi.node.Label 대역. 계정에 따로 사는 개체이고 노트는 참조만 한다."""

    def __init__(self, label_id, name):
        self.id = label_id
        self.name = name


class FakeNodeLabels:
    """gkeepapi.node.NodeLabels 대역.

    실제와 같이 id → Label 의 dict 를 들고 add/remove/all 을 준다. all() 이
    dict 순서를 그대로 주는 것까지 같다 — _serialize_labels 가 이름순으로
    다시 세우는지 확인하려면 대역도 정렬해 주면 안 된다.
    """

    def __init__(self):
        self._labels = {}

    def add(self, label):
        self._labels[label.id] = label

    def remove(self, label):
        self._labels.pop(label.id, None)

    def all(self):
        return list(self._labels.values())

    def get(self, label_id):
        return self._labels.get(label_id)

    def __len__(self):
        return len(self._labels)


class FakeColor:
    name = "Yellow"


class FakeNode:
    """text 노트 대역. type 은 실제 gkeepapi 가 노드에 심는 열거형 그대로다 —
    _is_checklist 가 보는 것이 바로 이 값이라서, 대역도 같은 값을 들고 있어야
    실제와 같은 경로를 지난다."""

    def __init__(self, node_id="n1", title="", text=""):
        self.id = node_id
        self.title = title
        self.text = text
        self.color = FakeColor()
        self.pinned = False
        self.archived = False
        self.trashed = False
        self.timestamps = FakeTimestamps()
        self.labels = FakeNodeLabels()
        self.type = ks.gkeepapi.node.NodeType.Note

    def trash(self):
        self.trashed = True


class FakeListItem:
    """체크리스트 항목 하나. id 는 Keep 이 정하는 안정적인 식별자다."""

    def __init__(self, item_id, text="", checked=False):
        self.id = item_id
        self.text = text
        self.checked = checked


class FakeListNode(FakeNode):
    """체크리스트 대역.

    실제 gkeepapi.node.List 를 그대로 따라간다:
      - type 이 NodeType.List 다.
      - text 는 항목들을 이어 붙여 만드는 **읽기 전용** 프로퍼티다. 대입하면
        AttributeError 가 난다 — update_note 가 체크리스트 본문을 건드리지 못하게
        막는 가드가 정말로 필요한지를 이 대역이 증명한다.
    """

    def __init__(self, node_id="n1", title="", items=None):
        super().__init__(node_id, title, "")
        self.type = ks.gkeepapi.node.NodeType.List
        self.items = [
            FakeListItem(f"{node_id}-i{n + 1}", text, checked)
            for n, (text, checked) in enumerate(items or [])
        ]

    @property
    def text(self):
        return "\n".join(
            f"{'☑' if i.checked else '☐'} {i.text}" for i in self.items
        )

    @text.setter
    def text(self, value):
        # FakeNode.__init__ 이 self.text = "" 를 하므로 그것만 통과시킨다.
        # 그 밖의 대입은 실제 List 와 같이 거절한다.
        if value != "":
            raise AttributeError("property 'text' of 'List' object has no setter")


class FakeKeepWithNodes(FakeKeep):
    """sync 시 서버가 본문을 덮어쓰는 상황까지 흉내낸다."""

    def __init__(self):
        super().__init__()
        self.nodes = {}
        self.server_override = None
        # 체크리스트 쪽 "다른 기기가 이겼다"를 흉내내는 훅. sync 때 한 번
        # 불리고, 인자로 받은 노드를 마음대로 고칠 수 있다.
        self.server_items_override = None
        # "다른 기기가 이 노드를 trash() 하고 먼저 sync 했다"를 흉내낸다.
        # list_notes 는 sync() 를 부르지 않으므로 이 집합이 그대로 남아
        # 있으면 find() 에 여전히 보인다 — sync_notes 만 sync() 를 실제로
        # 불러야 여기 담긴 id 가 트인다(trashed=True 로 바뀐다).
        self.deferred_trash_ids = set()
        # 다음 sync() 호출을 실패하게 만드는 훅. None 이면 평소대로 동작한다.
        self.sync_error = None
        # 계정의 라벨 저장소. 노트와 독립이라 따로 산다.
        self.label_store = {}

    def createNote(self, title=None, text=None):  # noqa: N802 - gkeepapi 명명 규칙
        node = FakeNode(f"n{len(self.nodes) + 1}", title or "", text or "")
        self.nodes[node.id] = node
        return node

    def createList(self, title=None, items=None):  # noqa: N802 - gkeepapi 명명 규칙
        node = FakeListNode(f"n{len(self.nodes) + 1}", title or "", items or [])
        self.nodes[node.id] = node
        return node

    def get(self, node_id):
        return self.nodes.get(node_id)

    # --- 라벨 (gkeepapi.Keep 의 라벨 API 대역) ---

    def createLabel(self, name):  # noqa: N802 - gkeepapi 명명 규칙
        if self.findLabel(name) is not None:
            raise ks.gkeepapi.exception.LabelException("Label exists")
        label = FakeLabel(f"tag.{len(self.label_store) + 1}", name)
        self.label_store[label.id] = label
        return label

    def findLabel(self, query, create=False):  # noqa: N802 - gkeepapi 명명 규칙
        # 실제와 같이 대소문자를 가리지 않는다.
        needle = query.lower() if isinstance(query, str) else query
        for label in self.label_store.values():
            if label.name.lower() == needle:
                return label
        return self.createLabel(query) if create and isinstance(query, str) else None

    def getLabel(self, label_id):  # noqa: N802 - gkeepapi 명명 규칙
        return self.label_store.get(label_id)

    def deleteLabel(self, label_id):  # noqa: N802 - gkeepapi 명명 규칙
        label = self.label_store.pop(label_id, None)
        if label is None:
            return
        # 실제 Keep 과 같이 붙어 있던 모든 노트에서 함께 떨어진다.
        for node in self.nodes.values():
            node.labels.remove(label)

    def labels(self):
        return list(self.label_store.values())

    def find(self, **kwargs):
        return iter([n for n in self.nodes.values() if not n.trashed])

    def sync(self, resync=False):
        if self.sync_error is not None:
            raise self.sync_error
        super().sync(resync)
        if self.server_override is not None:
            for node in self.nodes.values():
                if isinstance(node, FakeListNode):
                    continue  # 체크리스트의 text 는 읽기 전용이다
                node.text = self.server_override
        if self.server_items_override is not None:
            for node in self.nodes.values():
                if isinstance(node, FakeListNode):
                    self.server_items_override(node)
        for node_id in self.deferred_trash_ids:
            node = self.nodes.get(node_id)
            if node is not None:
                node.trashed = True
        self.deferred_trash_ids.clear()


@pytest.fixture
def account(monkeypatch):
    monkeypatch.setattr(ks.keyring, "get_password", lambda s, e: "good-token")
    svc = ks.KeepService(keep_factory=FakeKeepWithNodes)
    ks.handle(svc, json.dumps({"id": 0, "method": "set_account",
                               "params": {"email": "a@b.com"}}))
    return svc


def _call(svc, method, **params):
    return ks.handle(svc, json.dumps({"id": 1, "method": method, "params": params}))


def _make_list(svc, title="장보기", items=None):
    """대역 Keep 안에 List 노트를 직접 만들고 직렬화 결과를 돌려준다.

    create_checklist RPC 는 없앴다 — 이 앱은 Keep 의 List 를 새로 만들지 않는다
    (체크리스트는 이제 메모 본문 텍스트 안의 규약이다). 하지만 사용자가 **폰에서
    만들어 둔** List 노트는 여전히 열리고 고쳐져야 하고, 그 경로를 시험하려면
    그런 노트가 하나 있어야 한다. 그래서 RPC 를 거치지 않고 gkeepapi 의
    createList 를 그대로 부른다 — 실제로 노트가 생기는 경로와 같다.

    items 는 [{"text": ..., "checked": ...}] 로 받는다(옛 create_checklist 와
    같은 모양이라 이 파일의 시험들이 그대로 읽힌다).
    """
    keep = svc._require_keep()
    node = keep.createList(
        title,
        [(i.get("text", ""), i.get("checked", False)) for i in (items or [])],
    )
    keep.sync()
    return ks._serialize(node)


def test_create_then_list(account):
    _call(account, "create_note", title="제목", text="본문")
    res = _call(account, "list_notes")
    notes = res["result"]["notes"]
    assert len(notes) == 1
    assert notes[0]["title"] == "제목"
    assert notes[0]["text"] == "본문"
    assert notes[0]["color"] == "Yellow"
    # 정확한 시각은 대역의 순번을 따르므로 형식과 관계만 본다(갓 만든 메모는
    # 작성 시각과 수정 시각이 같다).
    assert notes[0]["created"] == notes[0]["updated"]
    assert notes[0]["created"].startswith("2026-07-30T09:")


# --- 동기화 -----------------------------------------------------------------
#
# list_notes 는 세션의 첫 authenticate() 가 채운 상태를 그대로 보여줄 뿐 sync()
# 를 부르지 않는다. 그래서 다른 기기(폰이나 keep.google.com)에서 생긴 변경,
# 특히 삭제가 이 세션에 영영 반영되지 않는 문제가 있었다 — 사용자가 실제로
# 겪은 "Keep 에서 지웠는데 앱에는 남아 있다"가 이것이다. sync_notes 는 그
# 간극을 메운다.


def test_sync_notes_calls_sync_before_listing(account):
    """sync_notes 는 목록을 만들기 전에 실제로 keep.sync() 를 부른다."""
    # account._keep 은 _require_keep() 이 처음 불릴 때까지 None 이다 — 아직
    # 아무 RPC 도 안 걸었으니 먼저 하나 걸어 인증을 트인다.
    _call(account, "list_notes")
    before = account._keep.synced
    _call(account, "sync_notes")
    assert account._keep.synced == before + 1


def test_sync_notes_returns_same_shape_as_list_notes(account):
    """응답 모양(키 집합)이 list_notes 와 같아야 한다 — 렌더러가 두 RPC 의
    결과를 같은 코드 경로로 다룰 수 있으려면 이것이 성립해야 한다."""
    _call(account, "create_note", title="제목", text="본문")
    list_res = _call(account, "list_notes")["result"]
    sync_res = _call(account, "sync_notes")["result"]
    assert set(sync_res) == set(list_res) == {"notes"}
    assert sync_res["notes"] == list_res["notes"]


def test_sync_notes_reflects_deletion_that_list_notes_would_miss(account):
    """이 시험이 이번 수정이 고치는 버그 그 자체를 재현한다.

    다른 기기가 메모를 trash() 하고 먼저 sync 했다고 하자. 이 세션은 아직
    sync() 를 부르지 않았으므로 로컬 노드는 여전히 trashed=False 다.
    list_notes 는 sync() 를 부르지 않으니 그 메모가 계속 보여야 하고(=버그
    재현), sync_notes 는 sync() 를 부르니 사라져야 한다(=고침 확인)."""
    created = _call(account, "create_note", title="t", text="곧 지워질 메모")["result"]["note"]

    # "다른 기기가 trash() 하고 sync 했다"를 흉내낸다 — 로컬 노드는 아직 그
    # 사실을 모른다(deferred_trash_ids 에만 적혀 있고, 다음 sync() 에서만
    # 실제로 trashed=True 로 바뀐다).
    account._keep.deferred_trash_ids.add(created["id"])

    still_there = _call(account, "list_notes")["result"]["notes"]
    assert any(n["id"] == created["id"] for n in still_there), \
        "list_notes 는 sync 하지 않으므로 아직 보여야 한다"

    after_sync = _call(account, "sync_notes")["result"]["notes"]
    assert not any(n["id"] == created["id"] for n in after_sync), \
        "sync_notes 는 sync() 를 불렀으므로 삭제가 반영돼야 한다"


def test_sync_notes_failure_is_an_error_not_a_silent_empty_list(account):
    """sync() 가 실패하면(네트워크, 만료된 세션 등) 그 실패가 에러로 떨어져야
    한다. 조용히 빈 목록을 돌려주면 사용자는 "메모가 전부 지워졌다"고 오해한다."""
    # account._keep 은 _require_keep() 이 처음 불릴 때까지 None 이다.
    _call(account, "list_notes")
    account._keep.sync_error = RuntimeError("network unreachable")
    res = _call(account, "sync_notes")
    assert "error" in res
    assert res["error"]["code"] == "INTERNAL"
    assert "result" not in res


def test_sync_notes_is_whitelisted(service):
    """ALLOWED_METHODS 가 보안 경계다 — 새 RPC 는 반드시 여기 올라야 닿을 수
    있다."""
    assert "sync_notes" in ks.ALLOWED_METHODS


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


@pytest.mark.parametrize("name", [
    "White", "Red", "Orange", "Yellow", "Green", "Teal",
    "Blue", "DarkBlue", "Purple", "Pink", "Brown", "Gray",
])
def test_update_color_accepts_each_of_the_twelve_names(account, name):
    """Keep 팔레트의 12개 이름 전부가 받아들여지고, 그대로 왕복해야 한다."""
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    res = _call(account, "update_note", id=created["id"], color=name)["result"]
    assert res["note"]["color"] == name
    assert res["conflict"] is False


def test_update_color_unknown_name_is_bad_request(account):
    """Keep 팔레트에 없는 이름은 BAD_REQUEST 여야 한다 — 조용히 무시하거나
    죽어서도 안 된다."""
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    res = _call(account, "update_note", id=created["id"], color="Rainbow")
    assert res["error"]["code"] == "BAD_REQUEST"
    # 색이 잘못됐으니 노드는 손대지 않은 채로 남아야 한다.
    notes = _call(account, "list_notes")["result"]["notes"]
    assert notes[0]["color"] == "Yellow"


def test_update_color_only_leaves_text_untouched_and_reports_no_conflict(account):
    """색만 바꾸는 요청은 text=None 으로 들어온다. sentText 는 유지된 본문으로
    떨어져야 하고(title-only 테스트와 같은 모양), 충돌로 오탐하면 안 된다."""
    created = _call(account, "create_note", title="t", text="유지될 본문")["result"]["note"]
    res = _call(account, "update_note", id=created["id"], color="Blue")["result"]
    assert res["note"]["text"] == "유지될 본문"
    assert res["note"]["color"] == "Blue"
    assert res["conflict"] is False
    assert res["sentText"] == "유지될 본문"


def test_update_text_and_color_together_applies_both(account):
    created = _call(account, "create_note", title="t", text="원본")["result"]["note"]
    res = _call(account, "update_note", id=created["id"], text="수정본", color="Green")["result"]
    assert res["note"]["text"] == "수정본"
    assert res["note"]["color"] == "Green"
    assert res["conflict"] is False


def test_update_title_and_text_together_no_conflict(account):
    """포스트잇이 편집기 문자열을 title/text 로 쪼개 한 번에 같이 보낸다.
    이 조합에서도 정상 저장은 여전히 충돌 없이 끝나야 한다 — 충돌 판정은
    text 필드 하나만 보고, sync 전후로 text 가 우리가 보낸 값과 같으면 그걸로
    끝이다. title 을 같이 보낸다고 그 판정이 흔들리면 안 된다."""
    created = _call(account, "create_note", title="원래 제목", text="원본 본문")["result"]["note"]
    res = _call(account, "update_note", id=created["id"], title="새 제목", text="새 본문")["result"]
    assert res["note"]["title"] == "새 제목"
    assert res["note"]["text"] == "새 본문"
    assert res["conflict"] is False
    assert res["sentText"] == "새 본문"


def test_update_title_and_text_together_detects_conflict_when_server_overrides(account):
    """title/text 를 같이 보낸 상태에서 sync 도중 다른 기기가 본문을 덮어쓰면
    여전히 충돌로 잡혀야 한다. 쪼개서 보낸 text 가 편집기 원문보다 짧아졌다고
    (title 이 앞에서 떨어져 나갔다고) 이 판정 로직 자체는 전혀 달라지지 않는다
    — sent_text 는 우리가 이번 호출에서 설정한 text 값 그대로이고, 그 값과
    sync 후 서버 값을 비교할 뿐이기 때문이다."""
    created = _call(account, "create_note", title="원래 제목", text="원본 본문")["result"]["note"]
    account._keep.server_override = "폰에서 고친 내용"
    res = _call(account, "update_note", id=created["id"], title="새 제목", text="PC에서 고친 내용")["result"]
    assert res["conflict"] is True
    assert res["sentText"] == "PC에서 고친 내용"
    assert res["note"]["title"] == "새 제목"  # title 은 충돌 판정과 무관하게 그대로 적용된다
    assert res["note"]["text"] == "폰에서 고친 내용"


# --- 체크리스트 -------------------------------------------------------------


def test_text_note_serializes_with_the_expected_fields(account):
    """text 노트의 직렬화 결과에 무엇이 실리는지를 못박는다.

    items 키는 **생기면 안 된다** — 렌더러는 kind 로 분기하지만, 여기에 빈
    items 가 딸려 오면 "항목이 하나도 없는 체크리스트"와 구별되지 않는다.

    필드 묶음을 통째로 견주는 것이 요점이다. 새 필드가 슬그머니 늘거나 옛 필드가
    사라지면 여기서 걸린다 — 렌더러가 그 모양에 기대고 있기 때문이다.
    """
    created = _call(account, "create_note", title="제목", text="본문")["result"]["note"]
    assert set(created) == {"id", "title", "text", "color", "pinned", "archived",
                            "created", "updated", "labels", "kind"}
    assert created["kind"] == "note"
    assert "items" not in created
    assert created["labels"] == [], "라벨을 붙인 적 없는 메모는 빈 배열이다"
    assert created["title"] == "제목"
    assert created["text"] == "본문"
    assert created["color"] == "Yellow"
    assert created["pinned"] is False
    assert created["archived"] is False
    # 갓 만든 메모는 작성 시각과 수정 시각이 같다. 정확한 값은 대역의 순번에
    # 따라 달라지므로 둘의 관계와 형식만 본다.
    assert created["created"] == created["updated"]
    assert created["created"].startswith("2026-07-30T09:")


def test_list_note_serializes_with_items(account):
    """폰에서 만든 List 노트의 직렬화 결과."""
    res = _make_list(account, title="장보기",
                     items=[{"text": "우유", "checked": False},
                            {"text": "빵", "checked": True}])
    assert res["kind"] == "list"
    assert res["title"] == "장보기"
    assert [i["text"] for i in res["items"]] == ["우유", "빵"]
    assert [i["checked"] for i in res["items"]] == [False, True]
    # 항목마다 안정적인 id 가 있어야 한다 — 순서나 글자가 아니라 이것으로 짝을 찾는다.
    assert all(i["id"] for i in res["items"])
    assert len({i["id"] for i in res["items"]}) == 2


def test_list_note_appears_in_list_notes_as_a_list(account):
    _make_list(account, title="장보기", items=[{"text": "우유"}])
    notes = _call(account, "list_notes")["result"]["notes"]
    assert len(notes) == 1
    assert notes[0]["kind"] == "list"
    # text 는 gkeepapi 의 List.text 그대로다(항목을 이어 붙인 것). 목록 창의
    # 검색이 항목 글자까지 훑을 수 있는 것이 이 덕이다.
    assert "우유" in notes[0]["text"]


def test_list_note_without_items_serializes_empty_items(account):
    res = _make_list(account, title="빈 목록")
    assert res["kind"] == "list"
    assert res["items"] == []


def test_toggle_item_checked(account):
    created = _make_list(account, title="장보기",
                         items=[{"text": "우유", "checked": False},
                                {"text": "빵", "checked": False}])
    items = [dict(i) for i in created["items"]]
    items[0]["checked"] = True
    res = _call(account, "update_checklist", id=created["id"], items=items)["result"]
    assert res["conflict"] is False
    assert [i["checked"] for i in res["note"]["items"]] == [True, False]
    # 글자는 건드리지 않았다.
    assert [i["text"] for i in res["note"]["items"]] == ["우유", "빵"]


def test_edit_item_text(account):
    created = _make_list(account, title="장보기", items=[{"text": "우유"}])
    items = [dict(i) for i in created["items"]]
    items[0]["text"] = "우유 2L"
    res = _call(account, "update_checklist", id=created["id"], items=items)["result"]
    assert res["conflict"] is False
    assert res["note"]["items"][0]["text"] == "우유 2L"
    # id 는 그대로다 — 글자를 고쳤다고 새 항목이 되면 안 된다.
    assert res["note"]["items"][0]["id"] == created["items"][0]["id"]


def test_update_checklist_can_change_title_too(account):
    """제목 칸은 두 종류 모두에 있다. 체크리스트도 제목을 갖는다."""
    created = _make_list(account, title="원래 제목", items=[{"text": "우유"}])
    res = _call(account, "update_checklist", id=created["id"],
                title="새 제목", items=created["items"])["result"]
    assert res["note"]["title"] == "새 제목"
    assert res["conflict"] is False


def test_update_checklist_detects_conflict_when_server_overrides(account):
    """sync 도중 다른 기기가 항목을 고쳤다면 충돌로 잡혀야 한다 — update_note 의
    sentText 판정과 같은 뜻이다."""
    created = _make_list(account, title="장보기", items=[{"text": "우유"}])

    def phone_edit(node):
        node.items[0].text = "폰에서 고친 항목"

    account._keep.server_items_override = phone_edit
    items = [dict(i) for i in created["items"]]
    items[0]["text"] = "PC에서 고친 항목"
    res = _call(account, "update_checklist", id=created["id"], items=items)["result"]
    assert res["conflict"] is True
    assert res["sentItems"][0]["text"] == "PC에서 고친 항목"
    assert res["note"]["items"][0]["text"] == "폰에서 고친 항목"


@pytest.mark.parametrize("bad_items", [
    "우유",                                   # 배열이 아니다
    {"text": "우유"},                          # 배열이 아니다(객체 하나)
    ["우유"],                                  # 항목이 객체가 아니다
    [{"text": 42}],                           # text 가 문자열이 아니다
    [{"checked": True}],                      # text 가 없다
    [{"text": "우유", "checked": "true"}],     # checked 가 문자열이다
    [{"text": "우유", "checked": 1}],          # checked 가 int 다(파이썬에서 bool 은 int 다)
    [{"text": "우유", "sort": 999}],           # 모르는 필드
])
def test_update_checklist_malformed_payload_is_bad_request(account, bad_items):
    """렌더러는 신뢰할 수 없다. 잘못된 payload 는 죽지도 조용히 무시되지도 않고
    BAD_REQUEST 로 떨어져야 한다 — update_note 의 색 검증과 같은 성격이다."""
    created = _make_list(account, title="장보기",
                         items=[{"text": "우유", "checked": False}])
    res = _call(account, "update_checklist", id=created["id"], items=bad_items)
    assert res["error"]["code"] == "BAD_REQUEST"
    # 거절됐으니 노드는 손대지 않은 채로 남아야 한다.
    after = _call(account, "list_notes")["result"]["notes"][0]
    assert after["items"] == created["items"]


def test_update_checklist_rejects_partial_application(account):
    """항목 셋 중 둘째가 잘못됐으면 첫째도 적용되면 안 된다. 검증은 노드를
    건드리기 **전에** 전부 끝나야 한다(update_note 의 색 검증과 같은 이유)."""
    created = _make_list(account, title="장보기",
                         items=[{"text": "우유"}, {"text": "빵"}])
    items = [dict(i) for i in created["items"]]
    items[0]["text"] = "적용되면 안 되는 값"
    items[1]["checked"] = "true"  # 무효
    res = _call(account, "update_checklist", id=created["id"], items=items)
    assert res["error"]["code"] == "BAD_REQUEST"
    after = _call(account, "list_notes")["result"]["notes"][0]
    assert [i["text"] for i in after["items"]] == ["우유", "빵"]


def test_update_checklist_unknown_item_id_is_bad_request(account):
    """이 체크리스트에 없는 항목 id 는 조용히 건너뛰지 않는다."""
    created = _make_list(account, title="장보기", items=[{"text": "우유"}])
    res = _call(account, "update_checklist", id=created["id"],
                items=[{"id": "없는항목id", "text": "우유", "checked": True}])
    assert res["error"]["code"] == "BAD_REQUEST"


def test_update_checklist_missing_note_is_not_found(account):
    res = _call(account, "update_checklist", id="없는id", items=[])
    assert res["error"]["code"] == "NOT_FOUND"


def test_update_checklist_on_text_note_is_bad_request(account):
    """text 노트에는 항목이 없다. 변환 경로도 없으므로 거절이 맞다."""
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    res = _call(account, "update_checklist", id=created["id"], items=[])
    assert res["error"]["code"] == "BAD_REQUEST"


def test_update_note_cannot_write_text_of_a_checklist(account):
    """List.text 는 읽기 전용 프로퍼티라 대입하면 AttributeError 가 난다.
    INTERNAL 스택 트레이스가 아니라 BAD_REQUEST 로 걸러져야 한다.

    포스트잇이 메모 본문을 "- [ ] 우유" 같은 텍스트로 저장하게 된 뒤에도 이
    가드는 그대로 필요하다 — 폰에서 만든 List 노트를 연 창이 실수로 text 경로를
    타면 여기서 걸려야 한다."""
    created = _make_list(account, title="장보기", items=[{"text": "우유"}])
    res = _call(account, "update_note", id=created["id"], text="본문으로 덮어쓰기")
    assert res["error"]["code"] == "BAD_REQUEST"
    after = _call(account, "list_notes")["result"]["notes"][0]
    assert [i["text"] for i in after["items"]] == ["우유"]


def test_update_note_can_still_change_a_checklists_title_and_color(account):
    """제목과 색은 두 종류 모두에 있다. 체크리스트라고 막을 이유가 없다."""
    created = _make_list(account, title="원래 제목", items=[{"text": "우유"}])
    res = _call(account, "update_note", id=created["id"],
                title="새 제목", color="Blue")["result"]
    assert res["note"]["title"] == "새 제목"
    assert res["note"]["color"] == "Blue"
    assert res["note"]["kind"] == "list"


def test_checklist_rpc_methods_are_whitelisted(service):
    """ALLOWED_METHODS 가 보안 경계다. 새 메서드는 여기 올라야 닿을 수 있고,
    올리지 않은 이름은 여전히 닿을 수 없어야 한다."""
    assert "update_checklist" in ks.ALLOWED_METHODS
    # create_checklist 는 없앴다. 이 앱은 Keep 의 List 를 새로 만들지 않는다 —
    # 체크리스트는 메모 본문 텍스트 안의 규약이다. 이름이 다시 슬며시 돌아오면
    # 여기서 걸린다.
    assert "create_checklist" not in ks.ALLOWED_METHODS
    assert not hasattr(ks.KeepService, "create_checklist")
    # 화이트리스트에 없는 내부 헬퍼는 여전히 부를 수 없다.
    for hidden in ["_validate_items", "_serialize_items", "_is_checklist"]:
        res = ks.handle(service, json.dumps({"id": 1, "method": hidden, "params": {}}))
        assert res["error"]["code"] == "UNKNOWN_METHOD", hidden


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


# --- 보관 처리 ---------------------------------------------------------------
#
# Keep 의 '보관처리'다. 지우는 것이 아니라 치워 두는 것이라 trash 와는 전혀 다른
# 경로이고, node.archived 는 setter 가 있어 색과 같은 update_note 로 나간다.


def test_update_archived_true_then_false_round_trips(account):
    """보관했다가 해제하면 원래대로 돌아와야 한다."""
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    assert created["archived"] is False

    res = _call(account, "update_note", id=created["id"], archived=True)["result"]
    assert res["note"]["archived"] is True

    res = _call(account, "update_note", id=created["id"], archived=False)["result"]
    assert res["note"]["archived"] is False


def test_update_archived_only_leaves_text_untouched_and_reports_no_conflict(account):
    """보관만 바꾸는 요청은 text=None 으로 들어온다. 색만 바꿀 때와 같은 모양이어야
    하고, 충돌로 오탐하면 안 된다."""
    created = _call(account, "create_note", title="t", text="유지될 본문")["result"]["note"]
    res = _call(account, "update_note", id=created["id"], archived=True)["result"]
    assert res["note"]["text"] == "유지될 본문"
    assert res["note"]["title"] == "t"
    assert res["conflict"] is False
    assert res["sentText"] == "유지될 본문"


def test_update_archived_rejects_non_boolean(account):
    """참/거짓이 아닌 값은 BAD_REQUEST 다.

    bool(archived) 로 슬쩍 변환하면 안 된다: 문자열 "false" 는 파이썬에서 참이라,
    해제하려던 요청이 조용히 보관으로 뒤집힌다.
    """
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    for bad in ["false", "true", 1, 0, "", None if False else []]:
        res = _call(account, "update_note", id=created["id"], archived=bad)
        assert res["error"]["code"] == "BAD_REQUEST", f"{bad!r} 이 통과했다"
    # 전부 거절됐으니 노드는 손대지 않은 채로 남아야 한다.
    notes = _call(account, "list_notes")["result"]["notes"]
    assert notes[0]["archived"] is False


def test_update_archived_together_with_text_applies_both(account):
    created = _call(account, "create_note", title="t", text="원본")["result"]["note"]
    res = _call(account, "update_note", id=created["id"], text="수정본", archived=True)["result"]
    assert res["note"]["text"] == "수정본"
    assert res["note"]["archived"] is True


def test_archived_note_still_appears_in_list_notes(account):
    """사이드카는 보관 여부를 가리지 않고 전부 준다. **이것이 맞다** — 걸러
    버리면 앱이 보관된 메모를 볼 수도 해제할 수도 없어져, 보관하는 순간 되돌릴
    길이 사라진다. 감추는 대신 맨 위 묶음으로 올려 구분한다."""
    created = _call(account, "create_note", title="보관될 메모", text="본문")["result"]["note"]
    _call(account, "update_note", id=created["id"], archived=True)

    notes = _call(account, "list_notes")["result"]["notes"]
    found = [n for n in notes if n["id"] == created["id"]]
    assert len(found) == 1, "보관됐다고 목록에서 사라지면 안 된다"
    assert found[0]["archived"] is True


def test_update_archived_works_on_a_checklist(account):
    """체크리스트도 보관할 수 있어야 한다. 본문 쓰기 가드에 걸리면 안 된다 —
    그 가드는 text 에만 해당한다."""
    created = _make_list(account, title="장보기", items=[{"text": "우유"}])
    res = _call(account, "update_note", id=created["id"], archived=True)["result"]
    assert res["note"]["archived"] is True
    # 항목은 그대로여야 한다 — 보관은 내용을 건드리지 않는다.
    assert [i["text"] for i in res["note"]["items"]] == ["우유"]


# --- 목록 정렬 ---------------------------------------------------------------


def test_list_notes_sorts_by_created_newest_first(account):
    """작성일 내림차순이다 — 최근에 쓴 메모가 위로."""
    first = _call(account, "create_note", title="먼저 쓴 것", text="a")["result"]["note"]
    second = _call(account, "create_note", title="나중에 쓴 것", text="b")["result"]["note"]

    notes = _call(account, "list_notes")["result"]["notes"]
    ids = [n["id"] for n in notes]
    assert ids.index(second["id"]) < ids.index(first["id"])


def test_editing_an_old_note_does_not_move_it_to_the_top(account):
    """**이 테스트가 updated 정렬과 갈리는 지점이다.**

    예전에는 updated 기준이라, 몇 달 전 메모를 한 글자만 고쳐도 맨 위로 튀어
    올라왔다. 목록의 순서가 "언제 쓴 글인가"가 아니라 "마지막으로 건드린 때"가
    되어 사용자가 기억하는 자리에 메모가 없었다.
    """
    old = _call(account, "create_note", title="오래된 것", text="a")["result"]["note"]
    new = _call(account, "create_note", title="새 것", text="b")["result"]["note"]

    # 오래된 쪽을 지금 고친다 → updated 는 최신이 되지만 created 는 그대로다.
    _call(account, "update_note", id=old["id"], text="고침")
    # 대역은 편집으로 updated 를 밀어 주지 않으므로 여기서 직접 민다. 이 한 줄이
    # 있어야 "updated 기준이었다면 순서가 뒤집혔을" 상황이 실제로 만들어진다 —
    # 없으면 이 테스트는 옛 구현에서도 통과해 버려 아무것도 지키지 못한다.
    import datetime
    account._keep.nodes[old["id"]].timestamps.updated += datetime.timedelta(days=365)

    ids = [n["id"] for n in _call(account, "list_notes")["result"]["notes"]]
    assert ids.index(new["id"]) < ids.index(old["id"]), "고쳤다고 위로 올라오면 안 된다"


def test_list_notes_carries_both_created_and_updated(account):
    """created 는 정렬과 화면 표시에, updated 는 동기화 판단에 쓰인다."""
    _call(account, "create_note", title="t", text="본문")
    note = _call(account, "list_notes")["result"]["notes"][0]
    assert "created" in note and "updated" in note
    # 갓 만든 메모는 둘이 같은 순간이다. 형식이 같은지(둘 다 isoformat) 본다.
    assert note["created"][:10] == note["updated"][:10]


def test_sync_notes_uses_the_same_order_as_list_notes(account):
    """[동기화] 를 눌렀다고 목록 순서가 바뀌면 무엇이 기준인지 알 수 없다."""
    for i in range(3):
        _call(account, "create_note", title=f"메모{i}", text="본문")
    listed = [n["id"] for n in _call(account, "list_notes")["result"]["notes"]]
    synced = [n["id"] for n in _call(account, "sync_notes")["result"]["notes"]]
    assert listed == synced


def test_archived_notes_come_first_then_newest_created(account):
    """보관된 것이 맨 위 묶음, 그 안에서도 밖에서도 작성일 최신순."""
    a = _call(account, "create_note", title="1번", text="x")["result"]["note"]
    b = _call(account, "create_note", title="2번", text="x")["result"]["note"]
    c = _call(account, "create_note", title="3번", text="x")["result"]["note"]
    d = _call(account, "create_note", title="4번", text="x")["result"]["note"]

    # 가장 먼저 만든 것과 세 번째로 만든 것을 보관한다.
    _call(account, "update_note", id=a["id"], archived=True)
    _call(account, "update_note", id=c["id"], archived=True)

    ids = [n["id"] for n in _call(account, "list_notes")["result"]["notes"]]
    # 보관된 둘이 위로(그 안에서 c 가 a 보다 나중에 만들어졌으므로 위),
    # 그 아래로 보관 안 된 둘이 최신순(d, b).
    assert ids == [c["id"], a["id"], d["id"], b["id"]]


def test_archiving_an_old_note_puts_it_on_top(account):
    """보관은 작성일과 무관하게 위 묶음으로 올린다 — 그것이 '가장 위' 규칙이다."""
    old = _call(account, "create_note", title="오래된 것", text="x")["result"]["note"]
    _call(account, "create_note", title="새 것", text="x")

    before = [n["id"] for n in _call(account, "list_notes")["result"]["notes"]]
    assert before[0] != old["id"], "보관 전에는 아래에 있다"

    _call(account, "update_note", id=old["id"], archived=True)
    after = [n["id"] for n in _call(account, "list_notes")["result"]["notes"]]
    assert after[0] == old["id"], "보관하면 맨 위로"


def test_unarchiving_returns_it_to_the_created_order(account):
    """해제하면 작성일 자리로 돌아간다 — 보관이 순서를 영구히 바꾸지 않는다."""
    old = _call(account, "create_note", title="오래된 것", text="x")["result"]["note"]
    new = _call(account, "create_note", title="새 것", text="x")["result"]["note"]

    _call(account, "update_note", id=old["id"], archived=True)
    _call(account, "update_note", id=old["id"], archived=False)

    ids = [n["id"] for n in _call(account, "list_notes")["result"]["notes"]]
    assert ids == [new["id"], old["id"]]


# --- 인증 실패 분류 -----------------------------------------------------------
#
# 사용자가 실제로 겪은 증상: [동기화] 를 눌렀더니 상태 줄에 "동기화하지
# 못했습니다: LoginException: BadAuthentication" 이라는 파이썬 예외 문자열이
# 그대로 찍혔다. 인증이 만료된 것인데 렌더러는 그것을 알 수 없어 재로그인
# 안내도, 재로그인 통로도 뜨지 않았다.


def test_login_failure_during_sync_is_auth_required(account):
    """**이 테스트가 그 버그를 고정한다.**

    AuthRequired 그물은 _require_keep 의 최초 authenticate() 하나만 감싼다.
    이미 인증된 세션이 도중에 거절당하면(토큰 갱신 실패) 그 예외는 그물 밖으로
    나가 맨 아래 except 의 INTERNAL 이 됐다. 렌더러는 code 로만 분기하므로
    INTERNAL 로는 재로그인이 필요한 상황임을 알 수 없다.
    """
    _call(account, "create_note", title="t", text="본문")
    account._keep.sync_error = ks.gkeepapi.exception.LoginException("BadAuthentication")

    res = _call(account, "sync_notes")
    assert res["error"]["code"] == "AUTH_REQUIRED"
    assert "BadAuthentication" in res["error"]["message"]


def test_browser_login_required_is_also_auth_required(account):
    """BrowserLoginRequiredException 은 LoginException 의 하위라 같이 걸린다."""
    _call(account, "create_note", title="t", text="본문")
    account._keep.sync_error = ks.gkeepapi.exception.BrowserLoginRequiredException("need browser")

    assert _call(account, "sync_notes")["error"]["code"] == "AUTH_REQUIRED"


def test_non_auth_sync_failure_is_still_internal(account):
    """인증과 무관한 실패까지 AUTH_REQUIRED 로 뭉뚱그리면 안 된다 — 그러면
    네트워크가 끊겼을 뿐인데 로그인 창이 뜬다."""
    _call(account, "create_note", title="t", text="본문")
    account._keep.sync_error = RuntimeError("network unreachable")

    res = _call(account, "sync_notes")
    assert res["error"]["code"] == "INTERNAL"
    assert "network unreachable" in res["error"]["message"]


# --- 실패한 쓰기가 로컬에 남지 않는다 -----------------------------------------
#
# 사용자가 실제로 겪은 증상: "구글 Keep 의 보관 항목과 앱의 보관 항목이 서로
# 일치하지 않습니다." gkeepapi 는 node.archived = True 같은 대입을 그 자리에서
# 메모리에 반영하고 서버로 보내는 것은 sync() 다. sync 가 실패하면 서버는 그
# 변경을 모르는데 이 세션의 노드는 바뀐 채로 남고, list_notes 는 sync 를 부르지
# 않으므로 앱은 Keep 에 존재한 적 없는 상태를 계속 보여준다.


def test_failed_write_drops_the_local_session(account):
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    keep = account._keep  # 버려지기 전에 붙잡아 둔다
    keep.sync_error = RuntimeError("network unreachable")

    res = _call(account, "update_note", id=created["id"], archived=True)
    assert res["error"]["code"] == "INTERNAL"

    # 로컬 노드는 이미 바뀌어 있다. 이것이 어긋남의 씨앗이다.
    assert keep.nodes[created["id"]].archived is True
    # 그래서 세션을 통째로 버린다 — 다음 호출의 _require_keep 이 authenticate 로
    # 서버 상태를 새로 받아 오므로, 서버가 모르는 보관 상태가 살아남지 못한다.
    assert account._keep is None


def test_failed_write_drops_the_session_on_auth_failure_too(account):
    """인증 만료로 실패한 경우도 같다 — 실제로 보고된 조합이 이쪽이다."""
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    keep = account._keep
    keep.sync_error = ks.gkeepapi.exception.LoginException("BadAuthentication")

    res = _call(account, "update_note", id=created["id"], archived=True)
    assert res["error"]["code"] == "AUTH_REQUIRED"
    assert account._keep is None


def test_failed_trash_also_drops_the_local_session(account):
    """update_note 만이 아니다. 노드를 먼저 고치고 미는 경로는 전부 같다."""
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    account._keep.sync_error = RuntimeError("boom")

    assert _call(account, "trash_note", id=created["id"])["error"]["code"] == "INTERNAL"
    assert account._keep is None


def test_successful_write_keeps_the_session(account):
    """성공한 저장까지 세션을 버리면 저장할 때마다 재인증한다."""
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    keep = account._keep
    _call(account, "update_note", id=created["id"], archived=True)
    assert account._keep is keep


def test_failed_sync_notes_keeps_the_session(account):
    """[동기화]는 로컬을 고치지 않는다 — 버릴 것이 없으므로 세션을 유지한다.

    네트워크가 잠깐 끊겼다고 다음 호출에서 재인증 왕복을 치를 이유가 없다.
    """
    _call(account, "create_note", title="t", text="본문")
    keep = account._keep
    keep.sync_error = RuntimeError("network unreachable")

    assert _call(account, "sync_notes")["error"]["code"] == "INTERNAL"
    assert account._keep is keep


# --- 고정 (Keep 의 '고정됨') ---------------------------------------------------
#
# 이 앱의 압정(항상 위)과는 다른 것이다. 고정은 Keep 노트의 필드라 폰과 웹에도
# 그대로 가고 목록의 순서를 정한다. 압정은 이 PC 의 창을 다른 창 위에 띄울지일
# 뿐이라 state.json 의 alwaysOnTop 에만 산다 — 여기 오지 않는다.


def test_update_pinned_true_then_false_round_trips(account):
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    assert created["pinned"] is False

    res = _call(account, "update_note", id=created["id"], pinned=True)["result"]
    assert res["note"]["pinned"] is True

    res = _call(account, "update_note", id=created["id"], pinned=False)["result"]
    assert res["note"]["pinned"] is False


def test_update_pinned_rejects_non_boolean(account):
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    for bad in ["false", "true", 1, 0, []]:
        res = _call(account, "update_note", id=created["id"], pinned=bad)
        assert res["error"]["code"] == "BAD_REQUEST", f"{bad!r} 이 통과했다"
    assert _call(account, "list_notes")["result"]["notes"][0]["pinned"] is False


def test_list_order_is_pinned_then_archived_then_rest(account):
    """**요청받은 순서 그대로다: 고정 최신순 → 보관 최신순 → 일반 최신순.**"""
    a = _call(account, "create_note", title="1번", text="x")["result"]["note"]
    b = _call(account, "create_note", title="2번", text="x")["result"]["note"]
    c = _call(account, "create_note", title="3번", text="x")["result"]["note"]
    d = _call(account, "create_note", title="4번", text="x")["result"]["note"]
    e = _call(account, "create_note", title="5번", text="x")["result"]["note"]
    f = _call(account, "create_note", title="6번", text="x")["result"]["note"]

    _call(account, "update_note", id=a["id"], pinned=True)    # 고정, 가장 오래됨
    _call(account, "update_note", id=d["id"], pinned=True)    # 고정, 더 최근
    _call(account, "update_note", id=b["id"], archived=True)  # 보관, 오래됨
    _call(account, "update_note", id=e["id"], archived=True)  # 보관, 더 최근
    # c, f 는 그대로 (일반)

    ids = [n["id"] for n in _call(account, "list_notes")["result"]["notes"]]
    assert ids == [d["id"], a["id"],   # 고정 최신순
                   e["id"], b["id"],   # 보관 최신순
                   f["id"], c["id"]]   # 일반 최신순


def test_pinned_beats_archived_when_both(account):
    """둘 다 달린 메모는 고정 묶음에 선다 — 위 순서가 곧 우선순위다."""
    both = _call(account, "create_note", title="둘 다", text="x")["result"]["note"]
    later = _call(account, "create_note", title="나중에 만든 보관", text="x")["result"]["note"]

    _call(account, "update_note", id=both["id"], pinned=True, archived=True)
    _call(account, "update_note", id=later["id"], archived=True)

    ids = [n["id"] for n in _call(account, "list_notes")["result"]["notes"]]
    assert ids[0] == both["id"], "고정이 보관보다 위다"


def test_unpinning_returns_it_to_the_created_order(account):
    """해제하면 제자리로 돌아간다 — 고정이 순서를 영구히 바꾸지 않는다."""
    old = _call(account, "create_note", title="오래된 것", text="x")["result"]["note"]
    new = _call(account, "create_note", title="새 것", text="x")["result"]["note"]

    _call(account, "update_note", id=old["id"], pinned=True)
    assert _call(account, "list_notes")["result"]["notes"][0]["id"] == old["id"]

    _call(account, "update_note", id=old["id"], pinned=False)
    ids = [n["id"] for n in _call(account, "list_notes")["result"]["notes"]]
    assert ids == [new["id"], old["id"]]


def test_pinned_and_archived_can_be_set_together(account):
    created = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    res = _call(account, "update_note", id=created["id"], pinned=True, archived=True)["result"]
    assert res["note"]["pinned"] is True
    assert res["note"]["archived"] is True


# --- 라벨 (Keep 의 '라벨' = 카테고리) -----------------------------------------
#
# 라벨은 노트의 필드가 아니라 계정에 따로 사는 개체다. 노트는 그것을 참조할
# 뿐이고(다대다), 그래서 색이나 보관과 달리 자기 RPC 를 갖는다. 이름이 아니라
# id 로 다루는 것이 이 묶음 전체의 규칙이다 — 이름은 언제든 바뀔 수 있다.


def _make_label(account, name):
    return _call(account, "create_label", name=name)["result"]["label"]


def test_create_and_list_labels(account):
    _make_label(account, "업무")
    _make_label(account, "개인")

    labels = _call(account, "list_labels")["result"]["labels"]
    assert [item["name"] for item in labels] == ["개인", "업무"], "이름순이다"
    assert all(item["id"] for item in labels), "id 가 실려 있다"


def test_create_label_rejects_duplicate_name_case_insensitively(account):
    _make_label(account, "Work")
    for dup in ["Work", "work", "  WORK  "]:
        res = _call(account, "create_label", name=dup)
        assert res["error"]["code"] == "BAD_REQUEST", f"{dup!r} 이 통과했다"
    assert len(_call(account, "list_labels")["result"]["labels"]) == 1


def test_create_label_rejects_empty_or_overlong_name(account):
    for bad in ["", "   ", 42, None, [], "가" * (ks.LABEL_NAME_MAX + 1)]:
        res = _call(account, "create_label", name=bad)
        assert res["error"]["code"] == "BAD_REQUEST", f"{bad!r} 이 통과했다"
    assert _call(account, "list_labels")["result"]["labels"] == []


def test_label_name_is_trimmed(account):
    label = _make_label(account, "  업무  ")
    assert label["name"] == "업무"


def test_set_note_labels_replaces_the_whole_set(account):
    note = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    work = _make_label(account, "업무")
    personal = _make_label(account, "개인")

    res = _call(account, "set_note_labels", id=note["id"],
                label_ids=[work["id"], personal["id"]])["result"]
    assert [item["name"] for item in res["note"]["labels"]] == ["개인", "업무"]

    # 더하기가 아니라 갈아 끼우기다 — 하나만 보내면 나머지는 떨어진다.
    res = _call(account, "set_note_labels", id=note["id"], label_ids=[work["id"]])["result"]
    assert [item["name"] for item in res["note"]["labels"]] == ["업무"]

    res = _call(account, "set_note_labels", id=note["id"], label_ids=[])["result"]
    assert res["note"]["labels"] == []


def test_set_note_labels_is_idempotent(account):
    note = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    work = _make_label(account, "업무")
    for _ in range(3):
        res = _call(account, "set_note_labels", id=note["id"], label_ids=[work["id"]])["result"]
        assert [item["id"] for item in res["note"]["labels"]] == [work["id"]]


def test_set_note_labels_rejects_unknown_id_without_touching_the_note(account):
    """모르는 id 를 조용히 건너뛰면 사용자가 고른 분류 중 일부가 신호 없이 사라진다.
    게다가 노드를 반쯤 고쳐 놓고 터지면 안 된다 — 검증이 먼저다."""
    note = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    work = _make_label(account, "업무")
    _call(account, "set_note_labels", id=note["id"], label_ids=[work["id"]])

    res = _call(account, "set_note_labels", id=note["id"],
                label_ids=[work["id"], "tag.없는것"])
    assert res["error"]["code"] == "BAD_REQUEST"
    after = _call(account, "list_notes")["result"]["notes"][0]
    assert [item["id"] for item in after["labels"]] == [work["id"]], "그대로여야 한다"


def test_set_note_labels_rejects_bad_shapes(account):
    note = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    for bad in ["문자열", 42, None, [123], [""], [None]]:
        res = _call(account, "set_note_labels", id=note["id"], label_ids=bad)
        assert res["error"]["code"] == "BAD_REQUEST", f"{bad!r} 이 통과했다"


def test_set_note_labels_tolerates_duplicates(account):
    """체크박스 화면이 실수로 만들 수 있는 모양이고, 뜻이 모호하지 않다."""
    note = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    work = _make_label(account, "업무")
    res = _call(account, "set_note_labels", id=note["id"],
                label_ids=[work["id"], work["id"]])["result"]
    assert [item["id"] for item in res["note"]["labels"]] == [work["id"]]


def test_rename_label_updates_it_everywhere(account):
    """**이름이 아니라 id 로 다루는 이유가 이것이다.** 이름을 바꿔도 붙어 있던
    메모의 분류가 그대로 따라와야 한다."""
    note = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    label = _make_label(account, "업무")
    _call(account, "set_note_labels", id=note["id"], label_ids=[label["id"]])

    renamed = _call(account, "rename_label", id=label["id"], name="회사")["result"]["label"]
    assert renamed["id"] == label["id"], "id 는 그대로다"
    assert renamed["name"] == "회사"

    after = _call(account, "list_notes")["result"]["notes"][0]
    assert [item["name"] for item in after["labels"]] == ["회사"]


def test_rename_label_rejects_a_name_another_label_already_has(account):
    a = _make_label(account, "업무")
    _make_label(account, "개인")
    res = _call(account, "rename_label", id=a["id"], name="개인")
    assert res["error"]["code"] == "BAD_REQUEST"


def test_rename_label_allows_changing_only_the_case_of_its_own_name(account):
    """자기 자신과 부딪히는 것은 막지 않는다 — 대소문자만 고치는 흔한 경우다."""
    label = _make_label(account, "work")
    res = _call(account, "rename_label", id=label["id"], name="Work")["result"]["label"]
    assert res["name"] == "Work"


def test_rename_unknown_label_is_not_found(account):
    assert _call(account, "rename_label", id="tag.없는것", name="x")["error"]["code"] == "NOT_FOUND"


def test_delete_label_removes_it_from_every_note(account):
    """메모는 지워지지 않는다. 분류만 사라진다."""
    a = _call(account, "create_note", title="1", text="x")["result"]["note"]
    b = _call(account, "create_note", title="2", text="x")["result"]["note"]
    label = _make_label(account, "업무")
    _call(account, "set_note_labels", id=a["id"], label_ids=[label["id"]])
    _call(account, "set_note_labels", id=b["id"], label_ids=[label["id"]])

    assert _call(account, "delete_label", id=label["id"])["result"] == {"ok": True}

    notes = _call(account, "list_notes")["result"]["notes"]
    assert len(notes) == 2, "메모는 그대로 있다"
    assert all(n["labels"] == [] for n in notes), "분류만 떨어진다"
    assert _call(account, "list_labels")["result"]["labels"] == []


def test_delete_unknown_label_is_not_found(account):
    assert _call(account, "delete_label", id="tag.없는것")["error"]["code"] == "NOT_FOUND"


def test_labels_are_sorted_by_name_on_a_note(account):
    """대역의 all() 은 붙인 순서를 그대로 준다 — 직렬화가 이름순으로 다시 세운다."""
    note = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    later = _make_label(account, "하하")
    earlier = _make_label(account, "가가")
    _call(account, "set_note_labels", id=note["id"], label_ids=[later["id"], earlier["id"]])

    after = _call(account, "list_notes")["result"]["notes"][0]
    assert [item["name"] for item in after["labels"]] == ["가가", "하하"]


def test_failed_label_write_drops_the_local_session(account):
    """라벨도 노드를 먼저 고치고 미는 경로다 — 실패한 쓰기가 남으면 안 된다."""
    note = _call(account, "create_note", title="t", text="본문")["result"]["note"]
    label = _make_label(account, "업무")
    account._keep.sync_error = RuntimeError("network unreachable")

    res = _call(account, "set_note_labels", id=note["id"], label_ids=[label["id"]])
    assert res["error"]["code"] == "INTERNAL"
    assert account._keep is None
