'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { packBookmarks, bookmarkAnchorFromDrop, BOOKMARK } = require('../bookmark-layout')

// 주 모니터. 아래쪽 40px 은 작업 표시줄이라 workArea 에서 빠져 있다.
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }
// 주 모니터 오른쪽에 붙은 보조 모니터. 원점이 (1920, 100) 이다.
const SECONDARY = { x: 1920, y: 100, width: 1280, height: 960 }
// 주 모니터 **왼쪽**에 있는 보조 모니터. 원점의 x 가 음수다.
const LEFT_OF_PRIMARY = { x: -1600, y: 0, width: 1600, height: 900 }
const SIZE = { width: 40, height: 200 }

/** 옮긴 적 없는(= 자동 배치) 책갈피 n 장. */
const fresh = (n) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, y: null }))
const ys = (placed) => placed.map((p) => p.bounds.y)

// --- 빈틈도 겹침도 없다 ------------------------------------------------------
//
// 이 파일이 지키는 것 하나를 고르라면 이것이다. 예전에는 자동 배치와 수동 배치가
// 각자 y 를 정해서, 사용자가 끌어다 놓는 순간 겹치거나 사이가 벌어졌다.

test('한 묶음의 책갈피는 정확히 맞닿는다 — 사이가 벌어지지도 겹치지도 않는다', () => {
  for (const members of [fresh(2), fresh(3), fresh(7)]) {
    const placed = packBookmarks(PRIMARY, members, 'right', SIZE)
    for (let i = 1; i < placed.length; i++) {
      const prev = placed[i - 1].bounds
      const cur = placed[i].bounds
      if (cur.x !== prev.x) continue // 열이 바뀐 자리는 이웃이 아니다
      assert.strictEqual(cur.y, prev.y + prev.height,
        `${i - 1} 번과 ${i} 번 사이에 틈이나 겹침이 있다`)
    }
  }
})

test('사용자가 제각각 끌어다 놓아도 결과는 빈틈없이 맞닿는다', () => {
  // 실제로 보고된 그 상태다: 세 장을 손으로 끌어다 놓았더니 y 가 94 / 279 / 505
  // 가 되어, 앞의 둘은 15px 겹치고 셋째 앞에는 26px 이 비었다. 사람이 200px
  // 격자에 픽셀 단위로 맞출 수 없으니 자유 배치로는 필연이었다.
  const placed = packBookmarks(
    PRIMARY,
    [{ id: 'a', y: 94 }, { id: 'b', y: 279 }, { id: 'c', y: 505 }],
    'right', SIZE
  )
  assert.deepStrictEqual(placed.map((p) => p.id), ['a', 'b', 'c'], '위에서부터의 순서')
  assert.deepStrictEqual(ys(placed), [94, 294, 494], '맨 위만 사용자의 값을 따르고 나머지는 붙는다')
})

test('줄의 시작점은 가장 위에 놓은 장을 따른다', () => {
  // 이것이 "✕ 단추를 가리지 않게 아래로 내리기"가 실제로 동작하는 이유다.
  const placed = packBookmarks(PRIMARY, [{ id: 'a', y: 300 }, { id: 'b', y: 700 }], 'right', SIZE)
  assert.deepStrictEqual(ys(placed), [300, 500])
})

test('아무도 안 옮겼으면 예전처럼 작업 영역 맨 위에서 시작한다', () => {
  assert.deepStrictEqual(ys(packBookmarks(PRIMARY, fresh(3), 'right', SIZE)), [0, 200, 400])
})

// --- 순서와 변 --------------------------------------------------------------

test('세로로 끌면 줄 안에서 순서가 바뀐다', () => {
  // b 를 a 보다 위로 끌었다 → b 가 줄의 첫 장이 되고 시작점도 b 를 따른다.
  const placed = packBookmarks(PRIMARY, [{ id: 'a', y: 400 }, { id: 'b', y: 120 }], 'right', SIZE)
  assert.deepStrictEqual(placed.map((p) => p.id), ['b', 'a'])
  assert.deepStrictEqual(ys(placed), [120, 320])
})

test('한 번도 안 옮긴 장은 옮긴 장들 뒤에 접힌 순서대로 붙는다', () => {
  const placed = packBookmarks(
    PRIMARY,
    [{ id: 'fresh1', y: null }, { id: 'moved', y: 300 }, { id: 'fresh2', y: null }],
    'right', SIZE
  )
  assert.deepStrictEqual(placed.map((p) => p.id), ['moved', 'fresh1', 'fresh2'])
  assert.deepStrictEqual(ys(placed), [300, 500, 700])
})

