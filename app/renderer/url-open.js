'use strict'

// 포스트잇 본문에서 Ctrl+클릭한 자리의 URL 을 찾아내고, 그것을 정말로 열어도
// 되는지 판정하는 순수 함수들.
//
// 위치가 app/renderer/ 인 이유는 bookmark-text.js / font-settings.js /
// note-filter.js 와 같다 — note.html 이 <script src> 로 직접 불러 쓰는 로직
// 모듈이라서다. 맨 아래 module.exports 가드 덕에 Node 의 require() 로도
// (테스트, 그리고 **main 프로세스**), contextIsolation 이 켜진 렌더러의 평범한
// <script src> 로도 둘 다 동작한다.
//
// **main 프로세스가 이 파일을 같이 쓰는 것이 이 기능의 보안 설계 전부다.**
// shell.openExternal() 은 문자열을 그대로 운영체제에 넘긴다. 그 문자열은 Keep
// 에서 온 외부 데이터이고, 렌더러는 신뢰 경계의 바깥쪽이다 — 렌더러에만 있는
// 검사는 검사가 아니다. 그래서 main.js 의 'shell:openExternal' 핸들러가 렌더러가
// 이미 통과시킨 값을 받아 sanitizeUrl() 을 **한 번 더** 돌린다. 렌더러 쪽 검사는
// 사용자에게 즉시 이유를 알려주기 위한 것일 뿐이고, 실제 방어선은 main 이다.

// 열어도 되는 스킴은 이 둘뿐이다. file:, javascript:, data:, ms-msdt:,
// 알 수 없는 것 — 전부 거절이다. 화이트리스트여야 한다: 블랙리스트로 두면
// 운영체제가 새 핸들러를 등록할 때마다 구멍이 하나씩 늘어난다.
const OPENABLE_PROTOCOLS = ['http:', 'https:']

// 사람이 문장 안에 주소를 쓸 때 앞뒤에 붙는 것들. 주소의 일부가 아니다.
// 여는 쪽은 앞에서, 문장부호와 닫는 쪽은 뒤에서 벗겨낸다.
const OPENERS = '([{<"\'«“‘'
const TRAILERS = '.,;:!?)]}>"\'»”’…'

/**
 * 클릭 위치를 감싸는 "공백이 아닌 덩어리"를 잘라낸다.
 *
 * <textarea> 에는 링크 요소가 없다. 클릭은 캐럿을 옮길 뿐이고, 그래서 우리가
 * 아는 것은 selectionStart 하나뿐이다. 여기서부터 좌우로 공백을 만날 때까지
 * 뻗어 나가는 것이 우리가 할 수 있는 전부이며, 실제로 그것으로 충분하다 —
 * URL 에는 공백이 들어갈 수 없기 때문이다.
 *
 * 캐럿이 주소의 **바로 뒤**에 떨어진 경우(끝 글자 다음 칸)도 그 주소로 읽힌다:
 * 왼쪽으로 뻗는 스캔이 주소를 그대로 집어 오고 오른쪽 스캔은 즉시 멈춘다.
 * 반대로 주소 뒤 공백을 지나 다음 낱말에 떨어지면 그 낱말이 후보가 되고,
 * 그것은 URL 로 파싱되지 않아 거절된다.
 *
 * @param {unknown} text 본문 전체
 * @param {unknown} caretIndex textarea.selectionStart
 * @returns {string} 후보 문자열. 찾을 수 없으면 빈 문자열.
 */
function tokenAtCaret (text, caretIndex) {
  if (typeof text !== 'string' || text === '') return ''
  if (!Number.isInteger(caretIndex) || caretIndex < 0 || caretIndex > text.length) return ''

  let start = caretIndex
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1
  let end = caretIndex
  while (end < text.length && !/\s/.test(text[end])) end += 1
  return text.slice(start, end)
}

/**
 * 후보 앞뒤에 붙은 괄호와 문장부호를 벗긴다.
 *
 * 일부러 단순하게 둔다. 주소 끝이 정말 ')' 인 경우(위키백과의 동음이의 링크
 * 같은 것)는 한 글자 짧은 주소가 열리지만, 그 방향의 실수는 안전하다 — 반대로
 * 문장부호를 남겨두면 열리지 않는 주소가 되어 기능이 고장 난 것처럼 보인다.
 */
function trimDelimiters (token) {
  if (typeof token !== 'string') return ''
  let s = token
  while (s.length > 0 && OPENERS.includes(s[0])) s = s.slice(1)
  while (s.length > 0 && TRAILERS.includes(s[s.length - 1])) s = s.slice(0, -1)
  return s
}

