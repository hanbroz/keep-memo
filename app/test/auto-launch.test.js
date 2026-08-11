'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { decideAutoLaunch } = require('../auto-launch')

const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\keep-sticky\\Keep Sticky.exe'

test('켜져 있으면 지금 실행 중인 exe 를 건다', () => {
  assert.deepStrictEqual(decideAutoLaunch(true, EXE), { action: 'enable', path: EXE })
})

test('꺼져 있으면 끈다 — 끌 때도 같은 경로를 함께 준다', () => {
  // Electron 문서: path 를 주고 걸었다면 읽을 때도 같은 path 를 줘야 한다.
  // 걸 때와 끌 때의 모양이 어긋나면 "껐는데 안 꺼진" 상태가 생긴다.
  assert.deepStrictEqual(decideAutoLaunch(false, EXE), { action: 'disable', path: EXE })
})

test('개발 실행(exe 경로 없음)에서는 시작 프로그램을 건드리지 않는다', () => {
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

test('경로가 바뀌면 새 경로를 건다 — 옛 포터블 등록이 이 길로 낫는다', () => {
  // 포터블로 쓰던 사용자의 레지스트리에는 아직 D:\KeepSticky-<스탬프>.exe 가
  // 걸려 있다. 그 파일은 지워지지 않으므로 실패하지도 않고, 재부팅 때마다 조용히
  // 옛 포터블이 뜬다 — %TEMP% 삭제 문제로 그대로 돌아간다. 뜰 때마다 지금 exe 로
  // 다시 걸기 때문에 설치본이 한 번 뜨는 것만으로 그 자리에서 낫는다.
  const oldPortable = 'D:\\KeepSticky-2026.08.10.13.58.exe'
  assert.strictEqual(decideAutoLaunch(true, oldPortable).path, oldPortable)
  assert.strictEqual(decideAutoLaunch(true, EXE).path, EXE)
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof decideAutoLaunch, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
