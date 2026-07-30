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
