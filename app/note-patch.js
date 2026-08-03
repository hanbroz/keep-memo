'use strict'

// 항목 묶음의 검증은 렌더러와 한 벌만 있어야 한다. 이유는 store.js 가
// font-settings.js 를 require 하는 것과 같다 — 창마다(그리고 프로세스마다) 따로
// 판단하면 언젠가 갈라진다. 이 모듈은 Electron 을 건드리지 않는 순수 함수뿐이라
// main 프로세스에서 그대로 require 된다.
const { normalizeChecklistItems } = require('./renderer/checklist-items')

// notes:update 로 렌더러가 보낼 수 있는 필드는 이 셋뿐이다. 사이드카의
// update_note(id, title=None, text=None, color=None) 과 정확히 맞춘다 —
// 여기 없는 키가 들어오면 사이드카까지 보내지 않고 거절한다.
//
// 예전에는 main.js 가 `{ id, text: patch.text }` 만 만들어 보내 title 도
// (그리고 이제 색도) 조용히 버렸다. patch 를 통째로 넘기지 않고 필드를
// 하나씩 꺼내 화이트리스트에 대조하는 이유는, 렌더러가 보낸 객체를 그대로
// JSON-RPC params 로 흘리면 사이드카의 ALLOWED_METHODS 화이트리스트와 같은
// 문제(임의 키워드 인자 주입)가 여기서도 생길 수 있기 때문이다.
const PATCH_FIELDS = ['title', 'text', 'color']

/**
 * 렌더러가 보낸 patch 를 검증하고 사이드카에 보낼 파라미터로 다듬는다.
 *
 * 지원하지 않는 필드가 하나라도 있으면 통째로 거절한다 — 일부만 조용히
 * 골라 보내면 사용자가 보낸 편집 중 일부가 아무 신호 없이 사라진다.
 *
 * @param {unknown} patch
 * @returns {{ok: true, params: {title?: string, text?: string, color?: string}}
 *          | {ok: false, message: string}}
 */
function validateNotePatch (patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, message: '패치는 객체여야 한다.' }
  }

  const unknownKeys = Object.keys(patch).filter((key) => !PATCH_FIELDS.includes(key))
  if (unknownKeys.length > 0) {
    return { ok: false, message: `지원하지 않는 필드: ${unknownKeys.join(', ')}` }
  }

  const params = {}
  for (const field of PATCH_FIELDS) {
    if (patch[field] !== undefined) params[field] = patch[field]
  }
  return { ok: true, params }
}

// notes:updateChecklist 로 보낼 수 있는 필드. 사이드카의
// update_checklist(id, items, title=None) 과 정확히 맞춘다.
//
// color 가 없는 것은 실수가 아니다 — 체크리스트의 색도 바꿀 수 있지만 그 경로는
// 예전과 같은 notes:update(update_note) 다. 색은 두 종류가 공유하는 필드이므로
// 두 벌로 만들 이유가 없다.
const CHECKLIST_PATCH_FIELDS = ['title', 'items']

/**
 * 체크리스트 저장 요청을 검증하고 사이드카에 보낼 파라미터로 다듬는다.
 *
 * validateNotePatch 와 같은 규칙이다: 모르는 필드가 하나라도 있으면 통째로
 * 거절한다. 항목 묶음 자체의 검증은 checklist-items.js 가 하고(렌더러와 같은
 * 함수다), 사이드카가 한 번 더 한다 — 진짜 경계는 거기다.
 *
 * items 는 필수다. 없으면 거절한다: 빈 배열("항목을 전부 지웠다")과 생략("항목은
 * 건드리지 않았다")을 구별할 수 없는데, 앞의 뜻으로 읽히면 체크리스트가 통째로
 * 비워진다.
 *
 * @param {unknown} patch
 * @returns {{ok: true, params: {items: Array, title?: string}}
 *          | {ok: false, message: string}}
 */
function validateChecklistPatch (patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, message: '패치는 객체여야 한다.' }
  }

  const unknownKeys = Object.keys(patch).filter((key) => !CHECKLIST_PATCH_FIELDS.includes(key))
  if (unknownKeys.length > 0) {
    return { ok: false, message: `지원하지 않는 필드: ${unknownKeys.join(', ')}` }
  }
  if (patch.title !== undefined && typeof patch.title !== 'string') {
    return { ok: false, message: '제목은 문자열이어야 한다.' }
  }
  if (patch.items === undefined) {
    return { ok: false, message: '항목 묶음이 없다.' }
  }

  const items = normalizeChecklistItems(patch.items)
  if (!items.ok) return { ok: false, message: items.message }

  const params = { items: items.items }
  if (patch.title !== undefined) params.title = patch.title
  return { ok: true, params }
}

module.exports = {
  validateNotePatch,
  validateChecklistPatch,
  PATCH_FIELDS,
  CHECKLIST_PATCH_FIELDS
}
