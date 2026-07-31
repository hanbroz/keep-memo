'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { pollCookie } = require('../login')

function fakeSession (sequence) {
  let i = 0
  return { cookies: { get: async () => sequence[Math.min(i++, sequence.length - 1)] } }
}

test('oauth_token 쿠키를 잡으면 값을 반환한다', async () => {
  const session = fakeSession([[], [{ name: 'oauth_token', value: 'oauth2_4/abc' }]])
  const value = await pollCookie(session, { intervalMs: 1, timeoutMs: 1000 })
  assert.strictEqual(value, 'oauth2_4/abc')
})

test('접두사가 다른 쿠키는 무시한다', async () => {
  const session = fakeSession([[{ name: 'oauth_token', value: 'garbage' }]])
  const value = await pollCookie(session, { intervalMs: 1, timeoutMs: 50 })
  assert.strictEqual(value, null)
})

test('시간이 다 되면 null 을 반환한다', async () => {
  const session = fakeSession([[]])
  const value = await pollCookie(session, { intervalMs: 1, timeoutMs: 30 })
  assert.strictEqual(value, null)
})