/**
 * 이 문자열을 shell.openExternal() 에 넘겨도 되는가.
 *
 * 판정은 정규식이 아니라 **URL 생성자**가 한다. 전체 문자열에 정규식을 대는
 * 방식은 "http://" 로 시작하는 것처럼 보이지만 실제로는 다른 스킴으로 해석되는
 * 입력을 걸러내지 못한다. 파서에게 물어보고, 파서가 못 읽으면 거절한다.
 *
 * 돌려주는 것은 입력 문자열이 아니라 parsed.href — 파서가 정규화하고 퍼센트
 * 인코딩까지 마친 값이다. 한국어가 든 주소는 이 단계에서 %XX 로 바뀌어
 * 운영체제에 넘어간다.
 *
 * @param {unknown} candidate
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
function sanitizeUrl (candidate) {
  if (typeof candidate !== 'string') return { ok: false, reason: 'NOT_A_STRING' }
  const trimmed = candidate.trim()
  if (trimmed === '') return { ok: false, reason: 'EMPTY' }
  // 공백이 남아 있으면 후보가 아니다. URL 생성자는 경로 안의 공백을 %20 으로
  // 삼켜버리므로, 문장 한 토막이 통째로 '유효한 주소'가 되는 길을 막는다.
  if (/\s/.test(trimmed)) return { ok: false, reason: 'HAS_WHITESPACE' }

  let parsed = null
  try {
    parsed = new URL(trimmed)
  } catch {
    // 스킴이 없는 것(www.example.com, 평범한 낱말), UNC 경로(\\server\share),
    // 호스트가 빈 것(http://) 이 전부 여기로 떨어진다. 추측해서 살려내지
    // 않는다 — 'www.' 로 시작하니 https 를 붙여주자는 친절이 곧 우회로다.
    return { ok: false, reason: 'UNPARSABLE' }
  }
  if (!OPENABLE_PROTOCOLS.includes(parsed.protocol)) {
    return { ok: false, reason: 'BLOCKED_PROTOCOL' }
  }
  return { ok: true, url: parsed.href }
}

/**
 * 본문과 캐럿 위치 하나로 "열 수 있는 주소"까지 한 번에 간다. 렌더러의
 * Ctrl+클릭 핸들러가 부르는 것은 이 함수 하나다.
 *
 * @param {unknown} text
 * @param {unknown} caretIndex
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
function urlAtCaret (text, caretIndex) {
  return sanitizeUrl(trimDelimiters(tokenAtCaret(text, caretIndex)))
}

/** 목록 창의 [Keep 열기] 가 여는 주소. 계정을 지정하지 못할 때의 기본값이다. */
const KEEP_LIST_URL = 'https://keep.google.com/'

/**
 * 목록 창의 [Keep 열기] 가 브라우저에 넘길 주소를 만든다.
 *
 * 그냥 keep.google.com 을 열면 **브라우저의 기본 구글 계정**으로 열린다. 이 앱이
 * 로그인한 계정과 브라우저 기본 계정이 다르면(회사 계정과 개인 계정을 같이 쓰면
 * 흔한 일이다) 남의 메모가 열리고, 사용자는 앱과 웹의 내용이 다르다고 읽는다.
 * 그래서 계정을 힌트로 실어 보낸다.
 *
 * **AccountChooser 는 구글이 문서로 약속한 엔드포인트가 아니다.** 언젠가 조용히
 * 바뀔 수 있다는 뜻이라, 그때도 버튼이 죽지는 않도록 이메일이 없으면 평범한
 * keep.google.com 으로 떨어진다. 그 계정으로 로그인돼 있지 않으면 구글이
 * 로그인 화면을 보여주는데, 그것도 맞는 결과다 — 우리가 원한 계정을 묻는 것이다.
 *
 * 이메일은 encodeURIComponent 를 지난다. 저장된 값이 이상해도(사용자가 손으로
 * 넣는 값이다) 질의 문자열의 다른 파라미터로 새어 나가지 않는다.
 *
 * @param {unknown} email 이 앱이 로그인한 계정. 없으면 계정 힌트 없이 연다.
 * @returns {string} https 주소. 언제나 sanitizeUrl 을 통과하는 모양이다.
 */
function keepListUrl (email) {
  const clean = typeof email === 'string' ? email.trim() : ''
  if (clean === '') return KEEP_LIST_URL
  return 'https://accounts.google.com/AccountChooser' +
    `?Email=${encodeURIComponent(clean)}` +
    `&continue=${encodeURIComponent(KEEP_LIST_URL)}`
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    OPENABLE_PROTOCOLS, tokenAtCaret, trimDelimiters, sanitizeUrl, urlAtCaret,
    keepListUrl, KEEP_LIST_URL
  }
}
