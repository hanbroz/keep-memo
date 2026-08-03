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

    def find(self, **kwargs):
        return iter([n for n in self.nodes.values() if not n.trashed])

    def sync(self, resync=False):
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


def test_text_note_serializes_unchanged_except_for_kind(account):
    """text 노트의 직렬화 결과는 예전 그대로여야 한다.

    새 필드는 kind 하나뿐이고, items 키는 **생기면 안 된다** — 렌더러는 kind 로
    분기하지만, 여기에 빈 items 가 딸려 오면 "항목이 하나도 없는 체크리스트"와
    구별되지 않는다.
    """
    created = _call(account, "create_note", title="제목", text="본문")["result"]["note"]
    assert set(created) == {"id", "title", "text", "color", "pinned", "archived",
                            "updated", "kind"}
    assert created["kind"] == "note"
    assert "items" not in created
    # 예전 일곱 필드의 값도 그대로다.
    assert created["title"] == "제목"
    assert created["text"] == "본문"
    assert created["color"] == "Yellow"
    assert created["pinned"] is False
    assert created["archived"] is False
    assert created["updated"] == "2026-07-30T09:00:00"


def test_create_checklist_with_items(account):
    res = _call(account, "create_checklist", title="장보기",
                items=[{"text": "우유", "checked": False},
                       {"text": "빵", "checked": True}])["result"]["note"]
    assert res["kind"] == "list"
    assert res["title"] == "장보기"
    assert [i["text"] for i in res["items"]] == ["우유", "빵"]
    assert [i["checked"] for i in res["items"]] == [False, True]
    # 항목마다 안정적인 id 가 있어야 한다 — 순서나 글자가 아니라 이것으로 짝을 찾는다.
    assert all(i["id"] for i in res["items"])
    assert len({i["id"] for i in res["items"]}) == 2


def test_create_checklist_appears_in_list_notes_as_a_list(account):
    _call(account, "create_checklist", title="장보기", items=[{"text": "우유"}])
    notes = _call(account, "list_notes")["result"]["notes"]
    assert len(notes) == 1
    assert notes[0]["kind"] == "list"
    # text 는 gkeepapi 의 List.text 그대로다(항목을 이어 붙인 것). 목록 창의
    # 검색이 항목 글자까지 훑을 수 있는 것이 이 덕이다.
    assert "우유" in notes[0]["text"]


def test_create_checklist_without_items_is_empty(account):
    res = _call(account, "create_checklist", title="빈 목록")["result"]["note"]
    assert res["kind"] == "list"
    assert res["items"] == []


def test_toggle_item_checked(account):
    created = _call(account, "create_checklist", title="장보기",
                    items=[{"text": "우유", "checked": False},
                           {"text": "빵", "checked": False}])["result"]["note"]
    items = [dict(i) for i in created["items"]]
    items[0]["checked"] = True
    res = _call(account, "update_checklist", id=created["id"], items=items)["result"]
    assert res["conflict"] is False
    assert [i["checked"] for i in res["note"]["items"]] == [True, False]
    # 글자는 건드리지 않았다.
    assert [i["text"] for i in res["note"]["items"]] == ["우유", "빵"]


def test_edit_item_text(account):
    created = _call(account, "create_checklist", title="장보기",
                    items=[{"text": "우유"}])["result"]["note"]
    items = [dict(i) for i in created["items"]]
    items[0]["text"] = "우유 2L"
    res = _call(account, "update_checklist", id=created["id"], items=items)["result"]
    assert res["conflict"] is False
    assert res["note"]["items"][0]["text"] == "우유 2L"
    # id 는 그대로다 — 글자를 고쳤다고 새 항목이 되면 안 된다.
    assert res["note"]["items"][0]["id"] == created["items"][0]["id"]


def test_update_checklist_can_change_title_too(account):
    """제목 칸은 두 종류 모두에 있다. 체크리스트도 제목을 갖는다."""
    created = _call(account, "create_checklist", title="원래 제목",
                    items=[{"text": "우유"}])["result"]["note"]
    res = _call(account, "update_checklist", id=created["id"],
                title="새 제목", items=created["items"])["result"]
    assert res["note"]["title"] == "새 제목"
    assert res["conflict"] is False


