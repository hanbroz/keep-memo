'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  extractIncomingVersion,
  describeVersionMismatch,
  extractRelaunchExecPath,
  decideQuitAction,
  describeQuitAction
} = require('../version-notice')

// 이 파일 전체에서 쓰는 "형식은 유효한" 포터블 exe 경로. Windows 절대 경로 +
// .exe 확장자 — 사용자가 실제로 두 번 클릭했을 KeepSticky-*.exe 를 흉내낸다.
const VALID_EXEC_PATH = 'C:\\Users\\hb\\Downloads\\KeepSticky-2026.08.03.1200.exe'

// --- extractIncomingVersion -------------------------------------------------

test('additionalData 가 { version: string } 이면 그 문자열을 그대로 뽑는다', () => {
  assert.strictEqual(extractIncomingVersion({ version: '2026.803.1200' }), '2026.803.1200')
})

test('additionalData 가 undefined 면(옛 빌드가 아무것도 안 보낸 경우) null 이다', () => {
  assert.strictEqual(extractIncomingVersion(undefined), null)
})

test('additionalData 가 빈 객체면 null 이다', () => {
  assert.strictEqual(extractIncomingVersion({}), null)
})

test('additionalData 가 객체가 아니면(null, 문자열, 숫자, 배열) null 이다', () => {
  for (const bad of [null, 'not-an-object', 42, []]) {
    assert.strictEqual(extractIncomingVersion(bad), null, `${JSON.stringify(bad)} 는 null 이어야 한다`)
  }
})

test('version 필드가 문자열이 아니면(숫자, null 등) null 이다', () => {
  assert.strictEqual(extractIncomingVersion({ version: 123 }), null)
  assert.strictEqual(extractIncomingVersion({ version: null }), null)
})

test('version 필드가 빈 문자열이면 null 이다', () => {
  assert.strictEqual(extractIncomingVersion({ version: '' }), null)
})

// --- describeVersionMismatch -------------------------------------------------

test('두 버전이 같으면 matches: true 이고 그 외 필드가 없다', () => {
  const res = describeVersionMismatch('2026.803.1200', '2026.803.1200')
  assert.deepStrictEqual(res, { matches: true })
})

test('두 버전이 다르면 matches: false 이고 둘 다 message/detail 에 등장한다', () => {
  const res = describeVersionMismatch('2026.803.1200', '2026.803.900')
  assert.strictEqual(res.matches, false)
  assert.ok(res.message)
  assert.ok(res.detail.includes('2026.803.1200'))
  assert.ok(res.detail.includes('2026.803.900'))
})

test('들어온 버전을 모르면(null) 안전한 쪽으로 불일치 취급한다', () => {
  const res = describeVersionMismatch('2026.803.1200', null)
  assert.strictEqual(res.matches, false)
  assert.ok(res.detail.includes('2026.803.1200'))
  // 모른다는 사실 자체가 드러나야 한다 — 조용히 아무 버전이나 채워 넣지 않는다.
  assert.ok(!res.detail.includes('null'))
  assert.ok(!res.detail.includes('undefined'))
})

test('실행 중인 버전이 빈 문자열이어도 던지지 않는다(방어적)', () => {
  const res = describeVersionMismatch('', '2026.803.1200')
  assert.strictEqual(res.matches, false)
})

// --- extractRelaunchExecPath -------------------------------------------------

test('additionalData 에 절대 경로 + .exe 인 execPath 가 있으면 그대로 뽑는다', () => {
  assert.strictEqual(
    extractRelaunchExecPath({ execPath: VALID_EXEC_PATH }),
    VALID_EXEC_PATH
  )
})

test('execPath 가 없으면(옛 빌드, 또는 개발 실행이라 PORTABLE_EXECUTABLE_FILE 이 없음) null 이다', () => {
  assert.strictEqual(extractRelaunchExecPath({ version: '2026.803.1200' }), null)
  assert.strictEqual(extractRelaunchExecPath({}), null)
  assert.strictEqual(extractRelaunchExecPath(undefined), null)
})

