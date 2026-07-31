# PyInstaller 스펙. 사용자 PC 에 Python 설치를 요구하지 않기 위해 단일 실행파일로 만든다.
#
# gpsoauth 는 import 시점에 importlib.metadata.version("urllib3") 과
# version("gpsoauth") 를 호출해 자기 버전을 확인한다. PyInstaller 는 기본적으로
# 배포본에 .dist-info 메타데이터를 담지 않으므로, 이를 넣어주지 않으면 빌드는
# 성공하지만 실행 시 "PackageNotFoundError: No package metadata was found for
# gpsoauth" 로 즉시 죽는다 — keyring 백엔드 문제와 같은 종류의, 개발 환경에서는
# 절대 재현되지 않는 배포본 전용 실패다.
from PyInstaller.utils.hooks import copy_metadata

a = Analysis(
    ["keep_service.py"],
    pathex=[],
    binaries=[],
    datas=copy_metadata("gpsoauth") + copy_metadata("urllib3"),
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
