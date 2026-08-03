'use strict'

// 포스트잇 본문의 **줄 모형**. 한 메모 안에서 평범한 글줄과 체크리스트 항목이
// 섞여 있게 하는 규약이 전부 여기 있다.
//
// 위치가 app/renderer/ 인 이유는 note-filter.js / url-open.js 와 같다 —
// note.html 이 <script src> 로 직접 불러 쓰고, 맨 아래 module.exports 가드 덕에
// Node 의 require() 로도(테스트) 그대로 동작한다.
//
// --- 왜 텍스트인가 ---------------------------------------------------------
//
// Keep 의 노트는 Note(자유 텍스트) **이거나** List(체크박스)다. 둘은 형제
// 클래스이고 Note 에는 항목을 추가하는 메서드가 없으며 type 에 setter 도
// 변환 메서드도 없다 — 한 메모 안에서 글과 체크박스가 공존할 수 없다.
//
// 그래서 체크리스트를 **본문 텍스트 안의 규약**으로 둔다. 이 프로젝트가 이미
// 정한 D1("서식은 로컬 전용, Keep 엔 순수 텍스트")과 같은 판단이다. 폰의 Keep
// 앱에서는 평범한 글줄로 보인다 — 그것이 우리가 받아들인 대가다.
//
// --- 정확한 규칙 -----------------------------------------------------------
//
// 본문을 '\n' 으로 쪼갠 것이 줄이고, 줄 하나는 셋 중 하나로 읽힌다:
//
//   "- [ ] 내용"  → 체크 안 된 항목, 글자는 "내용"
//   "- [x] 내용"  → 체크된 항목,     글자는 "내용"
//   그 밖의 모든 것 → 평범한 글줄, 글자는 줄 그대로
//
// 표식은 **정확히 여섯 글자**다: 하이픈, 공백, 대괄호 열기, (공백|x), 대괄호
// 닫기, 공백. 이 여섯 글자가 줄의 **맨 앞**에 그대로 있어야 한다.
//
//   - 앞에 공백이 있으면(`  - [ ] 우유`) 항목이 아니다. Keep 에는 들여쓰기도
//     중첩 목록도 없어서 들여쓴 항목이 뜻하는 바가 없고, 허용하면 직렬화가
//     들여쓰기를 몇 칸으로 되돌릴지 정해야 하는데 그 정보를 모형에 더 담는
//     순간 왕복이 깨지거나 모형이 쓸데없이 커진다.
//   - 대문자 X(`- [X] 우유`)는 항목이 아니다. 받아들이면 직렬화가 소문자로
//     되돌려 원본과 달라진다 — 아래 왕복 성질이 그 자리에서 깨진다.
//   - 마지막 공백이 없는 `- [ ]` 는 항목이 아니라 글줄이다. 반대로 **글자가 빈
//     항목**은 `- [ ] `(뒤 공백 포함)로 직렬화되고, 다시 읽으면 글자가 빈
//     항목이 된다. 이 대칭이 있어야 "방금 만든 빈 줄"이 왕복을 견딘다.
//
// --- 왕복과 멱등 -----------------------------------------------------------
//
// **모든 문자열 s 에 대해 serializeNoteLines(parseNoteLines(s)) === s 다.**
// 증명은 짧다: parseNoteLines 는 s 를 '\n' 으로 쪼개 각 줄에 parseNoteLine 을
// 걸고, parseNoteLine 은 표식을 **떼기만** 하며 무엇을 뗐는지(kind/checked)를
// 남김없이 기록한다. serializeNoteLine 은 그 기록대로 정확히 같은 여섯 글자를
// 도로 붙이거나(항목) 아무것도 안 붙인다(글줄) — 즉 줄 단위로 항등이고,
// join('\n') 은 split('\n') 의 역이다. 따라서 f = serialize∘parse 는 항등함수이고
// 항등함수는 자명하게 멱등이다(f(f(s)) = f(s)).
//
// 이 성질이 중요한 이유: 이 프로젝트는 제목을 본문에서 떼어낼 때 정확히 이
// 모양의 버그를 한 번 냈다 — 저장할 때마다 내용이 조금씩 흘러내렸다.
//
// 반대 방향(parse∘serialize)은 항등이 아니다. 손으로 만든
// { kind: 'text', text: '- [ ] 우유' } 를 직렬화한 뒤 다시 읽으면 항목이 된다.
// **정본 방향은 텍스트 → 줄 → 텍스트다**(Keep 이 들고 있는 것이 텍스트이므로).
// 편집기 쪽에서는 이 어긋남이 실제로 생기지 않는다: 글줄 맨 앞에 표식을 다
// 치는 순간 note.js 가 그 자리에서 항목으로 바꿔 준다.

const LINE_MARK_UNCHECKED = '- [ ] '
const LINE_MARK_CHECKED = '- [x] '

/**
 * 줄 하나를 읽는다.
 *
 * @param {unknown} raw 본문의 한 줄('\n' 은 들어 있지 않다)
 * @returns {{kind: 'text'|'item', checked: boolean, text: string}}
 */
function parseNoteLine (raw) {
  const line = typeof raw === 'string' ? raw : ''
  if (line.startsWith(LINE_MARK_UNCHECKED)) {
    return { kind: 'item', checked: false, text: line.slice(LINE_MARK_UNCHECKED.length) }
  }
  if (line.startsWith(LINE_MARK_CHECKED)) {
    return { kind: 'item', checked: true, text: line.slice(LINE_MARK_CHECKED.length) }
  }
  return { kind: 'text', checked: false, text: line }
}

/**
 * 줄 하나를 본문 글자로 되돌린다. parseNoteLine 의 정확한 역이다.
 *
 * @param {unknown} line
 * @returns {string}
 */
function serializeNoteLine (line) {
  if (!line || typeof line !== 'object' || typeof line.text !== 'string') return ''
  if (line.kind !== 'item') return line.text
  return (line.checked === true ? LINE_MARK_CHECKED : LINE_MARK_UNCHECKED) + line.text
}

/**
 * 본문 전체를 줄 배열로 읽는다. 빈 본문도 **줄 하나**다(빈 글줄) — 편집기에는
 * 언제나 캐럿을 놓을 줄이 최소 하나 있어야 한다.
 *
 * @param {unknown} body
 * @returns {Array<{kind: 'text'|'item', checked: boolean, text: string}>}
 */
function parseNoteLines (body) {
  return (typeof body === 'string' ? body : '').split('\n').map(parseNoteLine)
}

/**
 * 줄 배열을 Keep 에 보낼 본문 한 덩어리로 되돌린다.
 *
 * @param {unknown} lines
 * @returns {string}
 */
function serializeNoteLines (lines) {
  if (!Array.isArray(lines)) return ''
  return lines.map(serializeNoteLine).join('\n')
}

/**
 * 표식을 뗀 글자만 이어 붙인다. 책갈피 문구와 배지 요약처럼 **사람에게 보여줄**
 * 자리에서 쓴다 — 접힌 책갈피에 "- [ ] 우유" 가 세로로 서면 열 칸 중 여섯 칸이
 * 표식으로 낭비된다.
 *
 * @param {unknown} lines
 * @returns {string}
 */
function noteLinesPlainText (lines) {
  if (!Array.isArray(lines)) return ''
  return lines.map((line) => (line && typeof line.text === 'string' ? line.text : '')).join('\n')
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LINE_MARK_UNCHECKED,
    LINE_MARK_CHECKED,
    parseNoteLine,
    serializeNoteLine,
    parseNoteLines,
    serializeNoteLines,
    noteLinesPlainText
  }
}
