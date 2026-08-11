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
// --- 무엇을 거는가 ----------------------------------------------------------
//
// NSIS 설치본의 process.execPath, 즉 설치 자리(%LOCALAPPDATA%\Programs\…)의
// exe 다. 이름도 자리도 빌드마다 같으므로 한 번 걸면 계속 유효하다.
//
// 예전 portable 빌드에서는 이것을 쓸 수 없었다. 그때의 process.execPath 는
// **%TEMP% 밑의 압축 해제본**이었고, 그 폴더는 앱이 끝나면 지워져서 다음
// 재부팅에는 없는 파일을 가리켰다 — 오류 하나 없이 조용히 아무 일도 안 일어났다.
// 그래서 PORTABLE_EXECUTABLE_FILE 이라는 우회로가 필요했는데, 그 %TEMP% 삭제가
// 결국 앱을 실행 중에 망가뜨려 설치본으로 옮겼다(update-check.js 의 주석 참고).
//
// 부르는 쪽이 개발 실행에서는 빈 문자열을 넘긴다. 여기서는 비어 있는지만 본다.
//
// --- 왜 실행할 때마다 다시 거는가 -------------------------------------------
//
// 설치본에서는 경로가 고정이라 대개 같은 값을 다시 쓰는 셈이지만, **경로가
// 바뀌는 경우가 실제로 있다.** 포터블로 쓰던 사용자의 레지스트리에는 아직
// `D:\KeepSticky-<스탬프>.exe` 가 걸려 있다. 그 파일은 지워지지 않으므로 실패도
// 하지 않고, 재부팅 때마다 조용히 **옛 포터블이** 뜬다 — 방금 고친 문제로 그대로
// 돌아간다. 뜰 때마다 지금 실행 중인 exe 로 다시 걸면 설치본이 한 번 뜨는 것만으로
// 그 자리에서 낫는다. 레지스트리 값 이름은 앱 이름이라 항목이 쌓이지도 않는다.

/**
 * 지금 시작 프로그램 등록을 어떻게 해야 하는지 정한다.
 *
 * @param {boolean} enabled 사용자가 켜 두었는가 (state.json 의 autoLaunch)
 * @param {unknown} exePath 설치본이면 process.execPath, 개발 실행이면 빈 문자열
 * @returns {{action: 'skip', reason: string}
 *          | {action: 'enable', path: string}
 *          | {action: 'disable', path: string}}
 */
function decideAutoLaunch (enabled, exePath) {
  const exe = typeof exePath === 'string' ? exePath.trim() : ''

  // 설치본 실행이 아니다(npm start 같은 개발 실행). 시작 프로그램을 **건드리지
  // 않는다** — 켜지도 끄지도 않는다.
  //
  // 켜지 않는 이유: 개발 실행에서 걸릴 경로는 node_modules 안의 electron.exe 라,
  // 재부팅할 때마다 빈 Electron 창이 뜨고 개발자는 그것을 영영 달고 산다.
  // 끄지도 않는 이유: 개발 실행 한 번이 사용자가 켜 둔 설정을 말없이 지우면 안 된다.
  if (exe === '') {
    return { action: 'skip', reason: '설치본 실행이 아니라 시작 프로그램을 건드리지 않는다' }
  }

  // 끌 때도 경로를 함께 넘긴다. Electron 문서: path 를 주고 걸었다면 읽을 때도
  // 같은 path 를 줘야 openAtLogin 이 제대로 나온다 — 걸 때와 끌 때의 모양을
  // 어긋나게 두지 않는다.
  return enabled ? { action: 'enable', path: exe } : { action: 'disable', path: exe }
}

module.exports = { decideAutoLaunch }
