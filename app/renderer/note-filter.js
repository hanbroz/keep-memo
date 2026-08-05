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
 * **보관 처리된 메모도 여기서 빠지지 않는다.** 감추면 이 앱에서 보관을 해제할
 * 길이 사라진다 — 목록에 없는 메모는 열 수도 없기 때문이다. 대신 사이드카가
 * 보관된 것을 맨 위 묶음으로 올려 보내고(_serialize_for_list), 목록 창은 그 행에
 * '보관' 표를 달아 구분한다. 이 함수는 검색만 본다.
 *
 * 순서는 건드리지 않는다. 정렬은 사이드카 한 곳에서만 정한다 — 여기서 또 줄을
 * 세우면 두 벌이 언젠가 갈라진다.
 *
 * 라벨 필터와 검색은 **AND** 다. 라벨로 좁힌 뒤 그 안에서 다시 검색하는 것이
 * "카테고리 안에서 찾기"라는 자연스러운 뜻이다. 묶음 거르개(고정/보관)도 같은
 * AND 로 걸린다 — 서로 다른 종류의 좁히기라 겹쳐 쓸 수 있어야 한다.
 *
 * @param {Array} notes 전체 노트
 * @param {string} query 입력칸의 원본 문자열
 * @param {string} [labelFilter] 라벨 id, LABEL_FILTER_NONE, 또는 ''(전체)
 * @param {Set<string>} [facets] 켜진 묶음. 비어 있으면 [전체] 다.
 */
function filterNotes (notes, query, labelFilter = '', facets = null) {
  if (!Array.isArray(notes)) return []
  const q = normalizeSearchQuery(query)
  const byLabel = typeof labelFilter === 'string' && labelFilter !== ''
  const byFacet = facets instanceof Set && facets.size > 0
  if (q === '' && !byLabel && !byFacet) return notes.slice()
  return notes.filter((note) => {
    if (byFacet && !noteInFacets(note, facets)) return false
    if (byLabel && !noteHasLabel(note, labelFilter)) return false
    return noteMatchesQuery(note, q)
  })
}

// 머리의 표를 눌러 켜는 묶음. 노트의 불리언 필드 이름과 **같아야** 한다 —
// noteInFacets 가 그 이름으로 바로 읽는다.
const NOTE_FACETS = ['pinned', 'archived']

/**
 * 이 노트가 켜진 묶음에 드는가.
 *
 * 켜진 것들끼리는 **OR** 다. [고정]과 [보관]을 둘 다 켜면 고정된 것과 보관된
 * 것을 모두 본다는 뜻이지, 둘 다인 메모만 본다는 뜻이 아니다. 그래야 표에 적힌
 * 숫자와 실제로 보이는 줄 수가 맞는다 — '고정 3' 을 눌렀는데 한 줄만 나오면
 * 그 숫자는 거짓말이 된다.
 *
 * 켜진 것이 하나도 없으면 전부 통과한다. 그것이 [전체] 다.
 */
function noteInFacets (note, facets) {
  if (!(facets instanceof Set) || facets.size === 0) return true
  if (!note || typeof note !== 'object') return false
  return NOTE_FACETS.some((facet) => facets.has(facet) && !!note[facet])
}

// '라벨 없음'을 고른 상태. <select> 의 value 로 오가야 하므로 문자열이어야 하고,
// 진짜 라벨 id 와 부딪히면 안 된다 — Keep 의 라벨 id 는 'tag.' 로 시작하므로
// (예: tag.db0u9qguemcy.19f) 이 값이 그것과 같아질 일은 없다.
const LABEL_FILTER_NONE = 'none:라벨없음'

/**
 * 이 노트가 고른 라벨에 걸리는가.
 *
 * 이름이 아니라 **id** 로 견준다. 이름은 사용자가 언제든 바꿀 수 있어서, 이름을
 * 열쇠로 쓰면 이름을 바꾼 순간 그 라벨이 붙은 메모를 전부 놓친다.
 *
 * labels 가 없는 응답(옛 사이드카)은 라벨이 하나도 없는 것으로 본다 — 그러면
 * '라벨 없음' 에는 걸리고 특정 라벨에는 안 걸린다. 둘 다 맞는 해석이다.
 */
function noteHasLabel (note, labelFilter) {
  const labels = note && Array.isArray(note.labels) ? note.labels : []
  if (labelFilter === LABEL_FILTER_NONE) return labels.length === 0
  return labels.some((label) => label && label.id === labelFilter)
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
  module.exports = {
    normalizeSearchQuery, noteMatchesQuery, filterNotes, selectionToApply,
    noteHasLabel, LABEL_FILTER_NONE, NOTE_FACETS, noteInFacets
  }
}
