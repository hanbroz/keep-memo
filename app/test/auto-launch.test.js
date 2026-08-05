'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { decideAutoLaunch } = require('../auto-launch')

const EXE = 'D:\\Apps\\KeepSticky-2026.08.05.17.59.exe'

test('켜져 있으면 포터블 원본 exe 를 건다', () => {
  assert.deepStrictEqual(decideAutoLaunch(true, EXE), { action: 'enable', path: EXE })
})

test('꺼져 있으면 끈다 — 끌 때도 같은 경로를 함께 준다', () => {
  // Electron 문서: path 를 주고 걸었다면 읽을 때도 같은 path 를 줘야 한다.
  // 걸 때와 끌 때의 모양이 어긋나면 "껐는데 안 꺼진" 상태가 생긴다.
  assert.deepStrictEqual(decideAutoLaunch(false, EXE), { action: 'disable', path: EXE })
})

test('개발 실행(포터블 경로 없음)에서는 시작 프로그램을 건드리지 않는다', () => {
  // **이 검사가 이 파일에서 제일 중요하다.** 여기서 skip 하지 않으면 npm start
  // 한 번이 node_modules 안의 electron.exe 를 윈도우 시작 프로그램에 등록하고,
  // 개발자는 재부팅할 때마다 뜨는 빈 Electron 창을 영영 달고 산다.
  for (const missing of [undefined, null, '', '   ', 0, false, {}, []]) {
    const decision = decideAutoLaunch(true, missing)
    assert.strictEqual(decision.action, 'skip', `${JSON.stringify(missing)} 는 skip 이어야 한다`)
    assert.ok(decision.reason, 'skip 에는 이유가 붙어야 한다')
  }
})

test('개발 실행에서는 끄지도 않는다', () => {
  // 개발 실행 한 번이 사용자가 켜 둔 설정을 말없이 지우면 안 된다.
  assert.strictEqual(decideAutoLaunch(false, '').action, 'skip')
})

test('경로의 앞뒤 공백은 떼고 건다', () => {
  assert.deepStrictEqual(decideAutoLaunch(true, `  ${EXE}  `), { action: 'enable', path: EXE })
})

test('업데이트로 exe 이름이 바뀌면 새 exe 를 건다', () => {
  // 이 앱의 exe 이름에는 빌드 시각이 들어 있고, 자동 업데이트는 새 exe 를 옆에
  // 받아 그것으로 재시작한다. 뜰 때마다 다시 걸기 때문에 그 재시작이 이 경로를
  // 지나며 최신으로 낫는다 — 안 그러면 재부팅 때마다 옛 버전이 조용히 뜬다.
  const older = 'D:\\Apps\\KeepSticky-2026.08.05.16.52.exe'
  const newer = 'D:\\Apps\\KeepSticky-2026.08.05.17.59.exe'
  assert.strictEqual(decideAutoLaunch(true, older).path, older)
  assert.strictEqual(decideAutoLaunch(true, newer).path, newer)
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof decideAutoLaunch, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
