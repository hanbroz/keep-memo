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
    "set_account",
    "list_notes",
    "sync_notes",
    "create_note",
    "update_note",
    "update_checklist",
    "trash_note",
})
# create_checklist 는 없다. 이 앱이 만드는 메모는 언제나 text 노트다 —
# 체크리스트는 메모의 종류가 아니라 본문 텍스트 안의 규약이기 때문이다
# (app/renderer/line-model.js: "- [ ] 우유" / "- [x] 빵"). update_checklist 는
# 남아 있다: 사용자가 **폰에서 만들어 둔** 진짜 List 노트도 열려서 고칠 수
# 있어야 하고, List.text 는 읽기 전용이라 텍스트로는 쓸 수가 없기 때문이다.


class AuthRequired(Exception):
    """토큰이 없거나 무효하다. Electron 측은 로그인 창을 다시 띄운다."""


class NotFound(Exception):
    """요청한 노트가 없다."""


class BadRequest(Exception):
    """요청 자체가 잘못됐다. 예: Keep 팔레트에 없는 색 이름."""


def _is_checklist(node) -> bool:
    """이 노드가 체크리스트(gkeepapi 의 List)인가.

    Keep 의 노트는 Note **이거나** List 다. 둘은 TopLevelNode 밑의 형제 클래스고
    서로 변환할 수 없다 — Note 에는 항목을 추가하는 메서드가 아예 없고, type 에는
    setter 도 convert* 메서드도 없다. 그래서 이 판정은 한 번 정해지면 그 노트의
    수명 내내 바뀌지 않는다.

    isinstance 대신 node.type 을 보는 이유: 이 값은 gkeepapi 가 노드를 만들 때
    심는 NodeType 열거형 그대로이고, 테스트의 대역 노드도 같은 열거형을 그대로
    들고 있으면 실제와 같은 경로를 지난다. type 이 없는 객체(옛 대역)는 조용히
    text 노트로 떨어진다 — 새 필드가 없다고 죽지 않는 쪽이 맞다.
    """
    return getattr(node, "type", None) is gkeepapi.node.NodeType.List


def _serialize(node) -> dict:
    """Keep 노드를 RPC 로 넘길 수 있는 평평한 dict 로 변환한다.

    서식 정보는 Keep 에 존재하지 않으므로 여기에도 없다. 위치/크기/서식은
    Electron 쪽 state.json 이 노트 id 를 키로 따로 들고 있다.

    kind 는 항상 실린다("note" 또는 "list"). items 는 체크리스트에만 실린다 —
    text 노트의 직렬화 결과는 kind 한 필드가 더 붙는 것 말고는 예전과 정확히
    같아야 하고, 특히 items 키가 생기면 안 된다. 렌더러는 그 키의 유무만으로도
    어느 쪽인지 알 수 있지만, 그 판단을 kind 하나로 몰아 둔다.

    체크리스트의 text 는 gkeepapi 가 만들어 주는 "☐ 우유\\n☑ 빵" 꼴이다. 우리가
    만드는 값이 아니라 List.text 프로퍼티가 항목들을 이어 붙인 것이며, 읽기
    전용이다 — 목록 창의 검색이 항목 글자까지 훑을 수 있는 것이 이 덕이다.
    """
    data = {
        "id": node.id,
        "title": node.title or "",
        "text": node.text or "",
        "color": node.color.name,
        "pinned": bool(node.pinned),
        "archived": bool(node.archived),
        "updated": node.timestamps.updated.isoformat(),
        "kind": "list" if _is_checklist(node) else "note",
    }
    if data["kind"] == "list":
        data["items"] = _serialize_items(node)
    return data


def _serialize_items(node) -> list:
    """체크리스트의 항목들을 {id, text, checked} 목록으로 만든다.

    id 는 gkeepapi 가 항목마다 들고 있는 안정적인 식별자다. 순서나 글자가 아니라
    이 id 로 짝을 찾아야 "우유"가 두 줄 있는 체크리스트에서도 사용자가 누른 그
    줄이 정확히 바뀐다.
    """
    return [
        {"id": item.id, "text": item.text or "", "checked": bool(item.checked)}
        for item in node.items
    ]


