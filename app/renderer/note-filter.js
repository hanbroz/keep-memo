'use strict'

// 목록 창의 검색과, 검색이 절대 건드리면 안 되는 것(체크된 집합)을 다루는 순수
// 함수들. 위치가 app/renderer/ 인 이유는 bookmark-text.js / font-settings.js 와
// 같다 — list.html 이 <script src> 로 직접 불러 쓴다. 아래 module.exports 가드
// 덕에 Node 의 require() 로도 <script src> 로도 동작한다.
//
// 검색은 전부 여기서(=렌더러에서) 끝난다. list_notes 가 이미 title 과 text 를
// 같이 주므로 RPC 를 새로 만들 이유가 없다.

/** 사용자가 친 것을 비교용으로 다듬는다. 앞뒤 공백만 있는 질의는 빈 질의다. */
function normalizeSearchQuery (raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

/**
 * 노트 하나가 질의에 걸리는가. 제목 **또는** 본문에 대소문자 무시 부분 문자열로
 * 들어 있으면 걸린다. 제목과 본문을 따로 본다 — 이어붙여 검사하면 제목 끝과
 * 본문 앞을 걸치는 가짜 일치가 생긴다.
 *
 * @param {{title?: string, text?: string}} note
 * @param {string} normalizedQuery normalizeSearchQuery() 를 이미 지난 값
 */
function noteMatchesQuery (note, normalizedQuery) {
  if (normalizedQuery === '') return true
  if (!note || typeof note !== 'object') return false
  const title = typeof note.title === 'string' ? note.title.toLowerCase() : ''
  const text = typeof note.text === 'string' ? note.text.toLowerCase() : ''
  return title.includes(normalizedQuery) || text.includes(normalizedQuery)
}

/**
 * 화면에 그릴 노트만 골라낸다. 빈 질의는 전부 돌려준다(원본을 그대로 주지 않고
 * 얕은 복사를 준다 — 부르는 쪽이 정렬해도 원본이 흔들리지 않게).
 *
 * @param {Array} notes 전체 노트
 * @param {string} query 입력칸의 원본 문자열
 */
function filterNotes (notes, query) {
  if (!Array.isArray(notes)) return []
  const q = normalizeSearchQuery(query)
  if (q === '') return notes.slice()
  return notes.filter((note) => noteMatchesQuery(note, q))
}

/**
 * [완료] 가 main 으로 보낼 id 목록.
 *
 * **이 함수가 이 기능 전체에서 제일 위험한 지점을 막는다.** 기준은 "지금 화면에
 * 그려진 행"이 아니라 **전체 노트**다. 검색으로 걸러져 화면에서 사라진 노트의
 * 체크도 그대로 살아서 여기 들어온다. 그리지 않은 행을 세지 않으면, 검색을 켠
 * 채 [완료] 를 누른 사용자가 건드린 적도 없는 포스트잇이 조용히 내려간다 —
 * main 의 reconcileSelection 은 "체크 목록에 없다 = 내려라"로 읽기 때문이다.
 *
 * 동시에, 전체 노트에 없는 id 는 결과에 들어가지 않는다. Keep 에서 사라진
 * 메모까지 다시 띄우려 들지 않게 하기 위한 것이고, 검색을 넣기 전의 동작(행이
 * 곧 노트였으므로 없는 노트는 애초에 체크될 수 없었다)과도 같다.
 *
 * @param {Array<{id?: string}>} allNotes list_notes 가 준 전체 노트
 * @param {Set<string>|Array<string>} checkedIds 체크된 id 전체
 * @returns {string[]} allNotes 의 순서를 따르는, 중복 없는 id 목록
 */
function selectionToApply (allNotes, checkedIds) {
  if (!Array.isArray(allNotes)) return []
  const checked = checkedIds instanceof Set
    ? checkedIds
    : new Set(Array.isArray(checkedIds) ? checkedIds : [])
  const out = []
  const seen = new Set()
  for (const note of allNotes) {
    const id = note && typeof note.id === 'string' ? note.id : ''
    if (id === '' || seen.has(id)) continue
    if (!checked.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeSearchQuery, noteMatchesQuery, filterNotes, selectionToApply }
}