test('execPath 가 문자열이 아니면(숫자, null, 객체 등) null 이다', () => {
  assert.strictEqual(extractRelaunchExecPath({ execPath: 42 }), null)
  assert.strictEqual(extractRelaunchExecPath({ execPath: null }), null)
  assert.strictEqual(extractRelaunchExecPath({ execPath: {} }), null)
})

test('execPath 가 상대 경로면 null 이다', () => {
  assert.strictEqual(extractRelaunchExecPath({ execPath: 'KeepSticky.exe' }), null)
  assert.strictEqual(extractRelaunchExecPath({ execPath: '..\\KeepSticky.exe' }), null)
})

test('execPath 확장자가 .exe 가 아니면 null 이다', () => {
  assert.strictEqual(extractRelaunchExecPath({ execPath: 'C:\\Users\\hb\\KeepSticky.bat' }), null)
  assert.strictEqual(extractRelaunchExecPath({ execPath: 'C:\\Users\\hb\\KeepSticky' }), null)
})

test('execPath 가 빈 문자열이면 null 이다', () => {
  assert.strictEqual(extractRelaunchExecPath({ execPath: '' }), null)
})

// --- decideQuitAction ---------------------------------------------------------

test('경로가 형식도 맞고 실제로 존재하면 relaunch 를 고른다', () => {
  const res = decideQuitAction({ execPath: VALID_EXEC_PATH }, () => true)
  assert.deepStrictEqual(res, { action: 'relaunch', execPath: VALID_EXEC_PATH })
})

test('경로 형식은 맞지만 그 자리에 파일이 없으면(예: 이미 지워진 다운로드) quit-notice 를 고른다', () => {
  const res = decideQuitAction({ execPath: VALID_EXEC_PATH }, () => false)
  assert.deepStrictEqual(res, { action: 'quit-notice' })
})

test('execPath 를 아예 못 뽑으면(형식이 틀렸거나 없음) checkExists 를 부르지도 않고 quit-notice 를 고른다', () => {
  const checkExists = () => { throw new Error('형식이 틀린 경로에는 존재 확인이 불필요하다') }
  assert.deepStrictEqual(decideQuitAction({}, checkExists), { action: 'quit-notice' })
  assert.deepStrictEqual(decideQuitAction({ execPath: 'relative.exe' }, checkExists), { action: 'quit-notice' })
  assert.deepStrictEqual(decideQuitAction(undefined, checkExists), { action: 'quit-notice' })
})

// --- describeQuitAction --------------------------------------------------------

test('relaunch 일 때는 버튼 문구와 안내에 자동 재시작이 드러난다', () => {
  const { buttonLabel, callToAction } = describeQuitAction({ action: 'relaunch', execPath: VALID_EXEC_PATH })
  assert.ok(buttonLabel.includes('종료'))
  assert.ok(buttonLabel.includes('실행') || buttonLabel.includes('시작'))
  assert.ok(callToAction.includes('자동'))
})

test('quit-notice 일 때는 버튼이 종료만 말하고, 안내는 직접 다시 실행하라고 알린다', () => {
  const { buttonLabel, callToAction } = describeQuitAction({ action: 'quit-notice' })
  assert.strictEqual(buttonLabel, '실행 중인 것 종료하기')
  assert.ok(callToAction.includes('직접'))
  assert.ok(callToAction.includes('다시 실행'))
})

test('두 액션의 버튼 문구는 서로 다르다 — 자동 재시작 여부가 버튼에 드러나야 한다', () => {
  const relaunch = describeQuitAction({ action: 'relaunch', execPath: VALID_EXEC_PATH })
  const quitNotice = describeQuitAction({ action: 'quit-notice' })
  assert.notStrictEqual(relaunch.buttonLabel, quitNotice.buttonLabel)
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof extractIncomingVersion, 'function')
  assert.strictEqual(typeof describeVersionMismatch, 'function')
  assert.strictEqual(typeof extractRelaunchExecPath, 'function')
  assert.strictEqual(typeof decideQuitAction, 'function')
  assert.strictEqual(typeof describeQuitAction, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
