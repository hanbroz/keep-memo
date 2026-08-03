'use strict'

// 포스트잇 에디터 ↔ Keep 의 title/text 두 필드를 오가는 순수 문자열 로직.
// email-validate.js / bookmark-layout.js 와 같은 패턴(순수 함수 + 테스트)을
// 따르지만, 위치는 app/renderer/ 다 — 이 모듈은 note.html 이 <script> 태그로
// 직접 불러 쓰는 유일한 "로직 모듈"이라서다(email-validate.js 와
// bookmark-layout.js 는 main 프로세스에서만 require 된다). 아래
// `module.exports` 가드 덕에 Node 의 require() 로도, contextIsolation 이 켜진
// 렌더러의 평범한 <script src> 로도 둘 다 동작한다 — 후자에서는 module 이
// 없으므로 이 파일 최상위의 함수 선언이 그대로 전역(window)에 걸린다.

/**
 * title/text 두 필드를 포스트잇 에디터에 보여줄 한 문자열로 합친다.
 *
 * 규칙(요구사항 그대로): title 이 있으면 "title\ntext", title 이 비어 있으면
 * text 그대로.
 *
 * 다만 title 은 있는데 text 가 비어 있는 경우엔 title 만 보여준다(뒤에 빈 줄을
 * 남기지 않는다). 이 예외가 없으면 제목만 있는 메모를 열고 아무것도 고치지
 * 않았는데 저장할 때마다 편집기에 빈 줄이 하나씩 늘어난다 — splitTitleAndText
 * 가 줄바꿈이 아예 없는 한 줄을 통째로 title 로 돌려주는 것과 짝을 맞추기
 * 위한 예외다. 아래 splitTitleAndText 의 주석에 왕복이 정확히 맞는 이유를
 * 케이스별로 적어 두었다.
 *
 * @param {string} title
 * @param {string} text
 * @returns {string}
 */
function joinTitleAndText (title, text) {
  const t = title || ''
  const x = text || ''
  if (!t) return x
  if (!x) return t
  return `${t}\n${x}`
}

/**
 * 에디터에 보이는 한 문자열을 저장할 title/text 로 나눈다.
 *
 * 규칙(요구사항 그대로): 첫 줄이 title, 첫 번째 줄바꿈 다음부터 끝까지가 text.
 *
 * 이 함수는 joinTitleAndText 의 정확한 역함수다 — 정확히는, 임의의 문자열
 * s 에 대해 다음이 항상 성립한다:
 *
 *   const { title, text } = splitTitleAndText(s)
 *   joinTitleAndText(title, text) === s
 *
 * 이게 성립해야 하는 이유: 사용자가 편집기에서 본 문자열이 저장 시 title/text
 * 로 쪼개졌다가, 다음에 불러올 때 다시 합쳐져 화면에 그려진다. 이 왕복이
 * 정확히 맞지 않으면 아무것도 고치지 않고 저장하기만 해도 편집기 내용이 매번
 * 조금씩 달라진다(드리프트). (title, text) 자체가 저장 전후로 달라지는 것은
 * 이 기능의 의도된 부분이다 — Keep 쪽 필드 구조가 한 번 바뀌는 것뿐, 사용자가
 * 보는 문자열 s 는 안정적으로 유지된다.
 *
 * 세 갈래로 나뉘는 이유:
 *
 *  - 줄바꿈이 아예 없으면(idx === -1) 한 줄 전체가 title 이 되고 text 는
 *    비워진다. joinTitleAndText 는 title 이 있고 text 가 비어 있으면 title
 *    만 돌려주므로(위 주석 참고) 정확히 원래 문자열로 되돌아온다.
 *
 *  - 첫 줄이 비어 있으면(idx === 0, 곧 s 가 '\n' 으로 시작 — "본문이 빈 줄로
 *    시작하는" 경우) title 을 '' 로 두고 그 앞의 줄바꿈까지 삼켜버리면, 다시
 *    합칠 때 joinTitleAndText 가 title 이 비었을 때 text 를 그대로(줄바꿈 없이)
 *    보여주는 규칙과 맞물려 그 빈 줄 자체가 사라진다. 그래서 이 경우는 아무것도
 *    잘라내지 않고 문자열 전체를 text 로 그대로 넘긴다 — title 은 비어 있으니
 *    join 은 text 를 그대로 돌려주고, 결과가 s 와 정확히 같아진다.
 *
 *  - 그 외(idx > 0)는 그대로 첫 줄이 title, 나머지가 text. text 안에 남은
 *    줄바꿈(중간의 빈 줄, 끝의 trailing newline 포함)은 전혀 건드리지 않고
 *    그대로 옮겨지므로 다시 합칠 때 그대로 복원된다.
 *
 * 딱 하나, 이 스킴이 근본적으로 못 지키는 경우가 있다: title 하나뿐이고 그
 * 뒤에 줄바꿈 한 개만 있고 아무 내용도 없는 경우("hello" 대 "hello\n")는
 * 둘 다 title='hello', text='' 로 쪼개져 서로 구별할 수 없다 — "첫 줄 뒤에
 * 아무 것도 없다"와 "첫 줄 뒤에 줄바꿈만 있고 아무 것도 없다"를 title/text
 * 두 필드만으로는 구분할 방법이 없기 때문이다. 실사용에서는 보이지 않는
 * 후행 빈 줄 하나일 뿐이라 내용 손실로 보지 않았다 — 자세한 내용은 리포트에
 * 적었다.
 *
 * @param {string} combined
 * @returns {{title: string, text: string}}
 */
function splitTitleAndText (combined) {
  const s = combined || ''
  const idx = s.indexOf('\n')
  if (idx === -1) return { title: s, text: '' }
  if (idx === 0) return { title: '', text: s }
  return { title: s.slice(0, idx), text: s.slice(idx + 1) }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { joinTitleAndText, splitTitleAndText }
}
