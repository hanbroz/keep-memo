"""개인 Google 계정의 Keep 메모를 실제로 가져올 수 있는지 확인하는 검증 스크립트.

공식 Google Keep API(keep.googleapis.com)는 Workspace 전용이라 개인 @gmail.com 계정에서
쓸 수 없다. 이 스크립트는 비공식 클라이언트 gkeepapi(안드로이드 Keep 앱이 쓰는 내부 API)로
개인 계정 접근이 되는지를 실제로 확인한다.

사용법:
    pip install gkeepapi gpsoauth keyring

    # 1) 최초 1회 - 앱 비밀번호로 master token 발급 후 OS 자격증명 저장소에 보관
    python keep_probe.py login you@gmail.com

    # 2) 메모 조회 - 라벨로 "특정 메모"만 필터
    python keep_probe.py list you@gmail.com
    python keep_probe.py list you@gmail.com --label memo-app
    python keep_probe.py list you@gmail.com --label memo-app --dump

앱 비밀번호는 2단계 인증을 켠 뒤 https://myaccount.google.com/apppasswords 에서 발급한다.
"""

import argparse
import getpass
import json
import sys

import gkeepapi
import gpsoauth
import keyring

SERVICE = "keep_probe"
# ponytail: gpsoauth는 안드로이드 기기 ID를 요구한다. 고정 더미값이면 충분하고,
# 계정당 하나로 유지해야 Google이 매번 새 기기 로그인으로 보지 않는다.
DEVICE_ID = "0123456789abcdef"


def fmt_note(note) -> str:
    """메모 한 줄 요약. P=고정, A=보관."""
    flags = "".join(c for c, on in (("P", note.pinned), ("A", note.archived)) if on)
    title = note.title or "(제목없음)"
    return f"  - [{flags:2}] {title:40.40} | {note.timestamps.updated:%Y-%m-%d}"


def cmd_selfcheck() -> int:
    """자격증명 없이 돌릴 수 있는 유일한 검증. gkeepapi 노드 스키마가 바뀌면 여기서 깨진다."""
    n = gkeepapi.node.Note()
    n.title = "테스트 메모"
    assert fmt_note(n).startswith("  - [  ] 테스트 메모"), fmt_note(n)
    n.pinned, n.archived = True, True
    assert fmt_note(n).startswith("  - [PA]"), fmt_note(n)
    n.title = ""
    assert "(제목없음)" in fmt_note(n)
    assert isinstance(n.save(), dict) and "timestamps" in n.save()
    assert callable(gkeepapi.Keep.labels) and callable(gkeepapi.Keep.findLabel)
    print(f"[성공] selfcheck 통과 (gkeepapi {gkeepapi.__version__})")
    return 0


