'use strict'

// 책갈피(접힌 포스트잇)에 보여줄 문구를 title/text 두 필드에서 뽑는 순수
// 함수. 규칙: title 이 있으면 title, 없으면 text 의 첫 줄, 그마저 없으면 빈
// 문자열이다 — list.js 의 titleOf() 와 같은 규칙이다(그쪽은 목록 창에서
// '(제목없음)' 폴백까지 한 번에 하지만, 여기서는 그 폴백을 넣지 않는다. 빈
// 문자열과 "정말 아무것도 없다"를 구별해 둬야 note.js 의 renderBookmark() 가
// 필요할 때 그 폴백 문구를 직접 붙일 수 있다).
//
// email-validate.js / bookmark-layout.js / note-patch.js 와 같은 패턴(순수
// 함수 + 별도 테스트)을 따르지만 위치는 app/renderer/ 다 — note.html 이
// <script> 태그로 직접 불러 쓰는 로직 모듈이라서다(예전 note-title.js 와 같은
// 이유). 아래 module.exports 가드 덕에 Node 의 require() 로도,
// contextIsolation 이 켜진 렌더러의 평범한 <script src> 로도 둘 다 동작한다 —
// 후자에서는 module 이 없으므로 이 파일 최상위의 함수 선언이 그대로
// 전역(window)에 걸린다.
//
// title 자체가 매 입력마다 바뀌는 값이므로, 이 함수는 "저장된" 값이 아니라
// 호출 시점에 넘겨받은 title/text 를 그대로 쓴다 — note.js 는 저장 여부와
// 무관하게 title.value/body.value 를 매번 넘겨 부른다. 그래야 막 친 제목을
// 저장 전에 곧바로 접어도 책갈피에 그대로 보인다.
//
// @param {string} title
// @param {string} text
// @returns {string}
function deriveBookmarkText (title, text) {
  return title || (text || '').split('\n')[0] || ''
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { deriveBookmarkText }
}
