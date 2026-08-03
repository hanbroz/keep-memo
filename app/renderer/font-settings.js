'use strict'

// 서체 설정의 유일한 진실. 기본값, 고를 수 있는 글꼴 목록, 값 검증, 그리고
// "그 값을 화면에 입히는 방법"까지 전부 이 파일 하나에 있다.
//
// 위치가 app/renderer/ 인 이유는 bookmark-text.js 와 같다 — list.html 이
// <script src> 로 직접 불러 쓰는 로직 모듈이라서다. 아래 module.exports 가드
// 덕에 Node 의 require() 로도(테스트, 그리고 main 프로세스의 store.js),
// contextIsolation 이 켜진 렌더러의 평범한 <script src> 로도 둘 다 동작한다.
//
// **이 파일이 세 벌짜리 :root 블록의 표류를 막는 장치다.** list.html /
// note.html / setup-email.html 의 :root 는 여전히 각자 값을 적어 두지만, 그
// 값들은 이제 "applyFontSettings() 가 돌기 전까지의 기본값"일 뿐이다. 실제로
// 화면에 남는 값은 창마다 이 함수가 <html> 의 인라인 스타일로 덮어쓴 것이다.
// 포스트잇(note.html)도 나중에 같은 <script src="font-settings.js"> 한 줄과
// 같은 applyFontSettings() 호출로 붙는다 — 토큰 이름(--font-ui / --fs-title /
// --fs-body)이 같으므로 CSS 쪽에서 더 할 일이 없다.
//
// 웹폰트는 없다. CSP 가 default-src 'self' 이고 이 앱은 오프라인에서도 떠야
// 하므로 모든 선택지는 시스템에 이미 있는 글꼴이고, 전부 일반 계열(generic
// family)로 끝나는 대체 사슬을 달고 있다 — 그 글꼴이 없는 기계에서도 깨지지
// 않고 한 단계씩 내려앉는다. 한국어의 마지막 안전판은 'Malgun Gothic' 이다.
//
// **stack 문자열은 반드시 이 표에서만 나온다.** 사용자가 고르는 것은 key 이고,
// key 는 아래 목록에 있는 것만 통과한다. 그래서 사용자가 정한 값이 CSS 문자열로
// 이어붙여지는 경로가 존재하지 않는다.
const FONT_CHOICES = [
  { key: 'noto-sans-kr', label: 'Noto Sans KR', stack: "'Noto Sans KR', 'Malgun Gothic', sans-serif" },
  { key: 'malgun-gothic', label: '맑은 고딕', stack: "'Malgun Gothic', 'Noto Sans KR', sans-serif" },
  { key: 'system-ui', label: '시스템 기본', stack: "system-ui, 'Segoe UI', 'Malgun Gothic', sans-serif" },
  { key: 'gulim', label: '굴림', stack: "'Gulim', 'Malgun Gothic', sans-serif" },
  { key: 'batang', label: '바탕 (명조)', stack: "'Batang', 'Malgun Gothic', serif" },
  { key: 'consolas', label: 'Consolas (고정폭)', stack: "'Consolas', 'D2Coding', 'Malgun Gothic', monospace" }
]

// 사용자가 지정한 단위는 pt 다. px 로 바꿔 저장하지 않는다 — 되돌릴 때 반올림
// 오차가 생기고, 설정 창에 보여줄 숫자가 사용자가 넣은 숫자와 달라진다.
const FONT_PT_RANGE = { min: 6, max: 24 }

const DEFAULT_FONT_SETTINGS = { family: 'noto-sans-kr', titlePt: 10, bodyPt: 9 }

/** 알 수 없는 key 여도 반드시 쓸 수 있는 stack 을 돌려준다(기본 글꼴). */
function fontStackFor (familyKey) {
  const found = FONT_CHOICES.find((c) => c.key === familyKey)
  return (found || FONT_CHOICES[0]).stack
}

// 숫자로 읽을 수 있는 것만 숫자로 만든다. 빈 문자열('')은 Number('') === 0 이라
// 그대로 두면 "안 적었다"가 6pt 로 둔갑한다 — 여기서 NaN 으로 떨군다.
function toFiniteNumber (raw) {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw)
  return NaN
}

/**
 * 크기 하나를 쓸 수 있는 값으로 만든다.
 * 숫자로 읽히지 않으면(빈 칸, 글자, null, NaN, Infinity) 기본값으로 떨어지고,
 * 숫자로 읽히면 정수로 반올림한 뒤 [min, max] 로 조인다.
 */
function clampPt (raw, fallback) {
  const n = toFiniteNumber(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(FONT_PT_RANGE.max, Math.max(FONT_PT_RANGE.min, Math.round(n)))
}

/**
 * state.json 이든 렌더러의 입력칸이든, 밖에서 온 값을 항상 쓸 수 있는 설정으로
 * 만든다. 저장할 때도 읽을 때도 이 함수를 지나므로 state.json 에는 검증된 값만
 * 남고, 손으로 고쳐 넣은 이상한 값이 화면까지 오지 않는다.
 *
 * @param {unknown} raw
 * @returns {{family: string, titlePt: number, bodyPt: number}}
 */
function normalizeFontSettings (raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const known = FONT_CHOICES.some((c) => c.key === src.family)
  return {
    family: known ? src.family : DEFAULT_FONT_SETTINGS.family,
    titlePt: clampPt(src.titlePt, DEFAULT_FONT_SETTINGS.titlePt),
    bodyPt: clampPt(src.bodyPt, DEFAULT_FONT_SETTINGS.bodyPt)
  }
}

/**
 * 설정을 CSS 사용자 정의 속성으로 입힌다. 창마다 이 함수 하나만 부르면 된다.
 *
 * innerHTML 도, <style> 태그 조립도 쓰지 않는다 — CSSOM 의 setProperty 로
 * <html> 의 인라인 스타일 속성 세 개를 세울 뿐이다. 값도 전부 우리 것이다:
 * 글꼴은 위 표의 stack 문자열이고, 크기는 검증을 지난 숫자에 'pt' 를 붙인
 * 것이다. 사용자가 친 문자열이 CSS 로 흘러드는 길이 없다.
 *
 * @param {unknown} settings
 * @param {{style: {setProperty: Function}}} [root] 기본값은 document.documentElement
 * @returns {{family: string, titlePt: number, bodyPt: number}} 실제로 입힌 값
 */
function applyFontSettings (settings, root) {
  const s = normalizeFontSettings(settings)
  const target = root || (typeof document !== 'undefined' ? document.documentElement : null)
  if (target && target.style && typeof target.style.setProperty === 'function') {
    target.style.setProperty('--font-ui', fontStackFor(s.family))
    target.style.setProperty('--fs-title', `${s.titlePt}pt`)
    target.style.setProperty('--fs-body', `${s.bodyPt}pt`)
  }
  return s
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FONT_CHOICES,
    FONT_PT_RANGE,
    DEFAULT_FONT_SETTINGS,
    fontStackFor,
    clampPt,
    normalizeFontSettings,
    applyFontSettings
  }
}
