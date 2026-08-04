'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { tokenAtCaret, trimDelimiters, sanitizeUrl, urlAtCaret } = require('../renderer/url-open')

// --- 캐럿 위치에서 후보 잘라내기 -------------------------------------------

test('문장 한가운데의 주소를 캐럿 위치에서 그대로 집어낸다', () => {
  const url = 'https://example.com/docs'
  const text = `자세한 건 ${url} 에 있습니다`
  const at = text.indexOf(url)
  assert.strictEqual(tokenAtCaret(text, at), url) // 첫 글자
  assert.strictEqual(tokenAtCaret(text, at + 10), url) // 주소 한가운데
  assert.strictEqual(tokenAtCaret(text, at + url.length), url) // 마지막 글자 바로 뒤
})

test('캐럿이 주소 바로 뒤(끝 글자 다음 칸)에 떨어져도 그 주소로 읽는다', () => {
  const text = 'https://example.com'
  assert.strictEqual(tokenAtCaret(text, text.length), text)
})

test('주소 뒤 공백을 지나 다음 낱말에 떨어지면 그 낱말이 후보다', () => {
  // 이것이 위 경계 규칙의 반대쪽이다 — 여기서 주소가 나오면 안 된다.
  assert.strictEqual(tokenAtCaret('https://example.com 안녕', 20), '안녕')
})

test('빈 클릭(빈 본문, 공백 위, 범위 밖 인덱스)은 후보가 없다', () => {
  assert.strictEqual(tokenAtCaret('', 0), '')
  assert.strictEqual(tokenAtCaret('   ', 1), '')
  assert.strictEqual(tokenAtCaret('abc', -1), '')
  assert.strictEqual(tokenAtCaret('abc', 99), '')
  assert.strictEqual(tokenAtCaret('abc', 1.5), '')
  assert.strictEqual(tokenAtCaret(null, 0), '')
})

test('줄바꿈도 공백이다 — 후보가 다음 줄까지 번지지 않는다', () => {
  assert.strictEqual(tokenAtCaret('앞줄\nhttps://example.com\n뒷줄', 6), 'https://example.com')
})

test('앞뒤 괄호와 문장부호를 벗긴다', () => {
  assert.strictEqual(trimDelimiters('(https://example.com)'), 'https://example.com')
  assert.strictEqual(trimDelimiters('https://example.com,'), 'https://example.com')
  assert.strictEqual(trimDelimiters('https://example.com.'), 'https://example.com')
  assert.strictEqual(trimDelimiters('"https://example.com"'), 'https://example.com')
  // 끝의 '/' 는 주소의 일부다. 벗기면 안 된다.
  assert.strictEqual(trimDelimiters('https://example.com/'), 'https://example.com/')
})

// --- 열어도 되는가 ---------------------------------------------------------

test('http 와 https 만 열린다', () => {
  assert.deepStrictEqual(sanitizeUrl('http://example.com/a'),
    { ok: true, url: 'http://example.com/a' })
  assert.deepStrictEqual(sanitizeUrl('https://example.com/a'),
    { ok: true, url: 'https://example.com/a' })
})

test('스킴의 대소문자는 상관없다 — URL 생성자가 정규화한다', () => {
  assert.strictEqual(sanitizeUrl('HTTPS://EXAMPLE.COM/A').url, 'https://example.com/A')
})

test('javascript: 는 거절한다', () => {
  // Keep 본문에 붙여 넣힌 문자열이 그대로 운영체제로 가는 것이 이 기능의
  // 유일한 진짜 위험이다. 스킴 화이트리스트가 그것을 막는 지점이다.
  const res = sanitizeUrl('javascript:alert(document.domain)')
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'BLOCKED_PROTOCOL')
})

test('file: 은 거절한다', () => {
  const res = sanitizeUrl('file:///C:/Windows/System32/drivers/etc/hosts')
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'BLOCKED_PROTOCOL')
})

