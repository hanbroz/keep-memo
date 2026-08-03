'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { validateNotePatch } = require('../note-patch')

test('text 만 있는 patch 는 그대로 통과한다', () => {
  const res = validateNotePatch({ text: '본문' })
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.params, { text: '본문' })
})

test('title 만 있는 patch 도 통과한다 — 예전 버그는 이 필드를 조용히 버렸다', () => {
  const res = validateNotePatch({ title: '제목' })
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.params, { title: '제목' })
})

test('color 만 있는 patch 도 통과한다', () => {
  const res = validateNotePatch({ color: 'Blue' })
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.params, { color: 'Blue' })
})

test('title, text, color 를 한 번에 보내도 셋 다 통과한다', () => {
  const res = validateNotePatch({ title: '제목', text: '본문', color: 'Green' })
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.params, { title: '제목', text: '본문', color: 'Green' })
})

test('빈 patch 는 통과하되 보낼 파라미터가 없다', () => {
  const res = validateNotePatch({})
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.params, {})
})

test('지원하지 않는 필드가 섞여 있으면 통째로 거절한다', () => {
  const res = validateNotePatch({ text: '본문', trashed: true })
  assert.strictEqual(res.ok, false)
  assert.ok(res.message.includes('trashed'))
})

test('객체가 아닌 patch(null, 배열, 문자열)는 거절한다', () => {
  for (const bad of [null, [], 'text', 42, undefined]) {
    const res = validateNotePatch(bad)
    assert.strictEqual(res.ok, false, `${JSON.stringify(bad)} 는 거절돼야 한다`)
  }
})

test('값이 undefined 인 필드는 파라미터에서 빠진다', () => {
  // JSON.stringify 가 undefined 값을 가진 키를 제거하는 것과 같은 모양을
  // 미리 만들어 둔다 — 사이드카의 title=None/text=None/color=None 기본값과
  // 맞아떨어져야 "안 보낸 필드"와 "명시적으로 지운 필드"가 뒤섞이지 않는다.
  const res = validateNotePatch({ text: '본문', title: undefined, color: undefined })
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.params, { text: '본문' })
})
