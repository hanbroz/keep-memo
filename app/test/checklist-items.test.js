'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  normalizeChecklistItems, checklistSignature, checklistText
} = require('../renderer/checklist-items')

// --- 사이드카가 받아들이는 모양 --------------------------------------------

test('id/text/checked 를 갖춘 항목 묶음은 그대로 통과한다', () => {
  const res = normalizeChecklistItems([
    { id: 'i1', text: '우유', checked: false },
    { id: 'i2', text: '빵', checked: true }
  ])
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.items, [
    { text: '우유', checked: false, id: 'i1' },
    { text: '빵', checked: true, id: 'i2' }
  ])
})

test('빈 묶음도 유효하다 — 항목이 하나도 없는 체크리스트가 있을 수 있다', () => {
  const res = normalizeChecklistItems([])
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.items, [])
})

test('빈 text 는 유효하다 — 방금 만든, 아직 아무것도 안 쓴 줄이다', () => {
  const res = normalizeChecklistItems([{ id: 'i1', text: '', checked: false }])
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.items[0].text, '')
})

test('checked 를 빼면 false 로 채운다', () => {
  const res = normalizeChecklistItems([{ id: 'i1', text: '우유' }])
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.items[0].checked, false)
})

test('새로 만들 때(requireId: false)는 id 없이 text/checked 만 받는다', () => {
  const res = normalizeChecklistItems([{ text: '우유', checked: true }], { requireId: false })
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.items, [{ text: '우유', checked: true }])
  // id 를 붙이지 않는다 — 항목 id 는 Keep 이 정한다.
  assert.ok(!('id' in res.items[0]))
})

// --- 무엇이 무효인가 -------------------------------------------------------

test('배열이 아니면 거절한다', () => {
  for (const bad of [null, undefined, {}, 'items', 42, { 0: { text: 'x' } }]) {
    const res = normalizeChecklistItems(bad)
    assert.strictEqual(res.ok, false, `${JSON.stringify(bad)} 는 거절돼야 한다`)
  }
})

test('항목이 객체가 아니면 거절한다', () => {
  for (const bad of [null, '우유', 42, ['우유'], undefined]) {
    const res = normalizeChecklistItems([bad])
    assert.strictEqual(res.ok, false, `${JSON.stringify(bad)} 항목은 거절돼야 한다`)
    assert.ok(res.message.includes('0번째'))
  }
})

test('text 가 없거나 문자열이 아니면 거절한다', () => {
  for (const bad of [{ id: 'i1' }, { id: 'i1', text: null }, { id: 'i1', text: 42 },
                     { id: 'i1', text: ['x'] }]) {
    const res = normalizeChecklistItems([bad])
    assert.strictEqual(res.ok, false, `${JSON.stringify(bad)} 는 거절돼야 한다`)
    assert.ok(res.message.includes('text'))
  }
})

test('checked 가 진짜 불리언이 아니면 거절한다', () => {
  // 'false' 는 문자열이고 자바스크립트에서 참으로 읽힌다. 여기서 막지 않으면
  // 체크를 푼 항목이 체크된 채로 저장되는 종류의 사고가 열린다.
  for (const bad of ['true', 'false', 1, 0, null]) {
    const res = normalizeChecklistItems([{ id: 'i1', text: '우유', checked: bad }])
    assert.strictEqual(res.ok, false, `checked: ${JSON.stringify(bad)} 는 거절돼야 한다`)
    assert.ok(res.message.includes('checked'))
  }
})

test('id 가 없거나 빈 문자열이면 거절한다(기존 항목 수정)', () => {
  for (const bad of [{ text: 'x' }, { id: '', text: 'x' }, { id: 42, text: 'x' },
                     { id: null, text: 'x' }]) {
    const res = normalizeChecklistItems([bad])
    assert.strictEqual(res.ok, false, `${JSON.stringify(bad)} 는 거절돼야 한다`)
    assert.ok(res.message.includes('id'))
  }
})

test('id 가 겹치면 거절한다 — 어느 항목을 고치라는 것인지 정할 수 없다', () => {
  const res = normalizeChecklistItems([
    { id: 'i1', text: '우유' },
    { id: 'i1', text: '빵' }
  ])
  assert.strictEqual(res.ok, false)
  assert.ok(res.message.includes('겹친다'))
})

test('모르는 필드가 섞여 있으면 통째로 거절한다', () => {
  const res = normalizeChecklistItems([{ id: 'i1', text: '우유', checked: false, sort: 999 }])
  assert.strictEqual(res.ok, false)
  assert.ok(res.message.includes('sort'))
})

test('새로 만들 때 id 를 보내면 거절한다 — 렌더러가 정할 값이 아니다', () => {
  const res = normalizeChecklistItems([{ id: '내가정한id', text: '우유' }], { requireId: false })
  assert.strictEqual(res.ok, false)
  assert.ok(res.message.includes('id'))
})

test('거절 메시지는 몇 번째 항목이 문제인지 알려준다', () => {
  const res = normalizeChecklistItems([
    { id: 'i1', text: '우유' },
    { id: 'i2', text: 42 }
  ])
  assert.strictEqual(res.ok, false)
  assert.ok(res.message.includes('1번째'))
})

// --- 미저장 편집 판정용 서명 ------------------------------------------------

test('같은 묶음은 같은 서명, 체크 하나만 바뀌어도 다른 서명', () => {
  const before = [{ id: 'i1', text: '우유', checked: false }]
  const after = [{ id: 'i1', text: '우유', checked: true }]
  assert.strictEqual(checklistSignature(before), checklistSignature(before.slice()))
  assert.notStrictEqual(checklistSignature(before), checklistSignature(after))
})

test('항목 글자만 바뀌어도, 순서만 바뀌어도 다른 서명', () => {
  const base = [{ id: 'i1', text: '우유', checked: false }, { id: 'i2', text: '빵', checked: false }]
  const edited = [{ id: 'i1', text: '우유 2L', checked: false }, { id: 'i2', text: '빵', checked: false }]
  const swapped = [base[1], base[0]]
  assert.notStrictEqual(checklistSignature(base), checklistSignature(edited))
  assert.notStrictEqual(checklistSignature(base), checklistSignature(swapped))
})

test('구분자로 쓸 법한 글자를 항목에 넣어도 서로 다른 묶음이 같은 서명을 갖지 않는다', () => {
  // 구분자를 손으로 고르는 방식이 무너지는 지점이다. JSON 직렬화라 안전하다.
  const a = [{ id: 'i1', text: 'a", 1, "b', checked: false }]
  const b = [{ id: 'i1', text: 'a', checked: false }, { id: 'i1', text: 'b', checked: false }]
  assert.notStrictEqual(checklistSignature(a), checklistSignature(b))
})

test('배열이 아니면 빈 서명이다', () => {
  assert.strictEqual(checklistSignature(null), '')
  assert.strictEqual(checklistSignature('items'), '')
})

// --- 책갈피에 쓸 본문 문자열 ------------------------------------------------

test('항목 글자를 줄바꿈으로 이어 붙인다 — 책갈피는 그 첫 줄을 쓴다', () => {
  assert.strictEqual(
    checklistText([{ id: 'i1', text: '우유' }, { id: 'i2', text: '빵' }]),
    '우유\n빵')
  assert.strictEqual(checklistText([]), '')
  assert.strictEqual(checklistText(null), '')
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof normalizeChecklistItems, 'function')
})
