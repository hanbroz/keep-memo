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
