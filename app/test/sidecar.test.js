'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { Sidecar } = require('../sidecar')

const FAKE = path.join(__dirname, 'fake-sidecar.js')

function spawnFake (opts) {
  return new Sidecar(process.execPath, [FAKE], opts).start()
}

test('요청과 응답이 id 로 짝지어진다', async () => {
  const s = spawnFake()
  const [a, b] = await Promise.all([
    s.call('echo', { n: 1 }),
    s.call('echo', { n: 2 })
  ])
  assert.deepStrictEqual([a.n, b.n], [1, 2])
  s.stop()
})

test('서버 에러는 code 가 붙은 Error 로 거부된다', async () => {
  const s = spawnFake()
  await assert.rejects(s.call('boom'), (err) => {
    assert.strictEqual(err.code, 'AUTH_REQUIRED')
    assert.strictEqual(err.message, '토큰 없음')
    return true
  })
  s.stop()
})

test('응답이 없으면 TIMEOUT 으로 거부된다', async () => {
  const s = spawnFake({ timeoutMs: 200 })
  await assert.rejects(s.call('silent'), (err) => err.code === 'TIMEOUT')
  s.stop()
})

test('사이드카가 죽으면 대기 중인 요청이 전부 거부된다', async () => {
  const s = spawnFake({ timeoutMs: 5000 })
  const pending = s.call('silent')
  s.call('die').catch(() => {})
  await assert.rejects(pending, (err) => err.code === 'SIDECAR_DEAD')
})

test('사이드카가 죽으면 최대 3회까지 자동 재시작한다', async () => {
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 3 })
  for (let i = 0; i < 3; i++) {
    s.call('die').catch(() => {})
    await new Promise((r) => setTimeout(r, 120))
  }
  assert.strictEqual(s.restarts, 3)
  // 재시작된 프로세스가 살아 있어야 한다
  assert.deepStrictEqual(await s.call('echo', { ok: 1 }), { ok: 1 })
  s.stop()
})

test('재시작 한도를 넘으면 포기하고 onDead 를 호출한다', async () => {
  let deadCalled = false
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 1, onDead: () => { deadCalled = true } })
  for (let i = 0; i < 2; i++) {
    s.call('die').catch(() => {})
    await new Promise((r) => setTimeout(r, 120))
  }
  assert.strictEqual(deadCalled, true)
})
