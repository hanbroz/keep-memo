'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { deriveBookmarkText } = require('../renderer/bookmark-text')

test('제목이 있으면 제목을 그대로 쓴다', () => {
  assert.strictEqual(deriveBookmarkText('장보기', '우유\n계란'), '장보기')
})

test('제목이 비어 있으면 본문 첫 줄을 쓴다', () => {
  assert.strictEqual(deriveBookmarkText('', '우유\n계란'), '우유')
})

test('제목이 없고 본문이 한 줄뿐이면 그 한 줄을 쓴다', () => {
  assert.strictEqual(deriveBookmarkText('', '할 일 하나'), '할 일 하나')
})

test('제목도 본문도 없으면 빈 문자열이다 — "(제목없음)" 폴백은 여기서 넣지 않는다', () => {
  assert.strictEqual(deriveBookmarkText('', ''), '')
})

test('제목이 undefined/null 이어도 본문 첫 줄로 떨어진다', () => {
  assert.strictEqual(deriveBookmarkText(undefined, '본문'), '본문')
  assert.strictEqual(deriveBookmarkText(null, '본문'), '본문')
})

test('본문이 undefined/null 이고 제목도 없으면 빈 문자열이다', () => {
  assert.strictEqual(deriveBookmarkText('', undefined), '')
  assert.strictEqual(deriveBookmarkText('', null), '')
})

test('제목과 본문이 둘 다 있으면 본문은 무시된다(제목이 우선)', () => {
  assert.strictEqual(deriveBookmarkText('제목', '본문 첫 줄\n둘째 줄'), '제목')
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof deriveBookmarkText, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
