'use strict'

/**
 * [동기화] 가 받아온 최신 노트 목록과, 지금 바탕화면에 떠 있는 메모 id 를
 * 견줘서 **더 이상 Keep 에 없는데 아직 창이 떠 있는** 메모의 id 를 고른다.
 * selection-reconcile.js 와 같은 자리다 — Electron 을 require 하지 않는
 * 순수 함수라 main 프로세스에서 그대로 쓰고 여기서 따로 시험한다.
 *
 * 이 목록이 왜 필요한가: 동기화는 다른 기기에서 지운 메모를 목록 창에서
 * 사라지게 하지만, 그 메모의 포스트잇이 이미 열려 있었다면 그 창은 목록과
 * 별개로 그대로 남는다. 창이 남의 존재하지 않는 노트 id 를 붙든 채 있으면
 * 다음 저장(update_note/update_checklist)이 사이드카에서 NOT_FOUND 로
 * 떨어진다 — 사용자에게는 "저장이 계속 실패하는 멀쩡해 보이는 창"으로만
 * 보인다. 그래서 main 은 이 함수가 돌려준 id 마다 trash_note 를 거치지 않고
 * (Keep 에 다시 지우라고 할 이유가 없다 — 이미 없다) 바탕화면에서만 내린다.
 *
 * @param {string[]} openIds 지금 바탕화면에 떠 있는 메모 id (접힌 것 포함).
 * @param {Array<{id?: string}>} freshNotes sync_notes 가 돌려준 최신 노트 목록.
 * @returns {string[]} openIds 의 순서를 따르는, freshNotes 에 없는 id 목록.
 */
function orphanedNoteIds (openIds, freshNotes) {
  const fresh = new Set(
    (Array.isArray(freshNotes) ? freshNotes : [])
      .map((n) => (n && typeof n.id === 'string' ? n.id : ''))
      .filter((id) => id !== '')
  )
  if (!Array.isArray(openIds)) return []
  return openIds.filter((id) => typeof id === 'string' && id !== '' && !fresh.has(id))
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { orphanedNoteIds }
}