def _validate_items(raw) -> list:
    """렌더러가 보낸 항목 묶음을 검증하고 다듬는다.

    **이것이 update_note 의 색 검증과 같은 자리, 같은 성격의 코드다.** 렌더러는
    신뢰 경계의 바깥쪽이므로, 여기서 걸러지지 않은 값은 그대로 Keep 노드에
    쓰이거나 gkeepapi 안에서 AttributeError 로 터진다. 잘못된 payload 는 죽지도
    조용히 무시되지도 않고 BAD_REQUEST 로 떨어져야 한다.

    부르는 쪽은 반드시 **노드를 건드리기 전에** 이 함수를 통과시켜야 한다.
    항목 세 개 중 두 번째가 잘못됐을 때 첫 번째만 반쯤 적용된 채로 남으면 안 된다.

    유효한 모양:
      - 전체가 리스트다.
      - 항목 하나하나가 dict 다.
      - text 는 반드시 있고 문자열이다(빈 문자열은 유효하다 — 글자를 다 지운 줄).
      - checked 는 없으면 False, 있으면 진짜 bool 이어야 한다. isinstance(x, bool)
        로 보는 것이 핵심이다: 파이썬에서 True 는 int 이기도 해서 int 를 허용하면
        1/0 이 슬며시 통과한다.
      - id 는 반드시 있고 비어 있지 않은 문자열이며 겹칠 수 없다. 이 경로는
        **이미 있는 List 노트를 고치는 것뿐**이고 항목 id 는 Keep 이 정한다.
        (예전에는 create_checklist 를 위해 id 없는 모양도 받았다. 그 RPC 가
        사라지면서 이 갈래도 같이 없앴다 — 안 쓰이는 갈래는 검증되지 않는다.)
    """
    allowed = {"id", "text", "checked"}
    if not isinstance(raw, list):
        raise BadRequest(f"항목 묶음은 배열이어야 한다: {type(raw).__name__} 를 받았다")

    out = []
    seen_ids = set()
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise BadRequest(f"{index}번째 항목이 객체가 아니다: {type(entry).__name__}")

        unknown = sorted(set(entry) - allowed)
        if unknown:
            raise BadRequest(f"{index}번째 항목에 지원하지 않는 필드: {', '.join(unknown)}")

        text = entry.get("text")
        if not isinstance(text, str):
            raise BadRequest(f"{index}번째 항목의 text 는 문자열이어야 한다")

        checked = entry.get("checked", False)
        if not isinstance(checked, bool):
            raise BadRequest(f"{index}번째 항목의 checked 는 true/false 여야 한다")

        item_id = entry.get("id")
        if not isinstance(item_id, str) or item_id == "":
            raise BadRequest(f"{index}번째 항목의 id 가 없다")
        if item_id in seen_ids:
            raise BadRequest(f"항목 id 가 겹친다: {item_id}")
        seen_ids.add(item_id)
        out.append({"text": text, "checked": checked, "id": item_id})
    return out


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

    def sync_notes(self) -> dict:
        """Keep 서버와 맞춘 뒤 최신 목록을 돌려준다. list_notes 와 응답 모양은 같다.

        list_notes 는 세션의 첫 authenticate() 가 채워 둔 상태를 그대로 보여줄
        뿐이다 — 이 파일의 다른 sync() 호출은 전부 이 세션이 쓴 뒤에만
        일어나므로, 다른 기기(폰이나 keep.google.com)에서 생긴 변경, 특히
        **삭제**는 이 세션에 앉은 채로는 영영 반영되지 않는다. 사용자가 실제로
        겪은 증상이 그것이다: Keep 에서 지운 메모가 앱에는 계속 남아 있었다.

        keep.sync()(인자 없음, 델타 동기화)로 충분한지 keep.sync(resync=True)
        (전부 지우고 새로 받기)가 필요한지는 추측하지 않고 실제 계정으로
        확인했다: 세션 A 가 메모를 만들고 sync() 한 뒤, 독립적으로 인증한
        세션 B 가 그 메모를 trash() 하고 sync() 하면, 세션 A 가 델타
        sync()만 불러도 find() 결과에서 그 메모가 사라진다(gkeepapi 가 trashed
        상태 변경을 다른 필드 갱신과 똑같이 델타로 내려주고, find() 는 기본
        인자로 trashed 노드를 거르기 때문이다). 그래서 자원을 더 쓰는
        resync=True 대신 인자 없는 sync() 를 쓴다.

        sync() 가 실패하면(네트워크, 만료된 세션 등) 그 예외는 여기서 잡지
        않는다 — handle() 의 일반 except 가 INTERNAL 오류로 감싸 돌려주므로,
        실패가 조용히 빈 목록으로 보이는 일은 없다.
        """
        keep = self._require_keep()
        keep.sync()
        notes = [_serialize(n) for n in keep.find()]
        notes.sort(key=lambda n: n["updated"], reverse=True)
        return {"notes": notes}

    def create_note(self, title: str = "", text: str = "") -> dict:
        keep = self._require_keep()
        node = keep.createNote(title, text)
        keep.sync()
        return {"note": _serialize(node)}

    def update_checklist(self, id: str, items, title=None) -> dict:  # noqa: A002
        """**이미 있는** 체크리스트(Keep 의 List 노트)의 제목과 항목들을 고친다.

        이 앱은 List 를 새로 만들지 않는다. 체크리스트는 이제 메모 본문 텍스트
        안의 규약이기 때문이다(app/renderer/line-model.js). 그래도 사용자가
        폰에서 만들어 둔 List 노트는 이미 계정에 있고, 그것도 열려서 쓸 수 있어야
        한다 — List.text 는 항목을 이어 붙여 만드는 읽기 전용 프로퍼티라
        update_note 로는 손댈 수 없으므로 이 경로가 남는다.

        할 수 있는 것은 **체크 토글과 항목 글자 수정**이다. 추가/삭제/순서 바꾸기는
        여기 없다 — 없는 것이 조용히 되는 것보다 낫다. (포스트잇도 그 노트에서는
        줄을 더하거나 지우려는 키를 거절하고 이유를 알린다.)

        update_note 와 같은 순서를 지킨다: 검증을 전부 끝낸 뒤에야 노드를 건드리고,
        sync 뒤에 서버가 돌려준 값과 우리가 보낸 값을 비교해 충돌을 판정한다.
        """
        keep = self._require_keep()
        node = keep.get(id)
        if node is None:
            raise NotFound(id)
        if not _is_checklist(node):
            raise BadRequest(f"체크리스트가 아닌 메모다: {id}")

        entries = _validate_items(items)
        by_id = {item.id: item for item in node.items}
        missing = [e["id"] for e in entries if e["id"] not in by_id]
        if missing:
            # 조용히 건너뛰지 않는다. 여기서 무시하면 사용자가 방금 고친 줄이
            # 아무 신호 없이 사라진다 — 다른 기기가 그 항목을 지웠을 때 정확히
            # 그런 일이 벌어지고, 그때야말로 사용자가 알아야 할 때다.
            raise BadRequest(f"이 체크리스트에 없는 항목 id: {', '.join(missing)}")

        if title is not None:
            node.title = title
        for entry in entries:
            item = by_id[entry["id"]]
            item.text = entry["text"]
            item.checked = entry["checked"]
        sent_items = [dict(e) for e in entries]

        keep.sync()

        after = keep.get(id)
        if after is None:
            raise NotFound(id)
        # update_note 의 sentText 비교와 같은 뜻이다: sync 는 서버 판정 결과를
        # 로컬 노드에 덮어쓰므로, 우리가 보낸 것과 다르면 다른 기기의 편집이
        # 이겼다는 뜻이다. 다른 기기가 항목을 하나 더 넣었어도 길이가 달라져
        # 충돌로 잡힌다 — 우리가 보낼 수 없었던 항목이기 때문이다.
        # (dict 비교는 키 순서를 따지지 않으므로 두 목록을 그대로 견줄 수 있다.)
        return {
            "note": _serialize(after),
            "conflict": _serialize_items(after) != sent_items,
            "sentItems": sent_items,
        }

    def update_note(self, id: str, title=None, text=None, color=None) -> dict:  # noqa: A002
        keep = self._require_keep()
        node = keep.get(id)
        if node is None:
            raise NotFound(id)

        # 체크리스트의 본문은 여기로 오면 안 된다. List.text 는 항목들을 이어
        # 붙여 만드는 **읽기 전용** 프로퍼티라서, 대입하면 AttributeError 로
        # INTERNAL 오류가 난다. 색과 같은 방식으로 미리 걸러 BAD_REQUEST 를
        # 돌려준다 — 무엇을 잘못했는지 알 수 있는 오류가 스택 트레이스보다 낫다.
        if text is not None and _is_checklist(node):
            raise BadRequest(
                f"체크리스트의 본문은 update_note 로 바꿀 수 없다 (update_checklist 를 쓴다): {id}"
            )

        # 색은 자유 텍스트가 아니라 Keep 이 실제로 지원하는 12개 이름 중 하나다.
        # gkeepapi.node.ColorValue 의 멤버 이름과 대조하는 것 자체가 그 12개
        # 화이트리스트다 — 렌더러가 뭘 보내든 여기서 걸러진다. 노드를 건드리기
        # 전에 검증해, 색만 잘못됐을 뿐인 요청이 title/text 를 반쯤 적용한 채
        # 남기지 않게 한다.
        color_value = None
        if color is not None:
            try:
                color_value = gkeepapi.node.ColorValue[color]
            except KeyError:
                raise BadRequest(f"알 수 없는 색 이름: {color}")

        if title is not None:
            node.title = title
        if text is not None:
            node.text = text
        if color_value is not None:
            node.color = color_value
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

    if not isinstance(req, dict):
        return {"id": None, "error": {"code": "BAD_REQUEST",
                                       "message": f"요청은 JSON 객체여야 한다: {type(req).__name__} 를 받았다"}}

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
    except BadRequest as exc:
        return {"id": rid, "error": {"code": "BAD_REQUEST", "message": str(exc)}}
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
        # ensure_ascii=True: 응답을 \uXXXX 이스케이프로만 이루어진 순수 ASCII
        # 로 만든다. 한국어 Windows 콘솔의 기본 코드페이지(cp949)는 이모지 같은
        # BMP 밖 문자를 인코딩하지 못해, ensure_ascii=False 로 원문 그대로 쓰면
        # UnicodeEncodeError 로 사이드카가 즉사한다 — stdout 이 무슨 인코딩이든
        # ASCII 이스케이프는 항상 쓸 수 있으므로 이 경로는 스트림 인코딩에
        # 의존하지 않는다. Node 쪽 JSON.parse 는 \uXXXX 이스케이프를 그대로
        # 복원하므로 app/sidecar.js 는 변경할 필요가 없다.
        stdout.write(json.dumps(handle(service, line), ensure_ascii=True) + "\n")
        stdout.flush()


if __name__ == "__main__":
    # 실제 진입점에서만 전역 스트림을 재설정한다. serve() 는 스트림을 인자로
    # 받고 테스트가 자신의 스트림(cp949 등)을 넘기므로, 여기 말고 serve()
    # 안에서 sys.stdin/stdout 을 건드리면 테스트를 예측 불가능하게 만든다.
    #
    # 출력만 고치면 절반만 고친 것이다: sys.stdin 도 로캘 코드페이지를 물려받고
    # 있어서, Electron 이 UTF-8 로 써 보내는 한국어 노트 제목/본문(렌더러가
    # 입력한 텍스트)이 여기서 잘못 디코딩된다. 아직 아무도 못 봤을 뿐, 이 경로도
    # 살아있는 버그다. reconfigure 로 양방향 다 UTF-8 로 정직하게 맞춘다.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    serve(KeepService())
