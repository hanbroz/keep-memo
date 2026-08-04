'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { validateNotePatch, validateChecklistPatch } = require('../note-patch')

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

// --- 체크리스트 patch -------------------------------------------------------

test('title 과 items 를 갖춘 체크리스트 patch 는 통과한다', () => {
  const res = validateChecklistPatch({
    title: '장보기',
    items: [{ id: 'i1', text: '우유', checked: true }]
  })
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.params, {
    items: [{ text: '우유', checked: true, id: 'i1' }],
    title: '장보기'
  })
})

test('title 없이 items 만 보내도 통과한다 — 제목은 안 바꾼다는 뜻이다', () => {
  const res = validateChecklistPatch({ items: [{ id: 'i1', text: '우유' }] })
  assert.strictEqual(res.ok, true)
  assert.ok(!('title' in res.params))
})

test('items 가 없으면 거절한다', () => {
  // 빈 배열("항목을 전부 지웠다")과 생략("항목은 건드리지 않았다")을 구별할 수
  // 없다. 앞의 뜻으로 읽히면 체크리스트가 통째로 비워진다.
  const res = validateChecklistPatch({ title: '장보기' })
  assert.strictEqual(res.ok, false)
  assert.ok(res.message.includes('항목'))
})

test('빈 items 배열은 통과한다 — 생략과 달리 뜻이 분명하다', () => {
  const res = validateChecklistPatch({ items: [] })
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.params, { items: [] })
})

test('체크리스트 patch 에 모르는 필드가 있으면 통째로 거절한다', () => {
  const res = validateChecklistPatch({ items: [], text: '본문' })
  assert.strictEqual(res.ok, false)
  assert.ok(res.message.includes('text'))
})

test('항목 묶음 자체가 잘못되면 그 이유를 그대로 물고 올라온다', () => {
  const res = validateChecklistPatch({ items: [{ id: 'i1', text: '우유', checked: 'true' }] })
  assert.strictEqual(res.ok, false)
  assert.ok(res.message.includes('checked'))
})

test('제목이 문자열이 아니면 거절한다', () => {
  const res = validateChecklistPatch({ title: 42, items: [] })
  assert.strictEqual(res.ok, false)
  assert.ok(res.message.includes('제목'))
})

test('객체가 아닌 체크리스트 patch 는 거절한다', () => {
  for (const bad of [null, [], 'items', 42, undefined]) {
    const res = validateChecklistPatch(bad)
    assert.strictEqual(res.ok, false, `${JSON.stringify(bad)} 는 거절돼야 한다`)
  }
})

// --- 보관 -------------------------------------------------------------------

test('archived 는 통과시킨다 — 사이드카의 update_note 가 받는 필드다', () => {
  assert.deepStrictEqual(validateNotePatch({ archived: true }), { ok: true, params: { archived: true } })
  assert.deepStrictEqual(validateNotePatch({ archived: false }), { ok: true, params: { archived: false } })
})

test('archived 만 있는 patch 는 title/text 를 만들지 않는다', () => {
  // main.js 가 이 사실로 conflictBackup 을 남길지 정한다 — 보관은 편집기
  // 내용을 건드리지 않으므로 보관할 미저장 본문이 없다(색과 같다).
  const res = validateNotePatch({ archived: true })
  assert.strictEqual(res.params.title, undefined)
  assert.strictEqual(res.params.text, undefined)
})

test('archived 와 다른 필드를 같이 보내도 된다', () => {
  assert.deepStrictEqual(
    validateNotePatch({ title: '제목', archived: true }),
    { ok: true, params: { title: '제목', archived: true } }
  )
})

test('archived 옆에 모르는 필드가 있으면 통째로 거절한다', () => {
  // 예전에는 여기 pinned 를 썼는데 그것이 지원 필드가 되면서 이 테스트가
  // 실패했다 — 의도대로다. 지원하지 않는 것이 확실한 필드로 바꾼다.
  const res = validateNotePatch({ archived: true, labels: ['업무'] })
  assert.strictEqual(res.ok, false)
  assert.match(res.message, /labels/)
})

test('참/거짓이 아닌 archived 도 여기서는 통과한다 — 값 검사는 사이드카가 한다', () => {
  // 이 함수는 "보낼 수 있는 키"의 화이트리스트다. 값의 형태를 판정하는 진짜
  // 경계는 사이드카이고, 거기서 bool 이 아니면 BadRequest 로 거절한다.
  assert.strictEqual(validateNotePatch({ archived: 'true' }).ok, true)
})

test('pinned 도 통과시킨다 — Keep 의 고정됨이다', () => {
  assert.deepStrictEqual(validateNotePatch({ pinned: true }), { ok: true, params: { pinned: true } })
  assert.deepStrictEqual(validateNotePatch({ pinned: false }), { ok: true, params: { pinned: false } })
})

test('압정(항상 위)은 이 경로로 오지 않는다', () => {
  // alwaysOnTop 은 state.json 에만 사는 이 PC 의 설정이라 Keep 으로 나가지
  // 않는다. 실수로 여기 실리면 사이드카가 모르는 키라 통째로 거절당한다 —
  // 그 전에 여기서 걸린다.
  const res = validateNotePatch({ alwaysOnTop: true })
  assert.strictEqual(res.ok, false)
  assert.match(res.message, /alwaysOnTop/)
})

test('고정과 보관을 같이 보낼 수 있다', () => {
  assert.deepStrictEqual(
    validateNotePatch({ pinned: true, archived: true }),
    { ok: true, params: { archived: true, pinned: true } }
  )
})