def cmd_roundtrip(email: str) -> int:
    """실계정 왕복 검증: 생성 -> 읽기 -> 수정 -> 확인 -> 휴지통 -> 확인.

    설계 문서 §7 R3(쓰기가 Keep에 반영되는가)를 사람 개입 없이 확인한다.
    생성 이후 어느 단계에서 실패하든(assert 실패 포함) 테스트 노트를 실계정에
    남기지 않도록 정리한다. `delete()`는 절대 쓰지 않는다 - 항상 `trash()`만 쓴다.
    """
    token = keyring.get_password(SERVICE, email)
    if not token:
        print(f"[실패] 저장된 토큰 없음. 먼저 `python keep_probe.py cookie {email}` 실행.",
              file=sys.stderr)
        return 1

    keep = gkeepapi.Keep()
    keep.authenticate(email, token, device_id=DEVICE_ID)

    note_id = None
    try:
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
        # 여기서 바로 성공을 선언하지 않는다. trash()는 로컬 timestamp만 바꾸고,
        # 위의 create/update 단계와 달리 서버가 실제로 받아들였는지 아직 확인 전이다.
        # create/update와 동일한 패턴으로 resync 후 재조회해 서버 상태로 검증한다.
        keep.sync(resync=True)
        trashed_check = keep.get(note_id)
        assert trashed_check is not None, "휴지통 이동 후 노트를 서버에서 다시 찾지 못함"
        assert trashed_check.trashed, (
            f"서버가 휴지통 상태를 반영하지 않음: trashed={trashed_check.trashed!r}"
        )
        print("  4. 휴지통 이동 확인 (재조회한 서버 상태로 검증, Keep 휴지통에서 7일간 복구 가능)")
        print("[성공] 왕복 검증 통과 - 생성/수정/휴지통 3종 쓰기가 모두 서버에 반영됨 (R3 해소)")
        return 0
    finally:
        # 위 블록에서 assert가 실패하거나 예외가 나도 이 finally는 실행된다.
        # note_id가 잡힌 뒤라면(=노트가 실제로 생성됐다면) 실계정에 남지 않도록 trash()로 정리한다.
        # 정리 자체의 실패는 원래 예외를 가리지 않도록 별도로만 보고한다(assert는 건드리지 않음).
        if note_id is not None:
            try:
                keep.sync(resync=True)
                leftover = keep.get(note_id)
                if leftover is not None and not leftover.trashed:
                    leftover.trash()
                    keep.sync()
                    print(f"  [정리] 실패 경로 감지 - 테스트 노트(id={note_id})를 휴지통으로 이동함")
            except Exception as cleanup_err:  # noqa: BLE001 - 원본 예외를 가리지 않기 위해 여기서만 흡수
                print(
                    f"[실패] 정리 중 추가 오류 발생(id={note_id}, 계정에서 수동 확인 필요): {cleanup_err}",
                    file=sys.stderr,
                )


def _store(email: str, token: str) -> int:
    keyring.set_password(SERVICE, email, token)
    print(f"[성공] master token 발급 완료 ({token[:8]}...) "
          f"-> OS 자격증명 저장소({keyring.get_keyring().name})에 보관됨.")
    print("      이 토큰은 계정 전체 권한을 가진 장기 자격증명입니다. 파일/깃에 남기지 마세요.")
    print(f"      다음: python keep_probe.py list {email}")
    return 0


def cmd_login(email: str, echo: bool) -> int:
    print("2단계 인증 -> 앱 비밀번호(16자리)를 입력하세요. 일반 계정 비밀번호는 실패합니다.")
    # ponytail: getpass는 콘솔이 아니면(IDE 실행/파이프) 무한 대기한다. 그때는 그냥 input().
    # --echo는 붙여넣기가 실제로 들어갔는지 눈으로 확인해야 할 때만 쓴다(입력이 화면에 보임).
    ask = input if echo or not sys.stdin.isatty() else getpass.getpass
    raw = ask("app password: ")
    app_password = raw.replace(" ", "").strip()

    # 진단: 입력이 제대로 잡혔는지 vs 구글이 거부한 건지 구분하는 유일한 근거.
    print(f"  [진단] 입력 길이 {len(raw)} -> 공백제거 후 {len(app_password)}자 "
          f"(정상값 16), 영문소문자만={app_password.isalpha() and app_password.islower()}")
    if len(app_password) != 16:
        print("  [경고] 16자가 아닙니다. 붙여넣기가 안 들어갔거나 잘렸습니다. --echo 로 다시 시도하세요.",
              file=sys.stderr)

    res = gpsoauth.perform_master_login(email, app_password, DEVICE_ID)
    token = res.get("Token")
    if not token:
        print(f"[실패] master token 발급 불가. 구글 원본 응답: {res}", file=sys.stderr)
        print("      길이가 16이었는데도 BadAuthentication이면 -> 구글이 이 계정에 대해 앱 비밀번호",
              file=sys.stderr)
        print("      master login을 막은 것. `python keep_probe.py cookie <email>` 경로로 우회하세요.",
              file=sys.stderr)
        return 1
    return _store(email, token)


