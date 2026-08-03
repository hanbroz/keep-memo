'use strict'

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

module.exports = { validateNotePatch, PATCH_FIELDS }
