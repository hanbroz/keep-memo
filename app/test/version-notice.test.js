'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { extractIncomingVersion, describeVersionMismatch } = require('../version-notice')

// --- extractIncomingVersion -------------------------------------------------

test('additionalData 가 { version: string } 이면 그 문자열을 그대로 뽑는다', () => {
  assert.strictEqual(extractIncomingVersion({ version: '2026.803.1200' }), '2026.803.1200')
})

test('additionalData 가 undefined 면(옛 빌드가 아무것도 안 보낸 경우) null 이다', () => {
  assert.strictEqual(extractIncomingVersion(undefined), null)
})

test('additionalData 가 빈 객체면 null 이다', () => {
  assert.strictEqual(extractIncomingVersion({}), null)
})

test('additionalData 가 객체가 아니면(null, 문자열, 숫자, 배열) null 이다', () => {
  for (const bad of [null, 'not-an-object', 42, []]) {
    assert.strictEqual(extractIncomingVersion(bad), null, `${JSON.stringify(bad)} 는 null 이어야 한다`)
  }
})

test('version 필드가 문자열이 아니면(숫자, null 등) null 이다', () => {
  assert.strictEqual(extractIncomingVersion({ version: 123 }), null)
  assert.strictEqual(extractIncomingVersion({ version: null }), null)
})

test('version 필드가 빈 문자열이면 null 이다', () => {
  assert.strictEqual(extractIncomingVersion({ version: '' }), null)
})

// --- describeVersionMismatch -------------------------------------------------

test('두 버전이 같으면 matches: true 이고 그 외 필드가 없다', () => {
  const res = describeVersionMismatch('2026.803.1200', '2026.803.1200')
  assert.deepStrictEqual(res, { matches: true })
})

test('두 버전이 다르면 matches: false 이고 둘 다 message/detail 에 등장한다', () => {
  const res = describeVersionMismatch('2026.803.1200', '2026.803.900')
  assert.strictEqual(res.matches, false)
  assert.ok(res.message)
  assert.ok(res.detail.includes('2026.803.1200'))
  assert.ok(res.detail.includes('2026.803.900'))
})

test('들어온 버전을 모르면(null) 안전한 쪽으로 불일치 취급한다', () => {
  const res = describeVersionMismatch('2026.803.1200', null)
  assert.strictEqual(res.matches, false)
  assert.ok(res.detail.includes('2026.803.1200'))
  // 모른다는 사실 자체가 드러나야 한다 — 조용히 아무 버전이나 채워 넣지 않는다.
  assert.ok(!res.detail.includes('null'))
  assert.ok(!res.detail.includes('undefined'))
})

test('실행 중인 버전이 빈 문자열이어도 던지지 않는다(방어적)', () => {
  const res = describeVersionMismatch('', '2026.803.1200')
  assert.strictEqual(res.matches, false)
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof extractIncomingVersion, 'function')
  assert.strictEqual(typeof describeVersionMismatch, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
