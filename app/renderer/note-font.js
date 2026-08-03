'use strict'

// 노트 한 장이 전역 서체 설정을 자기만 다르게 쓰고 싶을 때의 규칙. 순수 함수뿐이다.
//
// 위치가 app/renderer/ 인 이유는 font-settings.js / note-filter.js /
// bookmark-text.js 와 같다 — note.html 이 <script src> 로 직접 불러 쓰는 로직
// 모듈이라서다. 맨 아래 module.exports 가드 덕에 Node 의 require() 로도(테스트,
// 그리고 main 프로세스의 store.js), contextIsolation 이 켜진 렌더러의 평범한
// <script src> 로도 둘 다 동작한다.
//
// **재정의(override)는 Keep 에 저장되지 않는다.** Keep 의 노트에는 서체 필드가
// 없다. 그래서 이 값은 state.json 의 그 노트 항목 안에, x/y/w/h/visible/folded/
// conflictBackup 과 나란히 산다 — 이 PC 에서만 쓰는 값이다.
//
// 표(FONT_CHOICES)도 범위(FONT_PT_RANGE, clampPt 안에 있다)도 여기서 새로 적지
// 않는다. 전역 설정과 고를 수 있는 것이 같아야 하므로 font-settings.js 것을
// 그대로 쓴다 — 두 벌로 적으면 언젠가 한쪽만 늘어난다.
const FONT_API = (typeof module !== 'undefined' && module.exports)
  ? require('./font-settings')
  // 렌더러에는 require 가 없다. note.html 이 font-settings.js 를 이 파일보다
  // 먼저 부르므로 그 파일의 최상위 선언을 이름 그대로 쓸 수 있다. globalThis
  // 로는 못 잡는다 — 클래식 스크립트의 최상위 const 는 window 의 속성이 되지
  // 않고 전역 렉시컬 스코프에만 들어가기 때문이다. 여기서 같은 이름으로 다시
  // const 선언을 하면(예: const { FONT_CHOICES } = ...) 같은 전역 렉시컬
  // 스코프에 이미 있는 이름이라 SyntaxError 가 난다. 그래서 객체 하나에 담아
  // FONT_API.xxx 로만 쓴다.
  : { FONT_CHOICES, clampPt, normalizeFontSettings }

function isPlainObject (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * state.json 에 저장할 재정의를 다듬는다.
 *
 * 핵심은 **"안 정했다"와 "이 값으로 정했다"를 구별해 남기는 것**이다. 전역
 * 설정을 그대로 베껴 넣지 않는다 — 베껴 넣으면 나중에 사용자가 전역 설정을
 * 바꿔도 이 노트만 옛 값에 얼어붙는다. 그래서 사용자가 실제로 고른 항목만
 * 남기고, 하나도 없으면 null(= 재정의 없음)이 된다.
 *
 * 값 자체의 검증은 전역 설정과 똑같은 잣대를 쓴다:
 *  - family 는 FONT_CHOICES 에 있는 key 만 통과한다(사용자가 정한 문자열이
 *    CSS 로 이어붙여지는 경로를 만들지 않는다).
 *  - 크기는 clampPt 가 [6, 24] 로 조인다. 숫자로 읽히지 않으면(빈 칸, 글자,
 *    null) 재정의로 치지 않고 빠진다 — 그 항목은 전역을 따른다.
 *
 * @param {unknown} raw
 * @returns {{family?: string, titlePt?: number, bodyPt?: number}|null}
 */
function normalizeNoteFontOverride (raw) {
  const src = isPlainObject(raw) ? raw : {}
  const out = {}
  if (FONT_API.FONT_CHOICES.some((c) => c.key === src.family)) out.family = src.family
  // clampPt 는 숫자로 읽히지 않으면 두 번째 인자를 그대로 돌려준다. null 을
  // 넘겨 "이 항목은 재정의가 아니다"를 표현한다.
  const titlePt = FONT_API.clampPt(src.titlePt, null)
  if (titlePt !== null) out.titlePt = titlePt
  const bodyPt = FONT_API.clampPt(src.bodyPt, null)
  if (bodyPt !== null) out.bodyPt = bodyPt
  return Object.keys(out).length === 0 ? null : out
}

/**
 * 이 노트에 실제로 입힐 서체 설정을 만든다. applyFontSettings() 에 그대로
 * 넘길 수 있는 모양({family, titlePt, bodyPt})이다.
 *
 * 재정의가 없는 항목은 전역 설정을 따른다. **따라서 전역 설정이 바뀌면 이
 * 함수를 다시 부르는 것만으로 재정의가 없는 노트가 곧바로 따라온다** — 노트
 * 쪽에 전역 값을 복사해 둔 것이 없기 때문이다. 이것이 "재정의 없는 노트는
 * 전역을 실시간으로 따른다"를 보장하는 지점이다.
 *
 * @param {unknown} globalSettings 전역 설정(검증 전이어도 된다)
 * @param {unknown} override 이 노트의 재정의(없으면 null/undefined)
 * @returns {{family: string, titlePt: number, bodyPt: number}}
 */
function resolveNoteFont (globalSettings, override) {
  const base = FONT_API.normalizeFontSettings(globalSettings)
  const ov = normalizeNoteFontOverride(override) || {}
  return {
    family: ov.family === undefined ? base.family : ov.family,
    titlePt: ov.titlePt === undefined ? base.titlePt : ov.titlePt,
    bodyPt: ov.bodyPt === undefined ? base.bodyPt : ov.bodyPt
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeNoteFontOverride, resolveNoteFont }
}