def test_update_checklist_detects_conflict_when_server_overrides(account):
    """sync 도중 다른 기기가 항목을 고쳤다면 충돌로 잡혀야 한다 — update_note 의
    sentText 판정과 같은 뜻이다."""
    created = _call(account, "create_checklist", title="장보기",
                    items=[{"text": "우유"}])["result"]["note"]

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
    created = _call(account, "create_checklist", title="장보기",
                    items=[{"text": "우유", "checked": False}])["result"]["note"]
    res = _call(account, "update_checklist", id=created["id"], items=bad_items)
    assert res["error"]["code"] == "BAD_REQUEST"
    # 거절됐으니 노드는 손대지 않은 채로 남아야 한다.
    after = _call(account, "list_notes")["result"]["notes"][0]
    assert after["items"] == created["items"]


def test_update_checklist_rejects_partial_application(account):
    """항목 셋 중 둘째가 잘못됐으면 첫째도 적용되면 안 된다. 검증은 노드를
    건드리기 **전에** 전부 끝나야 한다(update_note 의 색 검증과 같은 이유)."""
    created = _call(account, "create_checklist", title="장보기",
                    items=[{"text": "우유"}, {"text": "빵"}])["result"]["note"]
    items = [dict(i) for i in created["items"]]
    items[0]["text"] = "적용되면 안 되는 값"
    items[1]["checked"] = "true"  # 무효
    res = _call(account, "update_checklist", id=created["id"], items=items)
    assert res["error"]["code"] == "BAD_REQUEST"
    after = _call(account, "list_notes")["result"]["notes"][0]
    assert [i["text"] for i in after["items"]] == ["우유", "빵"]


def test_update_checklist_unknown_item_id_is_bad_request(account):
    """이 체크리스트에 없는 항목 id 는 조용히 건너뛰지 않는다."""
    created = _call(account, "create_checklist", title="장보기",
                    items=[{"text": "우유"}])["result"]["note"]
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


def test_create_checklist_rejects_client_supplied_item_id(account):
    """항목 id 는 Keep 이 정한다. 렌더러가 정해 보내면 거절한다."""
    res = _call(account, "create_checklist", title="장보기",
                items=[{"id": "내가정한id", "text": "우유"}])
    assert res["error"]["code"] == "BAD_REQUEST"


def test_update_note_cannot_write_text_of_a_checklist(account):
    """List.text 는 읽기 전용 프로퍼티라 대입하면 AttributeError 가 난다.
    INTERNAL 스택 트레이스가 아니라 BAD_REQUEST 로 걸러져야 한다."""
    created = _call(account, "create_checklist", title="장보기",
                    items=[{"text": "우유"}])["result"]["note"]
    res = _call(account, "update_note", id=created["id"], text="본문으로 덮어쓰기")
    assert res["error"]["code"] == "BAD_REQUEST"
    after = _call(account, "list_notes")["result"]["notes"][0]
    assert [i["text"] for i in after["items"]] == ["우유"]


def test_update_note_can_still_change_a_checklists_title_and_color(account):
    """제목과 색은 두 종류 모두에 있다. 체크리스트라고 막을 이유가 없다."""
    created = _call(account, "create_checklist", title="원래 제목",
                    items=[{"text": "우유"}])["result"]["note"]
    res = _call(account, "update_note", id=created["id"],
                title="새 제목", color="Blue")["result"]
    assert res["note"]["title"] == "새 제목"
    assert res["note"]["color"] == "Blue"
    assert res["note"]["kind"] == "list"


def test_checklist_rpc_methods_are_whitelisted(service):
    """ALLOWED_METHODS 가 보안 경계다. 새 메서드는 여기 올라야 닿을 수 있고,
    올리지 않은 이름은 여전히 닿을 수 없어야 한다."""
    assert "create_checklist" in ks.ALLOWED_METHODS
    assert "update_checklist" in ks.ALLOWED_METHODS
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
