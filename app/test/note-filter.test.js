'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  normalizeSearchQuery, filterNotes, selectionToApply, noteInFacets, NOTE_FACETS
} = require('../renderer/note-filter')

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
// --- 보관 처리 ---------------------------------------------------------------
//
// 보관된 메모는 목록에서 **감추지 않는다.** 감추면 이 앱에서 보관을 해제할 길이
// 사라진다 — 목록에 없는 메모는 열 수도 없기 때문이다. 위로 모아 두는 일(정렬)은
// 사이드카가 하고, 여기서는 검색이 보관 여부와 무관하게 걸리는지만 본다.

const MIXED = [
  { id: 'b', title: '지난 회의', text: '분기 계획', created: '2026-08-02', archived: true },
  { id: 'd', title: '옛 장부', text: '보관함 안', created: '2026-08-04', archived: true },
  { id: 'a', title: '장보기', text: '우유', created: '2026-08-01' },
  { id: 'c', title: '장롱', text: '정리', created: '2026-08-03', archived: false }
]

test('보관된 메모도 목록에서 빠지지 않는다', () => {
  // 빠지면 해제할 방법이 없어진다. 이 한 줄이 그 함정을 막는다.
  assert.deepStrictEqual(ids(filterNotes(MIXED, '')), ['b', 'd', 'a', 'c'])
})

test('사이드카가 준 순서를 그대로 지킨다 — 여기서 다시 줄 세우지 않는다', () => {
  // 정렬이 두 벌이 되면 언젠가 갈라진다. 거르기만 하고 순서는 건드리지 않는다.
  assert.deepStrictEqual(ids(filterNotes(MIXED, '장')), ['d', 'a', 'c'])
})

test('검색은 보관 여부와 무관하게 걸린다', () => {
  assert.deepStrictEqual(ids(filterNotes(MIXED, '분기')), ['b'], '보관된 것도 검색된다')
  assert.deepStrictEqual(ids(filterNotes(MIXED, '우유')), ['a'])
})

test('archived 필드가 없는 응답(옛 사이드카)도 그대로 다 나온다', () => {
  assert.deepStrictEqual(ids(filterNotes(NOTES, '')), ['n1', 'n2', 'n3', 'n4'])
})

// --- 라벨 필터 (Keep 의 '라벨' = 카테고리) -------------------------------------
//
// 언제나 id 로 견준다. 이름은 사용자가 언제든 바꿀 수 있어서, 이름을 열쇠로 쓰면
// 이름을 바꾼 순간 그 라벨이 붙은 메모를 전부 놓친다.

const { noteHasLabel, LABEL_FILTER_NONE } = require('../renderer/note-filter')

const WORK = { id: 'tag.work', name: '업무' }
const HOME = { id: 'tag.home', name: '개인' }
const LABELLED = [
  { id: 'a', title: '보고서', text: '분기', labels: [WORK] },
  { id: 'b', title: '장보기', text: '우유', labels: [HOME] },
  { id: 'c', title: '회의 준비', text: '자료', labels: [WORK, HOME] },
  { id: 'd', title: '낙서', text: '아무거나', labels: [] },
  { id: 'e', title: '옛 메모', text: '옛것' } // labels 키가 아예 없는 응답
]

test('라벨을 고르면 그 라벨이 붙은 메모만 나온다', () => {
  assert.deepStrictEqual(ids(filterNotes(LABELLED, '', 'tag.work')), ['a', 'c'])
  assert.deepStrictEqual(ids(filterNotes(LABELLED, '', 'tag.home')), ['b', 'c'])
})

test('전체(빈 값)를 고르면 라벨로 거르지 않는다', () => {
  assert.deepStrictEqual(ids(filterNotes(LABELLED, '', '')), ['a', 'b', 'c', 'd', 'e'])
  assert.deepStrictEqual(ids(filterNotes(LABELLED, '')), ['a', 'b', 'c', 'd', 'e'])
})

test('라벨 없음을 고르면 하나도 안 붙은 메모만 나온다', () => {
  // labels 키가 없는 옛 응답도 '없음'으로 본다.
  assert.deepStrictEqual(ids(filterNotes(LABELLED, '', LABEL_FILTER_NONE)), ['d', 'e'])
})