test('y 가 같으면 원래 순서를 지킨다 — 다시 그릴 때마다 자리를 맞바꾸면 안 된다', () => {
  const members = [{ id: 'a', y: 200 }, { id: 'b', y: 200 }, { id: 'c', y: 200 }]
  const once = packBookmarks(PRIMARY, members, 'right', SIZE).map((p) => p.id)
  const twice = packBookmarks(PRIMARY, members, 'right', SIZE).map((p) => p.id)
  assert.deepStrictEqual(once, ['a', 'b', 'c'])
  assert.deepStrictEqual(twice, once)
})

test('왼쪽 변에 붙이면 x 가 작업 영역의 왼쪽 끝이다', () => {
  const placed = packBookmarks(PRIMARY, fresh(2), 'left', SIZE)
  for (const p of placed) assert.strictEqual(p.bounds.x, 0)
})

test('모르는 변 값은 예전 동작인 오른쪽으로 본다', () => {
  for (const side of ['up', undefined, null, '']) {
    const [p] = packBookmarks(PRIMARY, fresh(1), side, SIZE)
    assert.strictEqual(p.bounds.x, 1920 - 40, String(side))
  }
})

// --- 여러 모니터 ------------------------------------------------------------

test('보조 모니터의 0 이 아닌 원점을 그대로 따른다', () => {
  const right = packBookmarks(SECONDARY, fresh(2), 'right', SIZE)
  assert.strictEqual(right[0].bounds.x, 1920 + 1280 - 40)
  assert.deepStrictEqual(ys(right), [100, 300], '보조 모니터의 workArea.y 에서 시작한다')

  const left = packBookmarks(SECONDARY, fresh(1), 'left', SIZE)
  assert.strictEqual(left[0].bounds.x, 1920)
})

test('작업 영역 왼쪽에 있는(음수 원점) 보조 모니터에서도 맞는다', () => {
  const right = packBookmarks(LEFT_OF_PRIMARY, fresh(1), 'right', SIZE)
  assert.strictEqual(right[0].bounds.x, -1600 + 1600 - 40)
  const left = packBookmarks(LEFT_OF_PRIMARY, fresh(1), 'left', SIZE)
  assert.strictEqual(left[0].bounds.x, -1600)
})

// --- 넘침과 방어 ------------------------------------------------------------

test('아래로 넘칠 장은 화면 밖이 아니라 안쪽 열로 넘어간다', () => {
  // 1040 / 200 = 5 장이 한 열에 들어간다.
  const placed = packBookmarks(PRIMARY, fresh(7), 'right', SIZE)
  assert.deepStrictEqual(ys(placed).slice(0, 5), [0, 200, 400, 600, 800])
  assert.strictEqual(placed[5].bounds.y, 0, '여섯째는 새 열의 맨 위')
  assert.strictEqual(placed[5].bounds.x, 1920 - 40 - 40, '오른쪽에서 한 열 안쪽')
  assert.strictEqual(placed[6].bounds.x, placed[5].bounds.x, '같은 열에 남는다')
})

test('왼쪽 변의 넘친 열은 오른쪽(화면 안쪽)으로 파고든다', () => {
  const placed = packBookmarks(PRIMARY, fresh(6), 'left', SIZE)
  assert.strictEqual(placed[0].bounds.x, 0)
  assert.strictEqual(placed[5].bounds.x, 40, '안쪽으로 한 열')
})

test('아무리 많이 접어도 작업 영역 밖으로는 나가지 않는다', () => {
  for (const placed of [packBookmarks(PRIMARY, fresh(200), 'right', SIZE),
                        packBookmarks(PRIMARY, fresh(200), 'left', SIZE)]) {
    for (const p of placed) {
      assert.ok(p.bounds.x >= 0 && p.bounds.x + p.bounds.width <= 1920, `x=${p.bounds.x}`)
      assert.ok(p.bounds.y >= 0 && p.bounds.y + p.bounds.height <= 1040, `y=${p.bounds.y}`)
    }
  }
})

