'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  LINE_MARK_UNCHECKED, LINE_MARK_CHECKED,
  parseNoteLine, serializeNoteLine,
  parseNoteLines, serializeNoteLines, noteLinesPlainText
} = require('../renderer/line-model')

// 왕복 검사에 쓸 표본들. 이 프로젝트는 제목을 본문에서 떼어낼 때 저장할 때마다
// 내용이 조금씩 흘러내리는 버그를 한 번 냈다 — 같은 모양의 사고를 여기서 막는다.
const SAMPLES = [
  '',                                   // 빈 본문
  '한 줄',                               // 한 줄
  '한 줄\n',                             // 끝의 줄바꿈
  '\n',                                 // 줄바꿈뿐
  '\n\n\n',                             // 빈 줄만 여러 개
  '앞\n\n뒤',                            // 가운데 빈 줄
  '- [ ] 우유',                          // 체크 안 된 항목 하나
  '- [x] 빵',                            // 체크된 항목 하나
  '- [ ] 우유\n- [x] 빵',                 // 전부 항목
  '- [ ] 우유\n\n- [x] 빵',               // 항목 사이 빈 줄
  '장보기\n- [ ] 우유\n- [x] 빵\n메모 끝',  // 글과 항목이 섞인 본문
  '- [ ] ',                             // 글자가 빈 항목(뒤 공백 있음)
  '- [ ]',                              // 표식을 닮았을 뿐인 글줄(뒤 공백 없음)
  '- [z] x',                            // 가운데 글자가 다르다
  '-[ ] x',                             // 하이픈 뒤 공백이 없다
  '  - [ ] x',                          // 앞에 공백이 있다
  '- [X] x',                            // 대문자 X
  '* [ ] x',                            // 다른 글머리표
  '- [ ] - [x] 중첩처럼 보이는 글자',       // 글자 안에 또 표식이 있다
  '- [ ] 우유\n',                        // 항목 + 끝의 줄바꿈
  'https://example.com/a\n- [ ] 주소 확인'
]

// --- 왕복과 멱등 -------------------------------------------------------------

test('모든 표본이 텍스트 → 줄 → 텍스트 왕복에서 글자 하나 안 바뀐다', () => {
  for (const sample of SAMPLES) {
    assert.strictEqual(serializeNoteLines(parseNoteLines(sample)), sample,
      `왕복이 깨졌다: ${JSON.stringify(sample)}`)
  }
})

test('두 번 왕복해도 한 번과 같다(멱등)', () => {
  for (const sample of SAMPLES) {
    const once = serializeNoteLines(parseNoteLines(sample))
    const twice = serializeNoteLines(parseNoteLines(once))
    assert.strictEqual(twice, once, `멱등이 깨졌다: ${JSON.stringify(sample)}`)
  }
})

test('줄 수는 줄바꿈 수 + 1 이다 — 끝의 줄바꿈이 빈 줄로 남는다', () => {
  assert.strictEqual(parseNoteLines('').length, 1)
  assert.strictEqual(parseNoteLines('a').length, 1)
  assert.strictEqual(parseNoteLines('a\n').length, 2)
  assert.strictEqual(parseNoteLines('a\nb').length, 2)
  assert.strictEqual(parseNoteLines('\n\n').length, 3)
})

test('빈 본문도 캐럿을 놓을 줄 하나다', () => {
  assert.deepStrictEqual(parseNoteLines(''), [{ kind: 'text', checked: false, text: '' }])
})

// --- 무엇이 항목인가 ---------------------------------------------------------

test('"- [ ] 내용" 은 체크 안 된 항목, "- [x] 내용" 은 체크된 항목이다', () => {
  assert.deepStrictEqual(parseNoteLine('- [ ] 우유'),
    { kind: 'item', checked: false, text: '우유' })
  assert.deepStrictEqual(parseNoteLine('- [x] 빵'),
    { kind: 'item', checked: true, text: '빵' })
})

test('표식을 닮았을 뿐인 줄은 평범한 글줄이다', () => {
  // 규칙을 여기서 못 박는다: 표식은 정확히 여섯 글자이고 줄 맨 앞에 있어야 한다.
  for (const line of ['- [z] x', '-[ ] x', '  - [ ] x', '- [X] x', '* [ ] x',
                      '- [ ]', '- []x', '-- [ ] x', ' - [x] x', '- [ ]x']) {
    const parsed = parseNoteLine(line)
    assert.strictEqual(parsed.kind, 'text', `${JSON.stringify(line)} 는 글줄이어야 한다`)
    assert.strictEqual(parsed.text, line)
  }
})

test('글자가 빈 항목은 뒤 공백까지 살아서 왕복한다', () => {
  const empty = { kind: 'item', checked: false, text: '' }
  assert.strictEqual(serializeNoteLine(empty), '- [ ] ')
  assert.deepStrictEqual(parseNoteLine('- [ ] '), empty)
  // 뒤 공백이 없는 "- [ ]" 는 항목이 아니다 — 이 비대칭이 왕복을 지킨다.
  assert.strictEqual(parseNoteLine('- [ ]').kind, 'text')
})

test('항목 글자 안에 표식이 또 있어도 앞의 하나만 뗀다', () => {
  assert.deepStrictEqual(parseNoteLine('- [ ] - [x] 우유'),
    { kind: 'item', checked: false, text: '- [x] 우유' })
})

test('표식 상수는 여섯 글자다', () => {
  assert.strictEqual(LINE_MARK_UNCHECKED, '- [ ] ')
  assert.strictEqual(LINE_MARK_CHECKED, '- [x] ')
  assert.strictEqual(LINE_MARK_UNCHECKED.length, 6)
  assert.strictEqual(LINE_MARK_CHECKED.length, 6)
})

// --- 직렬화 ------------------------------------------------------------------

test('줄 하나를 되돌릴 때 kind 가 item 이 아니면 표식을 붙이지 않는다', () => {
  assert.strictEqual(serializeNoteLine({ kind: 'text', checked: true, text: '우유' }), '우유')
  assert.strictEqual(serializeNoteLine({ kind: 'item', checked: true, text: '우유' }), '- [x] 우유')
  assert.strictEqual(serializeNoteLine({ kind: 'item', checked: false, text: '우유' }), '- [ ] 우유')
})

test('망가진 입력에도 죽지 않는다', () => {
  assert.strictEqual(serializeNoteLine(null), '')
  assert.strictEqual(serializeNoteLine(undefined), '')
  assert.strictEqual(serializeNoteLine({ kind: 'item' }), '')
  assert.strictEqual(serializeNoteLines(null), '')
  assert.strictEqual(serializeNoteLines('본문'), '')
  assert.deepStrictEqual(parseNoteLines(null), [{ kind: 'text', checked: false, text: '' }])
  assert.deepStrictEqual(parseNoteLine(42), { kind: 'text', checked: false, text: '' })
})

// --- 사람에게 보여줄 글자 -----------------------------------------------------

test('표식을 뗀 글자만 이어 붙인다 — 책갈피와 배지가 쓴다', () => {
  const lines = parseNoteLines('장보기\n- [ ] 우유\n- [x] 빵')
  assert.strictEqual(noteLinesPlainText(lines), '장보기\n우유\n빵')
  assert.strictEqual(noteLinesPlainText([]), '')
  assert.strictEqual(noteLinesPlainText(null), '')
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof parseNoteLines, 'function')
})
