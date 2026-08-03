'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { bookmarkBounds, BOOKMARK } = require('../bookmark-layout')

// 주 모니터. 아래쪽 40px 은 작업 표시줄이라 workArea 에서 빠져 있다.
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }
// 주 모니터 오른쪽에 붙은 보조 모니터. 원점이 (1920, 100) 이다.
const SECONDARY = { x: 1920, y: 100, width: 1280, height: 960 }
const SIZE = { width: 40, height: 200, gap: 10 }

test('0 번 슬롯은 작업 영역 오른쪽 가장자리 맨 위에 붙는다', () => {
  const b = bookmarkBounds(PRIMARY, 0, SIZE)
  assert.strictEqual(b.x, 1920 - 40) // 오른쪽 끝에 딱 붙는다
  assert.strictEqual(b.y, 0)         // 작업 영역 맨 위
  assert.strictEqual(b.width, 40)
  assert.strictEqual(b.height, 200)
})

test('N 번 슬롯은 N × (높이 + 간격) 만큼 아래로 내려간다', () => {
  for (const n of [1, 2, 3]) {
    const b = bookmarkBounds(PRIMARY, n, SIZE)
    assert.strictEqual(b.y, n * (200 + 10), `슬롯 ${n}`)
    assert.strictEqual(b.x, 1920 - 40, `슬롯 ${n} 은 같은 열에 남는다`)
  }
})

test('보조 모니터의 0 이 아닌 workArea.x / y 만큼 원점이 옮겨진다', () => {
  const b0 = bookmarkBounds(SECONDARY, 0, SIZE)
  assert.strictEqual(b0.x, 1920 + 1280 - 40) // 보조 모니터의 오른쪽 가장자리
  assert.strictEqual(b0.y, 100)              // 보조 모니터 작업 영역 맨 위

  const b2 = bookmarkBounds(SECONDARY, 2, SIZE)
  assert.strictEqual(b2.x, 1920 + 1280 - 40)
  assert.strictEqual(b2.y, 100 + 2 * (200 + 10))
})

test('작업 영역 왼쪽에 있는(음수 원점) 보조 모니터에서도 맞는다', () => {
  const left = { x: -1600, y: -200, width: 1600, height: 900 }
  const b = bookmarkBounds(left, 1, SIZE)
  assert.strictEqual(b.x, -1600 + 1600 - 40)
  assert.strictEqual(b.y, -200 + (200 + 10))
})

test('아래로 넘칠 슬롯은 화면 밖이 아니라 왼쪽 열로 넘어간다', () => {
  // 작업 영역 높이 1040 에 200+10 짜리 슬롯은 5 장까지 들어간다
  // (마지막 장 끝 = 4*210 + 200 = 1040). 6 장째부터 넘친다.
  const perColumn = Math.floor((1040 + 10) / (200 + 10)) // 5
  assert.strictEqual(perColumn, 5)

  const last = bookmarkBounds(PRIMARY, perColumn - 1, SIZE)
  assert.ok(last.y + last.height <= PRIMARY.y + PRIMARY.height, '마지막 슬롯도 작업 영역 안이다')
  assert.strictEqual(last.x, 1920 - 40, '아직 첫 열이다')

  const wrapped = bookmarkBounds(PRIMARY, perColumn, SIZE)
  assert.strictEqual(wrapped.y, 0, '새 열은 다시 맨 위에서 시작한다')
  assert.strictEqual(wrapped.x, 1920 - 40 - (40 + 10), '한 열 왼쪽으로 옮겨진다')
})

test('아무리 많이 접어도 작업 영역 밖으로는 나가지 않는다', () => {
  for (let i = 0; i < 400; i++) {
    const b = bookmarkBounds(PRIMARY, i, SIZE)
    assert.ok(b.x >= PRIMARY.x, `슬롯 ${i} x=${b.x} 가 왼쪽으로 새어나갔다`)
    assert.ok(b.x + b.width <= PRIMARY.x + PRIMARY.width, `슬롯 ${i} 가 오른쪽으로 새어나갔다`)
    assert.ok(b.y >= PRIMARY.y, `슬롯 ${i} 가 위로 새어나갔다`)
    assert.ok(b.y + b.height <= PRIMARY.y + PRIMARY.height, `슬롯 ${i} 가 아래로 새어나갔다`)
  }
})

test('작업 영역보다 큰 책갈피는 작업 영역 크기로 줄여서라도 안에 넣는다', () => {
  const tiny = { x: 0, y: 0, width: 30, height: 120 }
  const b = bookmarkBounds(tiny, 0, SIZE)
  assert.strictEqual(b.width, 30)
  assert.strictEqual(b.height, 120)
  assert.strictEqual(b.x, 0)
  assert.strictEqual(b.y, 0)

  // 그런 화면에서도 다음 슬롯이 밖으로 나가지 않는다.
  const b1 = bookmarkBounds(tiny, 1, SIZE)
  assert.ok(b1.y + b1.height <= tiny.height)
  assert.ok(b1.x >= tiny.x)
})

test('슬롯 번호가 음수이거나 숫자가 아니면 0 번으로 본다', () => {
  const zero = bookmarkBounds(PRIMARY, 0, SIZE)
  assert.deepStrictEqual(bookmarkBounds(PRIMARY, -3, SIZE), zero)
  assert.deepStrictEqual(bookmarkBounds(PRIMARY, NaN, SIZE), zero)
  assert.deepStrictEqual(bookmarkBounds(PRIMARY, undefined, SIZE), zero)
})

test('크기를 생략하면 기본 책갈피 크기를 쓴다', () => {
  const b = bookmarkBounds(PRIMARY, 0)
  assert.strictEqual(b.width, BOOKMARK.width)
  assert.strictEqual(b.height, BOOKMARK.height)
})

test('Electron 없이도 require 된다', () => {
  // 이 파일 자체가 electron 을 부르지 않고 여기까지 왔다는 것이 증거다.
  assert.strictEqual(typeof bookmarkBounds, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
