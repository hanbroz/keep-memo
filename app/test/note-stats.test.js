'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { ROW_TILTS, tiltFor, countNoteStats } = require('../renderer/note-stats')

test('고정·보관·전체를 센다', () => {
  const notes = [
    { id: 'a', pinned: true },
    { id: 'b', pinned: true, archived: true }, // 둘 다인 메모는 양쪽에 다 센다
    { id: 'c', archived: true },
    { id: 'd' }
  ]
  assert.deepStrictEqual(countNoteStats(notes), { pinned: 2, archived: 2, total: 4 })
})

test('목록이 아니거나 비어 있어도 0 을 돌려준다', () => {
  // 목록을 아직 못 받아온 창이 이 함수를 부른다. 여기서 던지면 머리의 숫자 표
  // 하나 때문에 목록 전체가 안 그려진다.
  for (const bad of [null, undefined, 'notes', 42, {}, []]) {
    assert.deepStrictEqual(countNoteStats(bad), { pinned: 0, archived: 0, total: 0 })
  }
})

test('구멍 난 항목이 있어도 세기를 멈추지 않는다', () => {
  assert.deepStrictEqual(countNoteStats([null, { id: 'a', pinned: true }, undefined]),
    { pinned: 1, archived: 0, total: 3 })
})

test('같은 메모는 언제나 같은 각도다', () => {
  // **이것이 이 함수의 존재 이유다.** 각도를 행의 순서로 정하면 검색어를 한 글자
  // 칠 때마다 남은 행들의 기울기가 통째로 다시 배정되어 목록이 눈에 띄게
  // 흔들린다. 같은 메모는 어디에 그려지든 같은 각도여야 한다.
  assert.strictEqual(tiltFor('note-abc'), tiltFor('note-abc'))
  assert.strictEqual(tiltFor(''), tiltFor(''))
})

test('각도는 언제나 우리가 정한 표 안의 값이다', () => {
  // 메모 id 는 외부 데이터이고 이 값은 CSS 로 나간다. 표 밖의 문자열이 나가는
  // 길이 있으면 그것이 곧 주입 경로다.
  const ids = ['', 'a', '한글 id', '1'.repeat(200), 'x/*}*/;color:red']
  for (const id of ids) assert.ok(ROW_TILTS.includes(tiltFor(id)), `표 밖의 값: ${tiltFor(id)}`)
  for (const odd of [null, undefined, 0, 12345, true]) {
    assert.ok(ROW_TILTS.includes(tiltFor(odd)))
  }
})

test('여러 메모가 같은 각도로 몰리지 않는다', () => {
  // 전부 같은 각도면 '쪽지가 조금씩 어긋난' 인상 자체가 사라진다. 실제 Keep id
  // 를 닮은 문자열로 흩어짐을 확인한다.
  //
  // 견주는 대상이 ROW_TILTS.length(10)가 아니라 **서로 다른 값의 수**(8)인 것이
  // 핵심이다. 표에는 '-0.3deg' 와 '0.4deg' 가 각각 두 번 들어 있어서(디자인
  // 원안 그대로다) 10 을 기대하면 어떤 해시로도 통과할 수 없다.
  const distinct = new Set(ROW_TILTS).size
  for (const shape of ['1a2b3c4d5e6f.', 'note-', '']) {
    const seen = new Set()
    for (let i = 0; i < 200; i++) seen.add(tiltFor(`${shape}${i}`))
    assert.strictEqual(seen.size, distinct, `'${shape}…' 꼴의 id 가 몇 각도에만 몰린다`)
  }
})
