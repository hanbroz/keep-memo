'use strict'

// "윈도우를 켜면 이 앱도 같이 뜬다"를 **무엇으로** 걸지 정하는 순수 함수.
//
// Electron 을 건드리지 않는다 — version-notice.js / update-check.js 와 같은
// 관례다. 실제로 레지스트리에 쓰는 것은 main.js 의 app.setLoginItemSettings()
// 이고, 여기서는 "무엇을 걸 것인가, 애초에 걸어도 되는가"만 정한다.
//
// --- 왜 기본으로 켜는가 -----------------------------------------------------
//
// 이 앱은 트레이에 상주하는 메모 앱이다. 바탕화면의 포스트잇은 재부팅해도
// 거기 있어야 쓸모가 있는데, 시작 프로그램에 없으면 재부팅 한 번에 전부
// 사라지고 사용자가 매번 직접 켜야 한다. 그래서 기본값이 켜짐이다(store.js 의
// getAutoLaunch). 끄는 길은 트레이 메뉴에 둔다 — 이 앱은 되돌릴 수 없는 것을
// 사용자에게 강요하지 않는다.
//
// --- 왜 process.execPath 를 쓰면 안 되는가 ---------------------------------
//
// setLoginItemSettings 는 path 를 안 주면 process.execPath 를 건다. 이 앱에서
// 그것은 **%TEMP% 밑의 압축 해제본**이다 — 포터블 exe 는 자기 자신을 임시
// 디렉터리에 풀고 그 사본을 실행하기 때문이다(version-notice.js 의 주석에
// 근거가 있다). 그 경로를 시작 프로그램으로 걸면 다음 재부팅에는 이미 정리된
// 파일을 가리켜 아무 일도 일어나지 않는다 — 그것도 오류 하나 없이 조용히.
//
// 걸어야 하는 것은 사용자가 두 번 클릭한 원본 exe, 즉 electron-builder 의
// portable 타겟이 넣어 주는 PORTABLE_EXECUTABLE_FILE 이다. 이 값은 우리
// 빌드 래퍼(NSIS)가 넣는 것이지 사용자 입력이 아니므로, 비어 있는지만 본다.
//
// --- 왜 실행할 때마다 다시 거는가 -------------------------------------------
//
// 이 앱의 exe 이름에는 빌드 시각이 들어 있다(KeepSticky-yyyy.MM.dd.HH.mm.exe).
// 자동 업데이트는 새 exe 를 **옆에** 받아 그것으로 재시작하고 옛 파일은 지우지
// 않는다("옛 파일은 남는다 — 지우는 것은 사용자 몫이다", main.js). 그래서 한 번
// 걸어 두고 끝내면 업데이트한 뒤에도 재부팅 때마다 계속 옛 버전이 뜬다 — 파일이
// 남아 있으니 실패하지도 않고, 어제 것이 조용히 뜬다. 최악의 모양이다.
//
// Electron 문서가 이 문제에 권하는 해법(버전과 무관한 stub 실행 파일을 걸어
// 두기)은 Squirrel 설치본 이야기라 포터블 빌드에는 쓸 수 없다 — 우리에겐 이름이
// 고정된 실행 파일이 없다. 대신 **뜰 때마다 지금 실행 중인 exe 로 다시 건다.**
// 레지스트리 값 이름은 앱 이름이라 빌드마다 같으므로 다시 걸면 옛 값을 덮어쓰고
// (버전마다 항목이 쌓이지 않는다), 업데이트 직후의 재시작도 이 경로를 그대로
// 지나므로 그 자리에서 최신으로 낫는다.

/**
 * 지금 시작 프로그램 등록을 어떻게 해야 하는지 정한다.
 *
 * @param {boolean} enabled 사용자가 켜 두었는가 (state.json 의 autoLaunch)
 * @param {unknown} portableExePath process.env.PORTABLE_EXECUTABLE_FILE
 * @returns {{action: 'skip', reason: string}
 *          | {action: 'enable', path: string}
 *          | {action: 'disable', path: string}}
 */
function decideAutoLaunch (enabled, portableExePath) {
  const exe = typeof portableExePath === 'string' ? portableExePath.trim() : ''

  // 포터블 실행이 아니다(npm start 같은 개발 실행). 시작 프로그램을 **건드리지
  // 않는다** — 켜지도 끄지도 않는다.
  //
  // 켜지 않는 이유: 개발 실행에서 걸릴 경로는 node_modules 안의 electron.exe 라,
  // 재부팅할 때마다 빈 Electron 창이 뜨고 개발자는 그것을 영영 달고 산다.
  // 끄지도 않는 이유: 개발 실행 한 번이 사용자가 켜 둔 설정을 말없이 지우면 안 된다.
  if (exe === '') {
    return { action: 'skip', reason: '포터블 실행이 아니라 시작 프로그램을 건드리지 않는다' }
  }

  // 끌 때도 경로를 함께 넘긴다. Electron 문서: path 를 주고 걸었다면 읽을 때도
  // 같은 path 를 줘야 openAtLogin 이 제대로 나온다 — 걸 때와 끌 때의 모양을
  // 어긋나게 두지 않는다.
  return enabled ? { action: 'enable', path: exe } : { action: 'disable', path: exe }
}

module.exports = { decideAutoLaunch }