test('data:, mailto:, 그 밖에 모르는 스킴도 전부 거절한다', () => {
  for (const bad of ['data:text/html,<b>x</b>', 'mailto:a@b.com', 'ms-msdt:/id', 'vbscript:x']) {
    const res = sanitizeUrl(bad)
    assert.strictEqual(res.ok, false, `${bad} 는 거절돼야 한다`)
    assert.strictEqual(res.reason, 'BLOCKED_PROTOCOL', `${bad} 의 거절 사유`)
  }
})

test('UNC 경로와 스킴 없는 문자열은 파싱에 실패해 거절된다', () => {
  for (const bad of ['\\\\server\\share\\secret.txt', '//evil.example.com', 'www.example.com',
                     '평범한낱말', 'http://']) {
    const res = sanitizeUrl(bad)
    assert.strictEqual(res.ok, false, `${bad} 는 거절돼야 한다`)
    assert.strictEqual(res.reason, 'UNPARSABLE', `${bad} 의 거절 사유`)
  }
})

test('Windows 드라이브 경로는 한 글자짜리 스킴으로 파싱된다 — 그래도 거절된다', () => {
  // 이것이 "정규식 대신 URL 생성자로 파싱하라"는 규칙이 왜 스킴 화이트리스트와
  // 반드시 짝이어야 하는지를 보여주는 자리다. 'C:\\Windows' 는 파싱에 실패하지
  // 않는다 — protocol 이 'c:' 인 멀쩡한 URL 로 읽힌다. 파싱 성공만 보고 열었다면
  // 여기서 로컬 경로가 운영체제로 넘어갔을 것이다.
  const res = sanitizeUrl('C:\\Windows\\System32')
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'BLOCKED_PROTOCOL')
})

test('문자열이 아니거나 비어 있으면 거절한다', () => {
  assert.strictEqual(sanitizeUrl(null).reason, 'NOT_A_STRING')
  assert.strictEqual(sanitizeUrl(42).reason, 'NOT_A_STRING')
  assert.strictEqual(sanitizeUrl({ href: 'https://example.com' }).reason, 'NOT_A_STRING')
  assert.strictEqual(sanitizeUrl('').reason, 'EMPTY')
  assert.strictEqual(sanitizeUrl('   ').reason, 'EMPTY')
})

test('공백이 든 문자열은 거절한다 — 문장 한 토막이 주소로 둔갑하지 않게', () => {
  // URL 생성자는 경로 안의 공백을 %20 으로 삼켜 이것을 '유효한 주소'로 만든다.
  const res = sanitizeUrl('https://example.com/a b')
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'HAS_WHITESPACE')
})

// --- 본문 + 캐럿 → 주소 (렌더러가 실제로 부르는 경로) ----------------------

test('문장 한가운데의 맨 주소가 열린다', () => {
  const text = '회의록은 https://example.com/notes 에 있습니다'
  assert.deepStrictEqual(urlAtCaret(text, 10), { ok: true, url: 'https://example.com/notes' })
})

test('괄호로 감싼 주소, 쉼표나 마침표가 뒤에 붙은 주소도 열린다', () => {
  assert.strictEqual(urlAtCaret('(https://example.com/a)', 5).url, 'https://example.com/a')
  assert.strictEqual(urlAtCaret('참고 https://example.com/a, 그리고', 8).url, 'https://example.com/a')
  assert.strictEqual(urlAtCaret('참고 https://example.com/a. 끝', 8).url, 'https://example.com/a')
})

test('한국어가 든 주소는 퍼센트 인코딩된 채로 열린다', () => {
  const res = urlAtCaret('https://example.com/한글문서', 5)
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.url, 'https://example.com/%ED%95%9C%EA%B8%80%EB%AC%B8%EC%84%9C')
  // 원문이 그대로 운영체제로 가지 않는다는 것이 핵심이다.
  assert.ok(!res.url.includes('한글'))
})

test('본문에 붙여 넣힌 javascript: 문자열을 Ctrl+클릭해도 열리지 않는다', () => {
  const text = '이거 눌러보세요 javascript:fetch("http://evil.example.com") 지금'
  const res = urlAtCaret(text, 12)
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'BLOCKED_PROTOCOL')
})