def cmd_cookie(email: str) -> int:
    """앱 비밀번호 경로가 막혔을 때의 우회: 브라우저 oauth_token 쿠키를 master token으로 교환.

    oauth_token은 1회용이고 ~60초 만에 만료된다. 그래서 이 명령을 먼저 띄워
    입력 대기 상태로 만들어 둔 뒤 브라우저 작업을 해야 한다.
    """
    print("!! oauth_token은 1회용, 유효시간 약 60초. 이 창을 켜 둔 채로 아래를 진행하세요.\n")
    print("1. 시크릿 창에서 https://accounts.google.com/EmbeddedSetup 접속 -> 계정 로그인")
    print("2. '동의' 클릭. -> 화면이 멈춘 것처럼 계속 로딩됩니다. 정상입니다. 무시하세요.")
    print("3. F12 -> Application(애플리케이션) -> Cookies -> https://accounts.google.com")
    print("4. 'oauth_token' 행의 Value를 복사 (값은 'oauth2_4/' 로 시작)")
    print("5. 즉시 아래에 붙여넣기\n")
    raw = input("oauth_token: ").strip()

    print(f"  [진단] 입력 {len(raw)}자, 접두사 정상={raw.startswith('oauth2_4/')}")
    if not raw.startswith("oauth2_4/"):
        print("  [경고] 'oauth2_4/'로 시작하지 않습니다. 다른 쿠키를 복사했을 수 있습니다.",
              file=sys.stderr)

    res = gpsoauth.exchange_token(email, raw, DEVICE_ID)
    token = res.get("Token")
    if not token:
        print(f"[실패] 토큰 교환 실패. 구글 원본 응답: {res}", file=sys.stderr)
        print("      BadAuthentication -> 60초를 넘겼거나 이미 사용된 토큰. 2~5단계를 처음부터 다시.",
              file=sys.stderr)
        return 1
    return _store(email, token)


def cmd_list(email: str, label: str | None, dump: bool) -> int:
    token = keyring.get_password(SERVICE, email)
    if not token:
        print(f"[실패] 저장된 토큰 없음. 먼저 `python keep_probe.py login {email}` 실행.", file=sys.stderr)
        return 1

    keep = gkeepapi.Keep()
    keep.authenticate(email, token, device_id=DEVICE_ID)

    print(f"라벨 목록: {[l.name for l in keep.labels()] or '(없음)'}")

    if label:
        found = keep.findLabel(label)
        if found is None:
            print(f"[실패] '{label}' 라벨이 계정에 없습니다.", file=sys.stderr)
            return 1
        notes = list(keep.find(labels=[found]))
    else:
        notes = list(keep.find())

    print(f"메모 {len(notes)}건" + (f" (라벨={label})" if label else " (전체)"))
    for n in notes:
        print(fmt_note(n))
        if dump:
            print(json.dumps(n.save(), ensure_ascii=False, indent=2, default=str))
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    lg = sub.add_parser("login", help="앱 비밀번호로 master token 발급")
    lg.add_argument("email")
    lg.add_argument("--echo", action="store_true", help="입력한 비밀번호를 화면에 표시(붙여넣기 확인용)")

    ck = sub.add_parser("cookie", help="앱 비밀번호가 막혔을 때: 브라우저 쿠키로 토큰 교환")
    ck.add_argument("email")

    ls = sub.add_parser("list", help="메모 조회")
    ls.add_argument("email")
    ls.add_argument("--label", help="이 라벨이 붙은 메모만 조회")
    ls.add_argument("--dump", action="store_true", help="메모 원본 JSON 출력")

    sub.add_parser("selfcheck", help="계정 없이 라이브러리 동작만 확인")

    rt = sub.add_parser("roundtrip", help="실계정 왕복 검증 (생성/수정/삭제)")
    rt.add_argument("email")

    a = p.parse_args()
    if a.cmd == "selfcheck":
        return cmd_selfcheck()
    if a.cmd == "login":
        return cmd_login(a.email, a.echo)
    if a.cmd == "cookie":
        return cmd_cookie(a.email)
    if a.cmd == "roundtrip":
        return cmd_roundtrip(a.email)
    return cmd_list(a.email, a.label, a.dump)


if __name__ == "__main__":
    sys.exit(main())
