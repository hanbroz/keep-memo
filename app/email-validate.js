'use strict'

// 이메일이 "이메일처럼 보이는지"만 최소한으로 확인한다. RFC 5322 전체를 구현하지
// 않는다 — 진짜 검증(계정이 실제로 존재하는지, 자격 증명이 맞는지)은 사이드카가
// gpsoauth 로 로그인을 시도할 때 이뤄진다. 여기서는 빈 값이나 명백히 잘못된
// 입력만 걸러 사용자가 그대로 넘기지 않게 한다.
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * @param {string} input - 사용자가 입력한 원본 문자열 (앞뒤 공백은 잘라낸다)
 * @returns {{ok: true, value: string} | {ok: false, message: string}}
 */
function validateEmail (input) {
  const trimmed = typeof input === 'string' ? input.trim() : ''
  if (!trimmed) {
    return { ok: false, message: '이메일을 입력해 주세요.' }
  }
  if (!EMAIL_LIKE.test(trimmed)) {
    return { ok: false, message: '올바른 이메일 형식이 아닙니다. 예: you@gmail.com' }
  }
  return { ok: true, value: trimmed }
}

module.exports = { validateEmail }
