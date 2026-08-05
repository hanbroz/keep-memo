'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { fitWindowBounds, MIN_VISIBLE } = require('../window-bounds')

// 주 모니터 하나. 위쪽 0,0 에서 시작하고 아래 40px 은 작업 표시줄이 먹었다.
const MAIN = { x: 0, y: 0, width: 1920, height: 1040 }
// 주 모니터 **왼쪽**에 붙인 보조 모니터. x 가 음수인 것이 핵심이다 — 실제로
// 흔한 배치이고, 음수 좌표를 "이상한 값"으로 보고 걷어내면 이 화면에 둔 창이
// 매번 주 모니터로 끌려온다.
const LEFT = { x: -1280, y: 0, width: 1280, height: 1024 }

const SIZE = { width: 460, height: 620, minWidth: 360, minHeight: 320 }

test('저장된 적이 없으면 크기만 정한다 — 자리는 Electron 이 가운데로 잡는다', () => {
  assert.deepStrictEqual(fitWindowBounds(null, [MAIN], SIZE), { width: 460, height: 620 })
  assert.deepStrictEqual(fitWindowBounds({}, [MAIN], SIZE), { width: 460, height: 620 })
  // 크기만 저장돼 있고 자리가 없는 경우도 같다.
  assert.deepStrictEqual(fitWindowBounds({ width: 800, height: 700 }, [MAIN], SIZE),
    { width: 800, height: 700 })
})

test('화면 안에 있으면 저장된 값을 그대로 쓴다', () => {
  const saved = { x: 300, y: 200, width: 800, height: 700 }
  assert.deepStrictEqual(fitWindowBounds(saved, [MAIN], SIZE), saved)
})

test('두 화면에 걸쳐 놓은 창을 억지로 밀어 넣지 않는다', () => {
  // 한쪽으로 당겨 버리면 사용자가 일부러 맞춰 둔 배치가 열 때마다 무너진다.
  const straddling = { x: -200, y: 100, width: 800, height: 600 }
  assert.deepStrictEqual(fitWindowBounds(straddling, [MAIN, LEFT], SIZE), straddling)
})

test('보조 모니터를 뽑으면 주 모니터 가운데로 데려온다', () => {
  // **이 기능에 반드시 딸려야 하는 구조다.** 그대로 두면 창은 열리지만 보이지
  // 않고, 보이지 않으니 끌어올 수도 없다 — 사용자에게는 "앱이 안 뜬다"로 보인다.
  const onLeft = { x: -1000, y: 300, width: 460, height: 620 }
  const rescued = fitWindowBounds(onLeft, [MAIN], SIZE)
  assert.deepStrictEqual(rescued, { x: 730, y: 210, width: 460, height: 620 })
  // 아직 그 모니터가 붙어 있으면 건드리지 않는다.
  assert.deepStrictEqual(fitWindowBounds(onLeft, [MAIN, LEFT], SIZE), onLeft)
})

test('살짝만 걸친 창도 구해 온다', () => {
  // 오른쪽 끝에서 창의 10px 만 보이는 상태. 제목 표시줄을 붙들 수 없다.
  const sliver = { x: MAIN.width - 10, y: 100, width: 460, height: 620 }
  const out = fitWindowBounds(sliver, [MAIN], SIZE)
  assert.notStrictEqual(out.x, sliver.x, '그대로 두면 잡을 수가 없다')
  assert.strictEqual(out.x, 730)
  // 문턱만큼 보이면 그대로 둔다.
  const enough = { x: MAIN.width - MIN_VISIBLE, y: 100, width: 460, height: 620 }
  assert.deepStrictEqual(fitWindowBounds(enough, [MAIN], SIZE), enough)
})

test('작업 표시줄 아래로 내려간 창도 구해 온다', () => {
  // workArea 는 작업 표시줄을 뺀 영역이라 y=1030 이면 10px 만 남는다.
  const under = { x: 300, y: 1030, width: 460, height: 620 }
  assert.strictEqual(fitWindowBounds(under, [MAIN], SIZE).y, 210)
})

test('최소 크기보다 작게 저장돼 있어도 올려 준다', () => {
  // state.json 을 손으로 고쳤거나 최소 크기를 나중에 올린 경우다.
  const tiny = { x: 100, y: 100, width: 120, height: 80 }
  const out = fitWindowBounds(tiny, [MAIN], SIZE)
  assert.strictEqual(out.width, 360)
  assert.strictEqual(out.height, 320)
})

test('망가진 값이 와도 쓸 수 있는 크기를 돌려준다', () => {
  for (const bad of [undefined, 'bounds', 42, [], { x: NaN, y: 3, width: 'wide', height: null },
    { x: Infinity, y: 0, width: 500, height: 500 }]) {
    const out = fitWindowBounds(bad, [MAIN], SIZE)
    assert.ok(out.width >= SIZE.minWidth && out.height >= SIZE.minHeight,
      `쓸 수 없는 크기: ${JSON.stringify(out)}`)
  }
})

test('화면 목록이 비었거나 망가져도 크기만 주고 넘어간다', () => {
  const saved = { x: 300, y: 200, width: 800, height: 700 }
  for (const bad of [[], null, undefined, 'displays', [null, { width: 0, height: 0 }]]) {
    assert.deepStrictEqual(fitWindowBounds(saved, bad, SIZE), { width: 800, height: 700 },
      '자리를 정하지 못하면 Electron 이 가운데 띄우게 둔다')
  }
})

test('창이 화면보다 크면 그 화면 안으로 줄여 담는다', () => {
  const huge = { x: -5000, y: -5000, width: 4000, height: 3000 }
  const out = fitWindowBounds(huge, [MAIN], SIZE)
  assert.strictEqual(out.width, MAIN.width)
  assert.strictEqual(out.height, MAIN.height)
  assert.strictEqual(out.x, MAIN.x)
  assert.strictEqual(out.y, MAIN.y)
})

test('창보다 작은 화면에서는 창 크기가 문턱이 된다', () => {
  // 문턱을 80px 로 못 박으면, 작은 화면에 꽉 찬 창을 "안 보인다"고 판정해
  // 열 때마다 가운데로 끌어온다.
  const small = { x: 0, y: 0, width: 300, height: 200 }
  const fills = { x: 0, y: 0, width: 300, height: 200 }
  assert.deepStrictEqual(fitWindowBounds(fills, [small], { width: 460, height: 620 }), fills)
})

test('Electron 없이도 require 된다', () => {
  // 화면 목록을 인자로 받으므로 모니터를 실제로 뽑지 않고도 시험할 수 있다.
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
