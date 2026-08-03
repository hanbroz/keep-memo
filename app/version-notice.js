'use strict'

// 두 번째 인스턴스가 실행되면(app.on('second-instance', ...)) 그 인스턴스의
// 버전과 지금 잠금을 쥐고 있는(=실행 중인) 인스턴스의 버전을 비교해, 사용자에게
// 보여줄 안내 다이얼로그의 문구를 정한다.
//
// dialog.showMessageBox 호출도, app.getVersion() 호출도 여기서 하지 않는다 —
// Electron 을 띄우지 않고도 "버전이 같은가/다른가"와 "다르면 뭐라고 보여줄
// 것인가"라는 순수한 판단만 테스트할 수 있어야 하기 때문이다. email-validate.js,
// note-patch.js, bookmark-text.js 와 같은 관례다.
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
      '두 버전이 함께 떠 있으면 설정과 포스트잇이 꼬일 수 있습니다.\n' +
      '계속하려면 먼저 지금 실행 중인 것을 종료한 뒤 새로 실행해 주세요.'
  }
}

module.exports = { extractIncomingVersion, describeVersionMismatch }
