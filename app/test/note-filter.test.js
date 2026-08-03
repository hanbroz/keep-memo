'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { normalizeSearchQuery, filterNotes, selectionToApply } = require('../renderer/note-filter')

// list_notes 가 주는 모양 그대로다 — id / title / text / updated.
const NOTES = [
  { id: 'n1', title: '장보기', text: '우유\n계란', updated: '2026-08-01' },
  { id: 'n2', title: '회의록', text: '분기 계획 정리', updated: '2026-08-02' },
  { id: 'n3', title: '', text: '장롱 정리하기', updated: '2026-08-03' },
  { id: 'n4', title: 'TODO', text: 'todo 목록 갱신', updated: '2026-08-03' }
]

const ids = (notes) => notes.map((n) => n.id)

test('제목에만 있는 낱말로 걸러진다', () => {
  assert.deepStrictEqual(ids(filterNotes(NOTES, '회의')), ['n2'])
})

test('본문에만 있는 낱말로 걸러진다', () => {
  // '계란' 은 n1 의 본문에만 있다(제목은 '장보기').
  assert.deepStrictEqual(ids(filterNotes(NOTES, '계란')), ['n1'])
})

test('제목과 본문 둘 다에 있어도 한 번만 나온다', () => {
  // n4 는 제목 'TODO' 와 본문 'todo 목록 갱신' 양쪽에 걸린다.
  assert.deepStrictEqual(ids(filterNotes(NOTES, 'todo')), ['n4'])
})

test('한 질의가 제목으로 하나, 본문으로 다른 하나를 잡을 수 있다', () => {
  // '장' 은 n1 의 제목('장보기')과 n3 의 본문('장롱 정리하기')에 걸린다.
  assert.deepStrictEqual(ids(filterNotes(NOTES, '장')), ['n1', 'n3'])
})

test('맞는 것이 없으면 빈 배열이다', () => {
  assert.deepStrictEqual(filterNotes(NOTES, '없는낱말'), [])
})

test('빈 질의는 전부 돌려준다', () => {
  assert.deepStrictEqual(ids(filterNotes(NOTES, '')), ['n1', 'n2', 'n3', 'n4'])
})

test('공백만 친 질의도 빈 질의로 본다 — 목록이 통째로 사라지면 안 된다', () => {
  assert.deepStrictEqual(ids(filterNotes(NOTES, '   ')), ['n1', 'n2', 'n3', 'n4'])
  assert.strictEqual(normalizeSearchQuery('  \t '), '')
})

test('대소문자를 가리지 않는다', () => {
  assert.deepStrictEqual(ids(filterNotes(NOTES, 'ToDo')), ['n4'])
  assert.deepStrictEqual(ids(filterNotes(NOTES, 'TODO')), ['n4'])
  assert.deepStrictEqual(ids(filterNotes(NOTES, 'todo')), ['n4'])
})

test('질의 앞뒤 공백은 무시된다', () => {
  assert.deepStrictEqual(ids(filterNotes(NOTES, '  회의  ')), ['n2'])
})

test('빈 질의라도 원본 배열을 그대로 돌려주지는 않는다', () => {
  const out = filterNotes(NOTES, '')
  assert.notStrictEqual(out, NOTES)
  assert.deepStrictEqual(out, NOTES)
})

test('title 이나 text 가 없는 노트도 던지지 않는다', () => {
  const odd = [{ id: 'x' }, { id: 'y', title: null, text: undefined }, null]
  assert.deepStrictEqual(filterNotes(odd, '아무거나'), [])
  assert.strictEqual(filterNotes(odd, '').length, 3)
})

test('노트 목록이 배열이 아니면 빈 배열이다', () => {
  assert.deepStrictEqual(filterNotes(null, ''), [])
  assert.deepStrictEqual(filterNotes(undefined, '회의'), [])
})

// --- 검색이 체크된 집합을 건드리지 않는다는 것 --------------------------------

test('체크된 메모가 검색으로 걸러져 나가도 [완료]는 여전히 그것을 포함한다', () => {
  // n1 을 체크해 둔 채 '회의' 를 검색하면 화면에는 n2 만 남는다.
  const checked = new Set(['n1'])
  assert.deepStrictEqual(ids(filterNotes(NOTES, '회의')), ['n2'], '화면에는 n2 만 있다')
  // 그래도 보낼 목록은 화면이 아니라 전체 노트 기준이다.
  assert.deepStrictEqual(selectionToApply(NOTES, checked), ['n1'],
    '보이지 않는다고 체크가 사라지면 건드린 적 없는 포스트잇이 내려간다')
})

test('체크된 메모를 검색으로 잡아도 결과는 같다 — 보이든 말든 한 번만 들어간다', () => {
  const checked = new Set(['n2'])
  assert.deepStrictEqual(ids(filterNotes(NOTES, '회의')), ['n2'])
  assert.deepStrictEqual(selectionToApply(NOTES, checked), ['n2'])
})

test('여러 개를 체크한 뒤 하나만 보이게 걸러도 전부 남는다', () => {
  const checked = new Set(['n1', 'n3', 'n4'])
  assert.deepStrictEqual(selectionToApply(NOTES, checked), ['n1', 'n3', 'n4'])
})

test('결과는 전체 노트의 순서를 따르고 중복이 없다', () => {
  const r = selectionToApply(NOTES, ['n4', 'n1', 'n4'])
  assert.deepStrictEqual(r, ['n1', 'n4'])
})

test('아무것도 체크하지 않으면 빈 목록이다 — 그래도 지우는 것이 아니라 내리는 것이다', () => {
  assert.deepStrictEqual(selectionToApply(NOTES, new Set()), [])
})

test('전체 노트에 없는 id 는 결과에 들어가지 않는다', () => {
  assert.deepStrictEqual(selectionToApply(NOTES, ['n2', '사라진노트']), ['n2'])
})

test('Set 대신 배열을 줘도 같게 동작한다', () => {
  assert.deepStrictEqual(selectionToApply(NOTES, ['n1', 'n2']), ['n1', 'n2'])
})

test('이상한 입력이 와도 창을 여닫는 경로로 새지 않는다', () => {
  assert.deepStrictEqual(selectionToApply(null, ['n1']), [])
  assert.deepStrictEqual(selectionToApply(NOTES, null), [])
  assert.deepStrictEqual(selectionToApply(NOTES, undefined), [])
  assert.deepStrictEqual(selectionToApply([{ id: 42 }, { id: '' }, null, { id: 'n1' }], ['n1', 42, '']), ['n1'])
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof filterNotes, 'function')
  assert.strictEqual(typeof selectionToApply, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