test('file: 경로를 Ctrl+클릭해도 열리지 않는다', () => {
  const res = urlAtCaret('백업 file:///C:/Users/secret.txt 참고', 5)
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'BLOCKED_PROTOCOL')
})

test('평범한 낱말과 빈 클릭은 조용히 실패하지 않고 이유를 남긴다', () => {
  // 렌더러는 이 reason 을 보고 상태 줄에 안내를 띄운다. ok:false 만으로는
  // "아무 일도 안 일어난 것"과 구별되지 않는다.
  assert.strictEqual(urlAtCaret('그냥 문장입니다', 1).reason, 'UNPARSABLE')
  assert.strictEqual(urlAtCaret('', 0).reason, 'EMPTY')
  assert.strictEqual(urlAtCaret('   ', 2).reason, 'EMPTY')
})

test('캐럿이 주소 바로 뒤에 떨어지면 열리고, 한 낱말 더 지나면 열리지 않는다', () => {
  const text = 'https://example.com/a 다음낱말'
  assert.strictEqual(urlAtCaret(text, 21).url, 'https://example.com/a')
  assert.strictEqual(urlAtCaret(text, 24).ok, false)
})

test('Electron 없이도 require 된다', () => {
  // main 프로세스와 렌더러가 같은 파일을 쓴다. Electron 을 끌어들이면 이
  // 테스트가 돌지 않고, 그러면 검증의 진짜 자리(main)를 못 지킨다.
  assert.strictEqual(typeof sanitizeUrl, 'function')
})

// --- [Keep 열기] 주소 ---------------------------------------------------------
//
// 그냥 keep.google.com 을 열면 브라우저의 기본 구글 계정으로 열린다. 회사 계정과
// 개인 계정을 같이 쓰면 남의 메모가 열리고, 앱과 웹의 내용이 다르다고 읽힌다.

const { keepListUrl, KEEP_LIST_URL } = require('../renderer/url-open')

test('계정을 알면 그 계정으로 열도록 주소에 실어 보낸다', () => {
  const url = keepListUrl('someone@gmail.com')
  const parsed = new URL(url)
  assert.strictEqual(parsed.host, 'accounts.google.com')
  assert.strictEqual(parsed.searchParams.get('Email'), 'someone@gmail.com')
  assert.strictEqual(parsed.searchParams.get('continue'), KEEP_LIST_URL)
})

test('계정을 모르면 평범한 keep.google.com 으로 떨어진다', () => {
  // AccountChooser 는 구글이 문서로 약속한 엔드포인트가 아니다. 계정이 없다고
  // 버튼이 죽으면 안 된다.
  for (const missing of [null, undefined, '', '   ', 42, {}]) {
    assert.strictEqual(keepListUrl(missing), KEEP_LIST_URL, JSON.stringify(missing))
  }
})

test('이메일이 이상해도 질의 문자열로 새어 나가지 않는다', () => {
  // 사용자가 손으로 넣는 값이다. 인코딩하지 않으면 & 하나로 다른 파라미터를
  // 덧붙일 수 있다.
  const url = keepListUrl('a@b.com&continue=https://evil.example/')
  const parsed = new URL(url)
  assert.strictEqual(parsed.searchParams.get('continue'), KEEP_LIST_URL,
    'continue 가 덮이면 안 된다')
  assert.strictEqual(parsed.searchParams.get('Email'), 'a@b.com&continue=https://evil.example/')
})

test('만들어진 주소는 언제나 sanitizeUrl 을 통과한다', () => {
  // main 은 이 주소도 예외 없이 openChecked 에 넣는다. 여기서 못 지나는 모양이
  // 나오면 버튼이 아무 일도 안 하는 것으로 보인다.
  for (const email of ['a@b.com', '', '이름@도메인.한국', 'a b@c.com']) {
    const checked = sanitizeUrl(keepListUrl(email))
    assert.strictEqual(checked.ok, true, `${JSON.stringify(email)} → ${keepListUrl(email)}`)
  }
})