test('라벨 필터와 검색은 AND 다 — 카테고리 안에서 찾기', () => {
  assert.deepStrictEqual(ids(filterNotes(LABELLED, '회의', 'tag.work')), ['c'])
  assert.deepStrictEqual(filterNotes(LABELLED, '장보기', 'tag.work'), [])
})

test('없는 라벨 id 로 거르면 아무것도 안 나온다', () => {
  // 방금 지운 라벨이 필터에 남아 있는 경우다. 조용히 전체를 보여주면
  // 사용자는 필터가 걸린 줄 알고 엉뚱한 목록을 읽는다.
  assert.deepStrictEqual(filterNotes(LABELLED, '', 'tag.지워짐'), [])
})

test('noteHasLabel 은 이름이 아니라 id 로 견준다', () => {
  const note = { labels: [{ id: 'tag.work', name: '업무' }] }
  assert.strictEqual(noteHasLabel(note, 'tag.work'), true)
  assert.strictEqual(noteHasLabel(note, '업무'), false, '이름으로는 걸리면 안 된다')
})

test('LABEL_FILTER_NONE 은 진짜 라벨 id 와 부딪히지 않는다', () => {
  // Keep 의 라벨 id 는 'tag.' 로 시작한다.
  assert.ok(!LABEL_FILTER_NONE.startsWith('tag.'))
})

// --- 묶음 거르개 (머리의 [고정]/[보관]/[전체] 표) ------------------------------

const FACETED = [
  { id: 'p', title: '고정만', pinned: true },
  { id: 'a', title: '보관만', archived: true },
  { id: 'pa', title: '둘 다', pinned: true, archived: true },
  { id: 'n', title: '아무것도 아님' }
]

test('켜진 묶음이 없으면 [전체] 다 — 전부 통과한다', () => {
  assert.deepStrictEqual(ids(filterNotes(FACETED, '', '', new Set())), ['p', 'a', 'pa', 'n'])
  assert.deepStrictEqual(ids(filterNotes(FACETED, '', '', null)), ['p', 'a', 'pa', 'n'])
})

test('[고정] 을 켜면 고정된 것만 남는다', () => {
  assert.deepStrictEqual(ids(filterNotes(FACETED, '', '', new Set(['pinned']))), ['p', 'pa'])
})

test('둘을 같이 켜면 합집합이다 — 교집합이 아니다', () => {
  // **표의 숫자가 거짓말이 되지 않게 하는 규칙이다.** '고정 2' 를 눌렀는데
  // 한 줄만 나오면 그 숫자는 화면과 맞지 않는다. 둘 다 켠 것은 "고정된 것과
  // 보관된 것을 모두 보겠다"는 뜻이지 "둘 다인 것만"이 아니다.
  const both = new Set(['pinned', 'archived'])
  assert.deepStrictEqual(ids(filterNotes(FACETED, '', '', both)), ['p', 'a', 'pa'])
})

test('묶음과 검색은 AND 로 걸린다', () => {
  const pinned = new Set(['pinned'])
  assert.deepStrictEqual(ids(filterNotes(FACETED, '둘 다', '', pinned)), ['pa'])
  // 검색에는 걸리지만 묶음에 안 드는 것은 빠진다.
  assert.deepStrictEqual(ids(filterNotes(FACETED, '보관만', '', pinned)), [])
})

test('묶음 이름은 노트의 필드 이름과 같다', () => {
  // noteInFacets 가 note[facet] 으로 바로 읽으므로 둘이 갈라지면 조용히
  // 아무것도 안 걸러진다(모든 노트가 undefined 를 갖는 셈이 된다).
  assert.deepStrictEqual(NOTE_FACETS, ['pinned', 'archived'])
  for (const facet of NOTE_FACETS) {
    assert.ok(FACETED.some((n) => facet in n), `${facet} 를 가진 노트가 없다`)
  }
})

test('노트가 아닌 것은 켜진 묶음에 들지 않는다', () => {
  const on = new Set(['pinned'])
  for (const bad of [null, undefined, 'note', 7]) assert.strictEqual(noteInFacets(bad, on), false)
  // 켜진 것이 없으면 그것들도 통과한다 — 거르지 않는 것이 [전체] 의 뜻이다.
  for (const bad of [null, undefined]) assert.strictEqual(noteInFacets(bad, new Set()), true)
})
