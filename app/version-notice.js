'use strict'
const path = require('node:path')

// 두 번째 인스턴스가 실행되면(app.on('second-instance', ...)) 그 인스턴스의
// 버전과 지금 잠금을 쥐고 있는(=실행 중인) 인스턴스의 버전을 비교해, 사용자에게
// 보여줄 안내 다이얼로그의 문구를 정한다.
//
// dialog.showMessageBox 호출도, app.getVersion() 호출도 여기서 하지 않는다 —
// Electron 을 띄우지 않고도 "버전이 같은가/다른가"와 "다르면 뭐라고 보여줄
// 것인가"라는 순수한 판단만 테스트할 수 있어야 하기 때문이다. email-validate.js,
// note-patch.js, bookmark-text.js 와 같은 관례다. node:path 는 Node 코어일 뿐
// Electron 이 아니므로 이 전제를 깨지 않는다 — require.cache 에 electron 경로가
// 안 남는다는 아래 테스트가 그 사실을 지킨다.
//
// scripts/build.js 가 매 빌드마다 package.json 의 version 을
// "yyyy.MMdd.HHmm" 형태로 바꿔 심으므로(--config.extraMetadata.version),
// app.getVersion() 은 빌드마다 달라진다 — 이 파일이 기대는 전제다.

/**
 * app.on('second-instance', (event, argv, workingDirectory, additionalData) => ...)
 * 의 네 번째 인자에서 버전 문자열을 뽑는다.
 *
 * additionalData 는 unknown 이다: 두 번째 인스턴스가 이 기능이 없는(옛) 빌드라면
 * app.requestSingleInstanceLock() 을 인자 없이 불러 애초에 아무것도 안 보내고,
 * Electron 은 그 경우 additionalData 로 빈 객체를 준다. 어느 쪽이든 버전을
 * 확실히 알 수 없는 상태이므로, 문자열이 아니면 "모른다"(null)로 취급한다.
 * 모르는 채로 조용히 통과시켜 버리면(=버전이 같다고 가정하면) 이 기능이 막으려는
 * 바로 그 상황(오래된 빌드가 소리 없이 이긴다)이 재현되므로, 모른다는 사실 자체를
 * 다이얼로그에서 드러내는 쪽(describeVersionMismatch 가 불일치로 판단)을 택한다.
 *
 * @param {unknown} additionalData
 * @returns {string | null}
 */
