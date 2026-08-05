'use strict'

// 목록 창 머리의 숫자 표(고정 N / 보관 N / 전체 N)와 행의 기울기.
//
// 위치가 app/renderer/ 인 이유는 note-filter.js 와 같다 — list.html 이
// <script src> 로 직접 불러 쓰는 순수 모듈이라서다. 아래 module.exports 가드
// 덕에 Node 의 require()(테스트)로도, contextIsolation 렌더러의 평범한
// <script src> 로도 둘 다 동작한다.

// 행마다 조금씩 다른 기울기. 리디자인의 '종이 쪽지' 인상은 이 미세한 어긋남에서
// 온다. 값은 디자인이 정한 열 개 그대로다.
const ROW_TILTS = ['-0.4deg', '0.3deg', '-0.3deg', '0.5deg', '-0.2deg',
  '0.4deg', '-0.5deg', '0.2deg', '-0.3deg', '0.4deg']

/**
 * 이 메모가 늘 갖는 기울기. **행의 순서가 아니라 메모 자신에서 나온다.**
 *
 * 순서로 정하면 검색어를 한 글자 칠 때마다 남은 행들의 기울기가 통째로 다시
 * 배정되어 목록이 눈에 띄게 흔들린다. 같은 메모는 언제 어디에 그려지든 같은
 * 각도여야 그 흔들림이 없다.
 *
 * id 를 CSS 로 흘리지 않는다 — 여기서 나가는 것은 위 표의 열 값 중 하나뿐이다.
 *
 * @param {unknown} id 노트 id
 * @returns {string} '0.3deg' 같은 CSS 각도
 */
function tiltFor (id) {
  const key = (id === null || id === undefined) ? '' : String(id)
  // FNV-1a. Math.imul 로 곱해야 32비트 곱셈의 상위 비트가 배정밀도 부동소수점에
  // 삼켜지지 않는다.
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193)
  // 상위 비트를 아래로 한 번 섞어 내린다. 이것이 없으면 고르는 데 쓰는 것이
  // 사실상 하위 몇 비트뿐이라, 앞이 길게 같고 끝만 다른 문자열(= Keep id 가
  // 꼭 그렇다)이 몇 각도에만 몰릴 수 있다.
  hash ^= hash >>> 15
  return ROW_TILTS[(hash >>> 0) % ROW_TILTS.length]
}

/**
 * 머리의 숫자 표에 쓸 값. 지금 걸러 보이는 것이 아니라 **전체** 노트를 센다 —
 * 검색으로 목록이 짧아졌을 때 "내 메모가 몇 장인지"를 알려주는 것이 이 표의
 * 쓸모이기 때문이다.
 *
 * @param {unknown} notes
 * @returns {{pinned: number, archived: number, total: number}}
 */
function countNoteStats (notes) {
  const list = Array.isArray(notes) ? notes : []
  let pinned = 0
  let archived = 0
  for (const note of list) {
    if (!note) continue
    if (note.pinned) pinned++
    if (note.archived) archived++
  }
  return { pinned, archived, total: list.length }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROW_TILTS, tiltFor, countNoteStats }
}
