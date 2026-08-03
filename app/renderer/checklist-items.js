'use strict'

// 체크리스트 항목 묶음의 모양을 정하고 검증하는 순수 함수들.
//
// 위치가 app/renderer/ 인 이유는 note-filter.js / font-settings.js 와 같다 —
// note.html / list.html 이 <script src> 로 직접 불러 쓰고, module.exports 가드
// 덕에 Node 의 require() 로도(테스트, 그리고 **main 프로세스**) 그대로 동작한다.
//
// 사이드카에도 같은 검증이 한 벌 더 있다(keep_service.py 의 _validate_items).
// 두 벌인 것이 맞다: 여기 있는 것은 잘못된 값이 IPC 를 건너가기 전에 사용자에게
// 이유를 알려주기 위한 것이고, 실제 보안 경계는 사이드카다 — 렌더러는 신뢰
// 경계의 바깥쪽이므로 렌더러에만 있는 검사는 검사가 아니다. main.js 의
// notes:updateChecklist 핸들러도 사이드카로 넘기기 전에 이 함수를 한 번 부른다
// (note-patch.js 의 validateNotePatch 와 같은 자리, 같은 이유다).

// 항목 하나가 가질 수 있는 키는 이것이 전부다. 모르는 키가 하나라도 섞여 있으면
// 통째로 거절한다 — 일부만 조용히 골라 보내면 사용자가 한 편집 중 일부가 아무
// 신호 없이 사라진다(note-patch.js 와 같은 판단이다).
const ITEM_FIELDS_WITH_ID = ['id', 'text', 'checked']
const ITEM_FIELDS_NEW = ['text', 'checked']

// note-font.js 에도 같은 일을 하는 isPlainObject 가 있다. 이름을 일부러 다르게
// 둔다: note.html 은 이 파일들을 클래식 <script> 로 나란히 불러오고, 그러면
// 최상위 선언들이 **하나의 전역 스코프**를 공유한다. 같은 이름의 function 선언은
// 조용히 나중 것이 이긴다(에러가 안 난다) — 지금은 두 몸통이 같아서 아무 일도
// 없지만, 한쪽만 고치는 날 다른 쪽이 소리 없이 따라 바뀐다. 같은 이름의 const
// 였다면 그 자리에서 SyntaxError 가 나 포스트잇 창 전체가 죽는다.
function isPlainItem (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 항목 묶음을 검증하고, 사이드카에 그대로 보낼 수 있는 모양으로 다듬는다.
 *
 * 무엇이 유효한가:
 *  - 전체는 배열이어야 한다(객체도, null 도, 문자열도 아니다).
 *  - 항목 하나하나는 평범한 객체여야 한다.
 *  - text 는 반드시 있어야 하고 문자열이어야 한다. 빈 문자열은 유효하다 —
 *    사용자가 방금 추가한, 아직 아무것도 안 쓴 줄이 그것이다.
 *  - checked 는 없으면 false 로 채운다. 있으면 반드시 진짜 불리언이어야 한다
 *    ('true' 나 1 은 거절한다 — 문자열 'false' 가 참으로 읽히는 종류의 사고를
 *    애초에 막는다).
 *  - id 는 기존 체크리스트를 고칠 때(requireId)만 필요하고 비어 있지 않은
 *    문자열이어야 한다. 새로 만들 때는 반대로 **있으면 거절한다** — 항목 id 는
 *    Keep 이 정하는 것이지 렌더러가 정하는 것이 아니다.
 *  - id 가 겹치면 거절한다. 어느 항목을 고치라는 것인지 정할 수 없다.
 *
 * @param {unknown} raw
 * @param {{requireId?: boolean}} [options] requireId 기본값은 true(기존 항목 수정)
 * @returns {{ok: true, items: Array<{id?: string, text: string, checked: boolean}>}
 *          | {ok: false, message: string}}
 */
function normalizeChecklistItems (raw, options) {
  const requireId = !options || options.requireId !== false
  const allowed = requireId ? ITEM_FIELDS_WITH_ID : ITEM_FIELDS_NEW

  if (!Array.isArray(raw)) return { ok: false, message: '항목 묶음은 배열이어야 한다.' }

  const items = []
  const seenIds = new Set()
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i]
    if (!isPlainItem(entry)) return { ok: false, message: `${i}번째 항목이 객체가 아니다.` }

    const unknownKeys = Object.keys(entry).filter((key) => !allowed.includes(key))
    if (unknownKeys.length > 0) {
      return { ok: false, message: `${i}번째 항목에 지원하지 않는 필드: ${unknownKeys.join(', ')}` }
    }
    if (typeof entry.text !== 'string') {
      return { ok: false, message: `${i}번째 항목의 text 는 문자열이어야 한다.` }
    }
    if (entry.checked !== undefined && typeof entry.checked !== 'boolean') {
      return { ok: false, message: `${i}번째 항목의 checked 는 true/false 여야 한다.` }
    }

    const item = { text: entry.text, checked: entry.checked === true }
    if (requireId) {
      if (typeof entry.id !== 'string' || entry.id === '') {
        return { ok: false, message: `${i}번째 항목의 id 가 없다.` }
      }
      if (seenIds.has(entry.id)) {
        return { ok: false, message: `항목 id 가 겹친다: ${entry.id}` }
      }
      seenIds.add(entry.id)
      item.id = entry.id
    }
    items.push(item)
  }
  return { ok: true, items }
}

/**
 * 항목 묶음을 한 문자열로 접는다. **미저장 편집이 있는가**를 판단하는 데만 쓴다
 * — 포스트잇이 text 노트에서 body.value !== savedText 로 판단하던 그 자리다.
 *
 * 구분자를 손으로 고르지 않고 JSON.stringify 에 맡긴다. "사용자가 입력할 수
 * 없는 글자"를 구분자로 삼는 방식은 그 가정이 참인가에 기대게 되는데(붙여넣기는
 * 제약이 다르다), 가정이 틀리면 서로 다른 묶음이 같은 서명을 갖게 되어 미저장
 * 편집이 조용히 사라진다. 항목마다 배열로 싸서 직렬화하면 그 가정 자체가
 * 필요 없다.
 *
 * @param {unknown} items
 * @returns {string}
 */
function checklistSignature (items) {
  if (!Array.isArray(items)) return ''
  return JSON.stringify(items.map((item) => [
    item && typeof item.id === 'string' ? item.id : '',
    item && item.checked === true ? 1 : 0,
    item && typeof item.text === 'string' ? item.text : ''
  ]))
}

/**
 * 책갈피와 목록 창이 쓸 "본문처럼 보이는 문자열". 체크리스트에는 본문
 * textarea 가 없으므로, 접었을 때 보여줄 글자를 항목에서 뽑아야 한다
 * (deriveBookmarkText 의 두 번째 인자로 그대로 넘어간다).
 *
 * @param {unknown} items
 * @returns {string}
 */
function checklistText (items) {
  if (!Array.isArray(items)) return ''
  return items
    .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
    .join('\n')
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ITEM_FIELDS_WITH_ID,
    ITEM_FIELDS_NEW,
    normalizeChecklistItems,
    checklistSignature,
    checklistText
  }
}