function extractIncomingVersion (additionalData) {
  if (!additionalData || typeof additionalData !== 'object') return null
  const value = /** @type {{ version?: unknown }} */ (additionalData).version
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 실행 중인 인스턴스의 버전과 새로 시작하려던 인스턴스의 버전을 비교한다.
 *
 * 같으면 조용히 넘어가는 것이 맞다(기존 동작 그대로) — 사용자는 그냥 앱을 한 번
 * 더 보고 싶었을 뿐이다. 다르면(또는 상대 버전을 모르면) 실행 중인 인스턴스가
 * 그 사실을 다이얼로그로 알려야 한다 — 두 버전이 같이 뜨면 설정 파일과 포스트잇
 * 위치가 꼬일 수 있기 때문이다.
 *
 * detail 은 "무슨 일이 있었는가"(버전이 다르다)까지만 말한다. "누르면 무슨 일이
 * 일어나는가"(자동으로 재시작되는지, 직접 다시 실행해야 하는지)는 재시작 가능
 * 여부(decideQuitAction)에 달려 있어 이 함수가 알 수 없는 정보다 — 그 문구는
 * describeQuitAction 이 따로 만들고, 호출자가 이 detail 뒤에 이어 붙인다.
 *
 * @param {string} runningVersion - app.getVersion() (지금 잠금을 쥔 인스턴스)
 * @param {string | null} incomingVersion - extractIncomingVersion() 의 결과
 * @returns {{ matches: true } | { matches: false, message: string, detail: string }}
 */
function describeVersionMismatch (runningVersion, incomingVersion) {
  if (incomingVersion !== null && incomingVersion === runningVersion) {
    return { matches: true }
  }

  const incomingLabel = incomingVersion === null ? '알 수 없음(구버전으로 추정)' : incomingVersion
  return {
    matches: false,
    message: '실행 중인 것과 다른 버전의 Keep Sticky 를 새로 시작하려고 합니다.',
    detail:
      `지금 실행 중인 버전: ${runningVersion}\n` +
      `새로 시작하려는 버전: ${incomingLabel}\n\n` +
      '두 버전이 함께 떠 있으면 설정과 포스트잇이 꼬일 수 있습니다.'
  }
}

// --- 재실행(relaunch) -------------------------------------------------------
//
// 예전에는 사용자가 [실행 중인 것 종료하기]를 누르면 실행 중이던(첫 번째)
// 인스턴스가 app.quit() 만 하고 끝났다. 그런데 사용자가 실제로 실행한 것은 방금
// 받은 새 exe(두 번째 인스턴스)였고, 그 두 번째 인스턴스는 잠금 획득에
// 실패해 이미 module scope 에서 조용히 죽어 있었다 — 그래서 첫 번째가 종료하고
// 나면 아무것도 안 떠 있게 된다. "종료했으면 앱을 실행해야 한다"는 요구는 첫
// 번째 인스턴스가 자기 자신을 새 exe 로 재실행해야만 채워진다
// (app.relaunch({ execPath })). 두 번째 인스턴스가 죽기 전에 자기가 어떤 exe
// 였는지를 additionalData 에 실어 보내야 하는 이유가 이것이다.
//
// 포터블 빌드에서 "자기가 어떤 exe 였는지"는 프로세스 이미지 경로
// (process.execPath) 가 아니다 — 포터블 exe 는 %TEMP% 밑에 자신을 통째로
// 압축 해제한 뒤 그 복사본을 실행하므로, process.execPath 는 사용자가 두 번
// 클릭한 KeepSticky-*.exe 가 아니라 electron-builder 의 NSIS 래퍼가 정리해
// 버릴 임시 디렉터리 안의 사본을 가리킨다. electron-builder 의 portable
// 타겟(app-builder-lib/templates/nsis/portable.nsi)은 압축을 풀기 전에
// `PORTABLE_EXECUTABLE_FILE` 환경 변수를 원본 exe 의 경로($EXEPATH)로 설정해
// 자식 프로세스에 물려준다 — 이것이 재실행에 써야 할 진짜 경로다.

/**
 * additionalData 에서 재실행에 쓸 실행 파일 경로를 뽑는다.
 *
 * additionalData 는 IPC 로 다른 프로세스가 보낸 값이다 — "새 빌드"라고 주장할
 * 뿐인 신뢰할 수 없는 입력이라, app.relaunch() 에 그대로 넘기기 전에 모양을
 * 검증한다: 절대 경로여야 하고 확장자가 .exe 여야 한다. 존재 여부(그 경로에
 * 실제로 파일이 있는가)는 파일시스템 접근이라 이 함수의 책임이 아니다 —
 * decideQuitAction() 이 주입받은 checkExists 로 그 다음 단계에서 확인한다.
 *
 * additionalData 가 이 필드를 아예 안 보냈다면(이 기능이 없는 옛 빌드, 또는
 * PORTABLE_EXECUTABLE_FILE 이 없는 개발 실행) 조용히 null 을 돌려준다 —
 * extractIncomingVersion() 과 같은 관례다.
 *
 * @param {unknown} additionalData
 * @returns {string | null}
 */
function extractRelaunchExecPath (additionalData) {
  if (!additionalData || typeof additionalData !== 'object') return null
  const value = /** @type {{ execPath?: unknown }} */ (additionalData).execPath
  if (typeof value !== 'string' || value.length === 0) return null
  if (!path.isAbsolute(value)) return null
  if (path.extname(value).toLowerCase() !== '.exe') return null
  return value
}

/**
 * 버전이 다른 두 번째 인스턴스가 실행됐을 때, 지금 실행 중인(첫 번째) 인스턴스가
 * 사용자가 [종료]를 눌렀을 때 무엇을 할지 정한다.
 *
 * checkExists 를 인자로 받는 이유: 이 모듈은 Electron 없이(그리고 실제
 * 파일시스템 없이) require·테스트되어야 한다는 원칙을 유지하려면 fs.existsSync
 * 를 여기서 직접 부를 수 없다. 호출자(main.js)가 fs.existsSync 를 그대로
 * 넘긴다 — 테스트에서는 실제 파일 없이 원하는 답을 돌려주는 가짜 함수를 넣는다.
 *
 * 경로 형식이 애초에 잘못됐으면(extractRelaunchExecPath 가 null) checkExists 를
 * 부르지도 않는다 — 존재 확인은 형식이 맞는 경로에만 의미가 있다.
 *
 * @param {unknown} additionalData
 * @param {(execPath: string) => boolean} checkExists - 보통 fs.existsSync
 * @returns {{ action: 'relaunch', execPath: string } | { action: 'quit-notice' }}
 */
function decideQuitAction (additionalData, checkExists) {
  const execPath = extractRelaunchExecPath(additionalData)
  if (execPath === null) return { action: 'quit-notice' }
  if (!checkExists(execPath)) return { action: 'quit-notice' }
  return { action: 'relaunch', execPath }
}

/**
 * decideQuitAction() 의 결과에 맞춰 다이얼로그에 쓸 버튼 라벨과, detail 뒤에
 * 이어 붙일 안내 문장을 정한다.
 *
 * 버튼 라벨이 갈리는 이유: "실행 중인 것 종료하기"는 재실행이 자동으로
 * 뒤따르지 않는 경우에는 정확한 설명이지만, 재실행이 뒤따르는 경우에는 실제로
 * 일어나는 일의 절반만 말한다 — 버튼을 누르면 종료와 동시에 새 버전이 뜬다는
 * 사실이 빠진다.
 *
 * 재실행이 불가능한 경우, "말하지 않고 종료"가 이 기능이 고치는 원래 문제였다.
 * 버튼을 누르면 지금 실행 중이던 것이 사라지고 그 뒤로 아무것도 뜨지 않으므로,
 * 그 사실과 "새 버전을 직접 다시 실행해야 한다"는 안내는 반드시 이 시점(=
 * 아직 무언가 떠 있어서 사용자에게 보여줄 수 있는 마지막 순간)에 해야 한다 —
 * 종료된 뒤에는 이 안내를 보여줄 창도 프로세스도 없다.
 *
 * @param {{ action: 'relaunch', execPath: string } | { action: 'quit-notice' }} quitAction
 * @returns {{ buttonLabel: string, callToAction: string }}
 */
function describeQuitAction (quitAction) {
  if (quitAction.action === 'relaunch') {
    return {
      buttonLabel: '종료하고 새 버전 실행하기',
      callToAction: '아래 버튼을 누르면 지금 실행 중인 것을 종료하고, 새 버전이 자동으로 시작됩니다.'
    }
  }
  return {
    buttonLabel: '실행 중인 것 종료하기',
    callToAction:
      '자동으로 다시 시작할 수 없습니다. 아래 버튼을 누르면 지금 실행 중인 것이 종료됩니다.\n' +
      '종료 후에는 새 버전을 직접 다시 실행해 주세요.'
  }
}

module.exports = {
  extractIncomingVersion,
  describeVersionMismatch,
  extractRelaunchExecPath,
  decideQuitAction,
  describeQuitAction
}
