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
  s.stop()
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

test('재시작 후 onRestart 로 세션 상태를 다시 세울 수 있다', async () => {
  // 재시작된 프로세스는 set_account 이전 상태다. onRestart 가 없으면(또는
  // 새 프로세스가 아직 못 받는 시점에 불리면) 이후 모든 호출이 AUTH_REQUIRED
  // 로 떨어지고 재로그인해도 낫지 않는다.
  let s = null
  const restored = []
  s = spawnFake({
    timeoutMs: 5000,
    maxRestarts: 2,
    onRestart: async (sc) => {
      assert.strictEqual(sc, s) // 훅은 사이드카 자신을 받는다
      restored.push(await sc.call('echo', { setAccount: true }))
    }
  })

  s.call('die').catch(() => {})
  await new Promise((r) => setTimeout(r, 300))

  assert.strictEqual(s.restarts, 1)
  // 훅이 불렸을 뿐 아니라, 그 안에서 보낸 호출이 새 프로세스에 실제로 닿았다.
  assert.deepStrictEqual(restored, [{ setAccount: true }])
  s.stop()
})

test('재시작 한도를 넘으면 onRestart 를 부르지 않는다', async () => {
  let restartCalls = 0
  const s = spawnFake({
    timeoutMs: 5000,
    maxRestarts: 1,
    onRestart: () => { restartCalls++ }
  })
  for (let i = 0; i < 2; i++) {
    s.call('die').catch(() => {})
    await new Promise((r) => setTimeout(r, 150))
  }
  assert.strictEqual(restartCalls, 1) // 재시작은 1회뿐이었으므로 훅도 1회
  s.stop()
})

test('죽은 사이드카에 호출하면 앱을 죽이지 않고 SIDECAR_DEAD 로 거부한다', async () => {
  // 한도를 넘긴 뒤에도 this.proc 는 죽은 자식을 가리킨 채 남는다. 가드가
  // 없으면 그 stdin 에 쓰는 순간 메인 프로세스의 uncaughtException 이 된다.
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 0 })
  s.call('die').catch(() => {})
  await new Promise((r) => setTimeout(r, 150))
  await assert.rejects(s.call('echo', { n: 1 }), (err) => err.code === 'SIDECAR_DEAD')
  s.stop()
})

test('사이드카 stderr 마지막 줄이 onDead 메시지에 실린다', async () => {
  // 패키징본은 console=False 라 파이썬 트레이스백을 볼 다른 경로가 없다.
  let deadMessage = null
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 0, onDead: (m) => { deadMessage = m } })
  await s.call('noisy', { line: 'Traceback (most recent call last):' })
  await new Promise((r) => setTimeout(r, 50))
  s.call('die').catch(() => {})
  await new Promise((r) => setTimeout(r, 200))
  assert.match(deadMessage, /Traceback \(most recent call last\):/)
  s.stop()
})

test('stop() 은 여러 번 불려도 안전하다', () => {
  // 종료 경로가 window-all-closed / before-quit / will-quit / session-end 로
  // 여러 개라 겹쳐 불리는 것이 정상이다.
  const s = spawnFake()
  s.stop()
  s.stop()
  assert.strictEqual(s.stopped, true)
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
