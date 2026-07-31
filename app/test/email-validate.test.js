'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { validateEmail } = require('../email-validate')

test('올바른 이메일 주소는 그대로 통과한다', () => {
  const res = validateEmail('you@gmail.com')
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.value, 'you@gmail.com')
})

test('빈 입력은 거부된다', () => {
  const res = validateEmail('')
  assert.strictEqual(res.ok, false)
  assert.ok(res.message)
})

test('@ 이 없는 입력은 거부된다', () => {
  const res = validateEmail('yougmail.com')
  assert.strictEqual(res.ok, false)
  assert.ok(res.message)
})

test('공백만 있는 입력은 거부된다', () => {
  const res = validateEmail('   ')
  assert.strictEqual(res.ok, false)
  assert.ok(res.message)
})

test('앞뒤 공백은 잘라내고 통과시킨다', () => {
  const res = validateEmail('  you@gmail.com  ')
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.value, 'you@gmail.com')
})