test('시작점이 화면 밖을 가리켜도 작업 영역 안으로 조인다', () => {
  // 저장해 둔 뒤에 해상도가 바뀌거나 작업 표시줄이 커진 경우.
  assert.deepStrictEqual(ys(packBookmarks(PRIMARY, [{ id: 'a', y: 99999 }], 'right', SIZE)),
    [1040 - 200], '아래 끝에 걸린다')
  assert.deepStrictEqual(ys(packBookmarks(PRIMARY, [{ id: 'a', y: -500 }], 'right', SIZE)),
    [0], '위 끝에 걸린다')
})

test('작업 영역보다 큰 책갈피는 작업 영역 크기로 줄여서라도 안에 넣는다', () => {
  const tiny = { x: 0, y: 0, width: 30, height: 120 }
  const [p] = packBookmarks(tiny, fresh(1), 'right', SIZE)
  assert.deepStrictEqual(p.bounds, { x: 0, y: 0, width: 30, height: 120 })
})

test('빈 묶음과 이상한 y 값에도 던지지 않는다', () => {
  assert.deepStrictEqual(packBookmarks(PRIMARY, [], 'right', SIZE), [])
  const placed = packBookmarks(
    PRIMARY,
    [{ id: 'a', y: NaN }, { id: 'b', y: '300' }, { id: 'c' }],
    'right', SIZE
  )
  // 숫자가 아닌 값은 전부 "안 옮김"으로 본다 → 원래 순서대로 맨 위에서부터.
  assert.deepStrictEqual(placed.map((p) => p.id), ['a', 'b', 'c'])
  assert.deepStrictEqual(ys(placed), [0, 200, 400])
})

test('크기를 생략하면 기본 책갈피 크기를 쓴다', () => {
  const [p] = packBookmarks(PRIMARY, fresh(1), 'right')
  assert.strictEqual(p.bounds.width, BOOKMARK.width)
  assert.strictEqual(p.bounds.height, BOOKMARK.height)
  assert.strictEqual(p.bounds.x, 1920 - BOOKMARK.width)
})

// --- 놓은 자리 → 앵커 --------------------------------------------------------

test('놓은 자리의 가까운 변으로 붙는다 — 기준은 책갈피의 가운데다', () => {
  // 왼쪽 모서리로 재면 폭 40px 만큼 치우쳐, 한가운데 놓았는데 오른쪽으로 붙는다.
  assert.strictEqual(bookmarkAnchorFromDrop(PRIMARY, { x: 100, y: 0 }, SIZE).side, 'left')
  assert.strictEqual(bookmarkAnchorFromDrop(PRIMARY, { x: 1700, y: 0 }, SIZE).side, 'right')
  assert.strictEqual(bookmarkAnchorFromDrop(PRIMARY, { x: 960 - 20 - 1, y: 0 }, SIZE).side, 'left')
  assert.strictEqual(bookmarkAnchorFromDrop(PRIMARY, { x: 960 - 20, y: 0 }, SIZE).side, 'right')
})

test('놓은 세로 위치도 작업 영역 안으로 조여 저장한다', () => {
  assert.strictEqual(bookmarkAnchorFromDrop(PRIMARY, { x: 0, y: 5000 }, SIZE).y, 1040 - 200)
  assert.strictEqual(bookmarkAnchorFromDrop(PRIMARY, { x: 0, y: -20 }, SIZE).y, 0)
  assert.strictEqual(bookmarkAnchorFromDrop(SECONDARY, { x: 1920, y: 120 }, SIZE).y, 120)
})

test('놓기 → 쌓기 → 다시 놓기가 제자리에 머문다', () => {
  // 이 왕복이 안정적이지 않으면 책갈피가 접었다 펼 때마다 조금씩 흘러내린다.
  // main 이 쌓은 결과를 앵커에 다시 적어 두므로, 그 값으로 또 쌓아도 같아야 한다.
  const first = packBookmarks(PRIMARY, [{ id: 'a', y: 300 }, { id: 'b', y: 700 }], 'right', SIZE)
  const again = packBookmarks(
    PRIMARY, first.map((p) => ({ id: p.id, y: p.bounds.y })), 'right', SIZE
  )
  assert.deepStrictEqual(again, first)
})

test('Electron 없이도 require 된다', () => {
  // 이 파일 자체가 electron 을 부르지 않고 여기까지 왔다는 것이 증거다.
  assert.strictEqual(typeof packBookmarks, 'function')
  assert.strictEqual(typeof bookmarkAnchorFromDrop, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
