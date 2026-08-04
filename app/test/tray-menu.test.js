'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { trayMenuTemplate, TRAY_TOOLTIP } = require('../tray-menu')

const noop = () => {}
const build = (over = {}) =>
  trayMenuTemplate({ onOpenList: noop, onRelogin: noop, onQuit: noop, ...over })

test('메뉴에 목록 열기와 다시 로그인과 종료가 모두 있다', () => {
  const labels = build().filter((i) => i.label).map((i) => i.label)
  assert.deepStrictEqual(labels, ['메모 목록 열기', '다시 로그인', '종료'])
})

test('각 항목이 넘겨준 핸들러에 연결된다', () => {
  let opened = 0
  let quit = 0
  let relogin = 0
  const items = trayMenuTemplate({
    onOpenList: () => opened++, onRelogin: () => relogin++, onQuit: () => quit++
  })
  const byLabel = (label) => items.find((i) => i.label === label)

  byLabel('메모 목록 열기').click()
  assert.strictEqual(opened, 1)
  assert.strictEqual(quit, 0, '목록을 여는 것이 앱을 끝내면 안 된다')

  byLabel('다시 로그인').click()
  assert.strictEqual(relogin, 1)
  assert.strictEqual(quit, 0, '다시 로그인이 앱을 끝내면 안 된다')

  byLabel('종료').click()
  assert.strictEqual(quit, 1)
})

test('메뉴에 삭제/휴지통 경로는 존재하지 않는다', () => {
  // 삭제는 포스트잇 우클릭 → 확인 대화상자 하나뿐이다. 트레이 메뉴는 손이
  // 미끄러지기 쉬운 곳이라 여기에 한 번 클릭으로 지우는 길이 있으면 안 된다.
  const text = JSON.stringify(build().map((i) => i.label || i.type))
  for (const banned of ['삭제', '휴지통', 'trash', 'delete']) {
    assert.ok(!text.toLowerCase().includes(banned.toLowerCase()), `메뉴에 "${banned}" 가 있다`)
  }
})

test('핸들러가 빠지면 조용히 죽은 메뉴를 만들지 않고 던진다', () => {
  assert.throws(() => trayMenuTemplate({ onQuit: noop }), TypeError)
  assert.throws(() => trayMenuTemplate({ onOpenList: noop }), TypeError)
  assert.throws(() => trayMenuTemplate({ onOpenList: noop, onQuit: noop }), TypeError,
    'onRelogin 이 빠져도 던져야 한다')
  assert.throws(() => trayMenuTemplate({ onOpenList: noop, onRelogin: noop, onQuit: 'app.quit()' }),
    TypeError)
})

test('종료는 항상 마지막이고 구분선 뒤에 있다', () => {
  // 목록을 열려다 한 칸 아래를 눌러 앱이 꺼지는 일이 없게 한다.
  const items = build()
  assert.strictEqual(items[items.length - 1].label, '종료')
  assert.strictEqual(items[items.length - 2].type, 'separator')
})

test('툴팁은 목록 창 제목과 같다', () => {
  assert.strictEqual(TRAY_TOOLTIP, 'Keep 메모')
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof trayMenuTemplate, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
