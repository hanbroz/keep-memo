'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { joinTitleAndText, splitTitleAndText } = require('../renderer/note-title')

// --- splitTitleAndText: 저장 시 규칙 그대로 ---------------------------------

test('여러 줄 본문은 첫 줄이 title, 나머지가 text 로 나뉜다', () => {
  const res = splitTitleAndText('장보기\n우유\n계란')
  assert.deepStrictEqual(res, { title: '장보기', text: '우유\n계란' })
})

test('줄바꿈이 없는 한 줄은 통째로 title 이 되고 text 는 비워진다', () => {
  const res = splitTitleAndText('할 일 하나')
  assert.deepStrictEqual(res, { title: '할 일 하나', text: '' })
})

test('빈 문자열은 title/text 둘 다 빈 문자열이 된다', () => {
  const res = splitTitleAndText('')
  assert.deepStrictEqual(res, { title: '', text: '' })
})

test('본문이 빈 줄로 시작하면 title 을 비우고 문자열 전체를 text 로 넘긴다', () => {
  // 첫 줄(빈 문자열)을 title 로 삼고 그 줄바꿈까지 삼켜버리면, 다시 합칠 때
  // (title 이 비었으니 text 를 그대로 보여주는 규칙과 맞물려) 그 빈 줄 자체가
  // 사라진다. 그래서 이 경우는 아무것도 잘라내지 않는다.
  const res = splitTitleAndText('\n둘째 줄부터 시작')
  assert.deepStrictEqual(res, { title: '', text: '\n둘째 줄부터 시작' })
})

test('title 자체에는 줄바꿈이 들어가지 않는다', () => {
  const res = splitTitleAndText('제목엔 줄바꿈이 없다\n본문')
  assert.ok(!res.title.includes('\n'))
  assert.strictEqual(res.title, '제목엔 줄바꿈이 없다')
})

// --- joinTitleAndText: 불러오기 시 규칙 그대로 ------------------------------

test('title 이 있으면 title, 줄바꿈, text 순으로 합친다', () => {
  assert.strictEqual(joinTitleAndText('장보기', '우유\n계란'), '장보기\n우유\n계란')
})

test('title 이 비어 있으면 text 만 그대로 보여준다', () => {
  assert.strictEqual(joinTitleAndText('', '아직 제목 없는 메모'), '아직 제목 없는 메모')
})

test('title 만 있고 text 가 비어 있으면 title 만 보여준다(빈 줄을 남기지 않는다)', () => {
  assert.strictEqual(joinTitleAndText('제목만 있음', ''), '제목만 있음')
})

test('title 도 text 도 없으면 빈 문자열이다', () => {
  assert.strictEqual(joinTitleAndText('', ''), '')
})

// --- 왕복(join(split(s)) === s): 이게 어긋나면 저장할 때마다 내용이 샌다 ----

const ROUND_TRIP_CASES = [
  ['빈 노트', ''],
  ['줄바꿈 없는 한 줄', '우유 사기'],
  ['여러 줄 노트', '장보기\n우유\n계란'],
  ['본문이 빈 줄로 시작', '\n둘째 줄부터가 진짜 내용'],
  ['본문 중간에 빈 줄', '제목\n\n첫 문단\n\n둘째 문단'],
  ['본문이 줄바꿈으로 끝남(후행 개행)', '제목\n마지막 줄\n'],
  ['본문이 여러 개의 후행 개행으로 끝남', '제목\n본문\n\n\n'],
  ['제목 없이 줄바꿈만', '\n'],
  ['제목에 해당하는 줄이 공백뿐', '   \n본문']
]

for (const [label, s] of ROUND_TRIP_CASES) {
  test(`왕복 보존 — ${label}`, () => {
    const { title, text } = splitTitleAndText(s)
    assert.strictEqual(joinTitleAndText(title, text), s)
  })
}

// title 하나뿐이고 그 뒤에 내용 없는 줄바꿈 하나만 있는 경우는 이 스킴이 근본
// 적으로 구별할 수 없는 유일한 경우다: "hello" 와 "hello\n" 모두
// title='hello', text='' 로 쪼개진다 — "첫 줄 뒤에 아무 것도 없다"와 "첫 줄
// 뒤에 줄바꿈만 있고 아무 내용도 없다"를 title/text 두 필드만으로는 구분할
// 방법이 없기 때문이다. 이 왕복은 실패가 아니라 이 설계의 알려진 한계로
// 문서화해 둔다(리포트 참고) — 보이지 않는 후행 빈 줄 하나일 뿐이라 실사용
// 콘텐츠 손실로 보지 않았다.
test('알려진 한계 — 제목뿐인 노트의 후행 개행 하나는 다음 왕복에서 사라진다', () => {
  const s = '제목뿐\n'
  const { title, text } = splitTitleAndText(s)
  assert.deepStrictEqual({ title, text }, { title: '제목뿐', text: '' })
  assert.strictEqual(joinTitleAndText(title, text), '제목뿐') // 후행 개행이 사라진다 — 의도된 한계
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof joinTitleAndText, 'function')
  assert.strictEqual(typeof splitTitleAndText, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
