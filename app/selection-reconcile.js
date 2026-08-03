'use strict'

/**
 * 목록 창의 체크 상태를 실제 바탕화면 상태로 맞추기 위해 무엇을 열고 무엇을
 * 내릴지 계산한다. Electron 을 require 하지 않는 순수 함수다.
 *
 * 이 프로젝트의 안전 규칙이 여기 그대로 반영되어 있다: 결과는 열 목록과
 * **내릴** 목록뿐이고, 지울 목록은 존재하지 않는다. 체크 해제는 바탕화면에서
 * 내리는 것이지 Keep 메모를 지우는 것이 아니다. 삭제는 포스트잇 우클릭 →
 * 확인 대화상자 경로에만 있다.
 *
 * 이미 떠 있는 메모를 다시 체크해도 toOpen 에 들어가지 않는다 — 들어가면
 * 편집 중이던 창이 다시 만들어지며 미저장 편집이 날아간다.
 *
 * @param {string[]} visibleIds 지금 바탕화면에 떠 있는 메모 id (접힌 것 포함).
 * @param {string[]} checkedIds 사용자가 체크해 둔 메모 id.
 * @returns {{toOpen: string[], toClose: string[]}}
 */
function reconcileSelection (visibleIds, checkedIds) {
  // 렌더러에서 IPC 로 건너온 값이다. 배열이 아니거나 문자열이 아닌 원소가
  // 섞여 있어도 여기서 조용히 걸러내고, 창 생성 경로까지 흘려보내지 않는다.
  const visible = toIdSet(visibleIds)
  const checked = toIdSet(checkedIds)

  const toOpen = [...checked].filter((id) => !visible.has(id))
  const toClose = [...visible].filter((id) => !checked.has(id))
  return { toOpen, toClose }
}

// Set 은 삽입 순서를 유지하므로 중복만 제거되고 입력 순서는 그대로 남는다.
function toIdSet (ids) {
  if (!Array.isArray(ids)) return new Set()
  return new Set(ids.filter((id) => typeof id === 'string' && id !== ''))
}

module.exports = { reconcileSelection }
